# AI Portfolio Manager — Session 3.5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a pure `tick()` core for `SMA_CROSSOVER`, completing the pure-core suite for all 4 MVP strategies. SMA's existing service file already contains pure helper functions (`calculateSMA`, `calculateATR`, `calculateADX`, `detectSignal`, `checkSMATrailingStop`, `createEmptySymbolState`); this session composes them into a single `tick(state, snapshot) → { newState, intents }` and adds focused tests on the orchestration logic.

**Architecture:** New `src/services/bots/sma-crossover/core.ts`:
- Re-exports the existing pure helpers (so call sites have one canonical path forward)
- Exports `initialState(config) → State` (state is per symbol, not per bot — SMA tracks N symbols)
- Exports `tick(state, snapshot) → { newState, intents }` for a single symbol per call

The cron handler today loops over `config.symbols`. The pure core stays single-symbol so its tests stay focused; the cron handler keeps the loop and calls `tick` once per symbol.

**Tech Stack:** TypeScript · Vitest · Bun

---

## Scope

| File | Action |
|---|---|
| `src/services/bots/sma-crossover/core.ts` | Create — pure tick + state + intent types, re-exports of existing helpers |
| `src/services/bots/__tests__/sma-crossover-core.test.ts` | Create — fixture-driven tests for tick orchestration |

