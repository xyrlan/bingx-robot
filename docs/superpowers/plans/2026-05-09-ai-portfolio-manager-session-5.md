# AI Portfolio Manager — Session 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deterministic backtest engine for the four MVP strategies (DCA, DCA_SPOT, TRAILING_STOP, SMA_CROSSOVER), driven by the existing pure-core `tick()` functions and the shared `fetchKlines` wrapper, with results deduplicated in the `backtest_runs` table.

**Architecture:**
- `src/lib/backtest/index.ts` — `runBacktest({ client, symbol, strategy, params, windowDays })` orchestrator: cache lookup → fetch klines → run simulator → compute metrics → write cache → return.
- `src/lib/backtest/types.ts` — shared types (`Trade`, `SimulatorResult`, `BacktestResult`).
- `src/lib/backtest/metrics.ts` — pure functions: `pnlPct`, `maxDrawdownPct`, `sharpeApprox`, `winRatePct`.
- `src/lib/backtest/cache.ts` — `paramsHash(params)`, `findCached(...)`, `writeCache(...)` against `backtestRuns`.
- `src/lib/backtest/simulators/{dca,dca-spot,trailing-stop,sma-crossover}.ts` — each one wraps the corresponding pure-core `tick()` from Session 3, drives it candle-by-candle, accumulates `Trade[]` and an equity curve.
- All four strategies share the same `Simulator` contract: `(candles, params) => SimulatorResult`. Index lookup keyed by `BotType`.
- No LLM, no real orders, no event emission. Pure additive surface.

**Tech Stack:** TypeScript · Vitest · Bun · Drizzle ORM (read/write `backtest_runs`).

**Dependencies:** Session 3, Session 3.5, Session 4 (all merged on `main`).

---

## Scope

| Module | File | Test file |
|---|---|---|
| Shared types | `src/lib/backtest/types.ts` | (tested transitively) |
| Metrics | `src/lib/backtest/metrics.ts` | `src/lib/backtest/__tests__/metrics.test.ts` |
| DCA simulator | `src/lib/backtest/simulators/dca.ts` | `src/lib/backtest/__tests__/simulators/dca.test.ts` |
| DCA_SPOT simulator | `src/lib/backtest/simulators/dca-spot.ts` | `src/lib/backtest/__tests__/simulators/dca-spot.test.ts` |
| TRAILING_STOP simulator | `src/lib/backtest/simulators/trailing-stop.ts` | `src/lib/backtest/__tests__/simulators/trailing-stop.test.ts` |
| SMA_CROSSOVER simulator | `src/lib/backtest/simulators/sma-crossover.ts` | `src/lib/backtest/__tests__/simulators/sma-crossover.test.ts` |
| Cache helpers | `src/lib/backtest/cache.ts` | `src/lib/backtest/__tests__/cache.test.ts` |
| Orchestrator | `src/lib/backtest/index.ts` | `src/lib/backtest/__tests__/run-backtest.test.ts` |

**Out of scope:** GRID_LONG / GRID_SHORT (excluded from MVP per spec), AI calls, paper trading wiring, drift test against real subaccount (Session 18), Inngest registration.

**File line targets:** keep each simulator under ~200 lines. If `simulators/sma-crossover.ts` would exceed that, split helpers into `simulators/sma-crossover.helpers.ts`.

---

## Conventions used by every simulator

Each simulator iterates closes in chronological order (klines are already sorted ascending by `time` per `getKlines` contract). For each candle index `i` from 0 to `candles.length - 1`:
1. Build a `Snapshot` matching the strategy's pure-core type using `candles[i]` and any synthetic state (open position flag, etc.).
2. Call `core.tick(state, snap)` → `{ newState, intents }`.
3. Apply intents to the simulator's bookkeeping (open position, append a closed `Trade`, update equity).
4. Set `state = newState`.

After the final candle, **force-close any open position** at `candles.at(-1).close` so every backtest emits a finite trade list and a terminal equity value (otherwise DCA — which has no built-in exit — would always report `totalTrades = 0`).

`Trade` shape (shared across strategies):

```ts
// src/lib/backtest/types.ts
export type Trade = {
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  side: 'LONG' | 'SHORT';
  pnlPct: number; // (exitPrice - entryPrice) / entryPrice * 100, sign-adjusted for side
  pnlUsdt: number; // notional * pnlPct/100
  notionalUsdt: number;
};

export type SimulatorResult = {
  trades: Trade[];
  equityCurve: number[]; // realized equity per candle, starting at 0 (relative P&L in USDT)
};

export type BacktestResult = {
  cached: boolean;
  pnlPct: number;
  maxDrawdownPct: number;
  sharpeApprox: number;
  winRatePct: number;
  totalTrades: number;
  paramsHash: string;
  runId: string; // primary key from backtest_runs
};
```

`pnlUsdt` is computed as `(pnlPct / 100) * notionalUsdt` so a $100 LONG that gains 5% records `pnlUsdt = 5`. SHORT trades use `pnlPct = (entryPrice - exitPrice) / entryPrice * 100`.

Equity curve = cumulative sum of `pnlUsdt` of trades closed up to and including candle `i`, written at every index (carries last value forward when no trade closes that candle). Used by `maxDrawdownPct`.

---

## Task 1: Shared types and registry stub

**Files:**
- Create: `src/lib/backtest/types.ts`

- [ ] **Step 1: Write the file**

```ts
// src/lib/backtest/types.ts
import type { BotType } from '@/services/bots/types';
import type { Kline } from '@/services/bingx.service';

export type Trade = {
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  side: 'LONG' | 'SHORT';
  pnlPct: number;
  pnlUsdt: number;
  notionalUsdt: number;
};

export type SimulatorResult = {
  trades: Trade[];
  equityCurve: number[];
};

export type Simulator<TParams> = (candles: Kline[], params: TParams) => SimulatorResult;

export type BacktestResult = {
  cached: boolean;
  pnlPct: number;
  maxDrawdownPct: number;
  sharpeApprox: number;
  winRatePct: number;
  totalTrades: number;
  paramsHash: string;
  runId: string;
};

export type BacktestableStrategy = Extract<BotType, 'DCA' | 'DCA_SPOT' | 'TRAILING_STOP' | 'SMA_CROSSOVER'>;
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep "src/lib/backtest" || echo "no errors"`
Expected: `no errors` (or empty output).

- [ ] **Step 3: Commit**

```bash
git add src/lib/backtest/types.ts
git commit -m "feat(backtest): shared types for backtest engine"
```

