import { inngest } from '@/inngest/client';
import {
  getRunningBots,
  getBingxClient,
  setBotStatus,
  getGridLevelsByBotId,
  createGridLevels,
  ensureMarginTypeAndLeverage,
  getContractInfo,
  getCurrentPrice,
  getOpenPositions,
  getOpenOrders,
  hasTakeProfitForPosition,
  placeTakeProfitOrder,
  placeGridEntryOrder,
  updateGridLevelOrderId,
  updateGridLevelTpOrderId,
  toPrecision,
} from '@/services/bingx.service';

const POSITION_ENTRY_TOLERANCE_PCT = 0.005;

function positionMatchesLevel(entryPrice: number, priceLevel: number): boolean {
  const diff = Math.abs(entryPrice - priceLevel) / priceLevel;
  return diff <= POSITION_ENTRY_TOLERANCE_PCT;
}

function isClosestLevelForPosition(
  entryPrice: number,
  priceLevel: number,
  levels: { priceLevel: string }[]
): boolean {
  const distToCurrent = Math.abs(entryPrice - priceLevel);
  for (const l of levels) {
    const other = Number(l.priceLevel);
    const distToOther = Math.abs(entryPrice - other);
    if (distToOther < distToCurrent) return false;
    if (distToOther === distToCurrent && other < priceLevel) return false;
  }
  return true;
}

function sanitizeLevelId(priceLevel: string): string {
  return String(priceLevel).replace(/\./g, '_');
}

