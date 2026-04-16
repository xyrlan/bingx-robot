import { inngest } from '@/inngest/client';
import {
  getRunningBots,
  getBotById,
  getContractInfo,
  getCurrentPrice,
  getOpenPositions,
  getKlines,
  ensureMarginTypeAndLeverage,
} from '@/services/bingx.service';
import { getClientForBot } from '@/inngest/helpers';
import {
  detectSignal,
  checkSMATrailingStop,
  placeEntryOrder,
  placeStopOrder,
  closePositionMarket,
  cancelStopOrder,
  createEmptySymbolState,
} from '@/services/bots/sma-crossover.service';
import type { SMAConfig } from '@/services/bots/types';
import { db } from '@/db';
import { tradingBots } from '@/db/schema';
import { eq } from 'drizzle-orm';

const TIMEFRAME_HOURS: Record<string, number> = {
  '1h': 1,
  '4h': 4,
  '1d': 24,
};

function shouldProcessCandle(timeframe: string): boolean {
  const hours = TIMEFRAME_HOURS[timeframe];
  if (!hours) return false;
  const now = new Date();
  const currentHour = now.getUTCHours();
  // For daily, only process at 00:xx UTC
  // For 4h, process at 0, 4, 8, 12, 16, 20
  // For 1h, process every hour
  return currentHour % hours === 0;
}

