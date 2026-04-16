import { inngest } from '@/inngest/client';
import {
  getRunningBots,
  getBotById,
  setBotStatus,
  getContractInfo,
  getCurrentPrice,
  recordTrade,
} from '@/services/bingx.service';
import { groupBotsBySymbolAndKey, getClientForBot } from '@/inngest/helpers';
import { placeDCAOrder, shouldPlaceDCAOrder } from '@/services/bots/dca.service';
import type { DCAConfig } from '@/services/bots/types';
import { db } from '@/db';
import { tradingBots } from '@/db/schema';
import { eq } from 'drizzle-orm';

export const dcaBotWatch = inngest.createFunction(
  {
    id: 'dca-bot-watch',
    name: 'DCA Bot Watch',
    retries: 3,
    concurrency: { limit: 1 },
  },
  { cron: '*/5 * * * *' },
  async ({ step, logger }) => {
    const bots = await step.run('fetch-dca-bots', async () => {
      const allRunning = await getRunningBots();
      return allRunning.filter((b) => b.botType === 'DCA');
    });

    if (bots.length === 0) return { processed: 0 };

    // Group bots by (symbol, apiKeyId) to share getContractInfo/getCurrentPrice
    const groups = groupBotsBySymbolAndKey(bots);

    let processed = 0;

    for (const [groupKey, groupBots] of groups) {
      const result = await step.run(`process-dca-group-${groupKey}`, async () => {
        let groupProcessed = 0;

        // Get a client from the first bot in the group
        const firstBot = groupBots[0];
        const client = await getClientForBot(firstBot);
        if (!client) return 0;

        const symbol = String(firstBot.symbol).trim().toUpperCase();
        const contractInfo = await getContractInfo(client, symbol);
        const quantityPrecision = contractInfo?.quantityPrecision ?? 4;
        const currentPrice = await getCurrentPrice(client, symbol);
        if (!currentPrice) return 0;

        for (const bot of groupBots) {
          const freshBot = await getBotById(bot.id, bot.userId);
          if (!freshBot || freshBot.status !== 'RUNNING') continue;

          const config = freshBot.config as DCAConfig | null;
          if (!config) continue;
          if (!shouldPlaceDCAOrder(config, freshBot.createdAt)) continue;

          const orderId = await placeDCAOrder(client, symbol, config, currentPrice, quantityPrecision);
          if (orderId) {
            const qty = config.orderSizeUsdt / currentPrice;
            const side = config.side === 'SELL' ? 'SHORT' : 'LONG';
            await recordTrade({
              botId: bot.id, symbol, side: side as 'LONG' | 'SHORT', type: 'ENTRY',
              price: currentPrice, quantity: qty, orderId,
            });
            const updatedConfig: DCAConfig = { ...config, ordersPlaced: config.ordersPlaced + 1, lastOrderAt: Date.now() };
            await db
              .update(tradingBots)
              .set({ config: updatedConfig, updatedAt: new Date() })
              .where(eq(tradingBots.id, bot.id));

            if (updatedConfig.ordersPlaced >= updatedConfig.totalOrders) {
              await setBotStatus(bot.id, bot.userId, 'STOPPED');
              logger.info(`DCA bot ${bot.id} completed all ${updatedConfig.totalOrders} orders`);
            }
            groupProcessed++;
          }
        }

        return groupProcessed;
      });

      processed += result ?? 0;
    }

    return { processed };
  }
);
