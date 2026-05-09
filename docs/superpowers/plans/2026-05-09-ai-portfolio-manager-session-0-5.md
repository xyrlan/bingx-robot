# AI Portfolio Manager — Session 0.5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-strategy Inngest cron triggers with a single master cron that fans out events only when matching bots exist. Eliminates idle invocations. Establishes the master/fan-out pattern that Session 11 (`ai-pm-tick`) will reuse.

**Architecture:** One Inngest cron `master-tick` runs `*/1 * * * *`. Each tick loads all running bots once, groups by `botType`, applies per-type cadence (DCA every 5 min, TRAILING every 3, SMA every 60, GRID every 5) via modulo on `Math.floor(Date.now()/60_000)`, and emits `bot.tick.<TYPE>` events with batched `botIds`. Strategy functions stop running on cron and become event-driven; they read bot ids from event payload instead of querying the DB.

**Tech Stack:** Inngest · TypeScript · Drizzle · Vitest · Bun

**Atomicity:** All changes ship in a single PR. Splitting flip-strategy-trigger from master-tick deployment leaves a window where bots miss ticks. Local commits stay granular per task; the merge to main is atomic.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/inngest/events.ts` | Create | Central event-name + payload-type definitions |
| `src/inngest/cadence.ts` | Create | Pure helpers: `shouldDispatch(botType, tickNumber)` for per-type cadence |
| `src/inngest/__tests__/cadence.test.ts` | Create | Vitest coverage for `shouldDispatch` |
| `src/inngest/functions/master-tick.ts` | Create | Cron `*/1 * * * *`. Load bots, group, dispatch events |
| `src/inngest/functions/__tests__/master-tick.test.ts` | Create | Vitest coverage with DB fixtures |
| `src/inngest/functions/dca-bot-watch.ts` | Modify | Trigger: cron → event `bot.tick.DCA`. Read `botIds` from event |
| `src/inngest/functions/dca-spot-bot-watch.ts` | Modify | Same swap with event `bot.tick.DCA_SPOT` |
| `src/inngest/functions/trailing-stop-watch.ts` | Modify | Same swap with event `bot.tick.TRAILING` |
| `src/inngest/functions/sma-crossover-watch.ts` | Modify | Same swap with event `bot.tick.SMA_CROSSOVER` |
| `src/inngest/functions/trading-bot-watch.ts` | Modify | Same swap with event `bot.tick.GRID`. Source-of-truth for active grid bots stays in master |
| `src/app/api/inngest/route.ts` | Modify | Register `masterTick` |
| `src/worker.ts` | Modify | Register `masterTick` |
| `src/services/bingx.service.ts` | Modify | Add `getRunningBotsByIds(botIds)` helper for strategy fns to load fresh bot rows from event payload |

`getRunningBotsByIds` is needed because event payload only carries IDs (small). Strategy fns still need full bot rows to read config, leverage, etc.

---

## Task 1: Create event types

**Files:**
- Create: `src/inngest/events.ts`

- [ ] **Step 1: Write the file**

```ts
/**
 * Inngest event names + payload types for AI portfolio orchestration.
 * Master tick (master-tick.ts) emits these events when corresponding
 * bots are due for a cadence cycle. Strategy handlers consume them.
 */

export type BotTickEventName =
  | 'bot.tick.GRID'
  | 'bot.tick.DCA'
  | 'bot.tick.DCA_SPOT'
  | 'bot.tick.TRAILING'
  | 'bot.tick.SMA_CROSSOVER';

export interface BotTickEventPayload {
  botIds: string[];
  tickNumber: number;
}
```

- [ ] **Step 2: Lint**

Run: `bunx eslint src/inngest/events.ts`

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/inngest/events.ts
git commit -m "feat(inngest): add bot tick event types for master fan-out"
```

---

## Task 2: Cadence helper + tests (TDD)

