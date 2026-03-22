# Batch Orders Refactoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce BingX API calls ~80% via batch order placement, enabling all cron jobs to run on Vercel serverless and eliminating the Railway Connect worker.

**Architecture:** Refactor the grid bot's per-level sequential processing into a two-phase "collect & batch" pattern: Phase 1 analyzes all levels without side effects, Phase 2 sends orders in batches of 5 via `POST /openApi/swap/v2/trade/batchOrders`. Other bots get symbol-grouping to deduplicate shared queries. Finally, remove Railway worker artifacts.

**Tech Stack:** Next.js 16, Inngest, BingX REST API, Drizzle ORM, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-22-batch-orders-refactoring-design.md`

**Testing strategy:** No test framework exists in this project. Verification is done via Inngest dev server + BingX VST (simulated trading) environment. Each task includes manual verification steps.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/services/bingx.service.ts` | Modify | Add `placeBatchOrders()`, extract `buildGridEntryPayload()` |
| `src/services/bots/grid-short.service.ts` | Modify | Extract `buildGridShortEntryPayload()` |
| `src/inngest/functions/trading-bot-watch.ts` | Rewrite | Collect & batch pattern |
| `src/inngest/functions/dca-bot-watch.ts` | Modify | Symbol grouping for shared queries |
| `src/inngest/functions/trailing-stop-watch.ts` | Modify | Symbol grouping for shared queries |
| `src/inngest/functions/dca-spot-bot-watch.ts` | Modify | Minimal — symbol grouping if multiple bots |
| `src/app/api/inngest/route.ts` | Modify | Remove `INNGEST_USE_CONNECT` conditional |
| `src/worker.ts` | Keep (stop deploying) | Rollback safety net |
| `package.json` | Modify | Remove worker scripts |

---

### Task 1: Add `placeBatchOrders()` to bingx.service.ts

**Files:**
- Modify: `src/services/bingx.service.ts` (add after `cancelBatchOrders` at line ~658)

- [ ] **Step 1: Add the `placeBatchOrders` function**

Add after the `cancelBatchOrders` function (line 658):

```typescript
/**
 * Place multiple orders via BingX batchOrders API (up to 5 per request).
 * Splits into chunks if orders.length > 5.
 * Unlike cancelBatchOrders (DELETE, batch size 10, omitRecvWindow),
 * this uses POST with useQueryParams=true and batch size 5.
 */
export async function placeBatchOrders(
  client: BingxClient,
  orders: Record<string, unknown>[]
): Promise<Array<{ orderId: string | null; error?: string }>> {
  const BATCH_SIZE = 5;
  if (orders.length === 0) return [];

  const results: Array<{ orderId: string | null; error?: string }> = [];

  for (let i = 0; i < orders.length; i += BATCH_SIZE) {
    if (i > 0) await new Promise((r) => setTimeout(r, 400)); // Rate limit between chunks
    const chunk = orders.slice(i, i + BATCH_SIZE);
    const batchOrdersParam = JSON.stringify(chunk);

    try {
      const response = (await client.post(
        '/openApi/swap/v2/trade/batchOrders',
        { batchOrders: batchOrdersParam },
        true
      )) as {
        orders?: Array<{ orderId?: string | number; order?: { orderId?: string | number } }>;
        errors?: Array<{ msg?: string; code?: number }>;
      };

      const successOrders = response?.orders ?? [];
      const errorOrders = response?.errors ?? [];

      for (const order of successOrders) {
        const raw = order?.orderId ?? order?.order?.orderId;
        results.push({ orderId: raw != null ? toSafeIdString(raw) ?? null : null });
      }

      for (const err of errorOrders) {
        results.push({ orderId: null, error: err?.msg ?? `Error code ${err?.code}` });
      }
    } catch (err) {
      // Entire chunk failed — mark all as failed
      for (let j = 0; j < chunk.length; j++) {
        results.push({ orderId: null, error: String(err) });
      }
    }
  }

  return results;
}
```

- [ ] **Step 2: Verify build compiles**

Run: `npm run build`
Expected: Build succeeds (function is added but not yet called)

- [ ] **Step 3: Commit**

```bash
git add src/services/bingx.service.ts
git commit -m "feat: add placeBatchOrders() for batch order placement (max 5 per request)"
```

---

### Task 2: Extract payload builders from grid entry functions

