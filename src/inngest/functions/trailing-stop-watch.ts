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
  { cron: '*/3 * * * *' },
  async ({ step, logger }) => {
    const bots = await step.run('fetch-trailing-bots', async () => {
      const allRunning = await getRunningBots();
      return allRunning.filter((b) => b.botType === 'TRAILING_STOP');
    });

    if (bots.length === 0) return { processed: 0 };

    const groups = new Map<string, typeof bots>();
    for (const bot of bots) {
      const key = `${String(bot.symbol).trim().toUpperCase()}:${bot.apiKeyId ?? bot.userId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(bot);
    }

    let processed = 0;

    for (const [groupKey, groupBots] of groups) {
      const result = await step.run(`process-trailing-group-${groupKey}`, async () => {
        let groupProcessed = 0;

        const firstBot = groupBots[0];
        const client = firstBot.apiKeyId
          ? await getBingxClientByApiKeyId(firstBot.apiKeyId)
          : await getBingxClient(firstBot.userId);
        if (!client) return 0;

        const symbol = String(firstBot.symbol).trim().toUpperCase();
        const contractInfo = await getContractInfo(client, symbol);
        const quantityPrecision = contractInfo?.quantityPrecision ?? 4;
        const currentPrice = await getCurrentPrice(client, symbol);
        if (!currentPrice) return 0;

        // Fetch positions once for the group
        const allPositions = await getOpenPositions(client, symbol);

        for (const bot of groupBots) {
          const freshBot = await getBotById(bot.id, bot.userId);
          if (!freshBot || freshBot.status !== 'RUNNING') continue;

          const config = freshBot.config as TrailingStopConfig | null;
          if (!config) continue;

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
              groupProcessed++;
            }
            continue;
          }

          // Step 2: Check positions (from pre-fetched data)
          const longPositions = allPositions.filter(
            (p) => p.positionSide.toUpperCase() === 'LONG' && p.positionAmt > 0
          );

          if (longPositions.length === 0) {
            logger.info(`Trailing stop bot ${bot.id}: no position found, stopping`);
            await setBotStatus(bot.id, bot.userId, 'STOPPED');
            continue;
          }

          const position = longPositions[0];
          const { action, updatedHighest } = checkTrailingStop(config, currentPrice, position.entryPrice);

          if (action === 'CLOSE') {
            logger.info(`Trailing stop triggered for bot ${bot.id} at ${currentPrice} (highest: ${updatedHighest})`);
            await closePosition(client, symbol, position.positionAmt, quantityPrecision);
            await setBotStatus(bot.id, bot.userId, 'STOPPED');
            groupProcessed++;
            continue;
          }

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
        }

        return groupProcessed;
      });

      processed += result ?? 0;
    }

    return { processed };
  }
);
