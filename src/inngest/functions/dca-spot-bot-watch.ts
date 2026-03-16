import { inngest } from '@/inngest/client';
import {
  getRunningBots,
  getBotById,
  setBotStatus,
  getBingxClientByApiKeyId,
  getBingxClient,
} from '@/services/bingx.service';
import { placeSpotDCAOrder } from '@/services/bots/dca-spot.service';
import { shouldPlaceDCAOrder } from '@/services/bots/dca.service';
import type { DCAConfig } from '@/services/bots/types';
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
  { cron: '*/5 * * * *' },
  async ({ step, logger }) => {
    const bots = await step.run('fetch-dca-spot-bots', async () => {
      const allRunning = await getRunningBots();
      return allRunning.filter((b) => b.botType === 'DCA_SPOT');
    });

    if (bots.length === 0) return { processed: 0 };

    let processed = 0;

    for (const bot of bots) {
      const result = await step.run(`process-dca-spot-${bot.id}`, async () => {
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

        const orderId = await placeSpotDCAOrder(client, symbol, config);
        if (orderId) {
          const updatedConfig: DCAConfig = { ...config, ordersPlaced: config.ordersPlaced + 1 };
          await db
            .update(tradingBots)
            .set({ config: updatedConfig, updatedAt: new Date() })
            .where(eq(tradingBots.id, bot.id));

          if (updatedConfig.ordersPlaced >= updatedConfig.totalOrders) {
            await setBotStatus(bot.id, bot.userId, 'STOPPED');
            logger.info(`DCA Spot bot ${bot.id} completed all ${updatedConfig.totalOrders} orders`);
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
