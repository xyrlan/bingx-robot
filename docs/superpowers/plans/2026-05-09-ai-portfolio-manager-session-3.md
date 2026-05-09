# AI Portfolio Manager — Session 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract pure simulation cores for the three simpler MVP strategies (`DCA`, `DCA_SPOT`, `TRAILING_STOP`) so backtest and real cron paths share the same decision logic. SMA_CROSSOVER (412 lines, complex) is deferred to a separate Session 3.5.

**Architecture:** Each strategy gets `src/services/bots/<strategy>/core.ts` exporting:
- `Intent` discriminated union (per-strategy variants of `PLACE_ENTRY`, `CLOSE_POSITION`, `RECORD_TRADE`)
- `initialState(config) → State`
- `tick(state, snapshot) → { newState, intents }` (pure, no IO)

The cron handler reads bot row, builds state from config, calls `tick`, then translates each `Intent` into a BingX API call + DB write. Backtest later (Session 5) reads historical candles and feeds them through the same `tick` function — no API calls, just intents accumulating into a trade list.

This session **does not change the strategy's external behavior** — same orders, same timing. Pure refactor with parity tests.

**Tech Stack:** TypeScript · Vitest · Bun

---

## Scope

| Strategy | Pure-core file | Test file |
|---|---|---|
| DCA | `src/services/bots/dca/core.ts` | `src/services/bots/__tests__/dca-core.test.ts` |
| DCA_SPOT | `src/services/bots/dca-spot/core.ts` | `src/services/bots/__tests__/dca-spot-core.test.ts` |
| TRAILING_STOP | `src/services/bots/trailing-stop/core.ts` | `src/services/bots/__tests__/trailing-stop-core.test.ts` |

`SMA_CROSSOVER` is deferred to Session 3.5 due to its size (412 lines) and indicator complexity (RSI/ATR/ADX gating + multi-symbol state).

---

## Common types

Each strategy's `core.ts` re-exports its own `Intent` type. There is **no shared base intent** — keeping each strategy's intent narrow makes tests and call sites simpler.

---

## Task 1: DCA pure-core

**Files:**
- Create: `src/services/bots/dca/core.ts`
- Create: `src/services/bots/__tests__/dca-core.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { initialState, tick, type Snapshot, type Intent } from '@/services/bots/dca/core';
import type { DCAConfig } from '@/services/bots/types';

const baseConfig = (overrides: Partial<DCAConfig> = {}): DCAConfig => ({
  intervalMinutes: 60,
  totalOrders: 5,
  orderSizeUsdt: 100,
  ordersPlaced: 0,
  side: 'BUY',
  ...overrides,
});

const ms = (h: number) => h * 60 * 60 * 1000;

describe('DCA core', () => {
  it('initialState carries forward ordersPlaced and lastOrderAt from config', () => {
    const config = baseConfig({ ordersPlaced: 2, lastOrderAt: 12345 });
    const state = initialState(config);
    expect(state.ordersPlaced).toBe(2);
    expect(state.lastOrderAt).toBe(12345);
  });

  it('emits PLACE_ENTRY when interval has elapsed and not all orders placed', () => {
    const config = baseConfig({ ordersPlaced: 1, lastOrderAt: 0 });
    const snap: Snapshot = { now: ms(2), currentPrice: 50000, botCreatedAt: 0, config };

    const result = tick(initialState(config), snap);

    expect(result.intents).toHaveLength(1);
    const intent = result.intents[0] as Extract<Intent, { kind: 'PLACE_ENTRY' }>;
    expect(intent.kind).toBe('PLACE_ENTRY');
    expect(intent.side).toBe('BUY');
    expect(intent.usdtAmount).toBe(100);
    expect(intent.referencePrice).toBe(50000);
    expect(result.newState.ordersPlaced).toBe(2);
    expect(result.newState.lastOrderAt).toBe(ms(2));
  });

  it('does NOT emit when interval has not elapsed', () => {
    const config = baseConfig({ ordersPlaced: 1, lastOrderAt: ms(1) });
    const snap: Snapshot = { now: ms(1) + 60_000, currentPrice: 50000, botCreatedAt: 0, config };

    const result = tick(initialState(config), snap);

    expect(result.intents).toEqual([]);
    expect(result.newState.ordersPlaced).toBe(1);
  });

  it('emits BOT_DONE when ordersPlaced reaches totalOrders after a fill', () => {
    const config = baseConfig({ ordersPlaced: 4, lastOrderAt: 0 });
    const snap: Snapshot = { now: ms(2), currentPrice: 50000, botCreatedAt: 0, config };

    const result = tick(initialState(config), snap);

    const kinds = result.intents.map(i => i.kind);
    expect(kinds).toContain('PLACE_ENTRY');
    expect(kinds).toContain('BOT_DONE');
    expect(result.newState.ordersPlaced).toBe(5);
  });

  it('does NOT emit when ordersPlaced already at totalOrders', () => {
    const config = baseConfig({ ordersPlaced: 5, lastOrderAt: 0 });
    const snap: Snapshot = { now: ms(2), currentPrice: 50000, botCreatedAt: 0, config };

    const result = tick(initialState(config), snap);

    expect(result.intents).toEqual([]);
  });

  it('SELL side produces SELL intent', () => {
    const config = baseConfig({ side: 'SELL' });
    const snap: Snapshot = { now: ms(2), currentPrice: 50000, botCreatedAt: 0, config };

    const result = tick(initialState(config), snap);

    const intent = result.intents[0] as Extract<Intent, { kind: 'PLACE_ENTRY' }>;
    expect(intent.side).toBe('SELL');
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `bun run test src/services/bots/__tests__/dca-core.test.ts`

Expected: failure — module not found.

- [ ] **Step 3: Implement core**

Create `src/services/bots/dca/core.ts`:

```ts
import type { DCAConfig } from '@/services/bots/types';