**Files:**
- Create: `src/inngest/cadence.ts`
- Create: `src/inngest/__tests__/cadence.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/inngest/__tests__/cadence.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { shouldDispatch } from '@/inngest/cadence';

describe('shouldDispatch', () => {
  it('GRID dispatches every 5 minutes', () => {
    expect(shouldDispatch('GRID_LONG', 0)).toBe(true);
    expect(shouldDispatch('GRID_LONG', 1)).toBe(false);
    expect(shouldDispatch('GRID_LONG', 4)).toBe(false);
    expect(shouldDispatch('GRID_LONG', 5)).toBe(true);
    expect(shouldDispatch('GRID_LONG', 10)).toBe(true);
  });

  it('GRID_SHORT shares the GRID cadence', () => {
    expect(shouldDispatch('GRID_SHORT', 0)).toBe(true);
    expect(shouldDispatch('GRID_SHORT', 5)).toBe(true);
    expect(shouldDispatch('GRID_SHORT', 3)).toBe(false);
  });

  it('DCA dispatches every 5 minutes', () => {
    expect(shouldDispatch('DCA', 0)).toBe(true);
    expect(shouldDispatch('DCA', 5)).toBe(true);
    expect(shouldDispatch('DCA', 4)).toBe(false);
  });

  it('DCA_SPOT shares the DCA cadence', () => {
    expect(shouldDispatch('DCA_SPOT', 5)).toBe(true);
    expect(shouldDispatch('DCA_SPOT', 4)).toBe(false);
  });

  it('TRAILING_STOP dispatches every 3 minutes', () => {
    expect(shouldDispatch('TRAILING_STOP', 0)).toBe(true);
    expect(shouldDispatch('TRAILING_STOP', 3)).toBe(true);
    expect(shouldDispatch('TRAILING_STOP', 6)).toBe(true);
    expect(shouldDispatch('TRAILING_STOP', 1)).toBe(false);
    expect(shouldDispatch('TRAILING_STOP', 5)).toBe(false);
  });

  it('SMA_CROSSOVER dispatches every 60 minutes', () => {
    expect(shouldDispatch('SMA_CROSSOVER', 0)).toBe(true);
    expect(shouldDispatch('SMA_CROSSOVER', 60)).toBe(true);
    expect(shouldDispatch('SMA_CROSSOVER', 120)).toBe(true);
    expect(shouldDispatch('SMA_CROSSOVER', 1)).toBe(false);
    expect(shouldDispatch('SMA_CROSSOVER', 59)).toBe(false);
  });

  it('returns false for unknown bot types', () => {
    // @ts-expect-error testing runtime guard
    expect(shouldDispatch('UNKNOWN', 0)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun run test src/inngest/__tests__/cadence.test.ts`

Expected: failure — module `@/inngest/cadence` does not exist.

- [ ] **Step 3: Implement `cadence.ts`**

Create `src/inngest/cadence.ts`:

```ts
import type { BotType } from '@/services/bots/types';

const CADENCE_MINUTES: Record<BotType, number> = {
  GRID_LONG: 5,
  GRID_SHORT: 5,
  DCA: 5,
  DCA_SPOT: 5,
  TRAILING_STOP: 3,
  SMA_CROSSOVER: 60,
};

/**
 * Returns true when the given bot type is due to be dispatched at the
 * given tick number. `tickNumber` is a monotonically-increasing minute
 * counter (typically Math.floor(Date.now() / 60_000)).
 */
export function shouldDispatch(botType: BotType, tickNumber: number): boolean {
  const interval = CADENCE_MINUTES[botType];
  if (!interval) return false;
  return tickNumber % interval === 0;
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun run test src/inngest/__tests__/cadence.test.ts`

Expected: 7 tests pass.

- [ ] **Step 5: Lint**