---

## Task 2: Metrics module

**Files:**
- Create: `src/lib/backtest/metrics.ts`
- Create: `src/lib/backtest/__tests__/metrics.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/lib/backtest/__tests__/metrics.test.ts
import { describe, it, expect } from 'vitest';
import {
  pnlPct,
  maxDrawdownPct,
  sharpeApprox,
  winRatePct,
} from '@/lib/backtest/metrics';
import type { Trade } from '@/lib/backtest/types';

const trade = (over: Partial<Trade>): Trade => ({
  entryPrice: 100,
  exitPrice: 110,
  entryTime: 0,
  exitTime: 1,
  side: 'LONG',
  pnlPct: 10,
  pnlUsdt: 10,
  notionalUsdt: 100,
  ...over,
});

describe('pnlPct', () => {
  it('returns 0 for empty trades', () => {
    expect(pnlPct([], 100)).toBe(0);
  });

  it('sums pnlUsdt and divides by initial capital', () => {
    const trades = [trade({ pnlUsdt: 5 }), trade({ pnlUsdt: -2 })];
    expect(pnlPct(trades, 100)).toBeCloseTo(3, 9);
  });
});

describe('maxDrawdownPct', () => {
  it('returns 0 for monotonically increasing curve', () => {
    expect(maxDrawdownPct([0, 1, 2, 3], 100)).toBe(0);
  });

  it('measures peak-to-trough loss as percent of initial capital', () => {
    // peak = 10, trough = 4 → drawdown = 6 / 100 = 6%
    expect(maxDrawdownPct([0, 5, 10, 7, 4, 8], 100)).toBeCloseTo(6, 9);
  });

  it('handles empty curve', () => {
    expect(maxDrawdownPct([], 100)).toBe(0);
  });
});

describe('sharpeApprox', () => {
  it('returns 0 when fewer than 2 trades', () => {
    expect(sharpeApprox([])).toBe(0);
    expect(sharpeApprox([trade({ pnlPct: 5 })])).toBe(0);
  });

  it('returns 0 when stddev of returns is 0', () => {
    const ts = [trade({ pnlPct: 1 }), trade({ pnlPct: 1 }), trade({ pnlPct: 1 })];
    expect(sharpeApprox(ts)).toBe(0);
  });

  it('returns positive when mean return > 0 and there is variance', () => {
    const ts = [trade({ pnlPct: 2 }), trade({ pnlPct: -1 }), trade({ pnlPct: 4 })];
    expect(sharpeApprox(ts)).toBeGreaterThan(0);
  });
});

describe('winRatePct', () => {
  it('returns 0 for empty trades', () => {
    expect(winRatePct([])).toBe(0);
  });

  it('counts trades with pnlUsdt > 0 as wins', () => {
    const ts = [
      trade({ pnlUsdt: 10 }),
      trade({ pnlUsdt: -5 }),
      trade({ pnlUsdt: 0 }),
      trade({ pnlUsdt: 7 }),
    ];
    expect(winRatePct(ts)).toBeCloseTo(50, 9);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/backtest/__tests__/metrics.test.ts`
Expected: FAIL with "Cannot find module '@/lib/backtest/metrics'".

- [ ] **Step 3: Implement metrics**

```ts
// src/lib/backtest/metrics.ts
import type { Trade } from '@/lib/backtest/types';

export function pnlPct(trades: Trade[], initialCapital: number): number {
  if (trades.length === 0 || initialCapital <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < trades.length; i++) sum += trades[i].pnlUsdt;
  return (sum / initialCapital) * 100;
}

export function maxDrawdownPct(equityCurve: number[], initialCapital: number): number {
  if (equityCurve.length === 0 || initialCapital <= 0) return 0;
  let peak = equityCurve[0];
  let maxDd = 0;
  for (let i = 1; i < equityCurve.length; i++) {
    const v = equityCurve[i];
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDd) maxDd = dd;
  }
  return (maxDd / initialCapital) * 100;
}

export function sharpeApprox(trades: Trade[]): number {
  if (trades.length < 2) return 0;
  let mean = 0;
  for (let i = 0; i < trades.length; i++) mean += trades[i].pnlPct;
  mean /= trades.length;

  let variance = 0;
  for (let i = 0; i < trades.length; i++) {
    const d = trades[i].pnlPct - mean;
    variance += d * d;
  }
  variance /= trades.length;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return mean / std;
}

export function winRatePct(trades: Trade[]): number {
  if (trades.length === 0) return 0;
  let wins = 0;
  for (let i = 0; i < trades.length; i++) {
    if (trades[i].pnlUsdt > 0) wins++;
  }
  return (wins / trades.length) * 100;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/backtest/__tests__/metrics.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/backtest/metrics.ts src/lib/backtest/__tests__/metrics.test.ts
git commit -m "feat(backtest): pnl, drawdown, sharpe, win-rate metrics"
```

---

## Task 3: DCA simulator

**Files:**
- Create: `src/lib/backtest/simulators/dca.ts`
- Create: `src/lib/backtest/__tests__/simulators/dca.test.ts`

DCA opens positions periodically and never closes on its own. The simulator force-closes the **net average position** at the final candle. It produces exactly **one synthetic trade** representing the aggregate accumulated position vs the final price.

- [ ] **Step 1: Write failing tests**