export interface Snapshot {
  now: number;
  currentPrice: number;
  botCreatedAt: number;
  config: DCAConfig;
}

export interface State {
  ordersPlaced: number;
  lastOrderAt: number | null;
}

export type Intent =
  | { kind: 'PLACE_ENTRY'; side: 'BUY' | 'SELL'; usdtAmount: number; referencePrice: number }
  | { kind: 'BOT_DONE' };

export function initialState(config: DCAConfig): State {
  return {
    ordersPlaced: config.ordersPlaced,
    lastOrderAt: config.lastOrderAt ?? null,
  };
}

export function tick(state: State, snap: Snapshot): { newState: State; intents: Intent[] } {
  const { now, currentPrice, botCreatedAt, config } = snap;

  if (state.ordersPlaced >= config.totalOrders) {
    return { newState: state, intents: [] };
  }

  const intervalMs = config.intervalMinutes * 60 * 1000;

  let due = false;
  if (state.lastOrderAt) {
    due = now - state.lastOrderAt >= intervalMs;
  } else {
    const elapsed = now - botCreatedAt;
    const expected = Math.floor(elapsed / intervalMs) + 1;
    due = state.ordersPlaced < expected;
  }

  if (!due) return { newState: state, intents: [] };

  const intents: Intent[] = [
    {
      kind: 'PLACE_ENTRY',
      side: config.side,
      usdtAmount: config.orderSizeUsdt,
      referencePrice: currentPrice,
    },
  ];
  const newState: State = {
    ordersPlaced: state.ordersPlaced + 1,
    lastOrderAt: now,
  };
  if (newState.ordersPlaced >= config.totalOrders) {
    intents.push({ kind: 'BOT_DONE' });
  }
  return { newState, intents };
}
```

- [ ] **Step 4: Run tests** — expect 6/6 pass.

- [ ] **Step 5: Lint** — `bunx eslint src/services/bots/dca/core.ts src/services/bots/__tests__/dca-core.test.ts` clean.

- [ ] **Step 6: Commit**

```bash
git add src/services/bots/dca/core.ts src/services/bots/__tests__/dca-core.test.ts
git commit -m "feat(bots): extract DCA pure-core for backtest reuse"
```

---

## Task 2: DCA_SPOT pure-core

DCA_SPOT shares the timing logic with DCA but operates on spot (no leverage, no positionSide). The only difference per `dca-spot.service.ts` is the order placement endpoint and absence of `positionSide`. Pure-core is identical except the intent's `positionSide` field is omitted.

In practice the two cores are 95% the same. We **DO duplicate** rather than abstract — Strategy Scope decisions might diverge later (e.g., DCA_SPOT could add take-profit after each buy). Easier to read, easier to change.

**Files:**
- Create: `src/services/bots/dca-spot/core.ts`
- Create: `src/services/bots/__tests__/dca-spot-core.test.ts`

- [ ] **Step 1: Write tests**

Identical pattern to DCA Task 1 with the imports pointed at `dca-spot/core`. Copy the test file from Task 1 and change the import path.

- [ ] **Step 2: Implement core**

```ts
import type { DCAConfig } from '@/services/bots/types';

export interface Snapshot {
  now: number;
  currentPrice: number;
  botCreatedAt: number;
  config: DCAConfig;
}

export interface State {
  ordersPlaced: number;
  lastOrderAt: number | null;
}

export type Intent =
  | { kind: 'PLACE_SPOT_BUY'; usdtAmount: number; referencePrice: number }
  | { kind: 'BOT_DONE' };

