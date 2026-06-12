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
  cancelBatchOrders,
  buildGridEntryPayload,
  updateGridLevelById,
  orderMatchesPriceLevel,
  toPrecision,
  toSafeIdString,
  recordTrade,
} from '@/services/bingx.service';
import { buildGridShortEntryPayload } from '@/services/bots/grid-short.service';
import {
  buildEntryCid,
  buildTpCid,
  entryCidBotPrefix,
  makeNonce,
  parseLevelShortId,
  shortId,
} from '@/services/bots/grid-cid';

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
type MinimalLevel = {
  id: string;
  priceLevel: string;
  orderId: string | null;
  tpOrderId: string | null;
  isActive: boolean;
  entryClientOrderId: string | null;
  tpClientOrderId: string | null;
};

/** Minimal position fields for step payload */
type MinimalPosition = { positionId?: string; entryPrice: number; positionAmt: number; positionSide: string };

/** Minimal order fields for step payload */
type MinimalOrder = {
  orderId: string;
  type?: string;
  side?: string;
  positionSide?: string;
  price?: number | string;
  stopPrice?: number | string;
  positionId?: string;
  clientOrderId?: string;
};

type PendingEntry = { levelId: string; levelPrice: string; clientOrderId: string; payload: Record<string, unknown> };
type PendingTP = { levelId: string; levelPrice: string; clientOrderId: string; positionId?: string; payload: Record<string, unknown> };
type OrphanAdoption = { levelId: string; orderId: string; clientOrderId?: string };
type CompletedCycle = {
  entryOrderId: string;
  tpOrderId: string;
  entryPrice: number;
  exitPrice: number;
  exitType: 'EXIT_TP' | 'EXIT_MANUAL';
  qty: number;
  pnl: number;
};

