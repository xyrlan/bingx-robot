import { inngest } from '@/inngest/client';
import {
  getRunningBots,
  getBotById,
  setBotStatus,
  getContractInfo,
  getCurrentPrice,
  getBingxClientByApiKeyId,
  getBingxClient,
} from '@/services/bingx.service';
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

    let processed = 0;

    for (const bot of bots) {
      const result = await step.run(`process-dca-${bot.id}`, async () => {
        const freshBot = await getBotById(bot.id, bot.userId);
        if (!freshBot || freshBot.status !== 'RUNNING') return 0;

        const config = freshBot.config as DCAConfig | null;
        if (!config) return 0;

        if (!shouldPlaceDCAOrder(config, freshBot.createdAt)) return 0;

        const client = freshBot.apiKeyId
          ? await getBingxClientByApiKeyId(freshBot.apiKeyId)
          : await getBingxClient(freshBot.userId);
        if (!client) {
          await setBotStatus(bot.id, bot.userId, 'STOPPED');
          return 0;
        }

        const symbol = String(freshBot.symbol).trim().toUpperCase();
        const contractInfo = await getContractInfo(client, symbol);
        const quantityPrecision = contractInfo?.quantityPrecision ?? 4;
        const currentPrice = await getCurrentPrice(client, symbol);
        if (!currentPrice) return 0;

        const orderId = await placeDCAOrder(client, symbol, config, currentPrice, quantityPrecision);
        if (orderId) {
          const updatedConfig: DCAConfig = { ...config, ordersPlaced: config.ordersPlaced + 1 };
          await db
            .update(tradingBots)
            .set({ config: updatedConfig, updatedAt: new Date() })
            .where(eq(tradingBots.id, bot.id));

          if (updatedConfig.ordersPlaced >= updatedConfig.totalOrders) {
            await setBotStatus(bot.id, bot.userId, 'STOPPED');
            logger.info(`DCA bot ${bot.id} completed all ${updatedConfig.totalOrders} orders`);
          }
          return 1;
        }
        return 0;
      });

      processed += result ?? 0;
    }

    return { processed };
  }
);
