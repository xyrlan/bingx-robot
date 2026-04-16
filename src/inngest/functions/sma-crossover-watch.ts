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
  calculateATR,
  calculateADX,
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

            // Fetch enough klines for all indicators: SMA(trend), ADX(period*2), ATR(period)
            const klineLimit = Math.max(
              config.trendPeriod,
              config.adxPeriod * 2,
              config.atrPeriod
            ) + 15; // +15 buffer for in-progress candle exclusion + smoothing
            const klines = await getKlines(
              client,
              symbol,
              config.timeframe,
              klineLimit
            );

            if (klines.length < config.trendPeriod + 1) {
              logger.info(`SMA bot ${bot.id}: not enough klines for ${symbol} (${klines.length}/${config.trendPeriod + 1})`);
              updatedStates[symbol] = state;
              continue;
            }

            // Use closed candles only (exclude last — it's in-progress)
            const closedKlines = klines.slice(0, -1);
            const closes = closedKlines.map((k) => k.close);

            // Calculate ATR and ADX from closed candles
            const atr = calculateATR(closedKlines, config.atrPeriod);
            const adx = calculateADX(closedKlines, config.adxPeriod);

            if (!atr) {
              logger.info(`SMA bot ${bot.id}: not enough data for ATR calculation on ${symbol}`);
              updatedStates[symbol] = state;
              continue;
            }

            const contractInfo = await getContractInfo(client, symbol);
            const pricePrecision = contractInfo?.pricePrecision ?? 2;
            const quantityPrecision = contractInfo?.quantityPrecision ?? 4;

            const currentPrice = await getCurrentPrice(client, symbol);
            if (!currentPrice) {
              updatedStates[symbol] = state;
              continue;
            }

            // Detect signal (crossover + trend confirmation)
            const { crossover, signal } = detectSignal({
              closes,
              fastPeriod: config.fastPeriod,
              mediumPeriod: config.mediumPeriod,
              trendPeriod: config.trendPeriod,
            });

            // --- CASE: Trend-confirmed signal, no position → open new (if ADX allows) ---
            if (signal && !state.position) {
              if (adx != null && adx < config.adxThreshold) {
                logger.info(`SMA bot ${bot.id}: ${signal} signal for ${symbol} BLOCKED by ADX (${adx.toFixed(1)} < ${config.adxThreshold})`);
                updatedStates[symbol] = { ...state, lastAtr: atr };
                continue;
              }
              logger.info(`SMA bot ${bot.id}: ${signal} signal for ${symbol} at ${currentPrice} (ADX: ${adx?.toFixed(1) ?? 'N/A'})`);

              await ensureMarginTypeAndLeverage(client, symbol, config.marginType, config.leverage);
              await new Promise((r) => setTimeout(r, 400));

              const orderId = await placeEntryOrder(
                client, symbol, signal, config.positionSizeUsdt, currentPrice, quantityPrecision
              );

              if (orderId) {
                await new Promise((r) => setTimeout(r, 400));
                const quantity = config.positionSizeUsdt / currentPrice;
                const stopDistance = config.initialStopAtrMult * atr;
                const initialStop = signal === 'LONG'
                  ? currentPrice - stopDistance
                  : currentPrice + stopDistance;

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
                  lastAtr: atr,
                };
                botProcessed++;
              } else {
                updatedStates[symbol] = { ...state, lastAtr: atr };
              }
              continue;
            }

            // --- CASE: Crossover opposite to current position → close (+ reverse if trend confirms) ---
            const isOppositeCrossover = crossover && state.position &&
              ((state.position === 'LONG' && crossover === 'SHORT') ||
               (state.position === 'SHORT' && crossover === 'LONG'));

            if (isOppositeCrossover) {
              logger.info(`SMA bot ${bot.id}: opposite crossover ${state.position} → ${crossover} for ${symbol} (trend confirms: ${signal != null})`);

              // Cancel existing stop
              if (state.stopOrderId) {
                await cancelStopOrder(client, symbol, state.stopOrderId);
                await new Promise((r) => setTimeout(r, 400));
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
                await new Promise((r) => setTimeout(r, 400));
              }

              // Open reverse ONLY if trend confirms AND ADX allows
              const adxAllowsReverse = adx == null || adx >= config.adxThreshold;
              if (signal && adxAllowsReverse) {
                await ensureMarginTypeAndLeverage(client, symbol, config.marginType, config.leverage);
                await new Promise((r) => setTimeout(r, 400));

                const orderId = await placeEntryOrder(
                  client, symbol, signal, config.positionSizeUsdt, currentPrice, quantityPrecision
                );

                if (orderId) {
                  await new Promise((r) => setTimeout(r, 400));
                  const quantity = config.positionSizeUsdt / currentPrice;
                  const stopDistance = config.initialStopAtrMult * atr;
                  const initialStop = signal === 'LONG'
                    ? currentPrice - stopDistance
                    : currentPrice + stopDistance;

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
                    lastAtr: atr,
                  };
                } else {
                  updatedStates[symbol] = createEmptySymbolState();
                }
              } else {
                // Closed but trend doesn't confirm reverse — just reset
                logger.info(`SMA bot ${bot.id}: closed ${state.position} for ${symbol}, no reverse (trend doesn't confirm)`);
                updatedStates[symbol] = createEmptySymbolState();
              }
              botProcessed++;
              continue;
            }

            // --- CASE: In position, no crossover → manage trailing stop ---
            if (state.position && state.entryPrice) {
              const trailingAtr = atr ?? state.lastAtr ?? 0;
              const trailing = checkSMATrailingStop(state, currentPrice, config, trailingAtr);

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
                  await new Promise((r) => setTimeout(r, 400));
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
                  lastAtr: atr,
                };
              } else {
                updatedStates[symbol] = {
                  ...state,
                  highestPrice: trailing.updatedHighest,
                  lowestPrice: trailing.updatedLowest,
                  lastAtr: atr,
                };
              }
              continue;
            }

            // No signal, no position — nothing to do
            updatedStates[symbol] = { ...state, lastAtr: atr };
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