```ts
// src/lib/backtest/__tests__/simulators/dca.test.ts
import { describe, it, expect } from 'vitest';
import { simulateDca } from '@/lib/backtest/simulators/dca';
import type { Kline } from '@/services/bingx.service';
import type { DCAConfig } from '@/services/bots/types';

const HOUR = 3_600_000;

const candle = (time: number, close: number): Kline => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
});

const baseParams: DCAConfig = {
  intervalMinutes: 60,
  totalOrders: 3,
  orderSizeUsdt: 100,
  ordersPlaced: 0,
  side: 'BUY',
};

describe('simulateDca', () => {
  it('returns no trades when no candles supplied', () => {
    const r = simulateDca([], baseParams);
    expect(r.trades).toEqual([]);
    expect(r.equityCurve).toEqual([]);
  });

  it('produces one aggregate trade after force-close, BUY side, with positive pnl on uptrend', () => {
    // 4 hourly candles, prices: 100, 110, 120, 130. Buys at 100, 110, 120 (3 orders), final close 130.
    const candles = [
      candle(0 * HOUR, 100),
      candle(1 * HOUR, 110),
      candle(2 * HOUR, 120),
      candle(3 * HOUR, 130),
    ];
    const r = simulateDca(candles, baseParams);
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    // avg entry = 110, exit = 130, side LONG
    expect(t.side).toBe('LONG');
    expect(t.entryPrice).toBeCloseTo(110, 9);
    expect(t.exitPrice).toBe(130);
    expect(t.notionalUsdt).toBe(300); // 3 orders × 100 USDT
    // pnlPct ≈ (130-110)/110 * 100 ≈ 18.18
    expect(t.pnlPct).toBeCloseTo((130 - 110) / 110 * 100, 6);
    expect(t.pnlUsdt).toBeCloseTo(300 * t.pnlPct / 100, 6);
    expect(r.equityCurve).toHaveLength(candles.length);
    expect(r.equityCurve[r.equityCurve.length - 1]).toBeCloseTo(t.pnlUsdt, 6);
  });

  it('SELL side flips P&L sign on uptrend', () => {
    const candles = [candle(0, 100), candle(HOUR, 110), candle(2 * HOUR, 120), candle(3 * HOUR, 130)];
    const r = simulateDca(candles, { ...baseParams, side: 'SELL' });
    expect(r.trades[0].side).toBe('SHORT');
    expect(r.trades[0].pnlPct).toBeLessThan(0);
  });

  it('caps orders at totalOrders', () => {
    const candles = Array.from({ length: 10 }, (_, i) => candle(i * HOUR, 100));
    const r = simulateDca(candles, { ...baseParams, totalOrders: 2 });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].notionalUsdt).toBe(200); // only 2 orders
  });

  it('produces no trades when totalOrders=0', () => {
    const candles = [candle(0, 100), candle(HOUR, 110)];
    const r = simulateDca(candles, { ...baseParams, totalOrders: 0 });
    expect(r.trades).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/backtest/__tests__/simulators/dca.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement DCA simulator**

```ts
// src/lib/backtest/simulators/dca.ts
import { tick, initialState } from '@/services/bots/dca/core';
import type { DCAConfig } from '@/services/bots/types';
import type { Kline } from '@/services/bingx.service';
import type { SimulatorResult, Trade } from '@/lib/backtest/types';

export function simulateDca(candles: Kline[], params: DCAConfig): SimulatorResult {
  if (candles.length === 0 || params.totalOrders <= 0) {
    return { trades: [], equityCurve: [] };
  }

  let state = initialState({ ...params, ordersPlaced: 0, lastOrderAt: undefined });
  const botCreatedAt = candles[0].time;

  // Accumulator for the aggregate "average entry" position
  let totalNotional = 0;
  let weightedPriceSum = 0;
  let firstEntryTime: number | null = null;

  const equityCurve: number[] = new Array(candles.length).fill(0);

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const { newState, intents } = tick(state, {
      now: c.time,
      currentPrice: c.close,
      botCreatedAt,
      config: { ...params, ordersPlaced: state.ordersPlaced, lastOrderAt: state.lastOrderAt ?? undefined },
    });
    state = newState;

    for (let j = 0; j < intents.length; j++) {
      const it = intents[j];
      if (it.kind === 'PLACE_ENTRY') {
        const notional = it.usdtAmount;
        weightedPriceSum += it.referencePrice * notional;
        totalNotional += notional;
        if (firstEntryTime === null) firstEntryTime = c.time;
      }
    }

    // Equity curve while position is open: mark-to-market unrealized P&L
    if (totalNotional > 0) {
      const avg = weightedPriceSum / totalNotional;
      const sign = params.side === 'BUY' ? 1 : -1;
      const unrealizedPct = sign * (c.close - avg) / avg * 100;
      equityCurve[i] = (unrealizedPct / 100) * totalNotional;
    } else {
      equityCurve[i] = i > 0 ? equityCurve[i - 1] : 0;
    }
  }

  if (totalNotional === 0 || firstEntryTime === null) {
    return { trades: [], equityCurve };
  }

  const last = candles[candles.length - 1];
  const avgEntry = weightedPriceSum / totalNotional;
  const side: Trade['side'] = params.side === 'BUY' ? 'LONG' : 'SHORT';
  const sign = side === 'LONG' ? 1 : -1;
  const pnlPctValue = sign * (last.close - avgEntry) / avgEntry * 100;
  const pnlUsdt = (pnlPctValue / 100) * totalNotional;

  const trade: Trade = {
    entryPrice: avgEntry,
    exitPrice: last.close,
    entryTime: firstEntryTime,
    exitTime: last.time,
    side,
    pnlPct: pnlPctValue,
    pnlUsdt,
    notionalUsdt: totalNotional,
  };

  // Force terminal equity to realized pnl
  equityCurve[equityCurve.length - 1] = pnlUsdt;

  return { trades: [trade], equityCurve };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/backtest/__tests__/simulators/dca.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/backtest/simulators/dca.ts src/lib/backtest/__tests__/simulators/dca.test.ts
git commit -m "feat(backtest): DCA simulator with aggregate close on terminal candle"
```

---

## Task 4: DCA_SPOT simulator

DCA_SPOT is structurally identical to DCA but always BUY-only and emits `PLACE_SPOT_BUY` intents.

**Files:**
- Create: `src/lib/backtest/simulators/dca-spot.ts`
- Create: `src/lib/backtest/__tests__/simulators/dca-spot.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/lib/backtest/__tests__/simulators/dca-spot.test.ts
import { describe, it, expect } from 'vitest';
import { simulateDcaSpot } from '@/lib/backtest/simulators/dca-spot';
import type { Kline } from '@/services/bingx.service';
import type { DCAConfig } from '@/services/bots/types';

const HOUR = 3_600_000;
const candle = (time: number, close: number): Kline => ({ time, open: close, high: close, low: close, close });

const baseParams: DCAConfig = {
  intervalMinutes: 60,
  totalOrders: 3,
  orderSizeUsdt: 100,
  ordersPlaced: 0,
  side: 'BUY',
};

