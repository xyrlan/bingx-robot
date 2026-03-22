# Batch Orders Refactoring — Eliminate Railway Worker

**Date:** 2026-03-22
**Status:** Draft
**Goal:** Reduce BingX API calls via batch order placement, making all cron jobs fast enough to run on Vercel serverless (eliminating the Railway Connect worker).

---

## Problem

The `trading-bot-watch` cron job makes 60+ individual API calls per cycle for a bot with 20 grid levels. This exceeds Vercel's serverless execution limits, requiring a long-running Railway worker (~$5-10/month) to host the Inngest Connect process.

### Root causes

1. **Redundant queries:** `getOpenOrders()` and `getOpenPositions()` are called per-level inside the processing loop (lines 226, 242, 316 of `trading-bot-watch.ts`), even though the same data was already fetched in the `setup` step.
2. **Individual order placement:** Each entry order and take-profit order is placed via a separate `POST /openApi/swap/v2/trade/order` call with no batching.

### Current call count per bot (20 levels)

| Call | Count | Purpose |
|------|-------|---------|
| `getOpenPositions()` | ~20 | Fresh check per level (line 226) |
| `getOpenOrders()` | ~20 | Fresh check per level (lines 242, 316) |
| `placeGridEntryOrder()` | ~10 | Individual entry placement |
| `placeTakeProfitOrder()` | ~5 | Individual TP placement |
| **Total** | **~55-65** | |

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

### Phase 2 — Fresh validation + Batch execution

1. **Single fresh validation:** Call `getOpenOrders()` and `getOpenPositions()` **once** to confirm pending orders are still needed (guards against race conditions from the ~seconds between setup and execution).
2. **Filter:** Remove any pending entry where an order now exists, or any pending TP where a TP was placed externally.
3. **Batch send:** Submit orders via `POST /openApi/swap/v2/trade/batchOrders` in chunks of 5 (API maximum).
4. **Process results:** Map each returned `orderId` back to its grid level and update the DB.

### Target call count per bot (20 levels)

| Call | Count | Purpose |
|------|-------|---------|
| Setup: `getContractInfo()` | 1 | Cached 10 min |
| Setup: `getCurrentPrice()` | 1 | |
| Setup: `getOpenPositions()` | 1 | |
| Setup: `getOpenOrders()` | 1 | |
| Fresh validation: `getOpenOrders()` | 1 | Pre-batch check |
| Fresh validation: `getOpenPositions()` | 1 | Pre-batch check |
| Batch entries (10 orders / 5 per batch) | 2 | `batchOrders` POST |
| Batch TPs (5 orders / 5 per batch) | 1 | `batchOrders` POST |
| **Total** | **~9** | **~85% reduction** |

---

## New service function: `placeBatchOrders`

Add to `src/services/bingx.service.ts`:

```typescript
export async function placeBatchOrders(
  client: BingxClient,
  orders: Record<string, unknown>[]
): Promise<Array<{ orderId: string | null; error?: string }>>
```

- Accepts an array of order payloads (same shape as individual `placeGridEntryOrder` payloads)
- Chunks into groups of 5
- Calls `POST /openApi/swap/v2/trade/batchOrders` with `batchOrders` param (JSON-stringified array)
- Returns per-order results (orderId or error)
- Follows the same pattern as existing `cancelBatchOrders()`

---

## Partial failure handling

The batch endpoint returns a result array where each element corresponds to an order in the request. For each:

- **Success** (`orderId` present): Update `gridLevel.orderId` or `gridLevel.tpOrderId` in DB
- **Failure** (`orderId` absent, error message present): Log the error. Do NOT update DB. The order will be retried on the next cron cycle (3 min).

This is safe because the system is already designed for idempotent retries — each cycle checks current state before acting.

---

## Other bot optimizations

### `dca-bot-watch` (Futures DCA)

**Current:** ~4 API calls per bot (getContractInfo, getCurrentPrice, placeDCAOrder).

**Optimization:**
- Group bots by `symbol` — fetch `getContractInfo()` and `getCurrentPrice()` once per symbol instead of per bot.
- If multiple DCA bots need orders in the same cycle, batch via `batchOrders`.

### `trailing-stop-watch`

**Current:** ~5 API calls per bot (getContractInfo, getCurrentPrice, getOpenPositions, placeEntry/close).

**Optimization:**
- Same symbol-grouping for `getContractInfo()`, `getCurrentPrice()`, `getOpenPositions()`.
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
2. Ensure `src/app/api/inngest/route.ts` exports all 4 functions (grid, dca, trailing, dca-spot)
3. Remove `src/worker.ts`
4. Remove `worker:dev` and `worker` scripts from `package.json`
5. Decommission Railway service (after production validation)

### Vercel execution limits

| Vercel Plan | Timeout | Feasibility |
|-------------|---------|-------------|
| Hobby | 10s | Tight with many bots — may need to limit concurrent bots |
| Pro | 60s | Comfortable for typical usage |
| Enterprise | 900s | No concerns |

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
| `src/services/bingx.service.ts` | Add `placeBatchOrders()` function |
| `src/inngest/functions/trading-bot-watch.ts` | Refactor to collect & batch pattern |
| `src/inngest/functions/dca-bot-watch.ts` | Symbol grouping for shared queries |
| `src/inngest/functions/trailing-stop-watch.ts` | Symbol grouping for shared queries |
| `src/inngest/functions/dca-spot-bot-watch.ts` | Optional spot batch orders |
| `src/services/bots/grid-short.service.ts` | Extract payload builders (reuse in batch) |
| `src/worker.ts` | Remove (after validation) |
| `package.json` | Remove worker scripts |
| Vercel env vars | Remove `INNGEST_USE_CONNECT=1` |