The current `placeGridEntryOrder` and `placeGridShortEntryOrder` both build an order payload AND call the API. We need to separate payload building from API calling so the batch can reuse the payloads.

**Files:**
- Modify: `src/services/bingx.service.ts:525-582` (extract `buildGridEntryPayload`)
- Modify: `src/services/bots/grid-short.service.ts:15-67` (extract `buildGridShortEntryPayload`)

- [ ] **Step 1: Extract `buildGridEntryPayload` in bingx.service.ts**

Add a new exported function before `placeGridEntryOrder` (before line 525). Then refactor `placeGridEntryOrder` to use it:

```typescript
/** Build the order payload for a LONG grid entry — no API call. */
export function buildGridEntryPayload(params: Omit<PlaceGridEntryOrderParams, 'client'>): Record<string, unknown> {
  const { symbol, priceLevel, quantity, takeProfitPct, pricePrecision, quantityPrecision, positionSide, currentPrice } = params;

  const priceStr = toPrecision(priceLevel, pricePrecision);
  const quantityStr = toQuantityPrecision(quantity, quantityPrecision);
  const useTriggerLimit = currentPrice != null && priceLevel > currentPrice;
  const orderType = useTriggerLimit ? 'TRIGGER_LIMIT' : 'LIMIT';

  const orderPayload: Record<string, unknown> = {
    symbol,
    side: 'BUY',
    type: orderType,
    quantity: parseFloat(quantityStr),
    price: parseFloat(priceStr),
    positionSide: positionSide.toUpperCase(),
    timeInForce: 'GTC',
    workingType: 'MARK_PRICE',
  };

  if (useTriggerLimit) {
    orderPayload.stopPrice = parseFloat(priceStr);
  }

  const tpStopPrice = priceLevel * (1 + takeProfitPct);
  const tpStopPriceStr = toPrecision(tpStopPrice, pricePrecision);
  const tpPrice = parseFloat(tpStopPriceStr);
  if (tpPrice > 0) {
    orderPayload.takeProfit = JSON.stringify({
      type: 'TAKE_PROFIT_MARKET',
      stopPrice: tpPrice,
      price: tpPrice,
      workingType: 'MARK_PRICE',
    });
  }

  return orderPayload;
}
```

Then simplify `placeGridEntryOrder` to:

```typescript
export async function placeGridEntryOrder(params: PlaceGridEntryOrderParams): Promise<string | null> {
  const { client, ...rest } = params;
  const orderPayload = buildGridEntryPayload(rest);

  try {
    const result = (await client.post('/openApi/swap/v2/trade/order', orderPayload, true)) as {
      orderId?: string | number;
      order?: { orderId?: string | number };
    };
    const raw = result?.orderId ?? result?.order?.orderId;
    return raw != null ? (toSafeIdString(raw) ?? null) : null;
  } catch (err) {
    throw err;
  }
}
```

- [ ] **Step 2: Extract `buildGridShortEntryPayload` in grid-short.service.ts**

Add a new exported function before `placeGridShortEntryOrder`. Then refactor:

```typescript
import { toPrecision, toQuantityPrecision, toSafeIdString } from '@/services/bingx.service';

/** Build the order payload for a SHORT grid entry — no API call. */
export function buildGridShortEntryPayload(params: Omit<PlaceGridShortEntryParams, 'client'>): Record<string, unknown> {
  const { symbol, priceLevel, quantity, takeProfitPct, pricePrecision, quantityPrecision, currentPrice } = params;

  const priceStr = toPrecision(priceLevel, pricePrecision);
  const quantityStr = toQuantityPrecision(quantity, quantityPrecision);
  const useTriggerLimit = currentPrice != null && priceLevel < currentPrice;
  const orderType = useTriggerLimit ? 'TRIGGER_LIMIT' : 'LIMIT';

  const orderPayload: Record<string, unknown> = {
    symbol,
    side: 'SELL',
    type: orderType,
    quantity: parseFloat(quantityStr),
    price: parseFloat(priceStr),
    positionSide: 'SHORT',
    timeInForce: 'GTC',
    workingType: 'MARK_PRICE',
  };

  if (useTriggerLimit) {
    orderPayload.stopPrice = parseFloat(priceStr);
  }

  const tpStopPrice = priceLevel * (1 - takeProfitPct);
  const tpStopPriceStr = toPrecision(tpStopPrice, pricePrecision);
  const tpPrice = parseFloat(tpStopPriceStr);
  if (tpPrice > 0) {
    orderPayload.takeProfit = JSON.stringify({
      type: 'TAKE_PROFIT_MARKET',
      stopPrice: tpPrice,
      price: tpPrice,
      workingType: 'MARK_PRICE',
    });
  }

  return orderPayload;
}
```