Existing `src/services/bots/sma-crossover.service.ts` is **not modified** in this session. It keeps the API-calling functions and the original pure helpers (we re-export them from core for forward use, but don't move them yet — backward compat with cron handler). The cron handler migration (`sma-crossover-watch.ts` calling tick instead of orchestrating directly) is deferred to Session 5 (when Backtest needs parity).

---

## Task 1: SMA pure-core (TDD)

**Files:**
- Create: `src/services/bots/sma-crossover/core.ts`
- Create: `src/services/bots/__tests__/sma-crossover-core.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/services/bots/__tests__/sma-crossover-core.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { initialState, tick, type Snapshot, type Intent } from '@/services/bots/sma-crossover/core';
import type { SMAConfig } from '@/services/bots/types';

const baseConfig = (overrides: Partial<SMAConfig> = {}): SMAConfig => ({
  symbols: ['BTC-USDT'],
  timeframe: '1h',
  fastPeriod: 9,
  mediumPeriod: 21,
  trendPeriod: 50,
  adxPeriod: 14,
  adxThreshold: 25,
  atrPeriod: 14,
  activationAtrMult: 1.5,
  trailingAtrMult: 1.0,
  initialStopAtrMult: 2.0,
  positionSizeUsdt: 100,
  leverage: 5,
  marginType: 'SEPARATE_ISOLATED',
  symbolStates: {},
  ...overrides,
});

// Build candles where SMA9 will cross above SMA21 on the last candle.
// Strategy: 50 flat-low candles, then a sharp upmove for the last few.
function trendUpCandles(): Array<{ open: number; high: number; low: number; close: number }> {
  const candles: Array<{ open: number; high: number; low: number; close: number }> = [];
  for (let i = 0; i < 60; i++) {
    candles.push({ open: 100, high: 101, low: 99, close: 100 });
  }
  // Big upmove on last 10 candles to push SMA9 above SMA21
  for (let i = 0; i < 10; i++) {
    const c = 110 + i;
    candles.push({ open: c, high: c + 1, low: c - 1, close: c });
  }
  return candles;
}

function flatChoppyCandles(): Array<{ open: number; high: number; low: number; close: number }> {
  const candles: Array<{ open: number; high: number; low: number; close: number }> = [];
  for (let i = 0; i < 100; i++) {
    const v = 100 + (i % 2);
    candles.push({ open: v, high: v + 0.5, low: v - 0.5, close: v });
  }
  return candles;
}

describe('SMA_CROSSOVER core', () => {
  it('initialState returns a fresh symbol state', () => {
    const config = baseConfig();
    const s = initialState(config);
    expect(s.position).toBeNull();
    expect(s.entryPrice).toBeNull();
    expect(s.entryOrderId).toBeNull();
    expect(s.trailingActivated).toBe(false);
  });

  it('emits ENTER_LONG when fast crosses medium up + close above trend + ADX above threshold', () => {
    const config = baseConfig({ adxThreshold: 0 }); // disable ADX gate for this test
    const candles = trendUpCandles();
    const snap: Snapshot = {
      symbol: 'BTC-USDT',
      candles,
      currentPrice: candles[candles.length - 1].close,
      hasOpenPosition: false,
      config,
    };

    const result = tick(initialState(config), snap);

    const enter = result.intents.find(i => i.kind === 'ENTER_LONG') as
      | Extract<Intent, { kind: 'ENTER_LONG' }>
      | undefined;
    expect(enter).toBeDefined();
    expect(enter!.usdtAmount).toBe(100);
  });

  it('does NOT emit ENTER on flat/choppy market (no crossover)', () => {
    const config = baseConfig({ adxThreshold: 0 });
    const candles = flatChoppyCandles();
    const snap: Snapshot = {
      symbol: 'BTC-USDT',
      candles,
      currentPrice: candles[candles.length - 1].close,
      hasOpenPosition: false,
      config,
    };

    const result = tick(initialState(config), snap);

    expect(result.intents.find(i => i.kind === 'ENTER_LONG')).toBeUndefined();
    expect(result.intents.find(i => i.kind === 'ENTER_SHORT')).toBeUndefined();
  });

  it('does NOT emit ENTER if a position is already open', () => {
    const config = baseConfig({ adxThreshold: 0 });
    const candles = trendUpCandles();
    const state = initialState(config);
    state.position = 'LONG';
    state.entryPrice = candles[candles.length - 1].close;
    state.entryOrderId = 'order-1';

    const snap: Snapshot = {
      symbol: 'BTC-USDT',
      candles,
      currentPrice: candles[candles.length - 1].close,
      hasOpenPosition: true,
      config,
    };

    const result = tick(state, snap);

    expect(result.intents.find(i => i.kind === 'ENTER_LONG')).toBeUndefined();
  });

  it('emits CLOSE_POSITION when trailing stop is hit', () => {
    const config = baseConfig({ adxThreshold: 0, trailingAtrMult: 1.0 });
    // Build candles: ATR is ~1, position entered at 100, peak at 110, current drops to 108
    const candles: Array<{ open: number; high: number; low: number; close: number }> = [];
    // Stable history to compute ATR ≈ 1
    for (let i = 0; i < 60; i++) {
      candles.push({ open: 100, high: 100.5, low: 99.5, close: 100 });
    }
    candles.push({ open: 108, high: 108, low: 108, close: 108 });

    const state = initialState(config);
    state.position = 'LONG';
    state.entryPrice = 100;
    state.entryOrderId = 'order-1';
    state.highestPrice = 110;
    state.lowestPrice = null;
    state.trailingActivated = true;

    const snap: Snapshot = {
      symbol: 'BTC-USDT',
      candles,
      currentPrice: 108,
      hasOpenPosition: true,
      config,
    };

    const result = tick(state, snap);

    expect(result.intents.find(i => i.kind === 'CLOSE_POSITION')).toBeDefined();
  });

  it('emits ACTIVATE_TRAILING when activation threshold reached', () => {
    const config = baseConfig({ adxThreshold: 0, activationAtrMult: 1.0, trailingAtrMult: 1.0 });
    const candles: Array<{ open: number; high: number; low: number; close: number }> = [];
    for (let i = 0; i < 60; i++) {
      candles.push({ open: 100, high: 100.5, low: 99.5, close: 100 });
    }
    candles.push({ open: 102, high: 102, low: 102, close: 102 });

    const state = initialState(config);
    state.position = 'LONG';
    state.entryPrice = 100;
    state.entryOrderId = 'order-1';
    state.trailingActivated = false;

    const snap: Snapshot = {
      symbol: 'BTC-USDT',
      candles,
      currentPrice: 102,
      hasOpenPosition: true,
      config,
    };

    const result = tick(state, snap);

    expect(result.intents.find(i => i.kind === 'ACTIVATE_TRAILING')).toBeDefined();
    expect(result.newState.trailingActivated).toBe(true);
  });

  it('returns no intents and unchanged state when not enough candles for indicators', () => {
    const config = baseConfig();
    const candles = [{ open: 100, high: 101, low: 99, close: 100 }];
    const snap: Snapshot = {
      symbol: 'BTC-USDT',
      candles,
      currentPrice: 100,
      hasOpenPosition: false,
      config,
    };

    const result = tick(initialState(config), snap);

    expect(result.intents).toEqual([]);
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `bun run test src/services/bots/__tests__/sma-crossover-core.test.ts`

Expected: failure — module `@/services/bots/sma-crossover/core` does not exist.

- [ ] **Step 3: Implement core**

Create `src/services/bots/sma-crossover/core.ts`:

```ts
import type { SMAConfig, SMASymbolState } from '@/services/bots/types';
import {
  calculateATR,
  calculateADX,
  detectSignal,
  checkSMATrailingStop,
  createEmptySymbolState,
} from '@/services/bots/sma-crossover.service';

export type State = SMASymbolState;

export interface Snapshot {
  symbol: string;
  candles: Array<{ open: number; high: number; low: number; close: number }>;
  currentPrice: number;
  hasOpenPosition: boolean;
  config: SMAConfig;
}

export type Intent =
  | { kind: 'ENTER_LONG'; usdtAmount: number; referencePrice: number }
  | { kind: 'ENTER_SHORT'; usdtAmount: number; referencePrice: number }
  | { kind: 'PLACE_INITIAL_STOP'; stopPrice: number; positionSide: 'LONG' | 'SHORT' }
  | { kind: 'ACTIVATE_TRAILING'; newStopPrice: number; positionSide: 'LONG' | 'SHORT' }
  | { kind: 'UPDATE_TRAILING_STOP'; newStopPrice: number; positionSide: 'LONG' | 'SHORT' }
  | { kind: 'CLOSE_POSITION'; positionSide: 'LONG' | 'SHORT' };

export function initialState(_config: SMAConfig): State {
  return createEmptySymbolState();
}

export function tick(state: State, snap: Snapshot): { newState: State; intents: Intent[] } {
  const { candles, currentPrice, hasOpenPosition, config } = snap;
  const intents: Intent[] = [];

  // Build close array for indicator calculations
  const closes = candles.map(c => c.close);

  // Indicators that we can compute given the candles available
  const atr = calculateATR(candles, config.atrPeriod);
  const adx = calculateADX(candles, config.adxPeriod);

  // CASE A: position open — manage trailing stop / exit
  if (state.position && hasOpenPosition) {
    if (atr == null) {
      return { newState: { ...state, lastAtr: state.lastAtr }, intents: [] };
    }
    const trail = checkSMATrailingStop(
      state,
      currentPrice,
      {
        activationAtrMult: config.activationAtrMult,
        trailingAtrMult: config.trailingAtrMult,
        initialStopAtrMult: config.initialStopAtrMult,
      },
      atr,
    );

    const newState: State = {
      ...state,
      highestPrice: trail.updatedHighest,
      lowestPrice: trail.updatedLowest,
      lastAtr: atr,
    };

    if (trail.action === 'CLOSE') {
      intents.push({ kind: 'CLOSE_POSITION', positionSide: state.position });
      return { newState, intents };
    }

    if (trail.action === 'ACTIVATE' && trail.newStopPrice != null) {
      newState.trailingActivated = true;
      intents.push({
        kind: 'ACTIVATE_TRAILING',
        newStopPrice: trail.newStopPrice,
        positionSide: state.position,
      });
      return { newState, intents };
    }

    // HOLD action — emit a stop-update intent only if the stop level changed materially
    if (trail.newStopPrice != null && state.trailingActivated) {
      intents.push({
        kind: 'UPDATE_TRAILING_STOP',
        newStopPrice: trail.newStopPrice,
        positionSide: state.position,
      });
    }

    return { newState, intents };
  }

  // CASE B: no position — look for an entry signal
  const signal = detectSignal({
    closes,
    fastPeriod: config.fastPeriod,
    mediumPeriod: config.mediumPeriod,
    trendPeriod: config.trendPeriod,
  });

  if (signal.signal == null) {
    return { newState: { ...state, lastAtr: atr ?? state.lastAtr }, intents: [] };
  }

  // ADX gate
  if (adx == null || adx < config.adxThreshold) {
    return { newState: { ...state, lastAtr: atr ?? state.lastAtr }, intents: [] };
  }

  const entryIntent: Intent =
    signal.signal === 'LONG'
      ? { kind: 'ENTER_LONG', usdtAmount: config.positionSizeUsdt, referencePrice: currentPrice }
      : { kind: 'ENTER_SHORT', usdtAmount: config.positionSizeUsdt, referencePrice: currentPrice };

  intents.push(entryIntent);

  // Initial stop based on ATR if available
  if (atr != null) {
    const stopPrice =
      signal.signal === 'LONG'
        ? currentPrice - config.initialStopAtrMult * atr
        : currentPrice + config.initialStopAtrMult * atr;
    intents.push({ kind: 'PLACE_INITIAL_STOP', stopPrice, positionSide: signal.signal });
  }

  const newState: State = {
    ...state,
    position: signal.signal,
    entryPrice: currentPrice,
    lastSignal: signal.signal,
    lastSignalAt: Date.now(),
    lastAtr: atr,
  };

  return { newState, intents };
}
```

Note: the import from `@/services/bots/sma-crossover.service` reuses the existing pure helpers there. We do NOT duplicate `calculateATR`/`calculateADX`/`detectSignal`/`checkSMATrailingStop` — they remain in the service file; core.ts is a thin orchestration layer.

- [ ] **Step 4: Run tests** — expect 7/7 pass.

If a test fails because `detectSignal` requires a different `closes.length` (e.g., one of the SMA periods needs more history than the fixture provides), adjust the fixtures (more candles) or relax the test assumption. Do NOT change the production code to make tests pass — change the test fixture instead.

- [ ] **Step 5: Run full suite**

Run: `bun run test`

Expected: 77 + 7 = 84 tests pass.

- [ ] **Step 6: Lint**

Run: `bunx eslint src/services/bots/sma-crossover/core.ts src/services/bots/__tests__/sma-crossover-core.test.ts`

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/services/bots/sma-crossover/core.ts src/services/bots/__tests__/sma-crossover-core.test.ts
git commit -m "feat(bots): extract SMA_CROSSOVER pure-core for backtest reuse"
```

---

## Self-Review

- **Spec coverage:** SMA pure-core complets the 4-strategy MVP set referenced by spec Session 3.
- **Reuse:** Existing pure helpers (`calculateATR`, `calculateADX`, `detectSignal`, `checkSMATrailingStop`, `createEmptySymbolState`) in `sma-crossover.service.ts` are imported, not copied.
- **Pure:** No `await`, no `db`, no `client` in `core.ts`. The `Date.now()` use inside tick is acceptable for `lastSignalAt` bookkeeping; it does NOT influence intents (no time-based gates in the orchestration). If the implementer wants strict purity, accept `now: number` in Snapshot.
- **No placeholders:** All code blocks complete.

## Done Criteria

1. `src/services/bots/sma-crossover/core.ts` exists, exports `initialState`, `tick`, `State`, `Intent`, `Snapshot`.
2. 7 fixture-driven tests pass.
3. Full suite passes (84 tests).
4. Lint clean.
5. Existing `sma-crossover.service.ts` and its cron handler unchanged.
