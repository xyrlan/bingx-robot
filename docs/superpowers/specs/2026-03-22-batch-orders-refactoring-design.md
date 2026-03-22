# Batch Orders Refactoring — Eliminate Railway Worker

**Date:** 2026-03-22
**Status:** Draft
**Goal:** Reduce BingX API calls via batch order placement, making all cron jobs fast enough to run on Vercel serverless (eliminating the Railway Connect worker).

---

## Problem

The `trading-bot-watch` cron job makes 30-60+ individual API calls per cycle for a bot with 20 grid levels (worst case: all levels need fresh checks + placement). This exceeds Vercel's serverless execution limits, requiring a long-running Railway worker (~$5-10/month) to host the Inngest Connect process.

### Root causes

1. **Redundant queries:** `getOpenOrders()` and `getOpenPositions()` are called per-level inside the processing loop (lines 226, 242, 316 of `trading-bot-watch.ts`), even though the same data was already fetched in the `setup` step.
2. **Individual order placement:** Each entry order and take-profit order is placed via a separate `POST /openApi/swap/v2/trade/order` call with no batching.

### Current call count per bot (20 levels, worst case)

| Call | Count | Purpose |
|------|-------|---------|
| `getOpenPositions()` | ~5-20 | Fresh check per level with position (line 226) |
| `getOpenOrders()` | ~10-20 | Fresh check per level (lines 242, 316) |
| `placeGridEntryOrder()` | ~10 | Individual entry placement |
| `placeTakeProfitOrder()` | ~5 | Individual TP placement |
| **Total** | **~30-65** | |

> Note: Actual count depends on how many levels have positions vs need entries. Typical case with 5 filled positions and 10 needing entries: ~35 calls.

---

## Solution: Collect & Batch

Refactor the `trading-bot-watch` processing loop into two phases, and apply similar optimizations to the other bot watch functions.

### Phase 1 — Analysis (no side effects)

Iterate all grid levels using the data already fetched in the `setup` step (`positions`, `orders`, `openOrderIds`). Classify each level:

| Category | Condition | Action |
|----------|-----------|--------|
| `SKIP_ORDER_OPEN` | Entry order still in `openOrderIds` | Skip |
| `NEEDS_TP` | Position exists at level, no TP order | Collect TP payload |
| `NEEDS_ENTRY` | No position, no open order, level active | Collect entry payload |
| `SKIP_INACTIVE` | `level.isActive === false` | Skip |
| `ADOPT_ORPHAN` | Orphan order matches level price | DB update only |

Output: `pendingEntries[]` and `pendingTPs[]` arrays with order payloads ready to send.

**Short-circuit:** If both arrays are empty after Phase 1 (e.g., all levels have open orders already), skip Phase 2 entirely — no fresh validation needed.

### Phase 2 — Fresh validation + Batch execution

1. **Single fresh validation:** Call `getOpenOrders()` and `getOpenPositions()` **once** to confirm pending orders are still needed (guards against race conditions from the ~seconds between setup and execution).
2. **Filter:** Remove any pending entry where an order now exists, or any pending TP where a TP was placed externally. Duplicate rejections by the exchange (order already exists) are expected "failures" and should be logged at `info` level, not `error`.
3. **Batch send:** Submit orders via `POST /openApi/swap/v2/trade/batchOrders` in chunks of 5 (API maximum).
4. **Process results:** Map each returned `orderId` back to its grid level and update the DB.

### Target call count per bot (20 levels)

| Call | Count | Purpose |
|------|-------|---------|
| Setup: `getContractInfo()` | 1 | Cached 10 min |
| Setup: `getCurrentPrice()` | 1 | |
| Setup: `getOpenPositions()` | 1 | |
| Setup: `getOpenOrders()` | 1 | |
| Fresh validation: `getOpenOrders()` | 0-1 | Pre-batch check (skipped if nothing pending) |
| Fresh validation: `getOpenPositions()` | 0-1 | Pre-batch check (skipped if nothing pending) |
| Batch entries (10 orders / 5 per batch) | 2 | `batchOrders` POST |
| Batch TPs (5 orders / 5 per batch) | 1 | `batchOrders` POST |
| **Total** | **~7-9** | **~80% reduction** |

---

## New service function: `placeBatchOrders`

Add to `src/services/bingx.service.ts`:

```typescript
export async function placeBatchOrders(
  client: BingxClient,
  orders: Record<string, unknown>[]
): Promise<Array<{ orderId: string | null; error?: string }>>
```

### Implementation details

- Accepts an array of order payloads (same shape as individual `placeGridEntryOrder` payloads)
- Chunks into groups of **5** (placement batch max — different from cancel batch max of 10)
- Calls `POST /openApi/swap/v2/trade/batchOrders` with `batchOrders` param as a JSON-stringified array
- Uses `client.post()` with `useQueryParams = true` (matching the existing individual order placement pattern at line 573 of `bingx.service.ts`)
- Returns per-order results from the `{ orders: [...], errors: [...] }` response
- Uses chunked iteration like `cancelBatchOrders`, but differs in: HTTP method (POST vs DELETE), batch size (5 vs 10), signing approach (useQueryParams vs omitRecvWindow), and return type (per-order results vs void)

### Batch endpoint compatibility

Per BingX API docs, `POST /openApi/swap/v2/trade/batchOrders` accepts a `batchOrders` parameter as `LIST<Order>` where "each order uses the same structure as Place Order". This confirms:

- **LIMIT orders:** Supported (standard type)
- **TRIGGER_LIMIT orders:** Supported (same structure as Place Order, which supports all listed types)
- **Embedded `takeProfit` JSON:** Supported — the `takeProfit` param is a stringified JSON sub-object within each order object, which is itself within the stringified `batchOrders` array. The double-serialization is handled by the API parser since this is the documented structure.
- **TAKE_PROFIT_MARKET with `positionId`/`closePosition`:** Supported — Place Order explicitly lists `positionId` and `closePosition` params, and batch uses the same structure.

