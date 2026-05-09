# AI Portfolio Manager — Session 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralize OHLCV fetching and indicator calculations so Signal (Session 7), Backtest (Session 5), and Decision (Session 8) layers all share one source.

**Architecture:**
- `src/lib/bingx/market-data.ts` — `fetchKlines(client, symbol, interval, limit)` thin wrapper around the existing `getKlines` helper in `bingx.service.ts`, with an in-memory cache (60s TTL keyed by `symbol|interval|limit`). The existing helper already returns sorted `Kline[]` rows; this layer adds memoization + a single import path for downstream code.
- `src/lib/ai-pm/indicators.ts` — pure functions: `sma`, `rsi`, `atr`, `bollinger`, `crossoverState`. Index-based loops, no `slice`/`reduce` allocations in hot paths. Each returns `null` when input is too short to produce a valid value.
- Tests use known-fixture assertions (flat series → known RSI/SMA, stepped series → known ATR, hand-computed Bollinger bounds, two pairs of MA series → CROSS_UP/CROSS_DOWN/NONE).

This session **does not call any AI**, **does not place any orders**, and does not change any existing strategy behavior. Pure additive surface.

**Tech Stack:** TypeScript · Vitest · Bun

---

## Scope

| Module | File | Test file |
|---|---|---|
| Market data wrapper + cache | `src/lib/bingx/market-data.ts` | `src/lib/bingx/__tests__/market-data.test.ts` |
| Indicators | `src/lib/ai-pm/indicators.ts` | `src/lib/ai-pm/__tests__/indicators.test.ts` |

**Out of scope:** LLM, Signal layer, Decision layer, persistence of klines, caching closed candles individually (60s TTL on whole response is sufficient for V1; per-candle caching deferred until profiling shows benefit).

**Dependencies:** Session 0 (already merged).

---

## Task 1: Indicators

**Files:**
- Create: `src/lib/ai-pm/indicators.ts`
- Create: `src/lib/ai-pm/__tests__/indicators.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { sma, rsi, atr, bollinger, crossoverState } from '@/lib/ai-pm/indicators';

const closes = (xs: number[]) => xs.map((c) => ({ close: c }));
const ohlc = (rows: [number, number, number][]) =>
  rows.map(([h, l, c]) => ({ high: h, low: l, close: c }));

describe('sma', () => {
  it('returns null when window shorter than period', () => {
    expect(sma(closes([1, 2, 3]), 5)).toBeNull();
  });

  it('averages last N closes', () => {
    expect(sma(closes([1, 2, 3, 4, 5]), 5)).toBe(3);
    expect(sma(closes([1, 2, 3, 4, 5]), 3)).toBe(4);
  });
});

describe('rsi', () => {
  it('returns null when fewer than period+1 candles', () => {
    expect(rsi(closes([1, 2, 3]), 14)).toBeNull();
  });

  it('flat series → 50 (no losses, no gains by convention)', () => {
    expect(rsi(closes(Array(20).fill(100)), 14)).toBe(50);
  });

  it('strict uptrend → > 70', () => {
    const series = Array.from({ length: 20 }, (_, i) => 100 + i);
    const v = rsi(closes(series), 14);
    expect(v).not.toBeNull();
    expect(v as number).toBeGreaterThan(70);
  });

  it('strict downtrend → < 30', () => {
    const series = Array.from({ length: 20 }, (_, i) => 100 - i);
    const v = rsi(closes(series), 14);
    expect(v).not.toBeNull();
    expect(v as number).toBeLessThan(30);
  });
});

describe('atr', () => {
  it('returns null when fewer than period+1 candles', () => {
    expect(atr(ohlc([[1, 1, 1]]), 14)).toBeNull();
  });

  it('constant TR series → ATR equals that constant', () => {
    const rows: [number, number, number][] = Array.from({ length: 16 }, () => [11, 9, 10]);
    expect(atr(ohlc(rows), 14)).toBeCloseTo(2, 9);
  });
});

describe('bollinger', () => {
  it('returns null when fewer than period candles', () => {
    expect(bollinger(closes([1, 2, 3]), 20, 2)).toBeNull();
  });

  it('flat series → upper=middle=lower', () => {
    const result = bollinger(closes(Array(20).fill(100)), 20, 2);
    expect(result).not.toBeNull();
    expect(result!.middle).toBe(100);
    expect(result!.upper).toBe(100);
    expect(result!.lower).toBe(100);
  });

  it('symmetric series produces symmetric bands around mean', () => {
    const r = bollinger(closes([1, 2, 3, 4, 5]), 5, 2);
    expect(r).not.toBeNull();
    expect(r!.middle).toBe(3);
    expect(r!.upper - r!.middle).toBeCloseTo(r!.middle - r!.lower, 9);
  });
});

describe('crossoverState', () => {
  it('NONE when series too short', () => {
    expect(crossoverState([1], [2])).toBe('NONE');
  });

  it('CROSS_UP when short crosses above long', () => {
    expect(crossoverState([9, 11], [10, 10])).toBe('CROSS_UP');
  });

  it('CROSS_DOWN when short crosses below long', () => {
    expect(crossoverState([11, 9], [10, 10])).toBe('CROSS_DOWN');
  });

  it('NONE when no crossing', () => {
    expect(crossoverState([8, 9], [10, 10])).toBe('NONE');
    expect(crossoverState([12, 13], [10, 10])).toBe('NONE');
  });
});
```