Run: `bunx eslint src/inngest/cadence.ts src/inngest/__tests__/cadence.test.ts`

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/inngest/cadence.ts src/inngest/__tests__/cadence.test.ts
git commit -m "feat(inngest): add per-bot-type cadence helper"
```

---

## Task 3: `getRunningBotsByIds` helper

Strategy fns receive a list of bot IDs from event payload but need full bot rows for processing. Add a tiny helper.

**Files:**
- Modify: `src/services/bingx.service.ts`
- Create: `src/services/bots/__tests__/get-running-bots-by-ids.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/services/bots/__tests__/get-running-bots-by-ids.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { db } from '@/db';
import { bingxApiKeys, tradingBots, users } from '@/db/schema';
import { getRunningBotsByIds } from '@/services/bingx.service';
import { eq } from 'drizzle-orm';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000002';

async function ensureUser() {
  await db.insert(users).values({
    id: TEST_USER_ID,
    email: 'session05-test@example.com',
  }).onConflictDoNothing();
}

async function makeKey() {
  const [row] = await db.insert(bingxApiKeys).values({
    userId: TEST_USER_ID,
    label: 'TestKey',
    apiKey: 't',
    secretKeyEncrypted: 't',
    managedByAi: false,
  }).returning();
  return row;
}

async function makeBot(apiKeyId: string, status: 'RUNNING' | 'STOPPED') {
  const [row] = await db.insert(tradingBots).values({
    userId: TEST_USER_ID,
    apiKeyId,
    symbol: 'BTC-USDT',
    botType: 'DCA',
    priceMin: '50000',
    priceMax: '60000',
    positionSizeUsdt: '10',
    takeProfitPercentage: '1',
    gridCount: 1,
    leverage: 1,
    status,
  }).returning();
  return row;
}