### Validation step (implementation plan)

Before implementing the full refactoring, make a single test batch call with 2 orders (one LIMIT with embedded `takeProfit`, one TAKE_PROFIT_MARKET with `positionId`) on a VST (simulated) environment to confirm end-to-end behavior. This de-risks the implementation.

---

## Partial failure handling

The batch endpoint returns `{ orders: [...], errors: [...] }`. For each order:

- **Success** (in `orders` array, `orderId` present): Update `gridLevel.orderId` or `gridLevel.tpOrderId` in DB
- **Failure** (in `errors` array): Log at `warn` level. Do NOT update DB. The order will be retried on the next cron cycle (3 min for grid bots, 5 min for DCA/trailing-stop bots).

This is safe because the system is already designed for idempotent retries — each cycle checks current state before acting.

---

## Other bot optimizations

### `dca-bot-watch` (Futures DCA)

**Current:** ~4 API calls per bot (getContractInfo, getCurrentPrice, placeDCAOrder).

**Optimization:**
- Group bots by `(symbol, apiKeyId)` pair — fetch `getContractInfo()` and `getCurrentPrice()` once per group instead of per bot. Different API keys may belong to different users, but `getContractInfo` is already cached at module level (shared across keys). `getCurrentPrice` can use any valid client for the same symbol.
- If multiple DCA bots need orders in the same cycle, batch via `batchOrders`.

### `trailing-stop-watch`

**Current:** ~5 API calls per bot (getContractInfo, getCurrentPrice, getOpenPositions, placeEntry/close).

**Optimization:**
- Same `(symbol, apiKeyId)` grouping for `getContractInfo()`, `getCurrentPrice()`, `getOpenPositions()`.
- Batch entry/close orders if multiple bots act in the same cycle.

### `dca-spot-bot-watch` (Spot DCA)

**Current:** ~1 API call per bot. Already lightweight.

**Optimization:**
- Batch spot orders via `POST /openApi/spot/v1/trade/batchOrders` if multiple bots fire in the same cycle.
- Minimal impact — already fast enough for Vercel.

---

## Railway removal

### Steps

1. Remove `INNGEST_USE_CONNECT=1` from Vercel environment variables
2. Simplify `src/app/api/inngest/route.ts` — remove the `INNGEST_USE_CONNECT` conditional (line 13), always register all 4 functions. Current code: `const functions = process.env.INNGEST_USE_CONNECT === '1' ? [] : [...]` becomes just `const functions = [tradingBotWatch, dcaBotWatch, trailingStopWatch, dcaSpotBotWatch]`
3. Remove `src/worker.ts`
4. Remove `worker:dev` and `worker` scripts from `package.json`
5. Decommission Railway service (after production validation)

### Vercel execution limits

| Vercel Plan | Timeout | Feasibility |
|-------------|---------|-------------|
| Hobby | 10s | Tight — cold starts (1-3s) + Inngest step overhead reduce effective time to ~5-7s. Recommend limiting to 3-5 concurrent running grid bots, or upgrading to Pro. |
| Pro | 60s | Comfortable for typical usage, even with cold starts |
| Enterprise | 900s | No concerns |

> **Cold start note:** Vercel serverless cold starts (Next.js + Drizzle ORM + Supabase client initialization) can add 1-3 seconds. Combined with Inngest step serialization overhead (~500ms per `step.run`), the effective execution time budget on Hobby is ~5-7s. The batch optimization should comfortably fit within this for a single bot with 20 levels (~9 API calls, each ~200-400ms = ~2-4s).

### Rollback strategy

Keep `worker.ts` in the repo (undeploy from Railway, don't delete the file) for the first weeks. If any cron job exceeds Vercel timeout:
1. Re-deploy worker to Railway
2. Set `INNGEST_USE_CONNECT=1` on Vercel
3. Inngest automatically routes to the external worker

---

## What does NOT change

- Inngest remains the orchestration layer (no migration to Vercel Cron)
- Retry logic (3 attempts) stays via Inngest configuration
- 4 separate cron jobs with independent schedules (not consolidated)
- Supabase auth, PostgreSQL, Drizzle ORM — unchanged
- Grid bot logic (level classification, TP attachment, orphan adoption) — same behavior, just batched
- "Let it Ride" stop behavior — entry orders cancelled, positions + TPs left active

---

## Files affected

| File | Change |
|------|--------|
| `src/services/bingx.service.ts` | Add `placeBatchOrders()` function (batch size 5, distinct from cancel batch size 10) |
| `src/inngest/functions/trading-bot-watch.ts` | Refactor to collect & batch pattern |
| `src/inngest/functions/dca-bot-watch.ts` | Symbol grouping for shared queries |
| `src/inngest/functions/trailing-stop-watch.ts` | Symbol grouping for shared queries |
| `src/inngest/functions/dca-spot-bot-watch.ts` | Optional spot batch orders |
| `src/services/bots/grid-short.service.ts` | Extract payload builders (reuse in batch) |
| `src/services/bots/dca.service.ts` | Optional batch-aware variant of `placeDCAOrder` |
| `src/services/bots/trailing-stop.service.ts` | Optional batch-aware variant of entry/close |
| `src/app/api/inngest/route.ts` | Remove `INNGEST_USE_CONNECT` conditional, always register all functions |
| `src/worker.ts` | Remove (after validation) |
| `package.json` | Remove worker scripts |
| Vercel env vars | Remove `INNGEST_USE_CONNECT=1` |