Then simplify `placeGridShortEntryOrder` to:

```typescript
export async function placeGridShortEntryOrder(params: PlaceGridShortEntryParams): Promise<string | null> {
  const { client, ...rest } = params;
  const orderPayload = buildGridShortEntryPayload(rest);

  try {
    const result = (await client.post('/openApi/swap/v2/trade/order', orderPayload, true)) as {
      orderId?: string | number;
      order?: { orderId?: string | number };
    };
    const raw = result?.orderId ?? result?.order?.orderId;
    return raw != null ? (toSafeIdString(raw) ?? null) : null;
  } catch (err) {
    throw err;
  }
}
```

- [ ] **Step 3: Verify build compiles**

Run: `npm run build`
Expected: Build succeeds. Existing individual placement still works (no behavioral change).

- [ ] **Step 4: Commit**

```bash
git add src/services/bingx.service.ts src/services/bots/grid-short.service.ts
git commit -m "refactor: extract payload builders from grid entry functions for batch reuse"
```

---

### Task 3: Refactor `trading-bot-watch.ts` to Collect & Batch

This is the main task. Rewrite the `process-levels` step to use the two-phase pattern.

**Files:**
- Rewrite: `src/inngest/functions/trading-bot-watch.ts:171-377` (the `process-levels-${bot.id}` step)

- [ ] **Step 1: Add new imports**

At the top of the file, add:

```typescript
import { buildGridEntryPayload, placeBatchOrders, toPrecision } from '@/services/bingx.service';
import { buildGridShortEntryPayload } from '@/services/bots/grid-short.service';
```

Remove the now-unused imports: `placeGridEntryOrder`, `placeTakeProfitOrder` from bingx.service, and `placeGridShortEntryOrder`, `placeShortTakeProfitOrder` from grid-short.service.

- [ ] **Step 2: Add `positionSide` to `MinimalOrder` type and mapping**

The rewritten code accesses `o.positionSide` in orphan detection. The existing `MinimalOrder` type (line 52) and `ordersMin` mapping (lines 140-147) don't include it. Update both:

In the `MinimalOrder` type (line 52):
```typescript
// Before:
type MinimalOrder = { orderId: string; type?: string; side?: string; price?: number | string; stopPrice?: number | string; positionId?: string };

// After:
type MinimalOrder = { orderId: string; type?: string; side?: string; positionSide?: string; price?: number | string; stopPrice?: number | string; positionId?: string };
```

In the `ordersMin` mapping (lines 140-147), add `positionSide`:
```typescript
const ordersMin: MinimalOrder[] = orders.map((o) => ({
  orderId: o.orderId,
  type: o.type,
  side: o.side,
  positionSide: o.positionSide,
  price: o.price,
  stopPrice: o.stopPrice,
  positionId: o.positionId,
}));
```

- [ ] **Step 3: Rewrite the `process-levels` step**

Replace the entire `process-levels-${bot.id}` step (lines 171-377) with the collect & batch pattern:

```typescript
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
        if (!isClosestLevelForPosition(pos.entryPrice, priceLevel, levels)) continue;

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
  const freshOrderIds = new Set(freshOrders.map((o) => String(o.orderId)));

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
```

- [ ] **Step 4: Clean up imports**

Remove unused imports at the top of the file. The final import block should be:

```typescript
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
  placeBatchOrders,
  buildGridEntryPayload,
  updateGridLevelOrderId,
  updateGridLevelTpOrderId,
  toPrecision,
  toSafeIdString,
} from '@/services/bingx.service';
import { buildGridShortEntryPayload } from '@/services/bots/grid-short.service';
```

- [ ] **Step 5: Verify build compiles**

Run: `npm run build`
Expected: Build succeeds with no type errors.

- [ ] **Step 6: Verify with Inngest dev server**

Run: `npm run dev` (terminal 1) and `npm run inngest` (terminal 2).
Open Inngest dashboard at `http://localhost:8288`.
Trigger a manual run of `trading-bot-watch` or wait for the cron.
Verify in Inngest UI that the function completes successfully and logs show batch operations.

