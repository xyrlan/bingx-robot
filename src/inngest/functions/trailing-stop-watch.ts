import { inngest } from '@/inngest/client';
import {
  getRunningBots,
  getBotById,
  setBotStatus,
  getContractInfo,
  getCurrentPrice,
  getOpenPositions,
  getBingxClientByApiKeyId,
  getBingxClient,
} from '@/services/bingx.service';
import {
  placeEntryMarketOrder,
  closePosition,
  checkTrailingStop,
} from '@/services/bots/trailing-stop.service';
import type { TrailingStopConfig } from '@/services/bots/types';
import { db } from '@/db';
import { tradingBots } from '@/db/schema';
import { eq } from 'drizzle-orm';

export const trailingStopWatch = inngest.createFunction(
  {
    id: 'trailing-stop-watch',
    name: 'Trailing Stop Watch',
    retries: 3,
    concurrency: { limit: 1 },
  },
  { cron: '*/1 * * * *' },
  async ({ step, logger }) => {
    const bots = await step.run('fetch-trailing-bots', async () => {
      const allRunning = await getRunningBots();
      return allRunning.filter((b) => b.botType === 'TRAILING_STOP');
    });

    if (bots.length === 0) return { processed: 0 };

    let processed = 0;

    for (const bot of bots) {
      const result = await step.run(`process-trailing-${bot.id}`, async () => {
        const freshBot = await getBotById(bot.id, bot.userId);
        if (!freshBot || freshBot.status !== 'RUNNING') return 0;

        const config = freshBot.config as TrailingStopConfig | null;
        if (!config) return 0;

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

        // Step 1: If no entry order placed yet, place market buy
        if (!config.entryOrderId) {
          const orderId = await placeEntryMarketOrder(
            client, symbol, config.positionSizeUsdt, currentPrice, quantityPrecision
          );
          if (orderId) {
            const updatedConfig: TrailingStopConfig = {
              ...config,
              entryOrderId: orderId,
              highestPrice: currentPrice,
            };
            await db
              .update(tradingBots)
              .set({ config: updatedConfig, updatedAt: new Date() })
              .where(eq(tradingBots.id, bot.id));
            return 1;
          }
          return 0;
        }

        // Step 2: Check positions
        const positions = await getOpenPositions(client, symbol);
        const longPositions = positions.filter(
          (p) => p.positionSide.toUpperCase() === 'LONG' && p.positionAmt > 0
        );

        if (longPositions.length === 0) {
          logger.info(`Trailing stop bot ${bot.id}: no position found, stopping`);
          await setBotStatus(bot.id, bot.userId, 'STOPPED');
          return 0;
        }

        const position = longPositions[0];
        const { action, updatedHighest } = checkTrailingStop(config, currentPrice, position.entryPrice);

        if (action === 'CLOSE') {
          logger.info(`Trailing stop triggered for bot ${bot.id} at ${currentPrice} (highest: ${updatedHighest})`);
          await closePosition(client, symbol, position.positionAmt, quantityPrecision);
          await setBotStatus(bot.id, bot.userId, 'STOPPED');
          return 1;
        }

        // Update config with latest highest price and activation status
        const updatedConfig: TrailingStopConfig = {
          ...config,
          highestPrice: updatedHighest,
          isActivated: action === 'ACTIVATE' ? true : config.isActivated,
        };

        if (
          updatedConfig.highestPrice !== config.highestPrice ||
          updatedConfig.isActivated !== config.isActivated
        ) {
          await db
            .update(tradingBots)
            .set({ config: updatedConfig, updatedAt: new Date() })
            .where(eq(tradingBots.id, bot.id));
        }
        return 0;
      });

      processed += result ?? 0;
    }

    return { processed };
  }
);