function isEntryTypeAndSide(order: MinimalOrder, expectedSide: string): boolean {
  const type = String(order.type ?? '').toUpperCase();
  if (type !== 'LIMIT' && type !== 'TRIGGER_LIMIT') return false;
  return String(order.side ?? '').toUpperCase() === expectedSide;
}

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
          id: l.id,
          priceLevel: String(l.priceLevel),
          orderId: l.orderId ?? null,
          tpOrderId: l.tpOrderId ?? null,
          isActive: l.isActive ?? true,
          entryClientOrderId: l.entryClientOrderId ?? null,
          tpClientOrderId: l.tpClientOrderId ?? null,
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
          clientOrderId: o.clientOrderId,
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

      // === Pure analysis — zero side effects, memoized by Inngest. The CIDs
      // generated here are stable across retries of the downstream steps; that
      // stability is what makes retried placements adoptable instead of duplicated.
      const analysis = await step.run(`analyze-${bot.id}`, async () => {
        const {
          symbol, levels, openOrderIds, orders, positions,
          pricePrecision, minQty, minUsdt,
          currentPrice, positionSizeUsdt, takeProfitPct, positionSide, botType,
        } = setup;
        const isShort = botType === 'GRID_SHORT';
        const expectedEntrySide = isShort ? 'SELL' : 'BUY';
        const openOrderIdsSet = new Set(openOrderIds);
        const nonce = makeNonce();
        const botCidPrefix = entryCidBotPrefix(bot.id);

        const pendingEntries: PendingEntry[] = [];
        const pendingTPs: PendingTP[] = [];
        const orphanAdoptions: OrphanAdoption[] = [];
        const completedCycles: CompletedCycle[] = [];

        for (const level of levels) {
          const priceLevel = Number(level.priceLevel);

          // Check if tracked entry order still open
          if (level.orderId && openOrderIdsSet.has(level.orderId)) {
            const order = orders.find((o) => String(o.orderId) === level.orderId);
            if (order && isEntryTypeAndSide(order, expectedEntrySide)) continue; // SKIP_ORDER_OPEN
          }

          // CID adoption: an open order carrying this level's entry CID is ours,
          // even if the orderId write-back failed (retry/crash) — adopt it.
          const levelCidPrefix = botCidPrefix + shortId(level.id);
          const cidOrder = orders.find(
            (o) => o.clientOrderId != null && o.clientOrderId.startsWith(levelCidPrefix)
          );
          if (cidOrder) {
            if (level.orderId !== cidOrder.orderId) {
              orphanAdoptions.push({ levelId: level.id, orderId: cidOrder.orderId, clientOrderId: cidOrder.clientOrderId });
            }
            continue;
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
            let tpIdx = 0;
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
                (level.tpClientOrderId != null &&
                  orders.some((o) => o.clientOrderId === level.tpClientOrderId)) ||
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
                const tpCid = buildTpCid(bot.id, level.id, nonce) + (tpIdx > 0 ? String(tpIdx) : '');
                tpIdx++;
                const tpPayload: Record<string, unknown> = {
                  symbol,
                  side: tpSide,
                  type: 'TAKE_PROFIT_MARKET',
                  positionSide: posSide,
                  stopPrice: parseFloat(stopPriceStr),
                  workingType: 'MARK_PRICE',
                  clientOrderID: tpCid,
                };
                if (positionIdStr != null) {
                  tpPayload.positionId = positionIdStr;
                  tpPayload.closePosition = 'true';
                } else {
                  tpPayload.quantity = parseFloat(toPrecision(pos.positionAmt, 8));
                }
                pendingTPs.push({
                  levelId: level.id,
                  levelPrice: String(level.priceLevel),
                  clientOrderId: tpCid,
                  positionId: positionIdStr ?? undefined,
                  payload: tpPayload,
                });
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
            const exitType = tpLikelyFilled ? 'EXIT_TP' as const : 'EXIT_MANUAL' as const;
            const pnl = isShort
              ? (entryPrice - exitPrice) * qty
              : (exitPrice - entryPrice) * qty;

            completedCycles.push({
              entryOrderId: level.orderId,
              tpOrderId: level.tpOrderId,
              entryPrice,
              exitPrice,
              exitType,
              qty,
              pnl,
            });
          }

          // Skip inactive levels
          if (level.isActive === false) continue;

          // Validate quantity
          if (positionSizeUsdt < minUsdt) continue;
          const quantityBtc = positionSizeUsdt / priceLevel;
          if (quantityBtc < minQty) continue;

          // Legacy orphan adoption: CID-less (or foreign) entry orders at this
          // level's tick-rounded price — orders placed before the CID rollout.
          const orphanOrder = orders.find((o) => {
            if (o.clientOrderId != null && o.clientOrderId.startsWith(botCidPrefix)) return false; // ours-by-CID handled above
            if (!isEntryTypeAndSide(o, expectedEntrySide)) return false;
            if (String(o.positionSide ?? '').toUpperCase() !== positionSide.toUpperCase()) return false;
            return orderMatchesPriceLevel(o, priceLevel, pricePrecision);
          });

          if (orphanOrder) {
            orphanAdoptions.push({ levelId: level.id, orderId: orphanOrder.orderId, clientOrderId: orphanOrder.clientOrderId });
            continue;
          }

          // NEEDS_ENTRY: Build entry payload with deterministic CID
          const clientOrderId = buildEntryCid(bot.id, level.id, nonce);
          const entryPayload = isShort
            ? buildGridShortEntryPayload({
                symbol, priceLevel, quantity: quantityBtc, takeProfitPct,
                pricePrecision, quantityPrecision: setup.quantityPrecision, currentPrice, clientOrderId,
              })
            : buildGridEntryPayload({
                symbol, priceLevel, quantity: quantityBtc, takeProfitPct,
                pricePrecision, quantityPrecision: setup.quantityPrecision, positionSide, currentPrice, clientOrderId,
              });

          pendingEntries.push({ levelId: level.id, levelPrice: String(level.priceLevel), clientOrderId, payload: entryPayload });
        }

        // === Reconciliation sweep: entry orders on the exchange that no active
        // level accounts for. Each level keeps exactly one order (tracked or
        // adopted); our-CID orders beyond that — and our-CID orders pointing at
        // levels that no longer exist (post-edit ghosts) — get cancelled.
        // CID-less orders are only swept when the level already has a keeper,
        // so manual orders at unrelated prices are never touched.
        const keeperByLevelId = new Map<string, string>();
        for (const l of levels) {
          if (l.orderId && openOrderIdsSet.has(l.orderId)) keeperByLevelId.set(l.id, l.orderId);
        }
        for (const a of orphanAdoptions) keeperByLevelId.set(a.levelId, a.orderId);

        const staleEntryOrderIds: string[] = [];
        for (const o of orders) {
          if (!isEntryTypeAndSide(o, expectedEntrySide)) continue;
          if (String(o.positionSide ?? '').toUpperCase() !== positionSide.toUpperCase()) continue;

          const cid = o.clientOrderId;
          let levelId: string | null = null;
          if (cid != null && cid.startsWith(botCidPrefix)) {
            const lvl8 = parseLevelShortId(cid, bot.id);
            levelId = levels.find((l) => shortId(l.id) === lvl8)?.id ?? null;
            if (levelId == null) {
              staleEntryOrderIds.push(o.orderId); // ghost: level deleted by an edit
              continue;
            }
          } else {
            levelId = levels.find((l) => orderMatchesPriceLevel(o, Number(l.priceLevel), pricePrecision))?.id ?? null;
            if (levelId == null) continue; // unknown order at an unrelated price — leave it alone
          }

          const keeper = keeperByLevelId.get(levelId);
          if (keeper != null && keeper !== o.orderId) staleEntryOrderIds.push(o.orderId);
        }

        return { pendingEntries, pendingTPs, orphanAdoptions, completedCycles, staleEntryOrderIds };
      });

      const { symbol, pricePrecision, positionSide } = setup;
      const isShort = setup.botType === 'GRID_SHORT';
      const expectedEntrySide = isShort ? 'SELL' : 'BUY';

      // === Record completed cycles (recordTrade dedupes on botId+orderId+type,
      // so a retry of this step cannot double-count P&L).
      await step.run(`record-trades-${bot.id}`, async () => {
        for (const cycle of analysis.completedCycles) {
          await recordTrade({
            botId: bot.id, symbol, side: positionSide as 'LONG' | 'SHORT',
            type: 'ENTRY', price: cycle.entryPrice, quantity: cycle.qty, orderId: cycle.entryOrderId,
          });
          await recordTrade({
            botId: bot.id, symbol, side: positionSide as 'LONG' | 'SHORT',
            type: cycle.exitType, price: cycle.exitPrice, quantity: cycle.qty,
            realizedPnl: cycle.pnl, orderId: cycle.tpOrderId,
          });
        }
        return { recorded: analysis.completedCycles.length };
      });

      // === Reconcile: adopt orphans into levels, cancel stale/duplicate entries.
      const reconcileResult = await step.run(`reconcile-${bot.id}`, async () => {
        if (analysis.orphanAdoptions.length === 0 && analysis.staleEntryOrderIds.length === 0) {
          return { adopted: 0, cancelled: 0 };
        }

        for (const adoption of analysis.orphanAdoptions) {
          await updateGridLevelById(adoption.levelId, {
            orderId: adoption.orderId,
            entryClientOrderId: adoption.clientOrderId ?? null,
            tpOrderId: null,
          });
        }

        if (analysis.staleEntryOrderIds.length > 0) {
          const client = bot.apiKeyId
            ? await getBingxClientByApiKeyId(bot.apiKeyId)
            : await getBingxClient(bot.userId);
          if (client) {
            try {
              await cancelBatchOrders(client, symbol, analysis.staleEntryOrderIds);
            } catch (err) {
              // Orders may have filled/been cancelled since the snapshot — fine.
              logger.warn(`[Reconcile] cancel stale entries for bot ${bot.id}:`, err);
            }
          }
        }

        return { adopted: analysis.orphanAdoptions.length, cancelled: analysis.staleEntryOrderIds.length };
      });

      // === Place entries. Re-checks bot status and the exchange before placing:
      // a retry of this step finds the CIDs from the previous attempt on the
      // exchange and adopts them instead of re-placing.
      const entryResult = await step.run(`place-entries-${bot.id}`, async () => {
        if (analysis.pendingEntries.length === 0) return { placed: 0 };

        const freshBot = await getBotById(bot.id, bot.userId);
        if (!freshBot || freshBot.status !== 'RUNNING') return { placed: 0 };

        const client = bot.apiKeyId
          ? await getBingxClientByApiKeyId(bot.apiKeyId)
          : await getBingxClient(bot.userId);
        if (!client) return { placed: 0 };

        const freshOrders = await getOpenOrders(client, symbol);
        let placed = 0;

        const toPlace: PendingEntry[] = [];
        for (const entry of analysis.pendingEntries) {
          const own = freshOrders.find((o) => o.clientOrderId === entry.clientOrderId);
          if (own) {
            // Previous attempt placed it — adopt.
            await updateGridLevelById(entry.levelId, {
              orderId: own.orderId, entryClientOrderId: entry.clientOrderId, tpOrderId: null,
            });
            placed++;
            continue;
          }
          const levelCidPrefix = entryCidBotPrefix(bot.id) + shortId(entry.levelId);
          const covered = freshOrders.some((o) =>
            (o.clientOrderId != null && o.clientOrderId.startsWith(levelCidPrefix)) ||
            (isEntryTypeAndSide(o, expectedEntrySide) &&
              orderMatchesPriceLevel(o, Number(entry.levelPrice), pricePrecision))
          );
          if (covered) continue; // an order already works this level
          toPlace.push(entry);
        }

        if (toPlace.length === 0) return { placed };

        const results = await placeBatchOrders(client, toPlace.map((e) => e.payload));
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const entry =
            (result.clientOrderId
              ? toPlace.find((e) => e.clientOrderId === result.clientOrderId)
              : toPlace[i]) ?? toPlace[i];
          if (result.orderId) {
            const affected = await updateGridLevelById(entry.levelId, {
              orderId: result.orderId, entryClientOrderId: entry.clientOrderId, tpOrderId: null,
            });
            if (affected === 0) {
              // Level vanished mid-tick (concurrent edit) — cancel instead of orphaning.
              logger.warn(`[BatchEntry] Level ${entry.levelPrice} gone, cancelling order ${result.orderId}`);
              try {
                await cancelBatchOrders(client, symbol, [result.orderId]);
              } catch (err) {
                logger.warn(`[BatchEntry] Failed to cancel orphan ${result.orderId}:`, err);
              }
            } else {
              placed++;
            }
          } else if (result.error) {
            logger.warn(`[BatchEntry] Level ${entry.levelPrice} failed: ${result.error}`);
          }
        }

        return { placed };
      });

      // === Place TPs — same adopt-before-place pattern.
      const tpResult = await step.run(`place-tps-${bot.id}`, async () => {
        if (analysis.pendingTPs.length === 0) return { placed: 0 };

        const client = bot.apiKeyId
          ? await getBingxClientByApiKeyId(bot.apiKeyId)
          : await getBingxClient(bot.userId);
        if (!client) return { placed: 0 };

        const freshOrders = await getOpenOrders(client, symbol);
        const freshPositions = await getOpenPositions(client, symbol);
        let placed = 0;

        const toPlace: PendingTP[] = [];
        for (const tp of analysis.pendingTPs) {
          const own = freshOrders.find((o) => o.clientOrderId === tp.clientOrderId);
          if (own) {
            await updateGridLevelById(tp.levelId, { tpOrderId: own.orderId, tpClientOrderId: tp.clientOrderId });
            placed++;
            continue;
          }

          const posSide = String(tp.payload.positionSide);
          const hasPosition = freshPositions.some((p) => {
            const side = p.positionSide.toUpperCase();
            return side === posSide && positionMatchesLevel(p.entryPrice, Number(tp.levelPrice));
          });
          if (!hasPosition) continue;

          const stopPrice = Number(tp.payload.stopPrice);
          if (hasTakeProfitForPosition(freshOrders, symbol, posSide, stopPrice, 0.001, tp.positionId)) continue;

          toPlace.push(tp);
        }

        if (toPlace.length === 0) return { placed };

        const results = await placeBatchOrders(client, toPlace.map((t) => t.payload));
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const tp =
            (result.clientOrderId
              ? toPlace.find((t) => t.clientOrderId === result.clientOrderId)
              : toPlace[i]) ?? toPlace[i];
          if (result.orderId) {
            const affected = await updateGridLevelById(tp.levelId, {
              tpOrderId: result.orderId, tpClientOrderId: tp.clientOrderId,
            });
            if (affected === 0) {
              logger.warn(`[BatchTP] Level ${tp.levelPrice} gone, cancelling TP ${result.orderId}`);
              try {
                await cancelBatchOrders(client, symbol, [result.orderId]);
              } catch (err) {
                logger.warn(`[BatchTP] Failed to cancel orphan TP ${result.orderId}:`, err);
              }
            } else {
              placed++;
            }
          } else if (result.error) {
            logger.warn(`[BatchTP] Level ${tp.levelPrice} failed: ${result.error}`);
          }
        }

        return { placed };
      });

      processed += reconcileResult.adopted + entryResult.placed + tpResult.placed;
    }

    return { processed };
  }
);