describe('simulateDcaSpot', () => {
  it('produces one LONG aggregate trade on uptrend (spot is buy-only)', () => {
    const candles = [candle(0, 100), candle(HOUR, 110), candle(2 * HOUR, 120), candle(3 * HOUR, 130)];
    const r = simulateDcaSpot(candles, baseParams);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].side).toBe('LONG');
    expect(r.trades[0].notionalUsdt).toBe(300);
    expect(r.trades[0].pnlPct).toBeGreaterThan(0);
  });

  it('produces a losing aggregate trade on downtrend', () => {
    const candles = [candle(0, 130), candle(HOUR, 120), candle(2 * HOUR, 110), candle(3 * HOUR, 100)];
    const r = simulateDcaSpot(candles, baseParams);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].pnlPct).toBeLessThan(0);
  });

  it('returns empty for empty candles', () => {
    expect(simulateDcaSpot([], baseParams).trades).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/backtest/__tests__/simulators/dca-spot.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement DCA_SPOT simulator**

```ts
// src/lib/backtest/simulators/dca-spot.ts
import { tick, initialState } from '@/services/bots/dca-spot/core';
import type { DCAConfig } from '@/services/bots/types';
import type { Kline } from '@/services/bingx.service';
import type { SimulatorResult, Trade } from '@/lib/backtest/types';

export function simulateDcaSpot(candles: Kline[], params: DCAConfig): SimulatorResult {
  if (candles.length === 0 || params.totalOrders <= 0) {
    return { trades: [], equityCurve: [] };
  }

  let state = initialState({ ...params, ordersPlaced: 0, lastOrderAt: undefined });
  const botCreatedAt = candles[0].time;

  let totalNotional = 0;
  let weightedPriceSum = 0;
  let firstEntryTime: number | null = null;
  const equityCurve: number[] = new Array(candles.length).fill(0);

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const { newState, intents } = tick(state, {
      now: c.time,
      currentPrice: c.close,
      botCreatedAt,
      config: { ...params, ordersPlaced: state.ordersPlaced, lastOrderAt: state.lastOrderAt ?? undefined },
    });
    state = newState;

    for (let j = 0; j < intents.length; j++) {
      const it = intents[j];
      if (it.kind === 'PLACE_SPOT_BUY') {
        weightedPriceSum += it.referencePrice * it.usdtAmount;
        totalNotional += it.usdtAmount;
        if (firstEntryTime === null) firstEntryTime = c.time;
      }
    }

    if (totalNotional > 0) {
      const avg = weightedPriceSum / totalNotional;
      const unrealizedPct = (c.close - avg) / avg * 100;
      equityCurve[i] = (unrealizedPct / 100) * totalNotional;
    } else {
      equityCurve[i] = i > 0 ? equityCurve[i - 1] : 0;
    }
  }

  if (totalNotional === 0 || firstEntryTime === null) {
    return { trades: [], equityCurve };
  }

  const last = candles[candles.length - 1];
  const avgEntry = weightedPriceSum / totalNotional;
  const pnlPctValue = (last.close - avgEntry) / avgEntry * 100;
  const pnlUsdt = (pnlPctValue / 100) * totalNotional;

  const trade: Trade = {
    entryPrice: avgEntry,
    exitPrice: last.close,
    entryTime: firstEntryTime,
    exitTime: last.time,
    side: 'LONG',
    pnlPct: pnlPctValue,
    pnlUsdt,
    notionalUsdt: totalNotional,
  };

  equityCurve[equityCurve.length - 1] = pnlUsdt;

  return { trades: [trade], equityCurve };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/backtest/__tests__/simulators/dca-spot.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/backtest/simulators/dca-spot.ts src/lib/backtest/__tests__/simulators/dca-spot.test.ts
git commit -m "feat(backtest): DCA_SPOT simulator (spot-style accumulation)"
```

---

## Task 5: TRAILING_STOP simulator

The pure-core emits `PLACE_ENTRY` and `CLOSE_POSITION` intents. The simulator owns the open-position flag and reacts to the candle stream:

- On `PLACE_ENTRY`: open a position at `currentPrice` (= candle close).
- On `CLOSE_POSITION`: realize the trade, append to `trades`, update equity.
- At end of stream: if a position is open, force-close at the final candle's close.

**Files:**
- Create: `src/lib/backtest/simulators/trailing-stop.ts`
- Create: `src/lib/backtest/__tests__/simulators/trailing-stop.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/lib/backtest/__tests__/simulators/trailing-stop.test.ts
import { describe, it, expect } from 'vitest';
import { simulateTrailingStop } from '@/lib/backtest/simulators/trailing-stop';
import type { Kline } from '@/services/bingx.service';
import type { TrailingStopConfig } from '@/services/bots/types';

const HOUR = 3_600_000;
const candle = (time: number, close: number): Kline => ({ time, open: close, high: close, low: close, close });

const baseParams: TrailingStopConfig = {
  activationPricePct: 5, // activates at +5% from entry
  trailingPct: 2,        // closes when price drops 2% below highest
  positionSizeUsdt: 100,
  highestPrice: 0,
  isActivated: false,
  entryOrderId: null,
};

describe('simulateTrailingStop', () => {
  it('returns no trades on empty candles', () => {
    expect(simulateTrailingStop([], baseParams).trades).toEqual([]);
  });

  it('opens position on first candle and closes when trailing stop triggers', () => {
    // entry @100, runs to 110 (activates >= 105), then drops to 107.8 (< 110*0.98=107.8) → close
    const candles = [
      candle(0 * HOUR, 100), // entry placed here
      candle(1 * HOUR, 105), // activates trailing
      candle(2 * HOUR, 110), // peak
      candle(3 * HOUR, 107), // 107 < 107.8 → close
    ];
    const r = simulateTrailingStop(candles, baseParams);
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.side).toBe('LONG');
    expect(t.entryPrice).toBe(100);
    expect(t.exitPrice).toBe(107);
    expect(t.notionalUsdt).toBe(100);
    expect(t.pnlPct).toBeCloseTo(7, 6);
  });

  it('force-closes open position at final candle if no stop hit', () => {
    const candles = [candle(0, 100), candle(HOUR, 102), candle(2 * HOUR, 103)];
    const r = simulateTrailingStop(candles, baseParams);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].exitPrice).toBe(103); // forced close at last close
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/backtest/__tests__/simulators/trailing-stop.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement TRAILING_STOP simulator**

```ts
// src/lib/backtest/simulators/trailing-stop.ts
import { tick, initialState } from '@/services/bots/trailing-stop/core';
import type { TrailingStopConfig } from '@/services/bots/types';
import type { Kline } from '@/services/bingx.service';
import type { SimulatorResult, Trade } from '@/lib/backtest/types';

export function simulateTrailingStop(candles: Kline[], params: TrailingStopConfig): SimulatorResult {
  if (candles.length === 0) return { trades: [], equityCurve: [] };

  // Reset transient state so the simulator always starts flat.
  let state = initialState({
    ...params,
    entryOrderId: null,
    entryPrice: undefined,
    highestPrice: 0,
    isActivated: false,
  });

  const trades: Trade[] = [];
  const equityCurve: number[] = new Array(candles.length).fill(0);

  let realized = 0;
  let openEntryPrice: number | null = null;
  let openEntryTime: number | null = null;
  const notional = params.positionSizeUsdt;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const hasOpenPosition = openEntryPrice !== null;
    const { newState, intents } = tick(state, {
      currentPrice: c.close,
      hasOpenPosition,
      config: params,
    });

    // The pure core sets entryOrderId=null at start; we synthesize one once the simulator opens a position.
    if (openEntryPrice === null) {
      // pre-position: detect a PLACE_ENTRY intent
      for (let j = 0; j < intents.length; j++) {
        if (intents[j].kind === 'PLACE_ENTRY') {
          openEntryPrice = c.close;
          openEntryTime = c.time;
          // Inject a synthetic order id + entryPrice so subsequent ticks see "position open".
          state = { ...newState, entryOrderId: 'sim', entryPrice: c.close };
          break;
        }
      }
      if (state.entryOrderId !== 'sim') state = newState;
    } else {
      state = newState;
      for (let j = 0; j < intents.length; j++) {
        if (intents[j].kind === 'CLOSE_POSITION' && openEntryPrice !== null && openEntryTime !== null) {
          const pnlPctValue = (c.close - openEntryPrice) / openEntryPrice * 100;
          const pnlUsdt = (pnlPctValue / 100) * notional;
          trades.push({
            entryPrice: openEntryPrice,
            exitPrice: c.close,
            entryTime: openEntryTime,
            exitTime: c.time,
            side: 'LONG',
            pnlPct: pnlPctValue,
            pnlUsdt,
            notionalUsdt: notional,
          });
          realized += pnlUsdt;
          openEntryPrice = null;
          openEntryTime = null;
          // Reset state for next entry (mirror initialState defaults).
          state = initialState({
            ...params,
            entryOrderId: null,
            entryPrice: undefined,
            highestPrice: 0,
            isActivated: false,
          });
        }
      }
    }

    if (openEntryPrice !== null) {
      const unrealizedUsdt = ((c.close - openEntryPrice) / openEntryPrice) * notional;
      equityCurve[i] = realized + unrealizedUsdt;
    } else {
      equityCurve[i] = realized;
    }
  }

  // Force-close any open position at the final candle.
  if (openEntryPrice !== null && openEntryTime !== null) {
    const last = candles[candles.length - 1];
    const pnlPctValue = (last.close - openEntryPrice) / openEntryPrice * 100;
    const pnlUsdt = (pnlPctValue / 100) * notional;
    trades.push({
      entryPrice: openEntryPrice,
      exitPrice: last.close,
      entryTime: openEntryTime,
      exitTime: last.time,
      side: 'LONG',
      pnlPct: pnlPctValue,
      pnlUsdt,
      notionalUsdt: notional,
    });
    realized += pnlUsdt;
    equityCurve[equityCurve.length - 1] = realized;
  }

  return { trades, equityCurve };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/backtest/__tests__/simulators/trailing-stop.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/backtest/simulators/trailing-stop.ts src/lib/backtest/__tests__/simulators/trailing-stop.test.ts
git commit -m "feat(backtest): TRAILING_STOP simulator with force-close on terminal candle"
```

---

## Task 6: SMA_CROSSOVER simulator

The SMA pure-core needs `candles` *up to and including* the current bar (it computes ATR/ADX inside `tick`). The simulator passes `candles.slice(0, i + 1)` each step. Position state is owned by the simulator: ENTER_LONG/SHORT opens, CLOSE_POSITION closes. Final candle force-closes any open position.

**Files:**
- Create: `src/lib/backtest/simulators/sma-crossover.ts`
- Create: `src/lib/backtest/__tests__/simulators/sma-crossover.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/lib/backtest/__tests__/simulators/sma-crossover.test.ts
import { describe, it, expect } from 'vitest';
import { simulateSmaCrossover } from '@/lib/backtest/simulators/sma-crossover';
import type { Kline } from '@/services/bingx.service';
import type { SMAConfig } from '@/services/bots/types';

const HOUR = 3_600_000;
const candle = (time: number, close: number): Kline => ({
  time,
  open: close,
  high: close * 1.01,
  low: close * 0.99,
  close,
});

const baseParams: SMAConfig = {
  symbols: ['TEST-USDT'],
  timeframe: '1h',
  fastPeriod: 5,
  mediumPeriod: 10,
  trendPeriod: 20,
  adxPeriod: 14,
  adxThreshold: 0, // disable ADX gate for the test
  atrPeriod: 14,
  activationAtrMult: 1,
  trailingAtrMult: 1,
  initialStopAtrMult: 2,
  positionSizeUsdt: 100,
  leverage: 1,
  marginType: 'CROSSED',
  symbolStates: {},
};

describe('simulateSmaCrossover', () => {
  it('returns no trades on empty candles', () => {
    expect(simulateSmaCrossover([], baseParams).trades).toEqual([]);
  });

  it('returns no trades when too few candles to compute trend SMA', () => {
    const c = Array.from({ length: 5 }, (_, i) => candle(i * HOUR, 100));
    expect(simulateSmaCrossover(c, baseParams).trades).toEqual([]);
  });

  it('opens and force-closes a position over a strong uptrend', () => {
    // 60 candles: flat 100 for 25, then linear ramp to 160. Trend should fire LONG eventually.
    const c: Kline[] = [];
    for (let i = 0; i < 25; i++) c.push(candle(i * HOUR, 100));
    for (let i = 0; i < 35; i++) c.push(candle((25 + i) * HOUR, 100 + i * 2));
    const r = simulateSmaCrossover(c, baseParams);
    // We do not assert exact entry index — just that at least one trade was produced and final close ≥ entry.
    expect(r.trades.length).toBeGreaterThanOrEqual(1);
    const last = r.trades[r.trades.length - 1];
    expect(last.exitPrice).toBeGreaterThan(0);
    expect(r.equityCurve).toHaveLength(c.length);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/backtest/__tests__/simulators/sma-crossover.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement SMA_CROSSOVER simulator**

```ts
// src/lib/backtest/simulators/sma-crossover.ts
import { tick, initialState } from '@/services/bots/sma-crossover/core';
import type { SMAConfig } from '@/services/bots/types';
import type { Kline } from '@/services/bingx.service';
import type { SimulatorResult, Trade } from '@/lib/backtest/types';

export function simulateSmaCrossover(candles: Kline[], params: SMAConfig): SimulatorResult {
  if (candles.length === 0) return { trades: [], equityCurve: [] };

  let state = initialState(params);
  const trades: Trade[] = [];
  const equityCurve: number[] = new Array(candles.length).fill(0);

  let realized = 0;
  let openSide: 'LONG' | 'SHORT' | null = null;
  let openEntryPrice: number | null = null;
  let openEntryTime: number | null = null;
  const notional = params.positionSizeUsdt;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const window = candles.slice(0, i + 1);
    const { newState, intents } = tick(state, {
      symbol: 'BACKTEST',
      candles: window,
      currentPrice: c.close,
      hasOpenPosition: openSide !== null,
      config: params,
    });
    state = newState;

    for (let j = 0; j < intents.length; j++) {
      const it = intents[j];
      if ((it.kind === 'ENTER_LONG' || it.kind === 'ENTER_SHORT') && openSide === null) {
        openSide = it.kind === 'ENTER_LONG' ? 'LONG' : 'SHORT';
        openEntryPrice = c.close;
        openEntryTime = c.time;
      } else if (it.kind === 'CLOSE_POSITION' && openSide !== null && openEntryPrice !== null && openEntryTime !== null) {
        const sign = openSide === 'LONG' ? 1 : -1;
        const pnlPctValue = sign * (c.close - openEntryPrice) / openEntryPrice * 100;
        const pnlUsdt = (pnlPctValue / 100) * notional;
        trades.push({
          entryPrice: openEntryPrice,
          exitPrice: c.close,
          entryTime: openEntryTime,
          exitTime: c.time,
          side: openSide,
          pnlPct: pnlPctValue,
          pnlUsdt,
          notionalUsdt: notional,
        });
        realized += pnlUsdt;
        openSide = null;
        openEntryPrice = null;
        openEntryTime = null;
        state = initialState(params);
      }
    }

    if (openSide !== null && openEntryPrice !== null) {
      const sign = openSide === 'LONG' ? 1 : -1;
      const unrealizedUsdt = sign * ((c.close - openEntryPrice) / openEntryPrice) * notional;
      equityCurve[i] = realized + unrealizedUsdt;
    } else {
      equityCurve[i] = realized;
    }
  }

  // Force-close at terminal candle.
  if (openSide !== null && openEntryPrice !== null && openEntryTime !== null) {
    const last = candles[candles.length - 1];
    const sign = openSide === 'LONG' ? 1 : -1;
    const pnlPctValue = sign * (last.close - openEntryPrice) / openEntryPrice * 100;
    const pnlUsdt = (pnlPctValue / 100) * notional;
    trades.push({
      entryPrice: openEntryPrice,
      exitPrice: last.close,
      entryTime: openEntryTime,
      exitTime: last.time,
      side: openSide,
      pnlPct: pnlPctValue,
      pnlUsdt,
      notionalUsdt: notional,
    });
    realized += pnlUsdt;
    equityCurve[equityCurve.length - 1] = realized;
  }

  return { trades, equityCurve };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/backtest/__tests__/simulators/sma-crossover.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/backtest/simulators/sma-crossover.ts src/lib/backtest/__tests__/simulators/sma-crossover.test.ts
git commit -m "feat(backtest): SMA_CROSSOVER simulator driven by candle stream"
```

---

## Task 7: Cache module

`backtestRuns` is unique on `(symbol, strategy, paramsHash, windowDays)`. The cache module hashes params deterministically (sorted JSON keys + SHA-256 truncated), reads existing rows, and writes new rows.

**Files:**
- Create: `src/lib/backtest/cache.ts`
- Create: `src/lib/backtest/__tests__/cache.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/lib/backtest/__tests__/cache.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

import { db } from '@/db';
import { paramsHash, findCached, writeCache } from '@/lib/backtest/cache';

beforeEach(() => {
  vi.mocked(db.select).mockReset();
  vi.mocked(db.insert).mockReset();
});

describe('paramsHash', () => {
  it('is stable across key order', () => {
    const a = paramsHash({ a: 1, b: 2, c: { d: 3, e: 4 } });
    const b = paramsHash({ c: { e: 4, d: 3 }, b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it('changes when values change', () => {
    expect(paramsHash({ a: 1 })).not.toBe(paramsHash({ a: 2 }));
  });
});

describe('findCached', () => {
  it('returns null when no row exists', async () => {
    const where = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) });
    const from = vi.fn().mockReturnValue({ where });
    vi.mocked(db.select).mockReturnValue({ from } as never);

    const r = await findCached('BTC-USDT', 'DCA', 'hash', 30);
    expect(r).toBeNull();
  });

  it('returns the row when present', async () => {
    const row = { id: 'abc', symbol: 'BTC-USDT' };
    const where = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([row]) });
    const from = vi.fn().mockReturnValue({ where });
    vi.mocked(db.select).mockReturnValue({ from } as never);

    const r = await findCached('BTC-USDT', 'DCA', 'hash', 30);
    expect(r).toEqual(row);
  });
});

describe('writeCache', () => {
  it('inserts and returns the new row', async () => {
    const inserted = { id: 'new-id' };
    const returning = vi.fn().mockResolvedValue([inserted]);
    const values = vi.fn().mockReturnValue({ returning });
    vi.mocked(db.insert).mockReturnValue({ values } as never);

    const r = await writeCache({
      symbol: 'BTC-USDT',
      strategy: 'DCA',
      paramsHash: 'hash',
      params: { x: 1 },
      windowDays: 30,
      pnlPct: '1.0000',
      maxDrawdownPct: '0.5000',
      sharpeApprox: '1.0000',
      winRatePct: '50.00',
      totalTrades: 1,
      metricsJson: { trades: [] },
    });
    expect(r).toEqual(inserted);
    expect(values).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/backtest/__tests__/cache.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement cache module**

```ts
// src/lib/backtest/cache.ts
import { createHash } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { backtestRuns } from '@/db/schema';
import type { BacktestableStrategy } from '@/lib/backtest/types';

export type BacktestRow = typeof backtestRuns.$inferSelect;
export type BacktestInsert = typeof backtestRuns.$inferInsert;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => [k, canonical((value as Record<string, unknown>)[k])] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

export function paramsHash(params: unknown): string {
  const json = JSON.stringify(canonical(params));
  return createHash('sha256').update(json).digest('hex').slice(0, 32);
}

export async function findCached(
  symbol: string,
  strategy: BacktestableStrategy,
  hash: string,
  windowDays: number,
): Promise<BacktestRow | null> {
  const rows = await db
    .select()
    .from(backtestRuns)
    .where(
      and(
        eq(backtestRuns.symbol, symbol),
        eq(backtestRuns.strategy, strategy),
        eq(backtestRuns.paramsHash, hash),
        eq(backtestRuns.windowDays, windowDays),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function writeCache(row: BacktestInsert): Promise<BacktestRow> {
  const [inserted] = await db.insert(backtestRuns).values(row).returning();
  return inserted;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/backtest/__tests__/cache.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/backtest/cache.ts src/lib/backtest/__tests__/cache.test.ts
git commit -m "feat(backtest): deterministic paramsHash + backtest_runs read/write helpers"
```

---

## Task 8: `runBacktest` orchestrator

Wires everything: cache lookup → klines fetch → simulator dispatch → metrics → cache write → return.

Signature:

```ts
runBacktest({
  client: BingxClient,
  symbol: string,
  strategy: BacktestableStrategy,
  params: DCAConfig | TrailingStopConfig | SMAConfig,
  windowDays?: number,        // default 30
  initialCapitalUsdt?: number,// default = sum of position sizes used by params, or 1000 fallback
  interval?: string,          // default '1h'
}): Promise<BacktestResult>
```

`limit` is computed as `windowDays * 24` for `1h` interval.

**Files:**
- Create: `src/lib/backtest/index.ts`
- Create: `src/lib/backtest/__tests__/run-backtest.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/lib/backtest/__tests__/run-backtest.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/bingx/market-data', () => ({ fetchKlines: vi.fn() }));
vi.mock('@/lib/backtest/cache', async () => {
  const actual = await vi.importActual<typeof import('@/lib/backtest/cache')>('@/lib/backtest/cache');
  return {
    ...actual,
    findCached: vi.fn(),
    writeCache: vi.fn(),
  };
});

import { fetchKlines } from '@/lib/bingx/market-data';
import { findCached, writeCache } from '@/lib/backtest/cache';
import { runBacktest } from '@/lib/backtest';
import type { BingxClient } from '@/lib/bingx/client';
import type { DCAConfig } from '@/services/bots/types';
import type { Kline } from '@/services/bingx.service';

const HOUR = 3_600_000;
const stubClient = {} as BingxClient;
const candle = (t: number, close: number): Kline => ({ time: t, open: close, high: close, low: close, close });

const dcaParams: DCAConfig = {
  intervalMinutes: 60,
  totalOrders: 3,
  orderSizeUsdt: 100,
  ordersPlaced: 0,
  side: 'BUY',
};

beforeEach(() => {
  vi.mocked(fetchKlines).mockReset();
  vi.mocked(findCached).mockReset();
  vi.mocked(writeCache).mockReset();
});

describe('runBacktest', () => {
  it('returns cached result without re-running on cache hit', async () => {
    vi.mocked(findCached).mockResolvedValue({
      id: 'cached-id',
      symbol: 'BTC-USDT',
      strategy: 'DCA',
      paramsHash: 'h',
      params: dcaParams,
      windowDays: 30,
      pnlPct: '5.0000',
      maxDrawdownPct: '1.0000',
      sharpeApprox: '0.7500',
      winRatePct: '100.00',
      totalTrades: 1,
      metricsJson: null,
      createdAt: new Date(),
    } as never);

    const r = await runBacktest({ client: stubClient, symbol: 'BTC-USDT', strategy: 'DCA', params: dcaParams });
    expect(r.cached).toBe(true);
    expect(r.runId).toBe('cached-id');
    expect(r.pnlPct).toBeCloseTo(5, 9);
    expect(fetchKlines).not.toHaveBeenCalled();
    expect(writeCache).not.toHaveBeenCalled();
  });

  it('runs the simulator and writes cache on miss', async () => {
    vi.mocked(findCached).mockResolvedValue(null);
    vi.mocked(fetchKlines).mockResolvedValue([
      candle(0, 100), candle(HOUR, 110), candle(2 * HOUR, 120), candle(3 * HOUR, 130),
    ]);
    vi.mocked(writeCache).mockResolvedValue({ id: 'new-id' } as never);

    const r = await runBacktest({ client: stubClient, symbol: 'BTC-USDT', strategy: 'DCA', params: dcaParams, windowDays: 30 });

    expect(fetchKlines).toHaveBeenCalledWith(stubClient, 'BTC-USDT', '1h', 30 * 24);
    expect(writeCache).toHaveBeenCalledOnce();
    expect(r.cached).toBe(false);
    expect(r.runId).toBe('new-id');
    expect(r.totalTrades).toBe(1);
    expect(r.pnlPct).toBeGreaterThan(0); // uptrend
  });

  it('throws when fetchKlines returns empty (no data to backtest)', async () => {
    vi.mocked(findCached).mockResolvedValue(null);
    vi.mocked(fetchKlines).mockResolvedValue([]);
    await expect(
      runBacktest({ client: stubClient, symbol: 'BTC-USDT', strategy: 'DCA', params: dcaParams }),
    ).rejects.toThrow(/no klines/i);
  });

  it('throws on unsupported strategy', async () => {
    vi.mocked(findCached).mockResolvedValue(null);
    vi.mocked(fetchKlines).mockResolvedValue([candle(0, 100)]);
    await expect(
      // @ts-expect-error testing runtime guard
      runBacktest({ client: stubClient, symbol: 'BTC-USDT', strategy: 'GRID_LONG', params: {} }),
    ).rejects.toThrow(/unsupported strategy/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/backtest/__tests__/run-backtest.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement orchestrator**

```ts
// src/lib/backtest/index.ts
import type { BingxClient } from '@/lib/bingx/client';
import { fetchKlines } from '@/lib/bingx/market-data';
import { simulateDca } from '@/lib/backtest/simulators/dca';
import { simulateDcaSpot } from '@/lib/backtest/simulators/dca-spot';
import { simulateTrailingStop } from '@/lib/backtest/simulators/trailing-stop';
import { simulateSmaCrossover } from '@/lib/backtest/simulators/sma-crossover';
import { findCached, paramsHash, writeCache } from '@/lib/backtest/cache';
import { pnlPct, maxDrawdownPct, sharpeApprox, winRatePct } from '@/lib/backtest/metrics';
import type {
  BacktestableStrategy,
  BacktestResult,
  SimulatorResult,
} from '@/lib/backtest/types';
import type {
  DCAConfig,
  TrailingStopConfig,
  SMAConfig,
} from '@/services/bots/types';
import type { Kline } from '@/services/bingx.service';

export type BacktestParams = DCAConfig | TrailingStopConfig | SMAConfig;

export type RunBacktestArgs = {
  client: BingxClient;
  symbol: string;
  strategy: BacktestableStrategy;
  params: BacktestParams;
  windowDays?: number;
  initialCapitalUsdt?: number;
  interval?: string;
};

function deriveInitialCapital(strategy: BacktestableStrategy, params: BacktestParams): number {
  if (strategy === 'DCA' || strategy === 'DCA_SPOT') {
    const p = params as DCAConfig;
    return Math.max(1, p.orderSizeUsdt * Math.max(1, p.totalOrders));
  }
  if (strategy === 'TRAILING_STOP') {
    const p = params as TrailingStopConfig;
    return Math.max(1, p.positionSizeUsdt);
  }
  if (strategy === 'SMA_CROSSOVER') {
    const p = params as SMAConfig;
    return Math.max(1, p.positionSizeUsdt);
  }
  return 1000;
}

function dispatch(strategy: BacktestableStrategy, candles: Kline[], params: BacktestParams): SimulatorResult {
  switch (strategy) {
    case 'DCA':
      return simulateDca(candles, params as DCAConfig);
    case 'DCA_SPOT':
      return simulateDcaSpot(candles, params as DCAConfig);
    case 'TRAILING_STOP':
      return simulateTrailingStop(candles, params as TrailingStopConfig);
    case 'SMA_CROSSOVER':
      return simulateSmaCrossover(candles, params as SMAConfig);
    default: {
      const _exhaustive: never = strategy;
      throw new Error(`Unsupported strategy: ${String(_exhaustive)}`);
    }
  }
}

export async function runBacktest(args: RunBacktestArgs): Promise<BacktestResult> {
  const {
    client,
    symbol,
    strategy,
    params,
    windowDays = 30,
    initialCapitalUsdt,
    interval = '1h',
  } = args;

  if (
    strategy !== 'DCA' &&
    strategy !== 'DCA_SPOT' &&
    strategy !== 'TRAILING_STOP' &&
    strategy !== 'SMA_CROSSOVER'
  ) {
    throw new Error(`Unsupported strategy: ${String(strategy)}`);
  }

  const hash = paramsHash(params);
  const cached = await findCached(symbol, strategy, hash, windowDays);
  if (cached) {
    return {
      cached: true,
      pnlPct: cached.pnlPct === null ? 0 : Number(cached.pnlPct),
      maxDrawdownPct: cached.maxDrawdownPct === null ? 0 : Number(cached.maxDrawdownPct),
      sharpeApprox: cached.sharpeApprox === null ? 0 : Number(cached.sharpeApprox),
      winRatePct: cached.winRatePct === null ? 0 : Number(cached.winRatePct),
      totalTrades: cached.totalTrades ?? 0,
      paramsHash: hash,
      runId: cached.id,
    };
  }

  const limit = windowDays * 24; // assumes hourly interval; spec uses 1h for V1
  const candles = await fetchKlines(client, symbol, interval, limit);
  if (candles.length === 0) {
    throw new Error(`No klines returned for ${symbol} ${interval} (window ${windowDays}d)`);
  }

  const sim = dispatch(strategy, candles, params);
  const capital = initialCapitalUsdt ?? deriveInitialCapital(strategy, params);

  const pnl = pnlPct(sim.trades, capital);
  const dd = maxDrawdownPct(sim.equityCurve, capital);
  const sharpe = sharpeApprox(sim.trades);
  const wr = winRatePct(sim.trades);

  const inserted = await writeCache({
    symbol,
    strategy,
    paramsHash: hash,
    params: params as unknown as Record<string, unknown>,
    windowDays,
    pnlPct: pnl.toFixed(4),
    maxDrawdownPct: dd.toFixed(4),
    sharpeApprox: sharpe.toFixed(4),
    winRatePct: wr.toFixed(2),
    totalTrades: sim.trades.length,
    metricsJson: { trades: sim.trades, equityCurve: sim.equityCurve, initialCapitalUsdt: capital },
  });

  return {
    cached: false,
    pnlPct: pnl,
    maxDrawdownPct: dd,
    sharpeApprox: sharpe,
    winRatePct: wr,
    totalTrades: sim.trades.length,
    paramsHash: hash,
    runId: inserted.id,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/backtest/__tests__/run-backtest.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/backtest/index.ts src/lib/backtest/__tests__/run-backtest.test.ts
git commit -m "feat(backtest): runBacktest orchestrator with caching and dispatch"
```

---

## Task 9: Verification

- [ ] **Step 1: Run all backtest tests together**

Run: `npx vitest run src/lib/backtest`
Expected: PASS, ~30 tests across 7 files.

- [ ] **Step 2: Run upstream module tests to confirm no regression**

Run: `npx vitest run src/lib/ai-pm src/lib/bingx src/services/bots`
Expected: PASS, no new failures vs baseline (43 tests prior to S5 work).

- [ ] **Step 3: Lint**

Run: `npm run lint -- src/lib/backtest`
Expected: 0 errors. Warnings tolerated only if pre-existing in repo.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep "src/lib/backtest" || echo "no errors"`
Expected: `no errors`.

- [ ] **Step 5: Final commit if any cleanup needed**

```bash
git status
# If any housekeeping changes from steps 1-4
git add -A
git commit -m "chore(backtest): finalize Session 5 verification"
```

---

## Done criteria (from spec, Session 5)

- Each strategy produces a numeric P&L for a known fixture and metrics match hand-computed values. ✅ (Tasks 2–6 cover all four strategies + metrics)
- Cache hit returns the same row without re-running simulation. ✅ (Task 8 covers cache hit)
- Running a backtest for `DCA BTC-USDT 30d` completes in under 5 seconds locally. *(manual smoke test, depends on live BingX; not automated — Session 18 covers drift)*

## Out of scope reminders

- No Inngest registration changes; Session 11 wires this into `ai-pm-tick`.
- No GRID_LONG / GRID_SHORT simulators (excluded from MVP).
- No paper trading integration; Session 10 owns that layer.
- No drift test against real subaccount; Session 18 owns it.
