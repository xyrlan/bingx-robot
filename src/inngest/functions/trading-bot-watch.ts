import { inngest } from '@/inngest/client';
import type { BotTickEventPayload } from '@/inngest/events';
import {
  getRunningBotsByIds,
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
  placeBatchOrders,
  buildGridEntryPayload,
  updateGridLevelOrderId,
  updateGridLevelTpOrderId,
  toPrecision,
  toSafeIdString,
  recordTrade,
} from '@/services/bingx.service';
import { buildGridShortEntryPayload } from '@/services/bots/grid-short.service';

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
type MinimalOrder = { orderId: string; type?: string; side?: string; positionSide?: string; price?: number | string; stopPrice?: number | string; positionId?: string };

export const tradingBotWatch = inngest.createFunction(
  {
    id: 'trading-bot-watch',
    name: 'Trading Bot Watch',
    retries: 3,
    concurrency: {limit: 1}
  },
  { event: 'bot.tick.GRID' },
  async ({ step, logger, event }) => {
    const { botIds } = event.data as BotTickEventPayload;
    const bots = await step.run('fetch-running-bots', async () => {
      return getRunningBotsByIds(botIds);
    });

    if (bots.length === 0) {
      logger.info('No running bots to process');
      return { processed: 0 };
    }

    let processed = 0;

    for (const bot of bots) {
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
          positionSide: o.positionSide,
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

      const processResult = await step.run(`process-levels-${bot.id}`, async () => {
        const {
          symbol, levels, openOrderIds, orders, positions,
          pricePrecision, quantityPrecision, minQty, minUsdt,
          currentPrice, positionSizeUsdt, takeProfitPct, positionSide, botType,
        } = setup;
        const isShort = botType === 'GRID_SHORT';

        const client = bot.apiKeyId
          ? await getBingxClientByApiKeyId(bot.apiKeyId)
          : await getBingxClient(bot.userId);
        if (!client) return { processed: 0 };

        const openOrderIdsSet = new Set(openOrderIds);

        // === PHASE 1: Analysis (no side effects) ===
        type PendingEntry = { levelPrice: string; payload: Record<string, unknown> };
        type PendingTP = { levelPrice: string; positionId?: string; payload: Record<string, unknown> };
        const pendingEntries: PendingEntry[] = [];
        const pendingTPs: PendingTP[] = [];
        const orphanUpdates: Array<{ levelPrice: string; orderId: string }> = [];

        for (const level of levels) {
          const priceLevel = Number(level.priceLevel);

          // Check if entry order still open
          if (level.orderId && openOrderIdsSet.has(level.orderId)) {
            const order = orders.find((o) => String(o.orderId) === level.orderId);
            const expectedEntrySide = isShort ? 'SELL' : 'BUY';
            const isEntryOrder =
              order &&
              ['LIMIT', 'TRIGGER_LIMIT'].includes(String(order.type ?? '').toUpperCase()) &&
              String(order.side ?? '').toUpperCase() === expectedEntrySide;
            if (isEntryOrder) continue; // SKIP_ORDER_OPEN
          }

          // Check for positions at this level
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
            // NEEDS_TP: Check if TP exists for each position
            for (const pos of positionsAtLevel) {
              const stopPrice = isShort
                ? priceLevel * (1 - takeProfitPct)
                : priceLevel * (1 + takeProfitPct);
              const stopPriceStr = toPrecision(stopPrice, pricePrecision);
              const skipTp = isShort
                ? (currentPrice != null && stopPrice >= currentPrice)
                : (currentPrice != null && stopPrice <= currentPrice);
              if (skipTp) continue;

              const posSide = pos.positionSide.toUpperCase();
              const hasTp =
                (level.tpOrderId && openOrderIdsSet.has(level.tpOrderId)) ||
                hasTakeProfitForPosition(
                  orders,
                  symbol,
                  posSide,
                  stopPrice,
                  0.001,
                  pos.positionId
                );

              if (!hasTp) {
                const tpSide = isShort ? 'BUY' : 'SELL';
                const positionIdStr = toSafeIdString(pos.positionId);
                const tpPayload: Record<string, unknown> = {
                  symbol,
                  side: tpSide,
                  type: 'TAKE_PROFIT_MARKET',
                  positionSide: posSide,
                  stopPrice: parseFloat(stopPriceStr),
                  workingType: 'MARK_PRICE',
                };
                if (positionIdStr != null) {
                  tpPayload.positionId = positionIdStr;
                  tpPayload.closePosition = 'true';
                } else {
                  tpPayload.quantity = parseFloat(toPrecision(pos.positionAmt, 8));
                }
                pendingTPs.push({ levelPrice: String(level.priceLevel), positionId: positionIdStr ?? undefined, payload: tpPayload });
              }
            }
            continue;
          }

          // Detect completed cycle: entry filled + TP/liquidation + position gone
          if (level.orderId && !openOrderIdsSet.has(level.orderId) &&
              level.tpOrderId && !openOrderIdsSet.has(level.tpOrderId)) {
            const entryPrice = priceLevel;
            const tpPrice = isShort
              ? priceLevel * (1 - takeProfitPct)
              : priceLevel * (1 + takeProfitPct);
            const qty = positionSizeUsdt / priceLevel;

            // Determine if TP filled or if position was liquidated:
            // If current price passed the TP price, TP likely filled.
            // Otherwise, position was likely liquidated — use currentPrice as exit.
            const tpLikelyFilled = currentPrice != null && (isShort
              ? currentPrice <= tpPrice
              : currentPrice >= tpPrice);

            const exitPrice = tpLikelyFilled ? tpPrice : (currentPrice ?? entryPrice);
            const exitType = tpLikelyFilled ? 'EXIT_TP' : 'EXIT_MANUAL';
            const pnl = isShort
              ? (entryPrice - exitPrice) * qty
              : (exitPrice - entryPrice) * qty;

            await recordTrade({
              botId: bot.id, symbol, side: positionSide as 'LONG' | 'SHORT',
              type: 'ENTRY', price: entryPrice, quantity: qty, orderId: level.orderId,
            });
            await recordTrade({
              botId: bot.id, symbol, side: positionSide as 'LONG' | 'SHORT',
              type: exitType, price: exitPrice, quantity: qty, realizedPnl: pnl, orderId: level.tpOrderId,
            });
          }

          // Skip inactive levels
          if (level.isActive === false) continue;

          // Validate quantity
          if (positionSizeUsdt < minUsdt) continue;
          const quantityBtc = positionSizeUsdt / priceLevel;
          if (quantityBtc < minQty) continue;

          // Check for orphan orders matching this level price
          const expectedOrphanSide = isShort ? 'SELL' : 'BUY';
          const orphanOrder = orders.find((o) => {
            if (String(o.side ?? '').toUpperCase() !== expectedOrphanSide) return false;
            if (String(o.positionSide ?? '').toUpperCase() !== positionSide.toUpperCase()) return false;
            const orderType = String(o.type ?? '').toUpperCase();
            if (orderType !== 'LIMIT' && orderType !== 'TRIGGER_LIMIT') return false;
            const price = Number(o.price ?? 0);
            const stopPrice = Number(o.stopPrice ?? 0);
            return Math.abs(price - priceLevel) < 0.0001 || Math.abs(stopPrice - priceLevel) < 0.0001;
          });

          if (orphanOrder) {
            orphanUpdates.push({ levelPrice: String(level.priceLevel), orderId: orphanOrder.orderId });
            continue;
          }

          // NEEDS_ENTRY: Build entry payload
          const entryPayload = isShort
            ? buildGridShortEntryPayload({
                symbol, priceLevel, quantity: quantityBtc, takeProfitPct,
                pricePrecision, quantityPrecision, currentPrice,
              })
            : buildGridEntryPayload({
                symbol, priceLevel, quantity: quantityBtc, takeProfitPct,
                pricePrecision, quantityPrecision, positionSide, currentPrice,
              });

          pendingEntries.push({ levelPrice: String(level.priceLevel), payload: entryPayload });
        }

        // Process orphan adoptions (DB only, no API calls)
        for (const orphan of orphanUpdates) {
          await updateGridLevelOrderId(bot.id, orphan.levelPrice, orphan.orderId);
          await updateGridLevelTpOrderId(bot.id, orphan.levelPrice, null);
        }

        // === Short-circuit: nothing to place ===
        if (pendingEntries.length === 0 && pendingTPs.length === 0) {
          return { processed: orphanUpdates.length };
        }

        // === PHASE 2: Fresh validation + Batch execution ===
        const freshOrders = await getOpenOrders(client, symbol);
        const freshPositions = await getOpenPositions(client, symbol);
        // Filter entries: skip if an order now exists at that price
        const validEntries = pendingEntries.filter((entry) => {
          const priceLevel = Number(entry.levelPrice);
          const expectedSide = isShort ? 'SELL' : 'BUY';
          const alreadyExists = freshOrders.some((o) => {
            if (String(o.side ?? '').toUpperCase() !== expectedSide) return false;
            const orderType = String(o.type ?? '').toUpperCase();
            if (orderType !== 'LIMIT' && orderType !== 'TRIGGER_LIMIT') return false;
            const price = Number(o.price ?? 0);
            const stopPrice = Number(o.stopPrice ?? 0);
            return Math.abs(price - priceLevel) < 0.0001 || Math.abs(stopPrice - priceLevel) < 0.0001;
          });
          return !alreadyExists;
        });

        // Filter TPs: skip if position no longer exists or TP was placed
        const validTPs = pendingTPs.filter((tp) => {
          const priceLevel = Number(tp.levelPrice);
          const posSide = String(tp.payload.positionSide);
          const hasPosition = freshPositions.some((p) => {
            const side = p.positionSide.toUpperCase();
            return side === posSide && positionMatchesLevel(p.entryPrice, priceLevel);
          });
          if (!hasPosition) return false;

          const stopPrice = Number(tp.payload.stopPrice);
          const hasTp = hasTakeProfitForPosition(freshOrders, symbol, posSide, stopPrice, 0.001, tp.positionId);
          return !hasTp;
        });

        let processed = orphanUpdates.length;

        // Batch place entry orders
        if (validEntries.length > 0) {
          const entryResults = await placeBatchOrders(client, validEntries.map((e) => e.payload));
          for (let i = 0; i < entryResults.length; i++) {
            const { orderId, error } = entryResults[i];
            if (orderId) {
              await updateGridLevelOrderId(bot.id, validEntries[i].levelPrice, orderId);
              await updateGridLevelTpOrderId(bot.id, validEntries[i].levelPrice, null);
              processed++;
            } else if (error) {
              console.warn(`[BatchEntry] Level ${validEntries[i].levelPrice} failed: ${error}`);
            }
          }
        }

        // Batch place TP orders
        if (validTPs.length > 0) {
          const tpResults = await placeBatchOrders(client, validTPs.map((t) => t.payload));
          for (let i = 0; i < tpResults.length; i++) {
            const { orderId, error } = tpResults[i];
            if (orderId) {
              await updateGridLevelTpOrderId(bot.id, validTPs[i].levelPrice, orderId);
              processed++;
            } else if (error) {
              console.warn(`[BatchTP] Level ${validTPs[i].levelPrice} failed: ${error}`);
            }
          }
        }

        return { processed };
      });

      processed += processResult?.processed ?? 0;
    }

    return { processed };
  }
);