- [ ] **Step 7: Commit**

```bash
git add src/inngest/functions/trading-bot-watch.ts
git commit -m "feat: refactor trading-bot-watch to collect & batch pattern

Replaces per-level sequential API calls with two-phase approach:
- Phase 1: analyze all levels, collect pending orders (no API calls)
- Phase 2: single fresh validation + batch placement (max 5 per request)

Reduces API calls from ~30-65 to ~7-9 per bot per cycle."
```

---

### Task 4: Optimize `dca-bot-watch.ts` with symbol grouping

**Files:**
- Modify: `src/inngest/functions/dca-bot-watch.ts`

- [ ] **Step 1: Refactor to group bots by (symbol, apiKeyId)**

Replace the entire function body (lines 25-79) with:

```typescript
async ({ step, logger }) => {
  const bots = await step.run('fetch-dca-bots', async () => {
    const allRunning = await getRunningBots();
    return allRunning.filter((b) => b.botType === 'DCA');
  });

  if (bots.length === 0) return { processed: 0 };

  // Group bots by (symbol, apiKeyId) to share getContractInfo/getCurrentPrice
  const groups = new Map<string, typeof bots>();
  for (const bot of bots) {
    const key = `${String(bot.symbol).trim().toUpperCase()}:${bot.apiKeyId ?? bot.userId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(bot);
  }

  let processed = 0;

  for (const [groupKey, groupBots] of groups) {
    const result = await step.run(`process-dca-group-${groupKey}`, async () => {
      let groupProcessed = 0;

      // Get a client from the first bot in the group
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

      for (const bot of groupBots) {
        const freshBot = await getBotById(bot.id, bot.userId);
        if (!freshBot || freshBot.status !== 'RUNNING') continue;

        const config = freshBot.config as DCAConfig | null;
        if (!config) continue;
        if (!shouldPlaceDCAOrder(config, freshBot.createdAt)) continue;

        const orderId = await placeDCAOrder(client, symbol, config, currentPrice, quantityPrecision);
        if (orderId) {
          const updatedConfig: DCAConfig = { ...config, ordersPlaced: config.ordersPlaced + 1 };
          await db
            .update(tradingBots)
            .set({ config: updatedConfig, updatedAt: new Date() })
            .where(eq(tradingBots.id, bot.id));

          if (updatedConfig.ordersPlaced >= updatedConfig.totalOrders) {
            await setBotStatus(bot.id, bot.userId, 'STOPPED');
            logger.info(`DCA bot ${bot.id} completed all ${updatedConfig.totalOrders} orders`);
          }
          groupProcessed++;
        }
      }

      return groupProcessed;
    });

    processed += result ?? 0;
  }

  return { processed };
}
```

- [ ] **Step 2: Verify build compiles**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/inngest/functions/dca-bot-watch.ts
git commit -m "feat: optimize dca-bot-watch with symbol grouping

Group DCA bots by (symbol, apiKeyId) to share getContractInfo and
getCurrentPrice calls. Reduces API calls from N*4 to N+2 per group."
```

---

### Task 5: Optimize `trailing-stop-watch.ts` with symbol grouping

**Files:**
- Modify: `src/inngest/functions/trailing-stop-watch.ts`

- [ ] **Step 1: Refactor to group bots by (symbol, apiKeyId)**

Replace the function body (lines 30-127) with:

```typescript
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
```

- [ ] **Step 2: Verify build compiles**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/inngest/functions/trailing-stop-watch.ts
git commit -m "feat: optimize trailing-stop-watch with symbol grouping