- [ ] **Step 2: Implement `indicators.ts`**

Required exports:
- `type Candle = { high: number; low: number; close: number }`
- `type CloseCandle = { close: number }`
- `type Bollinger = { upper: number; middle: number; lower: number }`
- `type CrossoverState = 'CROSS_UP' | 'CROSS_DOWN' | 'NONE'`
- `sma(candles, period)`, `rsi(candles, period=14)`, `atr(candles, period=14)`, `bollinger(candles, period=20, stdDev=2)`, `crossoverState(short, long)`.

Rules:
- All length checks return `null` (or `'NONE'` for crossover) without throwing.
- RSI uses Wilder smoothing (initial simple average for the first `period` diffs, then `(prev*(period-1)+current)/period`).
- ATR uses Wilder smoothing on True Range.
- Bollinger uses **population** standard deviation (`sqrt(sum((x-mean)^2)/period)`) so a flat series collapses to a single line.
- All loops index-based; no `.slice`/`.reduce`/`.map` inside the hot loop.

- [ ] **Step 3: Run `npm test src/lib/ai-pm/__tests__/indicators.test.ts` — all green.**

---

## Task 2: Market data wrapper + cache

**Files:**
- Create: `src/lib/bingx/market-data.ts`
- Create: `src/lib/bingx/__tests__/market-data.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BingxClient } from '@/lib/bingx/client';

vi.mock('@/services/bingx.service', () => ({
  getKlines: vi.fn(),
}));

import { getKlines } from '@/services/bingx.service';
import { fetchKlines, _clearKlinesCache } from '@/lib/bingx/market-data';

const stubClient = {} as unknown as BingxClient;
const sample = [{ open: 1, high: 1, low: 1, close: 1, time: 1 }];

beforeEach(() => {
  _clearKlinesCache();
  vi.mocked(getKlines).mockReset();
  vi.mocked(getKlines).mockResolvedValue(sample);
});

describe('fetchKlines', () => {
  it('forwards args to getKlines on cache miss', async () => {
    const result = await fetchKlines(stubClient, 'BTC-USDT', '1h', 720);
    expect(result).toEqual(sample);
    expect(getKlines).toHaveBeenCalledTimes(1);
    expect(getKlines).toHaveBeenCalledWith(stubClient, 'BTC-USDT', '1h', 720);
  });

  it('returns cached value within TTL without calling getKlines again', async () => {
    await fetchKlines(stubClient, 'BTC-USDT', '1h', 720);
    await fetchKlines(stubClient, 'BTC-USDT', '1h', 720);
    expect(getKlines).toHaveBeenCalledTimes(1);
  });

  it('refetches after TTL expiry', async () => {
    vi.useFakeTimers();
    try {
      await fetchKlines(stubClient, 'BTC-USDT', '1h', 720);
      vi.advanceTimersByTime(60_001);
      await fetchKlines(stubClient, 'BTC-USDT', '1h', 720);
      expect(getKlines).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caches per (symbol, interval, limit) tuple', async () => {
    await fetchKlines(stubClient, 'BTC-USDT', '1h', 720);
    await fetchKlines(stubClient, 'ETH-USDT', '1h', 720);
    await fetchKlines(stubClient, 'BTC-USDT', '4h', 720);
    await fetchKlines(stubClient, 'BTC-USDT', '1h', 100);
    expect(getKlines).toHaveBeenCalledTimes(4);
  });

  it('does not cache empty results (retries on next call)', async () => {
    vi.mocked(getKlines).mockResolvedValueOnce([]);
    await fetchKlines(stubClient, 'BTC-USDT', '1h', 720);
    await fetchKlines(stubClient, 'BTC-USDT', '1h', 720);
    expect(getKlines).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Implement `market-data.ts`**

- Export: `fetchKlines(client, symbol, interval, limit): Promise<Kline[]>`, `_clearKlinesCache()` (test-only helper, leading underscore signals private).
- Internal `Map<string, { value: Kline[]; expiresAt: number }>`, key = `${symbol}|${interval}|${limit}`, TTL = 60_000.
- On miss/expired: call `getKlines(client, symbol, interval, limit)` and store result with `expiresAt = Date.now() + 60_000`. Do not cache empty arrays (treat as soft-failure so we retry on next call).

- [ ] **Step 3: Run `npm test src/lib/bingx/__tests__/market-data.test.ts` — all green.**

---

## Task 3: Verification

- [ ] **Step 1: Lint** — `npm run lint` does not introduce new errors in the new files.
- [ ] **Step 2: Targeted tests** — both new test files green.
- [ ] **Step 3: Full suite** — confirm pre-existing failures are limited to DB-integration tests requiring Postgres (unchanged from baseline). No new failures introduced.

---

## Done criteria (from spec)

- All indicators have unit tests with assertions against known values. ✅
- `fetchKlines("BTC-USDT", "1h", 720)` returns 720 candles in dev. *(manual smoke test, not automated — relies on live BingX)*
- Cache is observable: second call within 60s does not hit BingX (mocked). ✅