export const smaCrossoverWatch = inngest.createFunction(
  {
    id: 'sma-crossover-watch',
    name: 'SMA Crossover Watch',
    retries: 3,
    concurrency: { limit: 1 },
  },
  { cron: '2 * * * *' },
  async ({ step, logger }) => {
    const bots = await step.run('fetch-sma-bots', async () => {
      const allRunning = await getRunningBots();
      return allRunning.filter((b) => b.botType === 'SMA_CROSSOVER');
    });

    if (bots.length === 0) return { processed: 0 };

    let processed = 0;

    for (const bot of bots) {
      const result = await step.run(`process-sma-bot-${bot.id}`, async () => {
        const freshBot = await getBotById(bot.id, bot.userId);
        if (!freshBot || freshBot.status !== 'RUNNING') return 0;

        const config = freshBot.config as SMAConfig | null;
        if (!config || !config.symbols || config.symbols.length === 0) return 0;

        // Check if a candle just closed for this timeframe
        if (!shouldProcessCandle(config.timeframe)) {
          logger.info(`SMA bot ${bot.id}: skipping, no candle close for ${config.timeframe}`);
          return 0;
        }

        const client = await getClientForBot(bot);
        if (!client) {
          logger.error(`SMA bot ${bot.id}: no BingX client`);
          return 0;
        }

        let botProcessed = 0;
        const updatedStates = { ...config.symbolStates };

        for (const symbol of config.symbols) {
          try {
            const state = updatedStates[symbol] ?? createEmptySymbolState();

            // Fetch klines — need trendPeriod + 1 candles minimum
            const klines = await getKlines(
              client,
              symbol,
              config.timeframe,
              config.trendPeriod + 10 // extra buffer
            );

            if (klines.length < config.trendPeriod + 1) {
              logger.info(`SMA bot ${bot.id}: not enough klines for ${symbol} (${klines.length}/${config.trendPeriod + 1})`);
              updatedStates[symbol] = state;
              continue;
            }

            // Extract close prices from closed candles (exclude last if it's in-progress)
            const closes = klines.map((k) => k.close);

            const contractInfo = await getContractInfo(client, symbol);
            const pricePrecision = contractInfo?.pricePrecision ?? 2;
            const quantityPrecision = contractInfo?.quantityPrecision ?? 4;

            const currentPrice = await getCurrentPrice(client, symbol);
            if (!currentPrice) {
              updatedStates[symbol] = state;
              continue;
            }

            // Detect signal
            const signal = detectSignal({
              closes,
              fastPeriod: config.fastPeriod,
              mediumPeriod: config.mediumPeriod,
              trendPeriod: config.trendPeriod,
            });

            // --- CASE: Signal detected, no position ---
            if (signal && !state.position) {
              logger.info(`SMA bot ${bot.id}: ${signal} signal for ${symbol} at ${currentPrice}`);

              await ensureMarginTypeAndLeverage(client, symbol, config.marginType, config.leverage);

              const orderId = await placeEntryOrder(
                client, symbol, signal, config.positionSizeUsdt, currentPrice, quantityPrecision
              );

              if (orderId) {
                const quantity = config.positionSizeUsdt / currentPrice;
                const initialStop = signal === 'LONG'
                  ? currentPrice * (1 - config.initialStopPct / 100)
                  : currentPrice * (1 + config.initialStopPct / 100);

                const stopOrderId = await placeStopOrder(
                  client, symbol, signal, initialStop, quantity, pricePrecision
                );

                updatedStates[symbol] = {
                  position: signal,
                  entryPrice: currentPrice,
                  entryOrderId: orderId,
                  stopOrderId,
                  highestPrice: signal === 'LONG' ? currentPrice : null,
                  lowestPrice: signal === 'SHORT' ? currentPrice : null,
                  trailingActivated: false,
                  lastSignal: signal,
                  lastSignalAt: Date.now(),
                };
                botProcessed++;
              } else {
                updatedStates[symbol] = state;
              }
              continue;
            }

            // --- CASE: Opposite signal, has position → close and maybe reverse ---
            if (signal && state.position && signal !== state.position) {
              logger.info(`SMA bot ${bot.id}: reverse signal ${state.position} → ${signal} for ${symbol}`);

              // Cancel existing stop
              if (state.stopOrderId) {
                await cancelStopOrder(client, symbol, state.stopOrderId);
              }

              // Close current position
              const positions = await getOpenPositions(client, symbol);
              const currentPos = positions.find(
                (p) => p.positionSide.toUpperCase() === state.position && p.positionAmt > 0
              );

              if (currentPos) {
                await closePositionMarket(
                  client, symbol, state.position!, currentPos.positionAmt, quantityPrecision
                );
              }

              // Open reverse if trend confirms
              await ensureMarginTypeAndLeverage(client, symbol, config.marginType, config.leverage);

              const orderId = await placeEntryOrder(
                client, symbol, signal, config.positionSizeUsdt, currentPrice, quantityPrecision
              );

              if (orderId) {
                const quantity = config.positionSizeUsdt / currentPrice;
                const initialStop = signal === 'LONG'
                  ? currentPrice * (1 - config.initialStopPct / 100)
                  : currentPrice * (1 + config.initialStopPct / 100);

                const stopOrderId = await placeStopOrder(
                  client, symbol, signal, initialStop, quantity, pricePrecision
                );

                updatedStates[symbol] = {
                  position: signal,
                  entryPrice: currentPrice,
                  entryOrderId: orderId,
                  stopOrderId,
                  highestPrice: signal === 'LONG' ? currentPrice : null,
                  lowestPrice: signal === 'SHORT' ? currentPrice : null,
                  trailingActivated: false,
                  lastSignal: signal,
                  lastSignalAt: Date.now(),
                };
              } else {
                // Closed but couldn't reverse — reset state
                updatedStates[symbol] = createEmptySymbolState();
              }
              botProcessed++;
              continue;
            }

            // --- CASE: Same-direction crossover while no position (already closed by trailing) ---
            // No action needed, signal already in effect

            // --- CASE: In position, no new signal → manage trailing stop ---
            if (state.position && state.entryPrice) {
              const trailing = checkSMATrailingStop(state, currentPrice, config);

              if (trailing.action === 'CLOSE') {
                logger.info(`SMA bot ${bot.id}: trailing stop hit for ${symbol} at ${currentPrice}`);

                if (state.stopOrderId) {
                  await cancelStopOrder(client, symbol, state.stopOrderId);
                }

                const positions = await getOpenPositions(client, symbol);
                const currentPos = positions.find(
                  (p) => p.positionSide.toUpperCase() === state.position && p.positionAmt > 0
                );

                if (currentPos) {
                  await closePositionMarket(
                    client, symbol, state.position, currentPos.positionAmt, quantityPrecision
                  );
                }

                updatedStates[symbol] = {
                  ...createEmptySymbolState(),
                  lastSignal: state.lastSignal,
                  lastSignalAt: state.lastSignalAt,
                };
                botProcessed++;
                continue;
              }

              // Update trailing stop if price moved
              const needsStopUpdate =
                trailing.updatedHighest !== state.highestPrice ||
                trailing.updatedLowest !== state.lowestPrice ||
                trailing.action === 'ACTIVATE';

              if (needsStopUpdate && trailing.newStopPrice) {
                // Cancel old stop and place updated one
                if (state.stopOrderId) {
                  await cancelStopOrder(client, symbol, state.stopOrderId);
                }

                const positions = await getOpenPositions(client, symbol);
                const currentPos = positions.find(
                  (p) => p.positionSide.toUpperCase() === state.position && p.positionAmt > 0
                );

                const quantity = currentPos?.positionAmt ?? config.positionSizeUsdt / currentPrice;

                const newStopOrderId = await placeStopOrder(
                  client, symbol, state.position, trailing.newStopPrice, quantity, pricePrecision
                );

                updatedStates[symbol] = {
                  ...state,
                  stopOrderId: newStopOrderId,
                  highestPrice: trailing.updatedHighest,
                  lowestPrice: trailing.updatedLowest,
                  trailingActivated: trailing.action === 'ACTIVATE' ? true : state.trailingActivated,
                };
              } else {
                updatedStates[symbol] = {
                  ...state,
                  highestPrice: trailing.updatedHighest,
                  lowestPrice: trailing.updatedLowest,
                };
              }
              continue;
            }

            // No signal, no position — nothing to do
            updatedStates[symbol] = state;
          } catch (err) {
            logger.error(`SMA bot ${bot.id}: error processing ${symbol}: ${err}`);
            updatedStates[symbol] = updatedStates[symbol] ?? createEmptySymbolState();
          }

          // Rate limit between symbols
          await new Promise((r) => setTimeout(r, 400));
        }

        // Save updated config
        const updatedConfig: SMAConfig = {
          ...config,
          symbolStates: updatedStates,
        };

        await db
          .update(tradingBots)
          .set({ config: updatedConfig, updatedAt: new Date() })
          .where(eq(tradingBots.id, bot.id));

        return botProcessed;
      });

      processed += result ?? 0;
    }

    return { processed };
  }
);