Group trailing stop bots by (symbol, apiKeyId) to share getContractInfo,
getCurrentPrice, and getOpenPositions calls."
```

---

### Task 6: Optimize `dca-spot-bot-watch.ts` with symbol grouping

**Files:**
- Modify: `src/inngest/functions/dca-spot-bot-watch.ts`

- [ ] **Step 1: Refactor to group by (symbol, apiKeyId)**

This bot is already lightweight (~1 API call per bot). Apply the same grouping pattern for consistency and to share the client creation:

```typescript
async ({ step, logger }) => {
  const bots = await step.run('fetch-dca-spot-bots', async () => {
    const allRunning = await getRunningBots();
    return allRunning.filter((b) => b.botType === 'DCA_SPOT');
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
    const result = await step.run(`process-dca-spot-group-${groupKey}`, async () => {
      let groupProcessed = 0;

      const firstBot = groupBots[0];
      const client = firstBot.apiKeyId
        ? await getBingxClientByApiKeyId(firstBot.apiKeyId)
        : await getBingxClient(firstBot.userId);
      if (!client) return 0;

      const symbol = String(firstBot.symbol).trim().toUpperCase();

      for (const bot of groupBots) {
        const freshBot = await getBotById(bot.id, bot.userId);
        if (!freshBot || freshBot.status !== 'RUNNING') continue;

        const config = freshBot.config as DCAConfig | null;
        if (!config) continue;
        if (!shouldPlaceDCAOrder(config, freshBot.createdAt)) continue;

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
          groupProcessed++;
        }
      }

      return groupProcessed;
    });

    processed += result ?? 0;
  }

  return { processed };
}
```

- [ ] **Step 2: Verify build compiles**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/inngest/functions/dca-spot-bot-watch.ts
git commit -m "feat: optimize dca-spot-bot-watch with symbol grouping"
```

---

### Task 7: Remove Railway worker artifacts

**Files:**
- Modify: `src/app/api/inngest/route.ts:13`
- Modify: `package.json:12-13` (scripts)
- Keep: `src/worker.ts` (rollback safety net — stop deploying, don't delete)

- [ ] **Step 1: Simplify inngest route**

In `src/app/api/inngest/route.ts`, replace line 13:

```typescript
// Before:
const functions = process.env.INNGEST_USE_CONNECT === '1' ? [] : [tradingBotWatch, dcaBotWatch, trailingStopWatch, dcaSpotBotWatch];

// After:
const functions = [tradingBotWatch, dcaBotWatch, trailingStopWatch, dcaSpotBotWatch];
```

Also remove the JSDoc comment block above (lines 8-12) since it references the Connect worker setup that's no longer needed.

- [ ] **Step 2: Remove worker scripts from package.json**

Remove these two lines from the `scripts` section:

```json
"worker": "tsx src/worker.ts",
"worker:dev": "tsx watch src/worker.ts",
```

- [ ] **Step 3: Verify build compiles**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/inngest/route.ts package.json
git commit -m "chore: remove Railway worker artifacts

- Simplify inngest route to always register all functions
- Remove worker/worker:dev scripts from package.json
- worker.ts kept in repo as rollback safety net"
```

---

### Task 8: End-to-end validation on VST

This task validates the entire refactoring before deploying to production.

- [ ] **Step 1: Verify all functions compile and register**

Run: `npm run build`
Expected: Clean build, no errors.

- [ ] **Step 2: Start local dev environment**

Run: `npm run dev` (terminal 1) and `npm run inngest` (terminal 2).
Open Inngest dashboard at `http://localhost:8288`.
Verify all 4 functions appear: `trading-bot-watch`, `dca-bot-watch`, `trailing-stop-watch`, `dca-spot-bot-watch`.

- [ ] **Step 3: Test batch order placement on VST**

If a VST environment is configured (BingX simulated trading):
1. Create a test grid bot with 5-10 levels
2. Start the bot
3. Wait for the cron to fire (or trigger manually in Inngest dashboard)
4. Verify in Inngest logs:
   - Phase 1 analysis completes (check for "pendingEntries" and "pendingTPs" counts)
   - Phase 2 batch calls succeed
   - Grid levels updated with orderIds in the database

- [ ] **Step 4: Verify no regressions in other bots**

If DCA or trailing-stop bots are running:
1. Check they still fire on schedule
2. Check logs for successful order placement
3. Verify bot configs update correctly in database

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: batch orders refactoring complete — ready for production validation"
```

---

## Deployment Checklist (post-validation)

After confirming the refactoring works on dev/VST:

1. Deploy to Vercel (standard Next.js deploy)
2. Remove `INNGEST_USE_CONNECT=1` from Vercel environment variables
3. Redeploy to pick up the env var change
4. Monitor Inngest dashboard for the first few cron cycles
5. Confirm all 4 functions execute within Vercel timeout
6. Stop the Railway service (don't delete — keep as rollback)
7. After 1-2 weeks of stable operation, optionally delete `src/worker.ts` and the Railway service