export function initialState(config: DCAConfig): State {
  return {
    ordersPlaced: config.ordersPlaced,
    lastOrderAt: config.lastOrderAt ?? null,
  };
}

export function tick(state: State, snap: Snapshot): { newState: State; intents: Intent[] } {
  const { now, currentPrice, botCreatedAt, config } = snap;

  if (state.ordersPlaced >= config.totalOrders) {
    return { newState: state, intents: [] };
  }

  const intervalMs = config.intervalMinutes * 60 * 1000;
  let due = false;
  if (state.lastOrderAt) {
    due = now - state.lastOrderAt >= intervalMs;
  } else {
    const elapsed = now - botCreatedAt;
    const expected = Math.floor(elapsed / intervalMs) + 1;
    due = state.ordersPlaced < expected;
  }

  if (!due) return { newState: state, intents: [] };

  const intents: Intent[] = [
    { kind: 'PLACE_SPOT_BUY', usdtAmount: config.orderSizeUsdt, referencePrice: currentPrice },
  ];
  const newState: State = {
    ordersPlaced: state.ordersPlaced + 1,
    lastOrderAt: now,
  };
  if (newState.ordersPlaced >= config.totalOrders) {
    intents.push({ kind: 'BOT_DONE' });
  }
  return { newState, intents };
}
```

DCA_SPOT does not have `side` (always buy on spot). Tests should reflect that — drop the SELL test case and the side field assertions.

- [ ] **Step 3: Run, lint, commit**

```bash
git add src/services/bots/dca-spot/core.ts src/services/bots/__tests__/dca-spot-core.test.ts
git commit -m "feat(bots): extract DCA_SPOT pure-core for backtest reuse"
```

---

## Task 3: TRAILING_STOP pure-core

TRAILING has more state (entry order id, position open, highest price tracking, activation flag).

**Files:**
- Create: `src/services/bots/trailing-stop/core.ts`
- Create: `src/services/bots/__tests__/trailing-stop-core.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { initialState, tick, type Snapshot, type Intent } from '@/services/bots/trailing-stop/core';
import type { TrailingStopConfig } from '@/services/bots/types';

const baseConfig = (overrides: Partial<TrailingStopConfig> = {}): TrailingStopConfig => ({
  activationPricePct: 1,
  trailingPct: 0.5,
  positionSizeUsdt: 100,
  highestPrice: 0,
  isActivated: false,
  entryOrderId: null,
  ...overrides,
});

describe('TRAILING_STOP core', () => {
  it('emits PLACE_ENTRY when no entry yet', () => {
    const config = baseConfig({ entryOrderId: null });
    const snap: Snapshot = { currentPrice: 50000, hasOpenPosition: false, config };

    const result = tick(initialState(config), snap);

    const intent = result.intents.find(i => i.kind === 'PLACE_ENTRY') as Extract<Intent, { kind: 'PLACE_ENTRY' }>;
    expect(intent).toBeDefined();
    expect(intent.usdtAmount).toBe(100);
    expect(intent.referencePrice).toBe(50000);
  });

  it('does not place entry if entryOrderId already set', () => {
    const config = baseConfig({ entryOrderId: 'order-1', entryPrice: 50000 });
    const snap: Snapshot = { currentPrice: 50000, hasOpenPosition: true, config };

    const result = tick(initialState(config), snap);

    expect(result.intents.find(i => i.kind === 'PLACE_ENTRY')).toBeUndefined();
  });

  it('activates when price crosses activation threshold', () => {
    const config = baseConfig({
      entryOrderId: 'order-1',
      entryPrice: 50000,
      isActivated: false,
      activationPricePct: 1,
    });
    const snap: Snapshot = { currentPrice: 50500, hasOpenPosition: true, config };

    const result = tick(initialState(config), snap);

    expect(result.newState.isActivated).toBe(true);
    expect(result.newState.highestPrice).toBeGreaterThanOrEqual(50500);
  });

  it('updates highestPrice while active', () => {
    const config = baseConfig({
      entryOrderId: 'order-1',
      entryPrice: 50000,
      highestPrice: 50500,
      isActivated: true,
    });
    const snap: Snapshot = { currentPrice: 50800, hasOpenPosition: true, config };

    const result = tick(initialState(config), snap);

    expect(result.newState.highestPrice).toBe(50800);
    expect(result.intents.find(i => i.kind === 'CLOSE_POSITION')).toBeUndefined();
  });

  it('emits CLOSE_POSITION when price drops below trailing threshold', () => {
    const config = baseConfig({
      entryOrderId: 'order-1',
      entryPrice: 50000,
      highestPrice: 51000,
      isActivated: true,
      trailingPct: 0.5,
    });
    const trailPrice = 51000 * (1 - 0.5 / 100);  // 50745
    const snap: Snapshot = { currentPrice: trailPrice - 1, hasOpenPosition: true, config };

    const result = tick(initialState(config), snap);

    expect(result.intents.find(i => i.kind === 'CLOSE_POSITION')).toBeDefined();
  });
});
```

- [ ] **Step 2: Run failing tests** — expect failures.

- [ ] **Step 3: Implement core**

```ts
import type { TrailingStopConfig } from '@/services/bots/types';

