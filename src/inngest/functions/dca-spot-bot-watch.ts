import { inngest } from '@/inngest/client';
import {
  getRunningBotsByIds,
  getBotById,
  setBotStatus,
} from '@/services/bingx.service';
import { groupBotsBySymbolAndKey, getClientForBot } from '@/inngest/helpers';
import { placeSpotDCAOrder } from '@/services/bots/dca-spot.service';
import { shouldPlaceDCAOrder } from '@/services/bots/dca.service';
import type { DCAConfig } from '@/services/bots/types';
import type { BotTickEventPayload } from '@/inngest/events';
import { db } from '@/db';
import { tradingBots } from '@/db/schema';
import { eq } from 'drizzle-orm';

export const dcaSpotBotWatch = inngest.createFunction(
  {
    id: 'dca-spot-bot-watch',
    name: 'DCA Spot Bot Watch',
    retries: 3,
    concurrency: { limit: 1 },
  },
  { event: 'bot.tick.DCA_SPOT' },
  async ({ step, logger, event }) => {
    const { botIds } = event.data as BotTickEventPayload;
    const bots = await step.run('fetch-dca-spot-bots', async () => {
      return getRunningBotsByIds(botIds);
    });

    if (bots.length === 0) return { processed: 0 };

    const groups = groupBotsBySymbolAndKey(bots);

    let processed = 0;

    for (const [groupKey, groupBots] of groups) {
      const result = await step.run(`process-dca-spot-group-${groupKey}`, async () => {
        let groupProcessed = 0;

        const firstBot = groupBots[0];
        const client = await getClientForBot(firstBot);
        if (!client) return 0;

        const symbol = String(firstBot.symbol).trim().toUpperCase();

        for (const bot of groupBots) {
          const freshBot = await getBotById(bot.id, bot.userId);
          if (!freshBot || freshBot.status !== 'RUNNING') continue;

          const config = freshBot.config as DCAConfig | null;
          if (!config) continue;
          if (!shouldPlaceDCAOrder(config, freshBot.createdAt)) continue;

          const orderId = await placeSpotDCAOrder(client, symbol, config);
          if (orderId) {
            const updatedConfig: DCAConfig = { ...config, ordersPlaced: config.ordersPlaced + 1, lastOrderAt: Date.now() };
            await db
              .update(tradingBots)
              .set({ config: updatedConfig, updatedAt: new Date() })
              .where(eq(tradingBots.id, bot.id));

            if (updatedConfig.ordersPlaced >= updatedConfig.totalOrders) {
              await setBotStatus(bot.id, bot.userId, 'STOPPED');
              logger.info(`DCA Spot bot ${bot.id} completed all ${updatedConfig.totalOrders} orders`);
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