export const tradingBotWatch = inngest.createFunction(
  {
    id: 'trading-bot-watch',
    name: 'Trading Bot Watch',
    retries: 3,
    concurrency: {limit: 1}
  },
  { cron: '*/1 * * * *' },
  async ({ step, logger }) => {
    const bots = await step.run('fetch-running-bots', async () => {
      return getRunningBots();
    });

    if (bots.length === 0) {
      logger.info('No running bots to process');
      return { processed: 0 };
    }

    let processed = 0;

    for (const bot of bots) {
      const setup = await step.run(`setup-bot-${bot.id}`, async () => {
        const client = await getBingxClient(bot.userId);
        if (!client) {
          logger.warn(`No BingX keys for user ${bot.userId}, stopping bot ${bot.id}`);
          await setBotStatus(bot.id, bot.userId, 'STOPPED');
          return { ok: false as const };
        }

        try {
          await client.get('/openApi/swap/v2/user/balance');
        } catch (err) {
          logger.error(`Balance check failed for bot ${bot.id}:`, err);
          throw err;
        }

        let levels = await getGridLevelsByBotId(bot.id);
        const symbol = String(bot.symbol ?? '').trim().toUpperCase() || bot.symbol;

        if (levels.length === 0) {
          levels = await createGridLevels(
            bot.id,
            String(bot.priceMin),
            String(bot.priceMax),
            bot.gridCount
          );
        }

        await ensureMarginTypeAndLeverage(
          client,
          symbol,
          bot.marginType,
          bot.leverage
        );

        const contractInfo = await getContractInfo(client, symbol);
        const pricePrecision = contractInfo?.pricePrecision ?? 4;
        const quantityPrecision = contractInfo?.quantityPrecision ?? 4;
        const minQty = contractInfo?.tradeMinQuantity ?? 0.0001;
        const minUsdt = contractInfo?.tradeMinUSDT ?? 0;

        const currentPrice = await getCurrentPrice(client, symbol);
        const positions = await getOpenPositions(client, symbol);
        const orders = await getOpenOrders(client, symbol);
        const openOrderIds = new Set(orders.map((o) => String(o.orderId)));

        return {
          ok: true as const,
          symbol,
          levels,
          openOrderIds: Array.from(openOrderIds),
          positions,
          orders,
          pricePrecision,
          quantityPrecision,
          minQty,
          minUsdt,
          currentPrice,
          positionSizeUsdt: Number(bot.positionSizeUsdt),
          takeProfitPct: Number(bot.takeProfitPercentage) / 100,
          positionSide: 'LONG',
        };
      });

      if (!setup.ok) continue;

      const {
        symbol,
        levels,
        openOrderIds,
        positions,
        orders,
        pricePrecision,
        quantityPrecision,
        minQty,
        minUsdt,
        currentPrice,
        positionSizeUsdt,
        takeProfitPct,
        positionSide,
      } = setup;

      const openOrderIdsSet = new Set(openOrderIds);

      for (const level of levels) {
        const priceLevel = Number(level.priceLevel);
        const orderStillOpen = level.orderId && openOrderIdsSet.has(level.orderId);

        if (orderStillOpen) continue;

        const positionsAtLevel = positions.filter((p) => {
          const side = p.positionSide.toUpperCase();
          const isLong = side === 'LONG' || side === 'BOTH';
          return isLong && positionMatchesLevel(p.entryPrice, priceLevel);
        });

        if (positionsAtLevel.length > 0) {
          const levelId = sanitizeLevelId(String(level.priceLevel));
          const fallbackResult = await step.run(
            `fallback-tp-${bot.id}-${levelId}`,
            async () => {
              const client = await getBingxClient(bot.userId);
              if (!client) return { placed: 0 };

              const positionsWithTpCheck = new Set<string | number>();
              let placed = 0;

              for (const positionAtLevel of positionsAtLevel) {
                if (!isClosestLevelForPosition(positionAtLevel.entryPrice, priceLevel, levels)) continue;
                const posKey = positionAtLevel.positionId ?? `${positionAtLevel.entryPrice}-${positionAtLevel.positionAmt}`;
                if (positionsWithTpCheck.has(posKey)) continue;
                positionsWithTpCheck.add(posKey);

                const stopPrice = priceLevel * (1 + takeProfitPct);
                const stopPriceStr = toPrecision(stopPrice, pricePrecision);
                const posSide = positionAtLevel.positionSide.toUpperCase();
                if (currentPrice != null && stopPrice <= currentPrice) continue;

                const hasTp =
                  (level.tpOrderId && openOrderIdsSet.has(level.tpOrderId)) ||
                  hasTakeProfitForPosition(
                    orders,
                    symbol,
                    posSide,
                    stopPrice,
                    0.001,
                    positionAtLevel.positionId
                  );

                if (!hasTp) {
                  const tpOrderId = await placeTakeProfitOrder(
                    client,
                    symbol,
                    posSide,
                    positionAtLevel.positionAmt,
                    parseFloat(stopPriceStr),
                    pricePrecision,
                    positionAtLevel.positionId
                  );
                  if (tpOrderId) {
                    await updateGridLevelTpOrderId(bot.id, String(level.priceLevel), tpOrderId);
                    placed++;
                  }
                }
              }
              return { placed };
            }
          );

          if (fallbackResult?.placed) processed += fallbackResult.placed;
          continue;
        }

        if (positionSizeUsdt < minUsdt) {
          logger.warn(`USDT ${positionSizeUsdt} below min ${minUsdt} for ${symbol}, skipping level ${priceLevel}`);
          continue;
        }

        const quantityBtc = positionSizeUsdt / priceLevel;
        if (quantityBtc < minQty) {
          logger.warn(
            `Quantity ${quantityBtc} below min ${minQty} for ${symbol} at ${priceLevel} (need ~${Math.ceil(minQty * priceLevel)} USDT)`
          );
          continue;
        }

        const levelId = sanitizeLevelId(String(level.priceLevel));
        const orderResult = await step.run(
          `place-entry-${bot.id}-${levelId}`,
          async () => {
            const client = await getBingxClient(bot.userId);
            if (!client) throw new Error(`No BingX client for bot ${bot.id}`);

            const freshOrders = await getOpenOrders(client, symbol);
            const freshIds = new Set(freshOrders.map((o) => String(o.orderId)));
            if (level.orderId && freshIds.has(level.orderId)) {
              return { orderId: level.orderId, skipped: true };
            }

            const orphanOrder = freshOrders.find(
              (o) =>
                String(o.side ?? '').toUpperCase() === 'BUY' &&
                String(o.positionSide ?? '').toUpperCase() === positionSide.toUpperCase() &&
                Math.abs(Number(o.price ?? 0) - priceLevel) < 0.0001
            );
            if (orphanOrder) {
              const orderIdRecuperado = orphanOrder.orderId;
              await updateGridLevelOrderId(bot.id, String(level.priceLevel), orderIdRecuperado);
              await updateGridLevelTpOrderId(bot.id, String(level.priceLevel), null);
              return { orderId: orderIdRecuperado, skipped: true };
            }

            const newOrderId = await placeGridEntryOrder({
              client,
              symbol,
              priceLevel,
              quantity: quantityBtc,
              takeProfitPct,
              pricePrecision,
              quantityPrecision,
              positionSide,
              currentPrice,
            });

            if (newOrderId) {
              await updateGridLevelOrderId(bot.id, String(level.priceLevel), String(newOrderId));
              await updateGridLevelTpOrderId(bot.id, String(level.priceLevel), null);
              return { orderId: newOrderId, skipped: false };
            }
            return { orderId: null, skipped: false };
          }
        );

        if (orderResult?.orderId && orderResult.skipped === false) {
          processed++;
          logger.info(`Placed entry order ${orderResult.orderId} at ${priceLevel} for bot ${bot.id}`);
        }
      }
    }

    return { processed };
  }
);