export interface Snapshot {
  currentPrice: number;
  hasOpenPosition: boolean;
  config: TrailingStopConfig;
}

export interface State {
  entryOrderId: string | null;
  entryPrice: number | null;
  highestPrice: number;
  isActivated: boolean;
}

export type Intent =
  | { kind: 'PLACE_ENTRY'; usdtAmount: number; referencePrice: number }
  | { kind: 'CLOSE_POSITION' };

export function initialState(config: TrailingStopConfig): State {
  return {
    entryOrderId: config.entryOrderId,
    entryPrice: config.entryPrice ?? null,
    highestPrice: config.highestPrice ?? 0,
    isActivated: config.isActivated,
  };
}

export function tick(state: State, snap: Snapshot): { newState: State; intents: Intent[] } {
  const { currentPrice, hasOpenPosition, config } = snap;

  if (!state.entryOrderId) {
    return {
      newState: state,
      intents: [
        {
          kind: 'PLACE_ENTRY',
          usdtAmount: config.positionSizeUsdt,
          referencePrice: currentPrice,
        },
      ],
    };
  }

  if (!hasOpenPosition) {
    return { newState: state, intents: [] };
  }

  const entryPrice = state.entryPrice ?? currentPrice;
  const newHighest = Math.max(state.highestPrice || entryPrice, currentPrice);

  if (!state.isActivated) {
    const activationPrice = entryPrice * (1 + config.activationPricePct / 100);
    if (currentPrice >= activationPrice) {
      return {
        newState: { ...state, isActivated: true, highestPrice: newHighest },
        intents: [],
      };
    }
    return { newState: { ...state, highestPrice: newHighest }, intents: [] };
  }

  const trailPrice = newHighest * (1 - config.trailingPct / 100);
  if (currentPrice <= trailPrice) {
    return {
      newState: { ...state, highestPrice: newHighest },
      intents: [{ kind: 'CLOSE_POSITION' }],
    };
  }

  return { newState: { ...state, highestPrice: newHighest }, intents: [] };
}
```

- [ ] **Step 4: Run tests** — 5/5 pass.

- [ ] **Step 5: Lint, commit**

```bash
git add src/services/bots/trailing-stop/core.ts src/services/bots/__tests__/trailing-stop-core.test.ts
git commit -m "feat(bots): extract TRAILING_STOP pure-core for backtest reuse"
```

---

## Task 4: Wire cores into the existing services (parity)

The existing service files (`dca.service.ts`, `dca-spot.service.ts`, `trailing-stop.service.ts`) keep their async functions for IO. This task connects the pure cores to the cron handlers without changing observable behavior.

This is **optional for Session 3** if scope is tight. The pure cores are testable on their own and Backtest (Session 5) needs them. The cron handlers can keep using the original logic — they will be migrated when Backtest needs the parity test.

**Recommended:** ship Tasks 1–3 first, leave Task 4 for Session 3.5 or Session 5 (when backtest provides motivation to ensure parity).

If implementer wants to do Task 4 anyway: add a parity test that runs the existing service path and the new pure core on the same fixture and asserts the same intents would be produced. Don't change the service code yet — just compare.

---

## Self-Review

- **Spec coverage:** Spec Session 3 entry asks for cores for DCA, DCA_SPOT, TRAILING_STOP, SMA_CROSSOVER. SMA is split into Session 3.5 due to complexity. Note this in the report so the planner can add Session 3.5 to spec later.
- **No placeholders:** All test fixtures and code blocks are concrete.
- **Type consistency:** `Intent` per strategy; `tick(state, snap)` signature consistent across cores.
- **Pure:** No `await`, no `db`, no `client`. Verified via lint.
- **YAGNI:** No shared `BaseIntent` abstraction; each strategy's intent is narrow and self-contained.

## Done Criteria

1. Three new `core.ts` files: dca, dca-spot, trailing-stop.
2. Three new `__tests__/<name>-core.test.ts` files; all tests pass.
3. `bun run test` passes (61 + new tests).
4. `bunx eslint` clean on touched files.
5. SMA_CROSSOVER deferred to Session 3.5; spec to be updated separately.
