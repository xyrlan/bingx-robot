import { inngest } from '@/inngest/client';
import {
  getRunningBots,
  getBotById,
  getBingxClient,
  getBingxClientByApiKeyId,
  setBotStatus,
  getGridLevelsByBotId,
  createGridLevels,
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
import { placeGridShortEntryOrder, placeShortTakeProfitOrder } from '@/services/bots/grid-short.service';

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

/** Minimal level fields for step payload (reduces Fast Origin Transfer) */
type MinimalLevel = { priceLevel: string; orderId: string | null; tpOrderId: string | null; isActive: boolean };

/** Minimal position fields for step payload */
type MinimalPosition = { positionId?: string; entryPrice: number; positionAmt: number; positionSide: string };

/** Minimal order fields for step payload */
type MinimalOrder = { orderId: string; type?: string; side?: string; price?: number | string; stopPrice?: number | string; positionId?: string };

export const tradingBotWatch = inngest.createFunction(
  {
    id: 'trading-bot-watch',
    name: 'Trading Bot Watch',
    retries: 3,
    concurrency: {limit: 1}
  },
  { cron: '*/3 * * * *' },
  async ({ step, logger }) => {
    const bots = await step.run('fetch-running-bots', async () => {
      return getRunningBots();
    });

    if (bots.length === 0) {
      logger.info('No running bots to process');
      return { processed: 0 };
    }

    // Only process grid bots (skip DCA, TRAILING_STOP, etc.)
    const gridBots = bots.filter(b => !b.botType || b.botType === 'GRID_LONG' || b.botType === 'GRID_SHORT');

    let processed = 0;

    for (const bot of gridBots) {
      const setup = await step.run(`setup-bot-${bot.id}`, async () => {
        const freshBot = await getBotById(bot.id, bot.userId);
        if (!freshBot || freshBot.status !== 'RUNNING') {
          return { ok: false as const };
        }

        const client = bot.apiKeyId
          ? await getBingxClientByApiKeyId(bot.apiKeyId)
          : await getBingxClient(bot.userId);
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

        const botType = freshBot.botType ?? 'GRID_LONG';
        const positionSide = botType === 'GRID_SHORT' ? 'SHORT' : 'LONG';

        if (levels.length === 0) {
          levels = await createGridLevels(
            bot.id,
            String(bot.priceMin),
            String(bot.priceMax),
            bot.gridCount,
            { positionSide }
          );
        }

        const contractInfo = await getContractInfo(client, symbol);
        const pricePrecision = contractInfo?.pricePrecision ?? 4;
        const quantityPrecision = contractInfo?.quantityPrecision ?? 4;
        const minQty = contractInfo?.tradeMinQuantity ?? 0.0001;
        const minUsdt = contractInfo?.tradeMinUSDT ?? 0;

        const currentPrice = await getCurrentPrice(client, symbol);
        const positions = await getOpenPositions(client, symbol);
        const orders = await getOpenOrders(client, symbol);
        const openOrderIds = new Set(orders.map((o) => String(o.orderId)));

        // Minimal payload to reduce Fast Origin Transfer (CDN to Compute)
        const levelsMin: MinimalLevel[] = levels.map((l) => ({
          priceLevel: String(l.priceLevel),
          orderId: l.orderId ?? null,
          tpOrderId: l.tpOrderId ?? null,
          isActive: l.isActive ?? true,
        }));
        const positionsMin: MinimalPosition[] = positions.map((p) => ({
          positionId: p.positionId,
          entryPrice: p.entryPrice,
          positionAmt: p.positionAmt,
          positionSide: p.positionSide,
        }));
        const ordersMin: MinimalOrder[] = orders.map((o) => ({
          orderId: o.orderId,
          type: o.type,
          side: o.side,
          price: o.price,
          stopPrice: o.stopPrice,
          positionId: o.positionId,
        }));

        return {
          ok: true as const,
          symbol,
          levels: levelsMin,
          openOrderIds: Array.from(openOrderIds),
          positions: positionsMin,
          orders: ordersMin,
          pricePrecision,
          quantityPrecision,
          minQty,
          minUsdt,
          currentPrice,
          positionSizeUsdt: Number(bot.positionSizeUsdt),
          takeProfitPct: Number(bot.takeProfitPercentage) / 100,
          positionSide,
          botType,
        };
      });

      if (!setup.ok) continue;

      // Single step per bot: process all levels (reduces round-trips / Fast Origin Transfer)
      const processResult = await step.run(`process-levels-${bot.id}`, async () => {
        const {
          symbol,
          levels,
          openOrderIds,
          orders,
          positions,
          pricePrecision,
          quantityPrecision,
          minQty,
          minUsdt,
          currentPrice,
          positionSizeUsdt,
          takeProfitPct,
          positionSide,
          botType,
        } = setup;
        const isShort = botType === 'GRID_SHORT';

        const client = bot.apiKeyId
          ? await getBingxClientByApiKeyId(bot.apiKeyId)
          : await getBingxClient(bot.userId);
        if (!client) return { processed: 0 };

        const openOrderIdsSet = new Set(openOrderIds);
        let botProcessed = 0;

        for (const level of levels) {
          const priceLevel = Number(level.priceLevel);
          let orderStillOpen = false;
          if (level.orderId && openOrderIdsSet.has(level.orderId)) {
            const order = orders.find((o) => String(o.orderId) === level.orderId);
            const expectedEntrySide = isShort ? 'SELL' : 'BUY';
            const isEntryOrder =
              order &&
              ['LIMIT', 'TRIGGER_LIMIT'].includes(String(order.type ?? '').toUpperCase()) &&
              String(order.side ?? '').toUpperCase() === expectedEntrySide;
            orderStillOpen = !!isEntryOrder;
          }

          if (orderStillOpen) continue;

          const positionsAtLevel = positions.filter((p) => {
            const side = p.positionSide.toUpperCase();
            const isMatchingSide = isShort
              ? (side === 'SHORT')
              : (side === 'LONG' || side === 'BOTH');
            return (
              isMatchingSide &&
              positionMatchesLevel(p.entryPrice, priceLevel) &&
              isClosestLevelForPosition(p.entryPrice, priceLevel, levels)
            );
          });

          if (positionsAtLevel.length > 0) {
            const freshPositions = await getOpenPositions(client, symbol);
            const freshPositionsAtLevel = freshPositions.filter((p) => {
              const side = p.positionSide.toUpperCase();
              const isMatchingSide = isShort
                ? (side === 'SHORT')
                : (side === 'LONG' || side === 'BOTH');
              return (
                isMatchingSide &&
                positionMatchesLevel(p.entryPrice, priceLevel) &&
                isClosestLevelForPosition(p.entryPrice, priceLevel, levels)
              );
            });

            if (freshPositionsAtLevel.length === 0) {
              // Position closed (TP triggered) - fall through to place-entry
            } else {
              const freshOrders = await getOpenOrders(client, symbol);
              const freshOpenOrderIds = new Set(freshOrders.map((o) => String(o.orderId)));
              const positionsWithTpCheck = new Set<string | number>();

              for (const positionAtLevel of freshPositionsAtLevel) {
                if (!isClosestLevelForPosition(positionAtLevel.entryPrice, priceLevel, levels)) continue;
                const posKey = positionAtLevel.positionId ?? `${positionAtLevel.entryPrice}-${positionAtLevel.positionAmt}`;
                if (positionsWithTpCheck.has(posKey)) continue;
                positionsWithTpCheck.add(posKey);

                const stopPrice = isShort
                  ? priceLevel * (1 - takeProfitPct)
                  : priceLevel * (1 + takeProfitPct);
                const stopPriceStr = toPrecision(stopPrice, pricePrecision);
                const posSide = positionAtLevel.positionSide.toUpperCase();
                const skipTp = isShort
                  ? (currentPrice != null && stopPrice >= currentPrice)
                  : (currentPrice != null && stopPrice <= currentPrice);
                if (skipTp) continue;

                const hasTp =
                  (level.tpOrderId && freshOpenOrderIds.has(level.tpOrderId)) ||
                  hasTakeProfitForPosition(
                    freshOrders,
                    symbol,
                    posSide,
                    stopPrice,
                    0.001,
                    positionAtLevel.positionId
                  );

                if (!hasTp) {
                  const tpOrderId = isShort
                    ? await placeShortTakeProfitOrder(
                        client,
                        symbol,
                        positionAtLevel.positionAmt,
                        parseFloat(stopPriceStr),
                        pricePrecision,
                        positionAtLevel.positionId
                      )
                    : await placeTakeProfitOrder(
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
                    botProcessed++;
                  }
                }
              }
              continue;
            }
          }

          if (level.isActive === false) continue;

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

          const freshOrders = await getOpenOrders(client, symbol);
          const freshIds = new Set(freshOrders.map((o) => String(o.orderId)));
          if (level.orderId && freshIds.has(level.orderId)) {
            const order = freshOrders.find((o) => String(o.orderId) === level.orderId);
            const expectedEntrySide2 = isShort ? 'SELL' : 'BUY';
            const isEntryOrder =
              order &&
              ['LIMIT', 'TRIGGER_LIMIT'].includes(String(order.type ?? '').toUpperCase()) &&
              String(order.side ?? '').toUpperCase() === expectedEntrySide2;
            if (isEntryOrder) continue;
          }

          const expectedOrphanSide = isShort ? 'SELL' : 'BUY';
          const orphanOrder = freshOrders.find((o) => {
            if (String(o.side ?? '').toUpperCase() !== expectedOrphanSide) return false;
            if (String(o.positionSide ?? '').toUpperCase() !== positionSide.toUpperCase()) return false;
            const orderType = String(o.type ?? '').toUpperCase();
            if (orderType !== 'LIMIT' && orderType !== 'TRIGGER_LIMIT') return false;
            const price = Number(o.price ?? 0);
            const stopPrice = Number(o.stopPrice ?? 0);
            const priceMatch = Math.abs(price - priceLevel) < 0.0001;
            const stopPriceMatch = Math.abs(stopPrice - priceLevel) < 0.0001;
            return priceMatch || stopPriceMatch;
          });
          if (orphanOrder) {
            await updateGridLevelOrderId(bot.id, String(level.priceLevel), orphanOrder.orderId);
            await updateGridLevelTpOrderId(bot.id, String(level.priceLevel), null);
            continue;
          }

          const newOrderId = isShort
            ? await placeGridShortEntryOrder({
                client,
                symbol,
                priceLevel,
                quantity: quantityBtc,
                takeProfitPct,
                pricePrecision,
                quantityPrecision,
                currentPrice,
              })
            : await placeGridEntryOrder({
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
            botProcessed++;
          }
        }

        return { processed: botProcessed };
      });

      processed += processResult?.processed ?? 0;
    }

    return { processed };
  }
);
