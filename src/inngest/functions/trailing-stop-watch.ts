import { inngest } from '@/inngest/client';
import {
  getRunningAiBots,
  getBotById,
  setBotStatus,
  getContractInfo,
  getCurrentPrice,
  getOpenPositions,
  recordTrade,
} from '@/services/bingx.service';
import { groupBotsBySymbolAndKey, getClientForBot } from '@/inngest/helpers';
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
      return getRunningAiBots('TRAILING_STOP');
    });

    if (bots.length === 0) return { processed: 0 };

    const groups = groupBotsBySymbolAndKey(bots);

    let processed = 0;

    for (const [groupKey, groupBots] of groups) {
      const result = await step.run(`process-trailing-group-${groupKey}`, async () => {
        let groupProcessed = 0;

        const firstBot = groupBots[0];
        const client = await getClientForBot(firstBot);
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
              const qty = config.positionSizeUsdt / currentPrice;
              await recordTrade({
                botId: bot.id, symbol, side: 'LONG', type: 'ENTRY',
                price: currentPrice, quantity: qty, orderId,
              });
              const updatedConfig: TrailingStopConfig = {
                ...config,
                entryOrderId: orderId,
                highestPrice: currentPrice,
                entryPrice: currentPrice,
              };
              await db
                .update(tradingBots)
                .set({ config: updatedConfig, updatedAt: new Date() })
                .where(eq(tradingBots.id, bot.id));
              groupProcessed++;
            }
            continue;
          }

          // Step 2: Check positions - retry if not found immediately after entry
          let longPositions = allPositions.filter(
            (p) => p.positionSide.toUpperCase() === 'LONG' && p.positionAmt > 0
          );

          // If no position found, re-fetch after a short delay (exchange may still be settling)
          if (longPositions.length === 0) {
            await new Promise((r) => setTimeout(r, 2000));
            const retryPositions = await getOpenPositions(client, symbol);
            longPositions = retryPositions.filter(
              (p) => p.positionSide.toUpperCase() === 'LONG' && p.positionAmt > 0
            );
          }

          if (longPositions.length === 0) {
            logger.info(`Trailing stop bot ${bot.id}: no position found after retry (liquidated/manually closed), stopping`);
            // Record exit at current price — position was closed outside bot control
            if (config.entryOrderId) {
              const entryEstimate = config.entryPrice || currentPrice;
              const qty = config.positionSizeUsdt / entryEstimate;
              const pnl = (currentPrice - entryEstimate) * qty;
              await recordTrade({
                botId: bot.id, symbol, side: 'LONG', type: 'EXIT_MANUAL',
                price: currentPrice, quantity: qty, realizedPnl: pnl,
              });
            }
            await setBotStatus(bot.id, bot.userId, 'STOPPED');
            continue;
          }

          const position = longPositions[0];
          const { action, updatedHighest } = checkTrailingStop(config, currentPrice, position.entryPrice);

          if (action === 'CLOSE') {
            logger.info(`Trailing stop triggered for bot ${bot.id} at ${currentPrice} (highest: ${updatedHighest})`);
            const closeOrderId = await closePosition(client, symbol, position.positionAmt, quantityPrecision);
            const pnl = (currentPrice - position.entryPrice) * position.positionAmt;
            await recordTrade({
              botId: bot.id, symbol, side: 'LONG', type: 'EXIT_TRAILING',
              price: currentPrice, quantity: position.positionAmt, realizedPnl: pnl,
              orderId: closeOrderId,
            });
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