describe('getRunningBotsByIds', () => {
  beforeAll(async () => { await ensureUser(); });

  afterEach(async () => {
    await db.delete(tradingBots).where(eq(tradingBots.userId, TEST_USER_ID));
    await db.delete(bingxApiKeys).where(eq(bingxApiKeys.userId, TEST_USER_ID));
  });

  it('returns running bots whose ids match', async () => {
    const key = await makeKey();
    const a = await makeBot(key.id, 'RUNNING');
    const b = await makeBot(key.id, 'RUNNING');
    const c = await makeBot(key.id, 'STOPPED');

    const result = await getRunningBotsByIds([a.id, b.id, c.id]);

    const ids = result.map(r => r.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });

  it('returns empty array on empty input', async () => {
    const result = await getRunningBotsByIds([]);
    expect(result).toEqual([]);
  });

  it('skips ids not present', async () => {
    const result = await getRunningBotsByIds(['00000000-0000-0000-0000-000000000999']);
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun run test src/services/bots/__tests__/get-running-bots-by-ids.test.ts`

Expected: failure — `getRunningBotsByIds` not exported.

- [ ] **Step 3: Implement helper**

Open `src/services/bingx.service.ts`. Below `getRunningAiBots`, insert:

```ts
export async function getRunningBotsByIds(botIds: string[]): Promise<TradingBot[]> {
  if (botIds.length === 0) return [];
  return db.query.tradingBots.findMany({
    where: and(
      inArray(tradingBots.id, botIds),
      eq(tradingBots.status, 'RUNNING'),
    ),
  });
}
```

If `inArray` is not imported, add it:

```ts
import { eq, and, desc, isNull, sql, inArray } from 'drizzle-orm';
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun run test src/services/bots/__tests__/get-running-bots-by-ids.test.ts`

Expected: 3 tests pass.

- [ ] **Step 5: Lint**

Run: `bunx eslint src/services/bingx.service.ts src/services/bots/__tests__/get-running-bots-by-ids.test.ts`

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/services/bingx.service.ts src/services/bots/__tests__/get-running-bots-by-ids.test.ts
git commit -m "feat(bingx): add getRunningBotsByIds helper for event-driven strategies"
```

---

## Task 4: Master tick function

**Files:**
- Create: `src/inngest/functions/master-tick.ts`

- [ ] **Step 1: Write the file**

```ts
import { inngest } from '@/inngest/client';
import { db } from '@/db';
import { tradingBots, bingxApiKeys } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { shouldDispatch } from '@/inngest/cadence';
import type { BotType } from '@/services/bots/types';
import type { BotTickEventName, BotTickEventPayload } from '@/inngest/events';

const TYPE_TO_EVENT: Record<BotType, BotTickEventName> = {
  GRID_LONG: 'bot.tick.GRID',
  GRID_SHORT: 'bot.tick.GRID',
  DCA: 'bot.tick.DCA',
  DCA_SPOT: 'bot.tick.DCA_SPOT',
  TRAILING_STOP: 'bot.tick.TRAILING',
  SMA_CROSSOVER: 'bot.tick.SMA_CROSSOVER',
};

interface BotRow {
  id: string;
  botType: BotType;
}

export const masterTick = inngest.createFunction(
  {
    id: 'master-tick',
    name: 'Master Tick (orchestrator)',
    retries: 3,
    concurrency: { limit: 1 },
  },
  { cron: '*/1 * * * *' },
  async ({ step, logger }) => {
    const now = Date.now();
    const tickNumber = Math.floor(now / 60_000);

    const bots = await step.run('load-running-bots', async (): Promise<BotRow[]> => {
      const rows = await db
        .select({ id: tradingBots.id, botType: tradingBots.botType })
        .from(tradingBots)
        .leftJoin(bingxApiKeys, eq(tradingBots.apiKeyId, bingxApiKeys.id))
        .where(eq(tradingBots.status, 'RUNNING'));
      return rows;
    });

    if (bots.length === 0) {
      return { tickNumber, dispatched: {} as Record<string, number> };
    }

    // Group by event name (multiple bot types can map to same event, e.g. GRID_LONG + GRID_SHORT)
    const byEvent = new Map<BotTickEventName, string[]>();
    for (const bot of bots) {
      const eventName = TYPE_TO_EVENT[bot.botType];
      if (!eventName) continue;
      // Cadence is keyed off the source bot type, not the target event.
      // GRID_LONG and GRID_SHORT share cadence (5 min). Either one in the group is sufficient.
      if (!shouldDispatch(bot.botType, tickNumber)) continue;
      const list = byEvent.get(eventName) ?? [];
      list.push(bot.id);
      byEvent.set(eventName, list);
    }

    const events = Array.from(byEvent.entries()).map(([name, botIds]) => ({
      name,
      data: { botIds, tickNumber } satisfies BotTickEventPayload,
    }));

    if (events.length === 0) {
      return { tickNumber, dispatched: {} };
    }

    await step.sendEvent('dispatch-tick-events', events);

    const dispatched: Record<string, number> = {};
    for (const ev of events) dispatched[ev.name] = ev.data.botIds.length;
    logger.info({ tickNumber, dispatched }, 'master-tick dispatched');
    return { tickNumber, dispatched };
  },
);
```

- [ ] **Step 2: Lint**

Run: `bunx eslint src/inngest/functions/master-tick.ts`

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/inngest/functions/master-tick.ts
git commit -m "feat(inngest): master-tick orchestrator with event fan-out"
```

---

## Task 5: Master tick integration test

**Files:**
- Create: `src/inngest/functions/__tests__/master-tick.test.ts`

- [ ] **Step 1: Write test**

```ts
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { db } from '@/db';
import { bingxApiKeys, tradingBots, users } from '@/db/schema';
import { eq } from 'drizzle-orm';

// We test the dispatch logic by extracting a pure helper. Re-import the
// internal mapping by re-creating the same logic here would duplicate.
// Instead, drive the function via a tiny harness that mimics what the
// Inngest runtime would call.

const TEST_USER_ID = '00000000-0000-0000-0000-000000000003';

async function seedUser() {
  await db.insert(users).values({
    id: TEST_USER_ID,
    email: 'session05-master-test@example.com',
  }).onConflictDoNothing();
}

async function seedKey() {
  const [k] = await db.insert(bingxApiKeys).values({
    userId: TEST_USER_ID,
    label: 'k',
    apiKey: 'k',
    secretKeyEncrypted: 'k',
    managedByAi: true,
  }).returning();
  return k;
}

async function seedBot(apiKeyId: string, botType: 'DCA' | 'TRAILING_STOP' | 'GRID_LONG') {
  const [b] = await db.insert(tradingBots).values({
    userId: TEST_USER_ID,
    apiKeyId,
    symbol: 'BTC-USDT',
    botType,
    priceMin: '50000',
    priceMax: '60000',
    positionSizeUsdt: '10',
    takeProfitPercentage: '1',
    gridCount: 1,
    leverage: 1,
    status: 'RUNNING',
  }).returning();
  return b;
}

describe('masterTick dispatch logic', () => {
  beforeAll(async () => { await seedUser(); });
  afterEach(async () => {
    await db.delete(tradingBots).where(eq(tradingBots.userId, TEST_USER_ID));
    await db.delete(bingxApiKeys).where(eq(bingxApiKeys.userId, TEST_USER_ID));
  });

  it('dispatches DCA event when DCA bots are running and tickNumber is multiple of 5', async () => {
    const key = await seedKey();
    await seedBot(key.id, 'DCA');

    const sent: { name: string; data: unknown }[] = [];
    const fakeStep = {
      run: async <T>(_id: string, fn: () => Promise<T>) => fn(),
      sendEvent: async (_id: string, events: { name: string; data: unknown }[]) => {
        sent.push(...events);
      },
    };
    const fakeLogger = { info: () => {} };

    // Force tickNumber that is a multiple of 5
    const now = 5 * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const { masterTick } = await import('@/inngest/functions/master-tick');
    // Inngest function exposes its handler via `.fn` (Inngest internals).
    // Falling back to invoking by manually calling the inner function:
    type Handler = (ctx: { step: unknown; logger: unknown }) => Promise<unknown>;
    const handler = (masterTick as unknown as { fn: Handler }).fn;
    await handler({ step: fakeStep, logger: fakeLogger });

    expect(sent.find(e => e.name === 'bot.tick.DCA')).toBeDefined();
    vi.restoreAllMocks();
  });

  it('does not dispatch when no bots are running', async () => {
    const sent: { name: string; data: unknown }[] = [];
    const fakeStep = {
      run: async <T>(_id: string, fn: () => Promise<T>) => fn(),
      sendEvent: async (_id: string, events: { name: string; data: unknown }[]) => {
        sent.push(...events);
      },
    };
    const fakeLogger = { info: () => {} };

    const { masterTick } = await import('@/inngest/functions/master-tick');
    type Handler = (ctx: { step: unknown; logger: unknown }) => Promise<unknown>;
    const handler = (masterTick as unknown as { fn: Handler }).fn;
    await handler({ step: fakeStep, logger: fakeLogger });

    expect(sent.length).toBe(0);
  });

  it('does not dispatch DCA when tickNumber is NOT a multiple of 5', async () => {
    const key = await seedKey();
    await seedBot(key.id, 'DCA');

    const sent: { name: string; data: unknown }[] = [];
    const fakeStep = {
      run: async <T>(_id: string, fn: () => Promise<T>) => fn(),
      sendEvent: async (_id: string, events: { name: string; data: unknown }[]) => {
        sent.push(...events);
      },
    };
    const fakeLogger = { info: () => {} };

    const now = 4 * 60_000; // tickNumber = 4
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const { masterTick } = await import('@/inngest/functions/master-tick');
    type Handler = (ctx: { step: unknown; logger: unknown }) => Promise<unknown>;
    const handler = (masterTick as unknown as { fn: Handler }).fn;
    await handler({ step: fakeStep, logger: fakeLogger });

    expect(sent.find(e => e.name === 'bot.tick.DCA')).toBeUndefined();
    vi.restoreAllMocks();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun run test src/inngest/functions/__tests__/master-tick.test.ts`

Expected: 3 tests pass.

If the harness pattern (`(masterTick as unknown as { fn: Handler }).fn`) does not work because Inngest does not expose the inner handler, the implementer should escalate (BLOCKED) — do NOT invent an alternative test that does not actually exercise `masterTick`. Possible escalation fix: extract the dispatch logic into a pure function `computeDispatchPlan(bots, tickNumber)` and test that directly.

- [ ] **Step 3: Lint**

Run: `bunx eslint src/inngest/functions/__tests__/master-tick.test.ts`

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/inngest/functions/__tests__/master-tick.test.ts
git commit -m "test(inngest): integration tests for master-tick dispatch"
```

---

## Task 6: Switch `dca-bot-watch` to event trigger

**Files:**
- Modify: `src/inngest/functions/dca-bot-watch.ts`

- [ ] **Step 1: Edit imports**

Open `src/inngest/functions/dca-bot-watch.ts`. Replace the existing import for `getRunningAiBots`:

Old:
```ts
import {
  getRunningAiBots,
  getBotById,
  ...
} from '@/services/bingx.service';
```

New:
```ts
import {
  getRunningBotsByIds,
  getBotById,
  ...
} from '@/services/bingx.service';
import type { BotTickEventPayload } from '@/inngest/events';
```

- [ ] **Step 2: Change trigger and bot fetch**

Find the `inngest.createFunction` definition. Change the trigger argument from `{ cron: '*/5 * * * *' }` to `{ event: 'bot.tick.DCA' }`.

Replace the fetch step. Old (after Session 0):
```ts
    const bots = await step.run('fetch-dca-bots', async () => {
      return getRunningAiBots('DCA');
    });
```

New:
```ts
    const { botIds } = event.data as BotTickEventPayload;
    const bots = await step.run('fetch-dca-bots', async () => {
      return getRunningBotsByIds(botIds);
    });
```

The handler signature must now accept `event`. Change:

Old:
```ts
async ({ step, logger }) => {
```

New:
```ts
async ({ step, logger, event }) => {
```

- [ ] **Step 3: Lint**

Run: `bunx eslint src/inngest/functions/dca-bot-watch.ts`

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/inngest/functions/dca-bot-watch.ts
git commit -m "feat(inngest): trigger dca-bot-watch from bot.tick.DCA event"
```

---

## Task 7: Switch `dca-spot-bot-watch`

**Files:**
- Modify: `src/inngest/functions/dca-spot-bot-watch.ts`

- [ ] **Step 1: Apply identical pattern**

Mirror Task 6:
- Replace `getRunningAiBots` import with `getRunningBotsByIds` and add `BotTickEventPayload` import.
- Change trigger from `{ cron: '*/5 * * * *' }` to `{ event: 'bot.tick.DCA_SPOT' }`.
- Change handler signature to include `event`.
- Replace `return getRunningAiBots('DCA_SPOT')` with `return getRunningBotsByIds(botIds)`.

- [ ] **Step 2: Lint**

Run: `bunx eslint src/inngest/functions/dca-spot-bot-watch.ts`

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/inngest/functions/dca-spot-bot-watch.ts
git commit -m "feat(inngest): trigger dca-spot-bot-watch from bot.tick.DCA_SPOT event"
```

---

## Task 8: Switch `trailing-stop-watch`

**Files:**
- Modify: `src/inngest/functions/trailing-stop-watch.ts`

- [ ] **Step 1: Apply identical pattern**

- Replace imports with `getRunningBotsByIds` + add `BotTickEventPayload`.
- Change trigger from `{ cron: '*/3 * * * *' }` to `{ event: 'bot.tick.TRAILING' }`.
- Change handler signature.
- Replace `return getRunningAiBots('TRAILING_STOP')` with `return getRunningBotsByIds(botIds)`.

- [ ] **Step 2: Lint**

Run: `bunx eslint src/inngest/functions/trailing-stop-watch.ts`

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/inngest/functions/trailing-stop-watch.ts
git commit -m "feat(inngest): trigger trailing-stop-watch from bot.tick.TRAILING event"
```

---

## Task 9: Switch `sma-crossover-watch`

**Files:**
- Modify: `src/inngest/functions/sma-crossover-watch.ts`

This file has a `shouldProcessCandle` timeframe gate around the cron run. Per-type cadence is now in master-tick (60-min cadence for SMA), so the timeframe check should remain ONLY if it gates by candle close timing (not duplicate cadence).

- [ ] **Step 1: Apply identical pattern**

- Replace imports with `getRunningBotsByIds` + add `BotTickEventPayload`.
- Change trigger from `{ cron: ... }` to `{ event: 'bot.tick.SMA_CROSSOVER' }`.
- Change handler signature.
- Replace `getRunningAiBots('SMA_CROSSOVER')` call with `getRunningBotsByIds(botIds)`.

- [ ] **Step 2: Decide on `shouldProcessCandle`**

Read the existing `shouldProcessCandle(timeframe)` function inside the file. Two cases:
- **Case A:** It gates by whether the current hour aligns with the bot's timeframe (1h, 4h, 1d). Keep it — the master-tick fires every 60 min on the SMA event, but a 4h bot should only process every 4 hours. The gate is correct and complements master cadence.
- **Case B:** It duplicates cadence (e.g. "only run every hour"). Remove it — master-tick already enforces hourly cadence.

If unsure, leave the function in place (Case A is the more likely original intent; it filters the *bot list*, not the cron execution).

- [ ] **Step 3: Lint**

Run: `bunx eslint src/inngest/functions/sma-crossover-watch.ts`

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/inngest/functions/sma-crossover-watch.ts
git commit -m "feat(inngest): trigger sma-crossover-watch from bot.tick.SMA_CROSSOVER event"
```

---

## Task 10: Switch `trading-bot-watch` (grid)

**Files:**
- Modify: `src/inngest/functions/trading-bot-watch.ts`

This function processes both GRID_LONG and GRID_SHORT bots. Master-tick maps both types to the same event `bot.tick.GRID`, so this function receives a single event for the union of grid bots.

- [ ] **Step 1: Read the file**

Open `src/inngest/functions/trading-bot-watch.ts`. Note the existing in-memory filter:

```ts
const gridBots = bots.filter(b => !b.botType || b.botType === 'GRID_LONG' || b.botType === 'GRID_SHORT');
```

This filter is no longer needed — master-tick only sends grid-bot IDs in the event payload. The handler can trust the input.

- [ ] **Step 2: Apply pattern**

- Replace `getRunningBots` (or `getRunningAiBots` if Session 0 already swapped — verify) with `getRunningBotsByIds`.
- Change trigger from `{ cron: ... }` to `{ event: 'bot.tick.GRID' }`.
- Change handler signature to include `event`.
- Replace the bot-fetch step with:

  ```ts
  const { botIds } = event.data as BotTickEventPayload;
  const bots = await step.run('fetch-grid-bots', async () => {
    return getRunningBotsByIds(botIds);
  });
  ```

- Remove the in-memory `.filter(b => ... GRID_LONG ... GRID_SHORT ...)` line.
- Add the import for `BotTickEventPayload`.

- [ ] **Step 3: Lint**

Run: `bunx eslint src/inngest/functions/trading-bot-watch.ts`

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/inngest/functions/trading-bot-watch.ts
git commit -m "feat(inngest): trigger trading-bot-watch from bot.tick.GRID event"
```

---

## Task 11: Register `masterTick` in route + worker

**Files:**
- Modify: `src/app/api/inngest/route.ts`
- Modify: `src/worker.ts`

- [ ] **Step 1: Edit `route.ts`**

Open `src/app/api/inngest/route.ts`. Add the master-tick import at the top:

```ts
import { masterTick } from "@/inngest/functions/master-tick";
```

Add `masterTick` as the first entry in the `functions` array:

```ts
const functions = [
  masterTick,
  tradingBotWatch,
  dcaBotWatch,
  trailingStopWatch,
  dcaSpotBotWatch,
  smaCrossoverWatch,
];
```

Lint: `bunx eslint src/app/api/inngest/route.ts`. Expected: clean.

- [ ] **Step 2: Edit `worker.ts`**

Open `src/worker.ts`. Add the import:

```ts
import { masterTick } from '@/inngest/functions/master-tick';
```

Add `masterTick` to the `functions` array inside `connect()`:

```ts
        functions: [
          masterTick,
          tradingBotWatch,
          dcaBotWatch,
          trailingStopWatch,
          dcaSpotBotWatch,
          smaCrossoverWatch,
        ],
```

Lint: `bunx eslint src/worker.ts`. Expected: clean.

- [ ] **Step 3: Commit (single commit covering both)**

```bash
git add src/app/api/inngest/route.ts src/worker.ts
git commit -m "feat(inngest): register master-tick orchestrator"
```

---

## Task 12: Smoke + manual verification (user runs)

**Files:** none modified.

- [ ] **Step 1: Run full test suite**

Run: `bun run test`

Expected: all previously-green tests still pass + new tests from Tasks 2, 3, 5 pass.

- [ ] **Step 2: Lint full repo on touched files**

Run: `bunx eslint src/inngest/{events,cadence}.ts src/inngest/functions/master-tick.ts src/inngest/functions/{dca-bot-watch,dca-spot-bot-watch,trailing-stop-watch,sma-crossover-watch,trading-bot-watch}.ts src/app/api/inngest/route.ts src/worker.ts src/services/bingx.service.ts`

Expected: clean.

- [ ] **Step 3: Manual smoke (user-run)**

Start dev server + Inngest dev:
```bash
bun run dev    # terminal 1
bun run inngest # terminal 2
```

Open `http://localhost:8288/functions`. Confirm 6 functions registered: `master-tick`, `trading-bot-watch`, `dca-bot-watch`, `dca-spot-bot-watch`, `trailing-stop-watch`, `sma-crossover-watch`.

Trigger `master-tick` once with empty body. Expected: `{ tickNumber: <N>, dispatched: {} }` when no bots are RUNNING.

Insert a test DCA bot with `managedByAi=true` key (use seed script from Session 0 plan Task 10). Wait until next tick where `tickNumber % 5 === 0`. Confirm in Inngest dashboard:
- `master-tick` returns `dispatched: { 'bot.tick.DCA': 1 }`.
- `bot.tick.DCA` event appears in event log.
- `dca-bot-watch` invocation appears with `event.data.botIds` containing the test bot's ID.

If any link in the chain is missing, the wiring is incorrect — escalate.

- [ ] **Step 4: No commit needed — verification only**

If everything verified, Session 0.5 is complete.

---

## Self-Review

- **Spec coverage:** Session 0.5 spec entry calls for events.ts (Task 1), cadence (Task 2 + helper used in Task 4), master-tick (Tasks 4-5), 5 strategy switches (Tasks 6-10), registration (Task 11). All covered.
- **Placeholder scan:** All steps include exact code or commands. The `Case A vs Case B` decision in Task 9 names both options explicitly with criteria; not a placeholder.
- **Type consistency:** `BotTickEventPayload` defined in Task 1 used in Tasks 6-10. `getRunningBotsByIds` defined in Task 3 used in Tasks 6-10. `shouldDispatch` defined in Task 2 used in Task 4. Master event mapping in Task 4 matches event names from Task 1.
- **Atomicity:** All 12 tasks land on a single feature branch. Merging this branch is atomic; intermediate commits within the branch can be reordered without affecting external behavior.

## Done Criteria for Session 0.5

1. `bun run test` passes including all new tests.
2. Inngest dev UI lists `master-tick` plus 5 strategy functions.
3. Strategy functions are triggered by event (not cron) — confirmed in Inngest dashboard.
4. With zero bots, only `master-tick` invocations occur.
5. With a test DCA bot, the chain master-tick → `bot.tick.DCA` → `dca-bot-watch` runs end-to-end at tick numbers that are multiples of 5.
6. Per-type cadence verified over 30 minutes of dev observation.
