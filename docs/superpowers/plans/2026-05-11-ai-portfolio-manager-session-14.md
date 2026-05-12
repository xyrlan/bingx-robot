# AI Portfolio Manager — Session 14: Event-Driven Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the AI Portfolio Manager react to drawdown, fill, funding-flip, error, and chat events within ~5 minutes instead of waiting for the 30-minute cron.

**Architecture:** Five Inngest event names (`ai-pm/event.*`). A wildcard subscriber (`ai-pm-event-handler`) inserts an `ai_events` row, debounces by `(configId, eventType, symbol)` over 5 minutes, then runs the existing AI PM pipeline scoped to one symbol (or decision-only for chat). Detection happens in three places: existing bot-watch handlers emit fill/error events for AI-managed real bots, a new `ai-pm-monitor` cron (every 5 minutes) advances paper bots and emits drawdown/funding-flip, and a new `POST /api/ai-pm/chat` route emits chat events.

**Tech Stack:** Next.js 16 (App Router), Drizzle ORM + PostgreSQL (Supabase), Inngest, Vitest, TypeScript. Branch: `feat/ai-pm-monitor`.

**Reference spec:** `docs/superpowers/specs/2026-05-11-ai-pm-monitor-design.md`

---

## File map

**Create:**
- `src/lib/ai-pm/events.ts` — payload types, event name constants, `mapNameToEnum` helper.
- `src/lib/ai-pm/event-pipeline.ts` — `runScopedPipeline` (signal[symbol] → decision → validate → execute).
- `src/lib/ai-pm/chat-pipeline.ts` — `runChatPipeline` (decision-only path; persists chat reply).
- `src/services/ai-events.service.ts` — `insertAiEvent`, `markEvent`, `checkThrottle`.
- `src/services/paper-bot-sim.service.ts` — advances paper bots one bar; helpers to emit fill/error/drawdown.
- `src/inngest/functions/ai-pm-event-handler.ts` — wildcard Inngest function.
- `src/inngest/functions/ai-pm-monitor.ts` — 5-minute cron (paper tick + drawdown + funding flip).
- `src/app/api/ai-pm/chat/route.ts` — POST endpoint that inserts chat row + emits event.
- `src/lib/ai-pm/__tests__/events.test.ts`
- `src/lib/ai-pm/__tests__/event-pipeline.test.ts`
- `src/lib/ai-pm/__tests__/chat-pipeline.test.ts`
- `src/services/__tests__/ai-events.service.test.ts`
- `src/services/__tests__/paper-bot-sim.service.test.ts`
- `src/inngest/functions/__tests__/ai-pm-event-handler.test.ts`
- `src/inngest/functions/__tests__/ai-pm-monitor.test.ts`
- `src/app/api/ai-pm/chat/__tests__/route.test.ts`
- `drizzle/0012_ai_events.sql` (drizzle-generated, name may differ)

**Modify:**
- `src/db/schema.ts` — add `aiEventStatusEnum`, `aiEvents`, `aiPmFundingCache` tables + relations.
- `src/app/api/inngest/route.ts` — register `aiPmEventHandler` and `aiPmMonitor`.
- `src/inngest/functions/trading-bot-watch.ts` — emit fill/error events for AI-managed bots.
- `src/inngest/functions/dca-bot-watch.ts` — same.
- `src/inngest/functions/dca-spot-bot-watch.ts` — same.
- `src/inngest/functions/trailing-stop-watch.ts` — same.
- `src/inngest/functions/sma-crossover-watch.ts` — same.

---

### Task 1: Schema additions

**Files:**
- Modify: `src/db/schema.ts`
- Create: `drizzle/0012_ai_events.sql` (via `npm run db:generate`)
- Test: `src/db/__tests__/ai-events-schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/db/__tests__/ai-events-schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { aiEvents, aiPmFundingCache, aiEventStatusEnum } from '@/db/schema';

describe('ai_events schema', () => {
  it('exposes aiEvents table with required columns', () => {
    const cols = aiEvents._.columns;
    expect(cols).toHaveProperty('id');
    expect(cols).toHaveProperty('configId');
    expect(cols).toHaveProperty('userId');
    expect(cols).toHaveProperty('eventType');
    expect(cols).toHaveProperty('symbol');
    expect(cols).toHaveProperty('payload');
    expect(cols).toHaveProperty('status');
    expect(cols).toHaveProperty('decisionId');
    expect(cols).toHaveProperty('emittedAt');
    expect(cols).toHaveProperty('processedAt');
    expect(cols).toHaveProperty('createdAt');
  });

  it('exposes aiPmFundingCache table with required columns', () => {
    const cols = aiPmFundingCache._.columns;
    expect(cols).toHaveProperty('id');
    expect(cols).toHaveProperty('configId');
    expect(cols).toHaveProperty('symbol');
    expect(cols).toHaveProperty('fundingRate');
    expect(cols).toHaveProperty('observedAt');
  });

  it('aiEventStatusEnum contains all states', () => {
    expect(aiEventStatusEnum.enumValues).toEqual([
      'PENDING',
      'THROTTLED',
      'PROCESSING',
      'PROCESSED',
      'FAILED',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run src/db/__tests__/ai-events-schema.test.ts
```

Expected: FAIL — `aiEvents` / `aiPmFundingCache` / `aiEventStatusEnum` not exported.

- [ ] **Step 3: Add enum + tables to `src/db/schema.ts`**

In the ENUMS section, after `aiTriggerSourceEnum`:

```ts
export const aiEventStatusEnum = pgEnum('ai_event_status', [
  'PENDING',
  'THROTTLED',
  'PROCESSING',
  'PROCESSED',
  'FAILED',
]);
```

In the AI Portfolio Manager section, after `aiChatMessages`:

```ts
export const aiEvents = pgTable('ai_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  configId: uuid('config_id')
    .notNull()
    .references(() => aiPmConfigs.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  eventType: aiTriggerSourceEnum('event_type').notNull(),
  symbol: text('symbol'),
  payload: jsonb('payload').notNull(),
  status: aiEventStatusEnum('status').notNull().default('PENDING'),
  decisionId: uuid('decision_id').references(() => aiDecisions.id, { onDelete: 'set null' }),
  emittedAt: timestamp('emitted_at').notNull(),
  processedAt: timestamp('processed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('ai_events_cfg_type_sym_idx').on(table.configId, table.eventType, table.symbol, table.createdAt),
  index('ai_events_status_idx').on(table.status),
  index('ai_events_user_created_idx').on(table.userId, table.createdAt),
]);

export const aiPmFundingCache = pgTable('ai_pm_funding_cache', {
  id: uuid('id').primaryKey().defaultRandom(),
  configId: uuid('config_id')
    .notNull()
    .references(() => aiPmConfigs.id, { onDelete: 'cascade' }),
  symbol: text('symbol').notNull(),
  fundingRate: decimal('funding_rate', { precision: 10, scale: 8 }).notNull(),
  observedAt: timestamp('observed_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('ai_pm_funding_cache_cfg_sym').on(table.configId, table.symbol),
]);
```

Add relations near the other AI PM relations:

```ts
export const aiEventsRelations = relations(aiEvents, ({ one }) => ({
  user: one(users, { fields: [aiEvents.userId], references: [users.id] }),
  config: one(aiPmConfigs, { fields: [aiEvents.configId], references: [aiPmConfigs.id] }),
  decision: one(aiDecisions, { fields: [aiEvents.decisionId], references: [aiDecisions.id] }),
}));

export const aiPmFundingCacheRelations = relations(aiPmFundingCache, ({ one }) => ({
  config: one(aiPmConfigs, { fields: [aiPmFundingCache.configId], references: [aiPmConfigs.id] }),
}));
```

- [ ] **Step 4: Generate migration**

```
npm run db:generate
```

Confirm a new file `drizzle/0012_*.sql` (name will be drizzle-generated) was created.

- [ ] **Step 5: Run test to verify it passes**

```
npx vitest run src/db/__tests__/ai-events-schema.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```
git add src/db/schema.ts src/db/__tests__/ai-events-schema.test.ts drizzle/
git commit -m "feat(ai-pm): add ai_events + ai_pm_funding_cache schema (S14)"
```

---

### Task 2: Event types and helpers

**Files:**
- Create: `src/lib/ai-pm/events.ts`
- Test: `src/lib/ai-pm/__tests__/events.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/ai-pm/__tests__/events.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mapNameToEnum, AI_PM_EVENT_NAMES } from '@/lib/ai-pm/events';
import type {
  FillPayload,
  ErrorPayload,
  DrawdownPayload,
  FundingFlipPayload,
  ChatPayload,
} from '@/lib/ai-pm/events';

describe('events', () => {
  it('AI_PM_EVENT_NAMES contains all five event names', () => {
    expect(AI_PM_EVENT_NAMES).toEqual([
      'ai-pm/event.fill',
      'ai-pm/event.error',
      'ai-pm/event.drawdown',
      'ai-pm/event.funding-flip',
      'ai-pm/event.chat',
    ]);
  });

  it('mapNameToEnum maps each event name to its DB enum', () => {
    expect(mapNameToEnum('ai-pm/event.fill')).toBe('EVENT_FILL');
    expect(mapNameToEnum('ai-pm/event.error')).toBe('EVENT_ERROR');
    expect(mapNameToEnum('ai-pm/event.drawdown')).toBe('EVENT_DRAWDOWN');
    expect(mapNameToEnum('ai-pm/event.funding-flip')).toBe('EVENT_FUNDING_FLIP');
    expect(mapNameToEnum('ai-pm/event.chat')).toBe('CHAT');
  });

  it('FillPayload type accepts a real-bot fill', () => {
    const p: FillPayload = {
      configId: 'cfg',
      emittedAt: new Date().toISOString(),
      symbol: 'BTC-USDT',
      botId: 'bot',
      botKind: 'real',
      side: 'LONG',
      fillPrice: '50000',
      quantity: '0.01',
      orderType: 'ENTRY',
    };
    expect(p.botKind).toBe('real');
  });

  it('ChatPayload type forces symbol=null', () => {
    const p: ChatPayload = {
      configId: 'cfg',
      emittedAt: new Date().toISOString(),
      symbol: null,
      chatMessageId: 'msg',
      userMessage: 'hi',
    };
    expect(p.symbol).toBeNull();
  });

  it('ErrorPayload accepts an unknown errorKind only via UNKNOWN literal', () => {
    const p: ErrorPayload = {
      configId: 'cfg',
      emittedAt: new Date().toISOString(),
      symbol: 'BTC-USDT',
      botId: 'bot',
      botKind: 'real',
      errorKind: 'UNKNOWN',
      message: 'boom',
    };
    expect(p.errorKind).toBe('UNKNOWN');
  });

  it('DrawdownPayload + FundingFlipPayload compile', () => {
    const d: DrawdownPayload = {
      configId: 'cfg',
      emittedAt: '',
      symbol: 'BTC-USDT',
      botId: 'bot',
      botKind: 'paper',
      drawdownPct: -12.5,
      thresholdPct: 10,
      currentPnlUsdt: '-125',
      capitalUsdt: '1000',
    };
    const f: FundingFlipPayload = {
      configId: 'cfg',
      emittedAt: '',
      symbol: 'BTC-USDT',
      previousRate: 0.0012,
      currentRate: -0.0008,
    };
    expect(d.drawdownPct).toBeLessThan(0);
    expect(f.previousRate * f.currentRate).toBeLessThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run src/lib/ai-pm/__tests__/events.test.ts
```

Expected: FAIL — `@/lib/ai-pm/events` does not exist.

- [ ] **Step 3: Create `src/lib/ai-pm/events.ts`**

```ts
export const AI_PM_EVENT_NAMES = [
  'ai-pm/event.fill',
  'ai-pm/event.error',
  'ai-pm/event.drawdown',
  'ai-pm/event.funding-flip',
  'ai-pm/event.chat',
] as const;

export type AiPmEventName = (typeof AI_PM_EVENT_NAMES)[number];

export interface BaseEventPayload {
  configId: string;
  emittedAt: string;
}

export interface FillPayload extends BaseEventPayload {
  symbol: string;
  botId: string;
  botKind: 'real' | 'paper';
  side: 'LONG' | 'SHORT';
  fillPrice: string;
  quantity: string;
  orderType: 'ENTRY' | 'TAKE_PROFIT' | 'STOP_LOSS';
}

export interface ErrorPayload extends BaseEventPayload {
  symbol: string;
  botId: string;
  botKind: 'real' | 'paper';
  errorKind:
    | 'API_ERROR'
    | 'INSUFFICIENT_MARGIN'
    | 'INVALID_PARAMS'
    | 'ORDER_REJECTED'
    | 'UNKNOWN';
  message: string;
}

export interface DrawdownPayload extends BaseEventPayload {
  symbol: string;
  botId: string;
  botKind: 'real' | 'paper';
  drawdownPct: number;
  thresholdPct: number;
  currentPnlUsdt: string;
  capitalUsdt: string;
}

export interface FundingFlipPayload extends BaseEventPayload {
  symbol: string;
  previousRate: number;
  currentRate: number;
}

export interface ChatPayload extends BaseEventPayload {
  symbol: null;
  chatMessageId: string;
  userMessage: string;
}

export type AiPmEventPayload =
  | FillPayload
  | ErrorPayload
  | DrawdownPayload
  | FundingFlipPayload
  | ChatPayload;

export type AiTriggerEnum =
  | 'EVENT_FILL'
  | 'EVENT_ERROR'
  | 'EVENT_DRAWDOWN'
  | 'EVENT_FUNDING_FLIP'
  | 'CHAT';

export function mapNameToEnum(name: AiPmEventName): AiTriggerEnum {
  switch (name) {
    case 'ai-pm/event.fill':
      return 'EVENT_FILL';
    case 'ai-pm/event.error':
      return 'EVENT_ERROR';
    case 'ai-pm/event.drawdown':
      return 'EVENT_DRAWDOWN';
    case 'ai-pm/event.funding-flip':
      return 'EVENT_FUNDING_FLIP';
    case 'ai-pm/event.chat':
      return 'CHAT';
  }
}

const ERROR_MESSAGE_MAX = 500;
const CHAT_MESSAGE_MAX = 2000;

export function truncateErrorMessage(msg: string): string {
  return msg.length > ERROR_MESSAGE_MAX ? msg.slice(0, ERROR_MESSAGE_MAX) : msg;
}

export function truncateChatMessage(msg: string): string {
  return msg.length > CHAT_MESSAGE_MAX ? msg.slice(0, CHAT_MESSAGE_MAX) : msg;
}
```

- [ ] **Step 4: Run test to verify it passes**

```
npx vitest run src/lib/ai-pm/__tests__/events.test.ts
```

Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```
git add src/lib/ai-pm/events.ts src/lib/ai-pm/__tests__/events.test.ts
git commit -m "feat(ai-pm): event name + payload types (S14)"
```

---

### Task 3: ai-events service (insert, mark, throttle-check)

**Files:**
- Create: `src/services/ai-events.service.ts`
- Test: `src/services/__tests__/ai-events.service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/services/__tests__/ai-events.service.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  insertAiEvent,
  markEvent,
  checkThrottle,
} from '@/services/ai-events.service';
import type { AiTriggerEnum } from '@/lib/ai-pm/events';

type FakeRow = {
  id: string;
  configId: string;
  userId: string;
  eventType: AiTriggerEnum;
  symbol: string | null;
  status: 'PENDING' | 'THROTTLED' | 'PROCESSING' | 'PROCESSED' | 'FAILED';
  createdAt: Date;
};

interface FakeDb {
  rows: FakeRow[];
  configs: Record<string, { userId: string }>;
}

function makeFakeDb(): FakeDb {
  return { rows: [], configs: {} };
}

function buildDbAdapter(fake: FakeDb) {
  let nextId = 1;
  return {
    insert: () => ({
      values: (v: Omit<FakeRow, 'id' | 'createdAt'> & { configId: string }) => ({
        returning: async () => {
          const row: FakeRow = {
            id: String(nextId++),
            createdAt: new Date(),
            configId: v.configId,
            userId: v.userId,
            eventType: v.eventType,
            symbol: v.symbol ?? null,
            status: v.status ?? 'PENDING',
          };
          fake.rows.push(row);
          return [row];
        },
      }),
    }),
    update: () => ({
      set: (patch: Partial<FakeRow>) => ({
        where: () => ({
          returning: async () => {
            // Test driver applies patch in advance for simplicity
            fake.rows[fake.rows.length - 1] = {
              ...fake.rows[fake.rows.length - 1],
              ...patch,
            };
            return [fake.rows[fake.rows.length - 1]];
          },
        }),
      }),
    }),
    query: {
      aiPmConfigs: {
        findFirst: async ({ where }: { where: unknown }) => {
          // tests preload configs map; we approximate by returning first known
          const ids = Object.keys(fake.configs);
          return ids.length ? { userId: fake.configs[ids[0]].userId, id: ids[0] } : null;
        },
      },
      aiEvents: {
        findMany: async ({ where }: { where: unknown }) => fake.rows.slice(),
      },
    },
  } as unknown as Parameters<typeof insertAiEvent>[0]['db'];
}

describe('ai-events.service', () => {
  it('insertAiEvent inserts row with PENDING status and stamps userId from config', async () => {
    const fake = makeFakeDb();
    fake.configs['cfg1'] = { userId: 'user-1' };
    const dbAdapter = buildDbAdapter(fake);

    const id = await insertAiEvent({
      db: dbAdapter,
      configId: 'cfg1',
      eventType: 'EVENT_FILL',
      symbol: 'BTC-USDT',
      payload: { foo: 'bar' },
      emittedAt: new Date(),
    });

    expect(id).toBe('1');
    expect(fake.rows[0]).toMatchObject({
      configId: 'cfg1',
      userId: 'user-1',
      eventType: 'EVENT_FILL',
      symbol: 'BTC-USDT',
      status: 'PENDING',
    });
  });

  it('markEvent updates status + processedAt + decisionId', async () => {
    const fake = makeFakeDb();
    fake.rows.push({
      id: 'r1',
      configId: 'cfg1',
      userId: 'u1',
      eventType: 'EVENT_FILL',
      symbol: null,
      status: 'PENDING',
      createdAt: new Date(),
    });
    const dbAdapter = buildDbAdapter(fake);

    await markEvent({ db: dbAdapter, aiEventId: 'r1', status: 'PROCESSED', decisionId: 'd1' });

    expect(fake.rows[0].status).toBe('PROCESSED');
  });

  it('checkThrottle returns true when prior event exists in window', async () => {
    const fake = makeFakeDb();
    const now = new Date();
    fake.rows.push({
      id: 'old',
      configId: 'cfg1',
      userId: 'u1',
      eventType: 'EVENT_FILL',
      symbol: 'BTC-USDT',
      status: 'PROCESSED',
      createdAt: new Date(now.getTime() - 60_000),
    });
    fake.rows.push({
      id: 'me',
      configId: 'cfg1',
      userId: 'u1',
      eventType: 'EVENT_FILL',
      symbol: 'BTC-USDT',
      status: 'PENDING',
      createdAt: now,
    });
    const dbAdapter = buildDbAdapter(fake);

    const throttled = await checkThrottle({
      db: dbAdapter,
      configId: 'cfg1',
      eventType: 'EVENT_FILL',
      symbol: 'BTC-USDT',
      currentEventId: 'me',
      windowSeconds: 300,
    });

    expect(throttled).toBe(true);
  });

  it('checkThrottle returns false when only the current event exists', async () => {
    const fake = makeFakeDb();
    fake.rows.push({
      id: 'me',
      configId: 'cfg1',
      userId: 'u1',
      eventType: 'EVENT_FILL',
      symbol: 'BTC-USDT',
      status: 'PENDING',
      createdAt: new Date(),
    });
    const dbAdapter = buildDbAdapter(fake);

    const throttled = await checkThrottle({
      db: dbAdapter,
      configId: 'cfg1',
      eventType: 'EVENT_FILL',
      symbol: 'BTC-USDT',
      currentEventId: 'me',
      windowSeconds: 300,
    });

    expect(throttled).toBe(false);
  });

  it('checkThrottle groups NULL symbols together (IS NOT DISTINCT FROM)', async () => {
    const fake = makeFakeDb();
    fake.rows.push({
      id: 'old',
      configId: 'cfg1',
      userId: 'u1',
      eventType: 'CHAT',
      symbol: null,
      status: 'PROCESSED',
      createdAt: new Date(),
    });
    fake.rows.push({
      id: 'me',
      configId: 'cfg1',
      userId: 'u1',
      eventType: 'CHAT',
      symbol: null,
      status: 'PENDING',
      createdAt: new Date(),
    });
    const dbAdapter = buildDbAdapter(fake);

    const throttled = await checkThrottle({
      db: dbAdapter,
      configId: 'cfg1',
      eventType: 'CHAT',
      symbol: null,
      currentEventId: 'me',
      windowSeconds: 300,
    });

    expect(throttled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run src/services/__tests__/ai-events.service.test.ts
```

Expected: FAIL — service module does not exist.

- [ ] **Step 3: Create `src/services/ai-events.service.ts`**

```ts
import { and, eq, gt, sql } from 'drizzle-orm';
import { aiEvents, aiPmConfigs } from '@/db/schema';
import { db as defaultDb } from '@/db';
import type { AiTriggerEnum } from '@/lib/ai-pm/events';

type Db = typeof defaultDb;

type EventStatus = 'PENDING' | 'THROTTLED' | 'PROCESSING' | 'PROCESSED' | 'FAILED';

export interface InsertAiEventParams {
  db?: Db;
  configId: string;
  eventType: AiTriggerEnum;
  symbol: string | null;
  payload: unknown;
  emittedAt: Date;
}

export interface MarkEventParams {
  db?: Db;
  aiEventId: string;
  status: EventStatus;
  decisionId?: string | null;
}

export interface CheckThrottleParams {
  db?: Db;
  configId: string;
  eventType: AiTriggerEnum;
  symbol: string | null;
  currentEventId: string;
  windowSeconds: number;
}

export async function insertAiEvent(params: InsertAiEventParams): Promise<string> {
  const database = params.db ?? defaultDb;

  const cfg = await database.query.aiPmConfigs.findFirst({
    where: eq(aiPmConfigs.id, params.configId),
  });
  if (!cfg) throw new Error(`AI PM config not found: ${params.configId}`);

  const [row] = await database
    .insert(aiEvents)
    .values({
      configId: params.configId,
      userId: cfg.userId,
      eventType: params.eventType,
      symbol: params.symbol,
      payload: params.payload,
      status: 'PENDING',
      emittedAt: params.emittedAt,
    })
    .returning();

  return row.id;
}

export async function markEvent(params: MarkEventParams): Promise<void> {
  const database = params.db ?? defaultDb;
  await database
    .update(aiEvents)
    .set({
      status: params.status,
      decisionId: params.decisionId ?? null,
      processedAt:
        params.status === 'PROCESSED' || params.status === 'FAILED'
          ? new Date()
          : null,
    })
    .where(eq(aiEvents.id, params.aiEventId))
    .returning();
}

export async function checkThrottle(params: CheckThrottleParams): Promise<boolean> {
  const database = params.db ?? defaultDb;
  const cutoff = new Date(Date.now() - params.windowSeconds * 1000);

  const rows = await database.query.aiEvents.findMany({
    where: and(
      eq(aiEvents.configId, params.configId),
      eq(aiEvents.eventType, params.eventType),
      sql`${aiEvents.symbol} IS NOT DISTINCT FROM ${params.symbol}`,
      gt(aiEvents.createdAt, cutoff),
    ),
  });

  return rows.some(
    (r) =>
      r.id !== params.currentEventId &&
      (r.status === 'PROCESSING' || r.status === 'PROCESSED'),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```
npx vitest run src/services/__tests__/ai-events.service.test.ts
```

Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```
git add src/services/ai-events.service.ts src/services/__tests__/ai-events.service.test.ts
git commit -m "feat(ai-pm): ai-events service (insert/mark/throttle) (S14)"
```

---

### Task 4: Scoped pipeline (event → signal → decision → validate → execute)

**Files:**
- Create: `src/lib/ai-pm/event-pipeline.ts`
- Test: `src/lib/ai-pm/__tests__/event-pipeline.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/ai-pm/__tests__/event-pipeline.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { runScopedPipeline } from '@/lib/ai-pm/event-pipeline';
import type { FillPayload } from '@/lib/ai-pm/events';

const fakeBingxClient = { /* mock — never actually called */ } as never;
const fakePortfolio = { totalEquityUsdt: 1000, openPositions: [], openBots: [] } as never;

function fakeConfig() {
  return {
    id: 'cfg1',
    userId: 'user-1',
    bingxApiKeyId: 'key-1',
    paperMode: true,
    enabled: true,
    killSwitch: false,
    maxCapitalUsdt: '1000',
    maxConcurrentBots: 5,
    allowedSymbols: ['BTC-USDT'],
    allowedStrategies: ['DCA'] as Array<'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER'>,
    anthropicApiKey: 'sk-test',
  };
}

describe('runScopedPipeline', () => {
  it('runs signal scoped to the event symbol only and executes a no_action result', async () => {
    const signalFn = vi.fn().mockResolvedValue({
      ok: true,
      result: { candidates: [{ symbol: 'BTC-USDT', regime: 'TRENDING_UP', score: 80, reason: '' }], signalIds: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } },
    });
    const decisionFn = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        proposedActions: [{ type: 'no_action', reasoning: 'nothing to do' }],
        rejectedActions: [],
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      },
    });
    const validateFn = vi.fn().mockResolvedValue({ status: 'PROPOSED', decisionId: 'dec-1' });
    const executeFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: 'dec-1' });
    const updateDecisionStatusFn = vi.fn().mockResolvedValue(undefined);

    const payload: FillPayload = {
      configId: 'cfg1',
      emittedAt: new Date().toISOString(),
      symbol: 'BTC-USDT',
      botId: 'bot-1',
      botKind: 'paper',
      side: 'LONG',
      fillPrice: '50000',
      quantity: '0.01',
      orderType: 'ENTRY',
    };

    const result = await runScopedPipeline({
      eventType: 'EVENT_FILL',
      symbol: payload.symbol,
      payload,
      aiEventId: 'ev-1',
      config: fakeConfig(),
      bingxClient: fakeBingxClient,
      portfolioState: fakePortfolio,
      db: {} as never,
      signalFn,
      decisionFn,
      validateFn,
      executeFn,
      updateDecisionStatusFn,
      isKillSwitchActive: async () => false,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(signalFn).toHaveBeenCalledWith(expect.objectContaining({
      allowedSymbols: ['BTC-USDT'],
    }));
    expect(result.executedDecisionId).toBe('dec-1');
    expect(result.proposedCount).toBe(1);
    expect(result.executedCount).toBe(1);
  });

  it('aborts when kill switch flips to true between steps', async () => {
    const signalFn = vi.fn().mockResolvedValue({ ok: true, result: { candidates: [], signalIds: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } } });
    const decisionFn = vi.fn();
    let killCount = 0;
    const isKillSwitchActive = vi.fn(async () => ++killCount > 1);

    const payload: FillPayload = {
      configId: 'cfg1',
      emittedAt: new Date().toISOString(),
      symbol: 'BTC-USDT',
      botId: 'bot-1',
      botKind: 'paper',
      side: 'LONG',
      fillPrice: '50000',
      quantity: '0.01',
      orderType: 'ENTRY',
    };

    const result = await runScopedPipeline({
      eventType: 'EVENT_FILL',
      symbol: payload.symbol,
      payload,
      aiEventId: 'ev-1',
      config: fakeConfig(),
      bingxClient: fakeBingxClient,
      portfolioState: fakePortfolio,
      db: {} as never,
      signalFn,
      decisionFn,
      validateFn: vi.fn(),
      executeFn: vi.fn(),
      updateDecisionStatusFn: vi.fn(),
      isKillSwitchActive,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(decisionFn).not.toHaveBeenCalled();
    expect(result.status).toBe('SKIPPED_KILL_SWITCH');
  });

  it('returns SIGNAL_FAILED when signal returns ok=false', async () => {
    const signalFn = vi.fn().mockResolvedValue({ ok: false, error: { kind: 'NO_MARKET_DATA', symbol: 'BTC-USDT' } });

    const payload: FillPayload = {
      configId: 'cfg1', emittedAt: '', symbol: 'BTC-USDT', botId: 'b', botKind: 'paper',
      side: 'LONG', fillPrice: '0', quantity: '0', orderType: 'ENTRY',
    };

    const result = await runScopedPipeline({
      eventType: 'EVENT_FILL', symbol: 'BTC-USDT', payload, aiEventId: 'ev-1',
      config: fakeConfig(), bingxClient: fakeBingxClient, portfolioState: fakePortfolio,
      db: {} as never, signalFn,
      decisionFn: vi.fn(), validateFn: vi.fn(), executeFn: vi.fn(),
      updateDecisionStatusFn: vi.fn(),
      isKillSwitchActive: async () => false,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(result.status).toBe('SIGNAL_FAILED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run src/lib/ai-pm/__tests__/event-pipeline.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `src/lib/ai-pm/event-pipeline.ts`**

```ts
import { runSignal as defaultSignal } from '@/lib/ai-pm/signal';
import { runDecision as defaultDecision } from '@/lib/ai-pm/decision';
import { validate as defaultValidate } from '@/lib/ai-pm/validation';
import { execute as defaultExecute } from '@/lib/ai-pm/executor';
import { aiDecisions } from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { db as Db } from '@/db';
import type { BingxClient } from '@/lib/bingx/client';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';
import type { AiTriggerEnum, AiPmEventPayload } from '@/lib/ai-pm/events';
import type { AiPmConfigDecrypted } from '@/services/ai-pm-config.service';

export type ScopedPipelineStatus =
  | 'COMPLETED'
  | 'SKIPPED_KILL_SWITCH'
  | 'SKIPPED_NO_BINGX_CLIENT'
  | 'SIGNAL_FAILED'
  | 'DECISION_FAILED'
  | 'PARTIAL';

export interface ScopedPipelineResult {
  status: ScopedPipelineStatus;
  proposedCount: number;
  executedCount: number;
  failedCount: number;
  rejectedCount: number;
  executedDecisionId: string | null;
}

export interface RunScopedPipelineParams {
  eventType: AiTriggerEnum;
  symbol: string;
  payload: AiPmEventPayload;
  aiEventId: string;
  config: AiPmConfigDecrypted;
  bingxClient: BingxClient;
  portfolioState: PortfolioState;
  db: typeof Db;
  signalFn?: typeof defaultSignal;
  decisionFn?: typeof defaultDecision;
  validateFn?: typeof defaultValidate;
  executeFn?: typeof defaultExecute;
  updateDecisionStatusFn?: typeof updateDecisionStatus;
  isKillSwitchActive: () => Promise<boolean>;
  logger: { info: (msg: string, ctx?: unknown) => void; warn: (msg: string, ctx?: unknown) => void; error: (msg: string, ctx?: unknown) => void };
}

const DEFAULT_REVIEWER_THRESHOLD_PCT = 30;

async function updateDecisionStatus(
  database: typeof Db,
  decisionId: string,
  status: 'EXECUTED' | 'EXECUTION_FAILED',
  reason: string | null,
  eventType: AiTriggerEnum,
  triggerDetail: string,
): Promise<void> {
  await database
    .update(aiDecisions)
    .set({
      status,
      rejectionReason: reason,
      executedAt: status === 'EXECUTED' ? new Date() : null,
      triggeredBy: eventType,
      triggerDetail,
    })
    .where(eq(aiDecisions.id, decisionId))
    .returning();
}

export async function runScopedPipeline(params: RunScopedPipelineParams): Promise<ScopedPipelineResult> {
  const signalFn = params.signalFn ?? defaultSignal;
  const decisionFn = params.decisionFn ?? defaultDecision;
  const validateFn = params.validateFn ?? defaultValidate;
  const executeFn = params.executeFn ?? defaultExecute;
  const updateFn = params.updateDecisionStatusFn ?? updateDecisionStatus;

  const result: ScopedPipelineResult = {
    status: 'COMPLETED',
    proposedCount: 0,
    executedCount: 0,
    failedCount: 0,
    rejectedCount: 0,
    executedDecisionId: null,
  };

  if (await params.isKillSwitchActive()) {
    return { ...result, status: 'SKIPPED_KILL_SWITCH' };
  }

  const signalOutcome = await signalFn({
    userId: params.config.userId,
    allowedSymbols: [params.symbol],
    anthropicApiKey: params.config.anthropicApiKey,
    bingxClient: params.bingxClient,
    db: params.db,
  });

  if (!signalOutcome.ok) {
    params.logger.warn('event_signal_failed', { aiEventId: params.aiEventId, kind: signalOutcome.error.kind });
    return { ...result, status: 'SIGNAL_FAILED' };
  }

  if (await params.isKillSwitchActive()) {
    return { ...result, status: 'SKIPPED_KILL_SWITCH' };
  }

  const decisionOutcome = await decisionFn({
    userId: params.config.userId,
    candidates: signalOutcome.result.candidates,
    portfolioState: params.portfolioState,
    config: {
      mode: 'BALANCED',
      maxCapitalUsdt: Number(params.config.maxCapitalUsdt ?? 1000),
      maxConcurrentBots: params.config.maxConcurrentBots ?? 5,
      allowedStrategies: (params.config.allowedStrategies ?? ['DCA', 'TRAILING_STOP', 'DCA_SPOT', 'SMA_CROSSOVER']) as Array<'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER'>,
    },
    anthropicApiKey: params.config.anthropicApiKey,
  });

  if (!decisionOutcome.ok) {
    params.logger.warn('event_decision_failed', { aiEventId: params.aiEventId, kind: decisionOutcome.error.kind });
    return { ...result, status: 'DECISION_FAILED' };
  }

  const actions = decisionOutcome.result.proposedActions;
  result.proposedCount = actions.length;
  const triggerDetail = JSON.stringify({ aiEventId: params.aiEventId, eventType: params.eventType, symbol: params.symbol });

  for (const action of actions) {
    if (await params.isKillSwitchActive()) {
      return { ...result, status: 'SKIPPED_KILL_SWITCH' };
    }

    let validation;
    try {
      validation = await validateFn({
        userId: params.config.userId,
        action,
        config: {
          maxCapitalUsdt: Number(params.config.maxCapitalUsdt ?? 1000),
          maxConcurrentBots: params.config.maxConcurrentBots ?? 5,
          allowedStrategies: (params.config.allowedStrategies ?? ['DCA', 'TRAILING_STOP', 'DCA_SPOT', 'SMA_CROSSOVER']) as Array<'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER'>,
          killSwitch: false,
          reviewerThresholdPct: DEFAULT_REVIEWER_THRESHOLD_PCT,
        },
        portfolioState: params.portfolioState,
        anthropicApiKey: params.config.anthropicApiKey,
        bingxClient: params.bingxClient,
        db: params.db,
      });
    } catch (err) {
      params.logger.error('event_validate_threw', { aiEventId: params.aiEventId, err: err instanceof Error ? err.message : String(err) });
      result.failedCount += 1;
      continue;
    }

    if (validation.status !== 'PROPOSED') {
      result.rejectedCount += 1;
      continue;
    }

    let exec;
    try {
      exec = await executeFn({
        userId: params.config.userId,
        decisionId: validation.decisionId,
        action,
        config: { bingxApiKeyId: params.config.bingxApiKeyId, paperMode: params.config.paperMode },
        db: params.db,
      });
    } catch (err) {
      params.logger.error('event_execute_threw', { aiEventId: params.aiEventId, err: err instanceof Error ? err.message : String(err) });
      result.failedCount += 1;
      await updateFn(params.db, validation.decisionId, 'EXECUTION_FAILED', 'execute threw', params.eventType, triggerDetail);
      continue;
    }

    if (exec.status === 'EXECUTED') {
      result.executedCount += 1;
      result.executedDecisionId ??= validation.decisionId;
      await updateFn(params.db, validation.decisionId, 'EXECUTED', null, params.eventType, triggerDetail);
    } else {
      result.failedCount += 1;
      await updateFn(params.db, validation.decisionId, 'EXECUTION_FAILED', exec.reason ?? null, params.eventType, triggerDetail);
    }
  }

  if (result.failedCount > 0) result.status = 'PARTIAL';
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

```
npx vitest run src/lib/ai-pm/__tests__/event-pipeline.test.ts
```

Expected: PASS — all 3 tests green.

- [ ] **Step 5: Commit**

```
git add src/lib/ai-pm/event-pipeline.ts src/lib/ai-pm/__tests__/event-pipeline.test.ts
git commit -m "feat(ai-pm): scoped event pipeline (S14)"
```

---

### Task 5: Chat pipeline (decision-only path)

**Files:**
- Create: `src/lib/ai-pm/chat-pipeline.ts`
- Test: `src/lib/ai-pm/__tests__/chat-pipeline.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/ai-pm/__tests__/chat-pipeline.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { runChatPipeline } from '@/lib/ai-pm/chat-pipeline';
import type { ChatPayload } from '@/lib/ai-pm/events';

function fakeConfig() {
  return {
    id: 'cfg1',
    userId: 'user-1',
    bingxApiKeyId: 'key-1',
    paperMode: true,
    enabled: true,
    killSwitch: false,
    maxCapitalUsdt: '1000',
    maxConcurrentBots: 5,
    allowedSymbols: ['BTC-USDT'],
    allowedStrategies: ['DCA'] as Array<'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER'>,
    anthropicApiKey: 'sk-test',
  };
}

describe('runChatPipeline', () => {
  it('persists assistant reply with no decisionId when chat decision yields no action', async () => {
    const inserts: unknown[] = [];
    const chatDecisionFn = vi.fn().mockResolvedValue({
      kind: 'reply',
      assistantText: 'Markets look choppy. I will wait.',
      usage: { inputTokens: 50, outputTokens: 20, costUsd: 0.0003 },
    });
    const fakeDb = {
      insert: () => ({ values: (v: unknown) => ({ returning: async () => { inserts.push(v); return [{ id: 'msg-2' }]; } }) }),
    } as never;

    const payload: ChatPayload = {
      configId: 'cfg1',
      emittedAt: new Date().toISOString(),
      symbol: null,
      chatMessageId: 'msg-1',
      userMessage: 'how is the market?',
    };

    const result = await runChatPipeline({
      payload,
      aiEventId: 'ev-1',
      config: fakeConfig(),
      portfolioState: { totalEquityUsdt: 1000, openPositions: [], openBots: [] } as never,
      db: fakeDb,
      chatDecisionFn,
      isKillSwitchActive: async () => false,
      loadChatHistoryFn: async () => [],
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(result.decisionId).toBeNull();
    expect(result.assistantText).toBe('Markets look choppy. I will wait.');
    expect(inserts).toHaveLength(1);
  });

  it('returns reply text + null decisionId when kill switch active', async () => {
    const result = await runChatPipeline({
      payload: { configId: 'cfg1', emittedAt: '', symbol: null, chatMessageId: 'msg-1', userMessage: 'hi' },
      aiEventId: 'ev-1',
      config: fakeConfig(),
      portfolioState: { totalEquityUsdt: 0, openPositions: [], openBots: [] } as never,
      db: { insert: () => ({ values: () => ({ returning: async () => [{ id: 'm' }] }) }) } as never,
      chatDecisionFn: vi.fn(),
      isKillSwitchActive: async () => true,
      loadChatHistoryFn: async () => [],
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    expect(result.decisionId).toBeNull();
    expect(result.assistantText).toMatch(/disabled/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run src/lib/ai-pm/__tests__/chat-pipeline.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/ai-pm/chat-pipeline.ts`**

```ts
import { aiChatMessages } from '@/db/schema';
import type { db as Db } from '@/db';
import type { ChatPayload } from '@/lib/ai-pm/events';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';
import type { AiPmConfigDecrypted } from '@/services/ai-pm-config.service';
import { callSonnet, type AnthropicFactory, type LlmUsage } from '@/lib/ai-pm/llm';

export type ChatDecisionResult =
  | { kind: 'reply'; assistantText: string; usage: LlmUsage }
  | { kind: 'action'; assistantText: string; usage: LlmUsage; /* future: action proposal */ };

export interface RunChatDecisionParams {
  userMessage: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  portfolioState: PortfolioState;
  anthropicApiKey: string;
  factory?: AnthropicFactory;
}

export async function runChatDecision(params: RunChatDecisionParams): Promise<ChatDecisionResult> {
  const systemPrompt = `You are an AI Portfolio Manager assistant. The user has these positions and bots: ${JSON.stringify(params.portfolioState)}. Respond concisely. For v1 you can only reply in natural language; no tools.`;
  const result = await callSonnet({
    apiKey: params.anthropicApiKey,
    systemPrompt,
    userPrompt: params.userMessage,
    tools: [],
    factory: params.factory,
    cacheSystem: false,
  });
  if (!result.ok) {
    return { kind: 'reply', assistantText: 'Sorry, I could not process that.', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  }
  const text = typeof result.data.text === 'string' ? result.data.text : '';
  return { kind: 'reply', assistantText: text, usage: result.data.usage };
}

export interface ChatPipelineResult {
  decisionId: string | null;
  assistantText: string;
}

export interface RunChatPipelineParams {
  payload: ChatPayload;
  aiEventId: string;
  config: AiPmConfigDecrypted;
  portfolioState: PortfolioState;
  db: typeof Db;
  chatDecisionFn?: typeof runChatDecision;
  loadChatHistoryFn: (userId: string, limit: number) => Promise<Array<{ role: 'user' | 'assistant'; content: string }>>;
  isKillSwitchActive: () => Promise<boolean>;
  logger: { info: (msg: string, ctx?: unknown) => void; warn: (msg: string, ctx?: unknown) => void; error: (msg: string, ctx?: unknown) => void };
}

const HISTORY_LIMIT = 20;

export async function runChatPipeline(params: RunChatPipelineParams): Promise<ChatPipelineResult> {
  const chatDecision = params.chatDecisionFn ?? runChatDecision;

  if (await params.isKillSwitchActive()) {
    const text = 'AI is currently disabled (kill switch active).';
    await persistAssistant(params.db, params.config.userId, text, null);
    return { decisionId: null, assistantText: text };
  }

  const history = await params.loadChatHistoryFn(params.config.userId, HISTORY_LIMIT);
  const decision = await chatDecision({
    userMessage: params.payload.userMessage,
    history,
    portfolioState: params.portfolioState,
    anthropicApiKey: params.config.anthropicApiKey,
  });

  await persistAssistant(params.db, params.config.userId, decision.assistantText, null);
  return { decisionId: null, assistantText: decision.assistantText };
}

async function persistAssistant(
  database: typeof Db,
  userId: string,
  content: string,
  decisionId: string | null,
): Promise<void> {
  await database
    .insert(aiChatMessages)
    .values({ userId, role: 'assistant', content, decisionId })
    .returning();
}
```

> Note: chat pipeline returns `decisionId: null` for v1 — only natural-language replies. Action-proposal via chat is deferred to a later session. The pipeline signature accepts the future shape (decisionId may become non-null) so callers don't need to change.

- [ ] **Step 4: Run test to verify it passes**

```
npx vitest run src/lib/ai-pm/__tests__/chat-pipeline.test.ts
```

Expected: PASS — both tests green.

- [ ] **Step 5: Commit**

```
git add src/lib/ai-pm/chat-pipeline.ts src/lib/ai-pm/__tests__/chat-pipeline.test.ts
git commit -m "feat(ai-pm): chat pipeline reply-only v1 (S14)"
```

---

### Task 6: Inngest event-handler function

**Files:**
- Create: `src/inngest/functions/ai-pm-event-handler.ts`
- Test: `src/inngest/functions/__tests__/ai-pm-event-handler.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/inngest/functions/__tests__/ai-pm-event-handler.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { handleAiPmEvent } from '@/inngest/functions/ai-pm-event-handler';
import type { FillPayload, ChatPayload } from '@/lib/ai-pm/events';

function basics() {
  return {
    insertAiEventFn: vi.fn().mockResolvedValue('ev-1'),
    markEventFn: vi.fn().mockResolvedValue(undefined),
    checkThrottleFn: vi.fn().mockResolvedValue(false),
    loadConfigFn: vi.fn().mockResolvedValue({
      id: 'cfg1', userId: 'u1', bingxApiKeyId: 'k1', paperMode: true,
      enabled: true, killSwitch: false,
      maxCapitalUsdt: '1000', maxConcurrentBots: 5,
      allowedSymbols: ['BTC-USDT'], allowedStrategies: ['DCA'],
      anthropicApiKey: 'sk',
    }),
    loadBingxClientFn: vi.fn().mockResolvedValue({}),
    loadPortfolioFn: vi.fn().mockResolvedValue({ totalEquityUsdt: 1000, openPositions: [], openBots: [] }),
    runScopedFn: vi.fn().mockResolvedValue({
      status: 'COMPLETED', proposedCount: 1, executedCount: 1, failedCount: 0, rejectedCount: 0, executedDecisionId: 'dec-1',
    }),
    runChatFn: vi.fn().mockResolvedValue({ decisionId: null, assistantText: 'hi' }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

const fillPayload: FillPayload = {
  configId: 'cfg1', emittedAt: new Date().toISOString(),
  symbol: 'BTC-USDT', botId: 'b1', botKind: 'paper',
  side: 'LONG', fillPrice: '50000', quantity: '0.01', orderType: 'ENTRY',
};

const chatPayload: ChatPayload = {
  configId: 'cfg1', emittedAt: new Date().toISOString(),
  symbol: null, chatMessageId: 'msg-1', userMessage: 'how is BTC?',
};

describe('handleAiPmEvent', () => {
  it('inserts event, runs scoped pipeline, marks PROCESSED', async () => {
    const b = basics();
    const result = await handleAiPmEvent({
      eventName: 'ai-pm/event.fill',
      data: fillPayload,
      db: {} as never,
      ...b,
    });
    expect(b.insertAiEventFn).toHaveBeenCalled();
    expect(b.runScopedFn).toHaveBeenCalled();
    expect(b.markEventFn).toHaveBeenCalledWith(expect.objectContaining({ aiEventId: 'ev-1', status: 'PROCESSED', decisionId: 'dec-1' }));
    expect(result.status).toBe('PROCESSED');
  });

  it('marks THROTTLED and skips pipeline when checkThrottle returns true', async () => {
    const b = basics();
    b.checkThrottleFn.mockResolvedValueOnce(true);
    const result = await handleAiPmEvent({
      eventName: 'ai-pm/event.fill',
      data: fillPayload,
      db: {} as never,
      ...b,
    });
    expect(b.runScopedFn).not.toHaveBeenCalled();
    expect(b.markEventFn).toHaveBeenCalledWith(expect.objectContaining({ aiEventId: 'ev-1', status: 'THROTTLED' }));
    expect(result.status).toBe('THROTTLED');
  });

  it('routes chat events through runChatPipeline (no signal/decision call)', async () => {
    const b = basics();
    const result = await handleAiPmEvent({
      eventName: 'ai-pm/event.chat',
      data: chatPayload,
      db: {} as never,
      ...b,
    });
    expect(b.runChatFn).toHaveBeenCalled();
    expect(b.runScopedFn).not.toHaveBeenCalled();
    expect(result.status).toBe('PROCESSED');
  });

  it('marks FAILED and rethrows when scoped pipeline throws', async () => {
    const b = basics();
    b.runScopedFn.mockRejectedValueOnce(new Error('boom'));
    await expect(
      handleAiPmEvent({ eventName: 'ai-pm/event.fill', data: fillPayload, db: {} as never, ...b })
    ).rejects.toThrow('boom');
    expect(b.markEventFn).toHaveBeenCalledWith(expect.objectContaining({ aiEventId: 'ev-1', status: 'FAILED' }));
  });

  it('returns SKIPPED_CONFIG_DISABLED when config not enabled and event is non-chat', async () => {
    const b = basics();
    b.loadConfigFn.mockResolvedValueOnce({ ...await b.loadConfigFn(), enabled: false });
    const result = await handleAiPmEvent({
      eventName: 'ai-pm/event.fill',
      data: fillPayload,
      db: {} as never,
      ...b,
    });
    expect(b.runScopedFn).not.toHaveBeenCalled();
    expect(result.status).toBe('SKIPPED_CONFIG_DISABLED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run src/inngest/functions/__tests__/ai-pm-event-handler.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `src/inngest/functions/ai-pm-event-handler.ts`**

```ts
import { inngest } from '@/inngest/client';
import { db } from '@/db';
import {
  AI_PM_EVENT_NAMES,
  mapNameToEnum,
  type AiPmEventName,
  type AiPmEventPayload,
  type ChatPayload,
} from '@/lib/ai-pm/events';
import {
  insertAiEvent as defaultInsertAiEvent,
  markEvent as defaultMarkEvent,
  checkThrottle as defaultCheckThrottle,
} from '@/services/ai-events.service';
import { getAiPmConfigById } from '@/services/ai-pm-config.service';
import { getBingxClientByApiKeyId } from '@/services/bingx.service';
import { loadPortfolioState } from '@/lib/ai-pm/portfolio-state';
import { runScopedPipeline } from '@/lib/ai-pm/event-pipeline';
import { runChatPipeline } from '@/lib/ai-pm/chat-pipeline';
import { aiChatMessages } from '@/db/schema';
import { desc, eq } from 'drizzle-orm';

const THROTTLE_WINDOW_SECONDS = 300;

export type HandleResultStatus =
  | 'PROCESSED'
  | 'THROTTLED'
  | 'FAILED'
  | 'SKIPPED_CONFIG_DISABLED'
  | 'SKIPPED_NO_BINGX_CLIENT';

export interface HandleAiPmEventParams {
  eventName: AiPmEventName;
  data: AiPmEventPayload;
  db: typeof db;
  insertAiEventFn?: typeof defaultInsertAiEvent;
  markEventFn?: typeof defaultMarkEvent;
  checkThrottleFn?: typeof defaultCheckThrottle;
  loadConfigFn?: typeof getAiPmConfigById;
  loadBingxClientFn?: typeof getBingxClientByApiKeyId;
  loadPortfolioFn?: typeof loadPortfolioState;
  runScopedFn?: typeof runScopedPipeline;
  runChatFn?: typeof runChatPipeline;
  logger: { info: (msg: string, ctx?: unknown) => void; warn: (msg: string, ctx?: unknown) => void; error: (msg: string, ctx?: unknown) => void };
}

export interface HandleResult {
  aiEventId: string;
  status: HandleResultStatus;
  decisionId?: string | null;
}

export async function handleAiPmEvent(params: HandleAiPmEventParams): Promise<HandleResult> {
  const insertAiEvent = params.insertAiEventFn ?? defaultInsertAiEvent;
  const markEvent = params.markEventFn ?? defaultMarkEvent;
  const checkThrottle = params.checkThrottleFn ?? defaultCheckThrottle;
  const loadConfig = params.loadConfigFn ?? getAiPmConfigById;
  const loadBingx = params.loadBingxClientFn ?? getBingxClientByApiKeyId;
  const loadPortfolio = params.loadPortfolioFn ?? loadPortfolioState;
  const runScoped = params.runScopedFn ?? runScopedPipeline;
  const runChat = params.runChatFn ?? runChatPipeline;

  const eventType = mapNameToEnum(params.eventName);
  const symbol = 'symbol' in params.data ? params.data.symbol : null;
  const emittedAt = new Date(params.data.emittedAt);

  const aiEventId = await insertAiEvent({
    db: params.db,
    configId: params.data.configId,
    eventType,
    symbol: symbol ?? null,
    payload: params.data,
    emittedAt,
  });

  const throttled = await checkThrottle({
    db: params.db,
    configId: params.data.configId,
    eventType,
    symbol: symbol ?? null,
    currentEventId: aiEventId,
    windowSeconds: THROTTLE_WINDOW_SECONDS,
  });

  if (throttled) {
    await markEvent({ db: params.db, aiEventId, status: 'THROTTLED' });
    return { aiEventId, status: 'THROTTLED' };
  }

  const config = await loadConfig(params.data.configId);
  if (!config || (!config.enabled && params.eventName !== 'ai-pm/event.chat')) {
    await markEvent({ db: params.db, aiEventId, status: 'FAILED' });
    return { aiEventId, status: 'SKIPPED_CONFIG_DISABLED' };
  }

  await markEvent({ db: params.db, aiEventId, status: 'PROCESSING' });

  try {
    if (params.eventName === 'ai-pm/event.chat') {
      const result = await runChat({
        payload: params.data as ChatPayload,
        aiEventId,
        config,
        portfolioState: await loadPortfolio({ userId: config.userId, bingxApiKeyId: config.bingxApiKeyId, db: params.db }),
        db: params.db,
        loadChatHistoryFn: async (userId, limit) => loadChatHistory(params.db, userId, limit),
        isKillSwitchActive: async () => {
          const fresh = await loadConfig(config.id);
          return Boolean(fresh?.killSwitch);
        },
        logger: params.logger,
      });
      await markEvent({ db: params.db, aiEventId, status: 'PROCESSED', decisionId: result.decisionId });
      return { aiEventId, status: 'PROCESSED', decisionId: result.decisionId };
    }

    const client = await loadBingx(config.bingxApiKeyId);
    if (!client) {
      await markEvent({ db: params.db, aiEventId, status: 'FAILED' });
      return { aiEventId, status: 'SKIPPED_NO_BINGX_CLIENT' };
    }

    const portfolioState = await loadPortfolio({ userId: config.userId, bingxApiKeyId: config.bingxApiKeyId, db: params.db });

    const result = await runScoped({
      eventType,
      symbol: symbol ?? '',
      payload: params.data,
      aiEventId,
      config,
      bingxClient: client,
      portfolioState,
      db: params.db,
      isKillSwitchActive: async () => {
        const fresh = await loadConfig(config.id);
        return Boolean(fresh?.killSwitch);
      },
      logger: params.logger,
    });

    await markEvent({
      db: params.db,
      aiEventId,
      status: 'PROCESSED',
      decisionId: result.executedDecisionId,
    });
    return { aiEventId, status: 'PROCESSED', decisionId: result.executedDecisionId };
  } catch (err) {
    params.logger.error('event_handler_failed', { aiEventId, err: err instanceof Error ? err.message : String(err) });
    await markEvent({ db: params.db, aiEventId, status: 'FAILED' });
    throw err;
  }
}

async function loadChatHistory(
  database: typeof db,
  userId: string,
  limit: number,
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const rows = await database
    .select({ role: aiChatMessages.role, content: aiChatMessages.content })
    .from(aiChatMessages)
    .where(eq(aiChatMessages.userId, userId))
    .orderBy(desc(aiChatMessages.createdAt))
    .limit(limit);
  return rows
    .reverse()
    .map((r) => ({ role: (r.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant', content: r.content ?? '' }));
}

export const aiPmEventHandler = inngest.createFunction(
  {
    id: 'ai-pm-event-handler',
    retries: 2,
    concurrency: [
      { limit: 5 },
      { limit: 1, key: 'event.data.configId' },
    ],
  },
  AI_PM_EVENT_NAMES.map((name) => ({ event: name })),
  async ({ event, logger }) => {
    return handleAiPmEvent({
      eventName: event.name as AiPmEventName,
      data: event.data as AiPmEventPayload,
      db,
      logger: {
        info: (msg, ctx) => logger.info(msg, ctx ?? {}),
        warn: (msg, ctx) => logger.warn(msg, ctx ?? {}),
        error: (msg, ctx) => logger.error(msg, ctx ?? {}),
      },
    });
  },
);
```

> Note: Inngest accepts an array of triggers as the second argument to `createFunction` for multi-event subscribers. Each entry binds one event name. This avoids the wildcard syntax which is less consistently supported across SDK versions.

- [ ] **Step 4: Run test to verify it passes**

```
npx vitest run src/inngest/functions/__tests__/ai-pm-event-handler.test.ts
```

Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```
git add src/inngest/functions/ai-pm-event-handler.ts src/inngest/functions/__tests__/ai-pm-event-handler.test.ts
git commit -m "feat(ai-pm): event-handler Inngest function (S14)"
```

---

### Task 7: Paper bot simulator + event emitter

**Files:**
- Create: `src/services/paper-bot-sim.service.ts`
- Test: `src/services/__tests__/paper-bot-sim.service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/services/__tests__/paper-bot-sim.service.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { tickPaperBots, computeDrawdownPct } from '@/services/paper-bot-sim.service';

const baseBot = {
  id: 'pb-1',
  userId: 'u1',
  decisionId: null,
  symbol: 'BTC-USDT',
  strategy: 'DCA' as const,
  capitalUsdt: '1000',
  status: 'RUNNING' as const,
  pnlUsdt: '0',
  startedAt: new Date(),
  stoppedAt: null,
  trades: [],
  params: { leverage: 1, reasoning: '' },
  createdAt: new Date(),
};

describe('paper-bot-sim', () => {
  it('computeDrawdownPct returns negative percentage from pnl/capital', () => {
    expect(computeDrawdownPct({ pnlUsdt: '-150', capitalUsdt: '1000' })).toBeCloseTo(-15);
    expect(computeDrawdownPct({ pnlUsdt: '0', capitalUsdt: '1000' })).toBeCloseTo(0);
    expect(computeDrawdownPct({ pnlUsdt: '50', capitalUsdt: '1000' })).toBeCloseTo(5);
  });

  it('tickPaperBots updates pnlUsdt using last candle close vs starting price', async () => {
    const fetchKlinesFn = vi.fn().mockResolvedValue([
      { open: 100, high: 110, low: 90, close: 95, openTime: 1, closeTime: 2, volume: 0 },
    ]);
    const fakeDb = {
      query: { paperBots: { findMany: async () => [{ ...baseBot, pnlUsdt: '0', params: { ...baseBot.params, lastSimPrice: 100 } }] } },
      update: () => ({ set: (patch: { pnlUsdt: string }) => ({ where: () => ({ returning: async () => [{ ...baseBot, pnlUsdt: patch.pnlUsdt }] }) }) }),
    } as never;
    const sendEventFn = vi.fn();

    const ticked = await tickPaperBots({
      db: fakeDb,
      configId: 'cfg1',
      userId: 'u1',
      allowedSymbols: ['BTC-USDT'],
      maxDrawdownPct: 50,
      fetchKlinesFn,
      sendEventFn,
      bingxClient: {} as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(ticked.advanced).toBe(1);
    // pnl decreases because close (95) < lastSimPrice (100); capital 1000 → pnl ≈ -50
    expect(ticked.bots[0].newPnlUsdt).toBeCloseTo(-50, 0);
  });

  it('tickPaperBots emits drawdown event when threshold breached', async () => {
    const fetchKlinesFn = vi.fn().mockResolvedValue([
      { open: 100, high: 110, low: 50, close: 60, openTime: 1, closeTime: 2, volume: 0 },
    ]);
    const captured: unknown[] = [];
    const sendEventFn = vi.fn(async (ev: unknown) => { captured.push(ev); });
    const fakeDb = {
      query: { paperBots: { findMany: async () => [{ ...baseBot, params: { ...baseBot.params, lastSimPrice: 100 } }] } },
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [baseBot] }) }) }),
    } as never;

    await tickPaperBots({
      db: fakeDb,
      configId: 'cfg1',
      userId: 'u1',
      allowedSymbols: ['BTC-USDT'],
      maxDrawdownPct: 10,
      fetchKlinesFn,
      sendEventFn,
      bingxClient: {} as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const drawdownEvent = captured.find((e) => (e as { name: string }).name === 'ai-pm/event.drawdown');
    expect(drawdownEvent).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run src/services/__tests__/paper-bot-sim.service.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `src/services/paper-bot-sim.service.ts`**

```ts
import { eq, and } from 'drizzle-orm';
import { paperBots } from '@/db/schema';
import { fetchKlines } from '@/lib/bingx/market-data';
import type { BingxClient } from '@/lib/bingx/client';
import type { Kline } from '@/services/bingx.service';
import type { db as Db } from '@/db';
import type { AiPmEventName, AiPmEventPayload } from '@/lib/ai-pm/events';

export interface PaperBotSimRow {
  id: string;
  symbol: string;
  capitalUsdt: string;
  pnlUsdt: string;
  newPnlUsdt: number;
  drawdownPct: number;
}

export interface TickResult {
  advanced: number;
  bots: PaperBotSimRow[];
}

export interface TickPaperBotsParams {
  db: typeof Db;
  configId: string;
  userId: string;
  allowedSymbols: string[];
  maxDrawdownPct: number;
  fetchKlinesFn?: (client: BingxClient, symbol: string, interval: string, limit: number) => Promise<Kline[]>;
  sendEventFn: (event: { name: AiPmEventName; data: AiPmEventPayload }) => Promise<void> | void;
  bingxClient: BingxClient;
  logger: { info: (msg: string, ctx?: unknown) => void; warn: (msg: string, ctx?: unknown) => void; error: (msg: string, ctx?: unknown) => void };
}

const INTERVAL = '5m';
const CANDLE_LIMIT = 2;

export function computeDrawdownPct(input: { pnlUsdt: string; capitalUsdt: string }): number {
  const pnl = Number(input.pnlUsdt);
  const capital = Number(input.capitalUsdt);
  if (capital === 0) return 0;
  return (pnl / capital) * 100;
}

export async function tickPaperBots(params: TickPaperBotsParams): Promise<TickResult> {
  const fetcher = params.fetchKlinesFn ?? fetchKlines;
  const out: PaperBotSimRow[] = [];

  const bots = await params.db.query.paperBots.findMany({
    where: and(eq(paperBots.userId, params.userId), eq(paperBots.status, 'RUNNING')),
  });

  for (const bot of bots) {
    if (!params.allowedSymbols.includes(bot.symbol)) continue;

    const candles = await fetcher(params.bingxClient, bot.symbol, INTERVAL, CANDLE_LIMIT);
    if (candles.length === 0) continue;

    const lastClose = Number(candles[candles.length - 1].close);
    const botParams = (bot.params as { lastSimPrice?: number } | null) ?? {};
    const lastSimPrice = botParams.lastSimPrice ?? lastClose;
    const capital = Number(bot.capitalUsdt);
    const prevPnl = Number(bot.pnlUsdt ?? 0);
    const pctChange = (lastClose - lastSimPrice) / lastSimPrice;
    const newPnl = prevPnl + capital * pctChange;

    await params.db
      .update(paperBots)
      .set({
        pnlUsdt: String(newPnl.toFixed(8)),
        params: { ...botParams, lastSimPrice: lastClose },
      })
      .where(eq(paperBots.id, bot.id))
      .returning();

    const drawdownPct = computeDrawdownPct({ pnlUsdt: String(newPnl), capitalUsdt: bot.capitalUsdt });
    out.push({
      id: bot.id,
      symbol: bot.symbol,
      capitalUsdt: bot.capitalUsdt,
      pnlUsdt: bot.pnlUsdt ?? '0',
      newPnlUsdt: newPnl,
      drawdownPct,
    });

    if (drawdownPct < -params.maxDrawdownPct) {
      await params.sendEventFn({
        name: 'ai-pm/event.drawdown',
        data: {
          configId: params.configId,
          emittedAt: new Date().toISOString(),
          symbol: bot.symbol,
          botId: bot.id,
          botKind: 'paper',
          drawdownPct,
          thresholdPct: params.maxDrawdownPct,
          currentPnlUsdt: String(newPnl),
          capitalUsdt: bot.capitalUsdt,
        },
      });
    }
  }

  return { advanced: out.length, bots: out };
}
```

- [ ] **Step 4: Run test to verify it passes**

```
npx vitest run src/services/__tests__/paper-bot-sim.service.test.ts
```

Expected: PASS — all 3 tests green.

- [ ] **Step 5: Commit**

```
git add src/services/paper-bot-sim.service.ts src/services/__tests__/paper-bot-sim.service.test.ts
git commit -m "feat(ai-pm): paper-bot simulator + drawdown emitter (S14)"
```

---

### Task 8: ai-pm-monitor Inngest cron

**Files:**
- Create: `src/inngest/functions/ai-pm-monitor.ts`
- Test: `src/inngest/functions/__tests__/ai-pm-monitor.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/inngest/functions/__tests__/ai-pm-monitor.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { runMonitorForConfig } from '@/inngest/functions/ai-pm-monitor';

function baseCfg() {
  return {
    id: 'cfg1',
    userId: 'u1',
    bingxApiKeyId: 'k1',
    enabled: true,
    killSwitch: false,
    paperMode: true,
    maxDrawdownPct: '10',
    allowedSymbols: ['BTC-USDT'],
    anthropicApiKey: 'sk',
  };
}

describe('ai-pm-monitor', () => {
  it('emits funding-flip when sign of rate changes vs cache', async () => {
    const sent: unknown[] = [];
    const fakeDb = {
      query: {
        paperBots: { findMany: async () => [] },
        aiPmFundingCache: { findFirst: async () => ({ symbol: 'BTC-USDT', fundingRate: '0.0010' }) },
      },
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
      insert: () => ({ values: () => ({ onConflictDoUpdate: () => ({ returning: async () => [] }) }) }),
    } as never;

    await runMonitorForConfig({
      db: fakeDb,
      config: baseCfg(),
      loadBingxClientFn: async () => ({}) as never,
      fetchFundingRateFn: async () => -0.0008,
      tickPaperBotsFn: vi.fn().mockResolvedValue({ advanced: 0, bots: [] }),
      sendEventFn: async (e) => { sent.push(e); },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(sent.find((e) => (e as { name: string }).name === 'ai-pm/event.funding-flip')).toBeDefined();
  });

  it('does not emit funding-flip when sign unchanged', async () => {
    const sent: unknown[] = [];
    const fakeDb = {
      query: {
        paperBots: { findMany: async () => [] },
        aiPmFundingCache: { findFirst: async () => ({ symbol: 'BTC-USDT', fundingRate: '0.0010' }) },
      },
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
      insert: () => ({ values: () => ({ onConflictDoUpdate: () => ({ returning: async () => [] }) }) }),
    } as never;

    await runMonitorForConfig({
      db: fakeDb,
      config: baseCfg(),
      loadBingxClientFn: async () => ({}) as never,
      fetchFundingRateFn: async () => 0.0015,
      tickPaperBotsFn: vi.fn().mockResolvedValue({ advanced: 0, bots: [] }),
      sendEventFn: async (e) => { sent.push(e); },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(sent.find((e) => (e as { name: string }).name === 'ai-pm/event.funding-flip')).toBeUndefined();
  });

  it('calls tickPaperBots once with config thresholds', async () => {
    const tickFn = vi.fn().mockResolvedValue({ advanced: 0, bots: [] });
    const fakeDb = {
      query: {
        paperBots: { findMany: async () => [] },
        aiPmFundingCache: { findFirst: async () => null },
      },
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
      insert: () => ({ values: () => ({ onConflictDoUpdate: () => ({ returning: async () => [] }) }) }),
    } as never;

    await runMonitorForConfig({
      db: fakeDb,
      config: baseCfg(),
      loadBingxClientFn: async () => ({}) as never,
      fetchFundingRateFn: async () => 0,
      tickPaperBotsFn: tickFn,
      sendEventFn: async () => {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(tickFn).toHaveBeenCalledWith(expect.objectContaining({
      configId: 'cfg1',
      userId: 'u1',
      maxDrawdownPct: 10,
      allowedSymbols: ['BTC-USDT'],
    }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run src/inngest/functions/__tests__/ai-pm-monitor.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/inngest/functions/ai-pm-monitor.ts`**

```ts
import { eq, and } from 'drizzle-orm';
import { inngest } from '@/inngest/client';
import { db } from '@/db';
import { aiPmFundingCache } from '@/db/schema';
import { listEnabledAiPmConfigs } from '@/services/ai-pm-config.service';
import { getBingxClientByApiKeyId } from '@/services/bingx.service';
import { tickPaperBots } from '@/services/paper-bot-sim.service';
import type { BingxClient } from '@/lib/bingx/client';
import type { AiPmEventName, AiPmEventPayload } from '@/lib/ai-pm/events';
import type { AiPmConfigDecrypted } from '@/services/ai-pm-config.service';

export interface RunMonitorForConfigParams {
  db: typeof db;
  config: Pick<AiPmConfigDecrypted, 'id' | 'userId' | 'bingxApiKeyId' | 'paperMode' | 'maxDrawdownPct' | 'allowedSymbols' | 'enabled' | 'killSwitch'>;
  loadBingxClientFn?: (apiKeyId: string) => Promise<BingxClient | null>;
  fetchFundingRateFn?: (client: BingxClient, symbol: string) => Promise<number>;
  tickPaperBotsFn?: typeof tickPaperBots;
  sendEventFn: (event: { name: AiPmEventName; data: AiPmEventPayload }) => Promise<void>;
  logger: { info: (msg: string, ctx?: unknown) => void; warn: (msg: string, ctx?: unknown) => void; error: (msg: string, ctx?: unknown) => void };
}

async function defaultFetchFundingRate(client: BingxClient, symbol: string): Promise<number> {
  const resp = await client.get<{ data: Array<{ lastFundingRate?: string }> | { lastFundingRate?: string } }>(
    '/openApi/swap/v2/quote/premiumIndex',
    { symbol },
  );
  const item = Array.isArray(resp.data) ? resp.data[0] : resp.data;
  return Number(item?.lastFundingRate ?? 0);
}

export async function runMonitorForConfig(params: RunMonitorForConfigParams): Promise<{ advanced: number; flipped: string[] }> {
  if (params.config.killSwitch || !params.config.enabled) {
    return { advanced: 0, flipped: [] };
  }

  const loadBingx = params.loadBingxClientFn ?? getBingxClientByApiKeyId;
  const fetchRate = params.fetchFundingRateFn ?? defaultFetchFundingRate;
  const tickFn = params.tickPaperBotsFn ?? tickPaperBots;

  const client = await loadBingx(params.config.bingxApiKeyId);
  if (!client) {
    params.logger.warn('monitor_no_bingx_client', { configId: params.config.id });
    return { advanced: 0, flipped: [] };
  }

  const allowedSymbols = params.config.allowedSymbols ?? [];
  const maxDrawdownPct = Number(params.config.maxDrawdownPct ?? 20);

  const tickResult = params.config.paperMode
    ? await tickFn({
        db: params.db,
        configId: params.config.id,
        userId: params.config.userId,
        allowedSymbols,
        maxDrawdownPct,
        sendEventFn: params.sendEventFn,
        bingxClient: client,
        logger: params.logger,
      })
    : { advanced: 0, bots: [] };

  const flipped: string[] = [];
  for (const symbol of allowedSymbols) {
    const cached = await params.db.query.aiPmFundingCache.findFirst({
      where: and(eq(aiPmFundingCache.configId, params.config.id), eq(aiPmFundingCache.symbol, symbol)),
    });
    let currentRate: number;
    try {
      currentRate = await fetchRate(client, symbol);
    } catch (err) {
      params.logger.warn('funding_rate_fetch_failed', { symbol, err: err instanceof Error ? err.message : String(err) });
      continue;
    }

    if (cached) {
      const prev = Number(cached.fundingRate);
      if (Math.sign(prev) !== 0 && Math.sign(currentRate) !== 0 && Math.sign(prev) !== Math.sign(currentRate)) {
        await params.sendEventFn({
          name: 'ai-pm/event.funding-flip',
          data: {
            configId: params.config.id,
            emittedAt: new Date().toISOString(),
            symbol,
            previousRate: prev,
            currentRate,
          },
        });
        flipped.push(symbol);
      }
    }

    await params.db
      .insert(aiPmFundingCache)
      .values({ configId: params.config.id, symbol, fundingRate: String(currentRate) })
      .onConflictDoUpdate({
        target: [aiPmFundingCache.configId, aiPmFundingCache.symbol],
        set: { fundingRate: String(currentRate), observedAt: new Date() },
      });
  }

  return { advanced: tickResult.advanced, flipped };
}

export const aiPmMonitor = inngest.createFunction(
  {
    id: 'ai-pm-monitor',
    retries: 0,
    concurrency: { limit: 3 },
  },
  { cron: '*/5 * * * *' },
  async ({ step, logger }) => {
    const configs = await step.run('load-configs', listEnabledAiPmConfigs);
    if (configs.length === 0) return { tickAt: Date.now(), configs: 0 };

    const results: Array<{ configId: string; advanced: number; flipped: string[] }> = [];
    for (const cfg of configs) {
      const r = await step.run(`monitor-${cfg.id}`, () =>
        runMonitorForConfig({
          db,
          config: cfg,
          sendEventFn: async (event) => {
            await inngest.send(event);
          },
          logger: {
            info: (msg, ctx) => logger.info(msg, ctx ?? {}),
            warn: (msg, ctx) => logger.warn(msg, ctx ?? {}),
            error: (msg, ctx) => logger.error(msg, ctx ?? {}),
          },
        }),
      );
      results.push({ configId: cfg.id, ...r });
    }
    return { tickAt: Date.now(), configs: configs.length, results };
  },
);
```

- [ ] **Step 4: Run test to verify it passes**

```
npx vitest run src/inngest/functions/__tests__/ai-pm-monitor.test.ts
```

Expected: PASS — all 3 tests green.

- [ ] **Step 5: Commit**

```
git add src/inngest/functions/ai-pm-monitor.ts src/inngest/functions/__tests__/ai-pm-monitor.test.ts
git commit -m "feat(ai-pm): ai-pm-monitor cron (paper tick + funding flip) (S14)"
```

---

### Task 9: Sidecar event emission helpers + integration into trading-bot-watch

**Files:**
- Create: `src/lib/ai-pm/emit-events.ts` — helpers `maybeEmitFillEvent`, `maybeEmitErrorEvent`.
- Modify: `src/inngest/functions/trading-bot-watch.ts` — call helpers when AI-managed.
- Test: `src/lib/ai-pm/__tests__/emit-events.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/ai-pm/__tests__/emit-events.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { maybeEmitFillEvent, maybeEmitErrorEvent } from '@/lib/ai-pm/emit-events';

describe('maybeEmitFillEvent', () => {
  it('emits when bot is AI-managed (real)', async () => {
    const sent: unknown[] = [];
    const sendEventFn = async (e: unknown) => { sent.push(e); };
    const lookupConfigFn = async () => ({ id: 'cfg1' });

    await maybeEmitFillEvent({
      sendEventFn,
      lookupConfigByApiKeyIdFn: lookupConfigFn,
      apiKeyId: 'k1',
      botId: 'b1',
      botKind: 'real',
      symbol: 'BTC-USDT',
      side: 'LONG',
      fillPrice: '50000',
      quantity: '0.01',
      orderType: 'ENTRY',
    });

    expect(sent).toHaveLength(1);
    expect((sent[0] as { name: string }).name).toBe('ai-pm/event.fill');
  });

  it('does not emit when no config matches apiKeyId', async () => {
    const sent: unknown[] = [];
    const sendEventFn = async (e: unknown) => { sent.push(e); };
    const lookupConfigFn = async () => null;

    await maybeEmitFillEvent({
      sendEventFn,
      lookupConfigByApiKeyIdFn: lookupConfigFn,
      apiKeyId: 'k1',
      botId: 'b1',
      botKind: 'real',
      symbol: 'BTC-USDT',
      side: 'LONG',
      fillPrice: '50000',
      quantity: '0.01',
      orderType: 'ENTRY',
    });

    expect(sent).toHaveLength(0);
  });
});

describe('maybeEmitErrorEvent', () => {
  it('truncates messages over 500 chars', async () => {
    const sent: Array<{ name: string; data: { message: string } }> = [];
    await maybeEmitErrorEvent({
      sendEventFn: async (e) => { sent.push(e as { name: string; data: { message: string } }); },
      lookupConfigByApiKeyIdFn: async () => ({ id: 'cfg1' }),
      apiKeyId: 'k1',
      botId: 'b1',
      botKind: 'real',
      symbol: 'BTC-USDT',
      errorKind: 'API_ERROR',
      message: 'x'.repeat(700),
    });
    expect(sent[0].data.message.length).toBeLessThanOrEqual(500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run src/lib/ai-pm/__tests__/emit-events.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/ai-pm/emit-events.ts`**

```ts
import type { AiPmEventName, AiPmEventPayload, FillPayload, ErrorPayload } from '@/lib/ai-pm/events';
import { truncateErrorMessage } from '@/lib/ai-pm/events';
import { getAiPmConfigByBingxApiKeyId } from '@/services/ai-pm-config.service';

export interface EmitFillParams {
  sendEventFn: (event: { name: AiPmEventName; data: AiPmEventPayload }) => Promise<void> | void;
  lookupConfigByApiKeyIdFn?: typeof getAiPmConfigByBingxApiKeyId;
  apiKeyId: string;
  botId: string;
  botKind: 'real' | 'paper';
  symbol: string;
  side: 'LONG' | 'SHORT';
  fillPrice: string;
  quantity: string;
  orderType: 'ENTRY' | 'TAKE_PROFIT' | 'STOP_LOSS';
}

export async function maybeEmitFillEvent(params: EmitFillParams): Promise<void> {
  const lookup = params.lookupConfigByApiKeyIdFn ?? getAiPmConfigByBingxApiKeyId;
  const config = await lookup(params.apiKeyId);
  if (!config) return;

  const data: FillPayload = {
    configId: config.id,
    emittedAt: new Date().toISOString(),
    symbol: params.symbol,
    botId: params.botId,
    botKind: params.botKind,
    side: params.side,
    fillPrice: params.fillPrice,
    quantity: params.quantity,
    orderType: params.orderType,
  };
  await params.sendEventFn({ name: 'ai-pm/event.fill', data });
}

export interface EmitErrorParams {
  sendEventFn: (event: { name: AiPmEventName; data: AiPmEventPayload }) => Promise<void> | void;
  lookupConfigByApiKeyIdFn?: typeof getAiPmConfigByBingxApiKeyId;
  apiKeyId: string;
  botId: string;
  botKind: 'real' | 'paper';
  symbol: string;
  errorKind: ErrorPayload['errorKind'];
  message: string;
}

export async function maybeEmitErrorEvent(params: EmitErrorParams): Promise<void> {
  const lookup = params.lookupConfigByApiKeyIdFn ?? getAiPmConfigByBingxApiKeyId;
  const config = await lookup(params.apiKeyId);
  if (!config) return;

  const data: ErrorPayload = {
    configId: config.id,
    emittedAt: new Date().toISOString(),
    symbol: params.symbol,
    botId: params.botId,
    botKind: params.botKind,
    errorKind: params.errorKind,
    message: truncateErrorMessage(params.message),
  };
  await params.sendEventFn({ name: 'ai-pm/event.error', data });
}
```

- [ ] **Step 4: Run test to verify it passes**

```
npx vitest run src/lib/ai-pm/__tests__/emit-events.test.ts
```

Expected: PASS — both tests green.

- [ ] **Step 5: Commit**

```
git add src/lib/ai-pm/emit-events.ts src/lib/ai-pm/__tests__/emit-events.test.ts
git commit -m "feat(ai-pm): event emission helpers (S14)"
```

---

### Task 10: Wire fill/error emission into trading-bot-watch + other handlers

**Files:**
- Modify: `src/inngest/functions/trading-bot-watch.ts`
- Modify: `src/inngest/functions/dca-bot-watch.ts`
- Modify: `src/inngest/functions/dca-spot-bot-watch.ts`
- Modify: `src/inngest/functions/trailing-stop-watch.ts`
- Modify: `src/inngest/functions/sma-crossover-watch.ts`

Implementation note: each handler already iterates user bots and handles errors. Add a call to `maybeEmitErrorEvent` inside the existing error catch path; add a call to `maybeEmitFillEvent` after a successful fill is observed. Look in each handler for the existing pattern that updates `bot_trades` rows — that is the fill-detection point.

- [ ] **Step 1: Identify integration points**

For each handler file, locate:
- The line where a new fill row is inserted into `bot_trades` (search for `botTrades` insert calls). This is the fill emission point.
- The catch block where a BingX API call failure is logged. This is the error emission point.

If a handler does not directly insert into `bot_trades` (i.e. fills only land via cron-triggered reconciliation), instead emit the fill event at the location where the bot's filled order is first observed (look for status change to `FILLED`).

- [ ] **Step 2: Write integration test for trading-bot-watch**

Add a test in `src/inngest/functions/__tests__/trading-bot-watch.test.ts` (or create if missing):

```ts
import { describe, it, expect, vi } from 'vitest';
import { runTradingBotWatchOnce } from '@/inngest/functions/trading-bot-watch';

describe('trading-bot-watch event emission', () => {
  it('calls maybeEmitFillEvent for AI-managed bots on new fill', async () => {
    const emit = vi.fn();
    await runTradingBotWatchOnce({
      // ... minimal mocks
      emitFillFn: emit,
      bots: [{ id: 'b1', apiKeyId: 'k1', symbol: 'BTC-USDT', userId: 'u1', isAiManaged: true }],
      newFills: [{ botId: 'b1', side: 'LONG', price: '50000', qty: '0.01', orderType: 'ENTRY' }],
    } as never);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
```

> If `runTradingBotWatchOnce` does not exist with that shape, extract a thin wrapper around the existing handler body that takes injectable dependencies (the body currently inside the `inngest.createFunction` callback). Keep the inngest function definition itself in the file; only refactor the body to call the exported helper.

- [ ] **Step 3: Run test to verify it fails**

```
npx vitest run src/inngest/functions/__tests__/trading-bot-watch.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Wire emission into `trading-bot-watch.ts`**

In each handler, after a successful fill insert and inside each error catch, call the relevant `maybeEmit*Event` helper. Example skeleton for fill emission:

```ts
import { maybeEmitFillEvent, maybeEmitErrorEvent } from '@/lib/ai-pm/emit-events';
import { inngest } from '@/inngest/client';

// inside the loop, after inserting a bot_trades row for a fill:
await maybeEmitFillEvent({
  sendEventFn: (event) => inngest.send(event),
  apiKeyId: bot.apiKeyId,
  botId: bot.id,
  botKind: 'real',
  symbol: bot.symbol,
  side: trade.side,
  fillPrice: trade.price,
  quantity: trade.quantity,
  orderType: trade.type === 'ENTRY' ? 'ENTRY' : trade.type === 'EXIT_TP' ? 'TAKE_PROFIT' : 'STOP_LOSS',
});

// inside a catch block where a BingX call rejected:
await maybeEmitErrorEvent({
  sendEventFn: (event) => inngest.send(event),
  apiKeyId: bot.apiKeyId,
  botId: bot.id,
  botKind: 'real',
  symbol: bot.symbol,
  errorKind: classifyError(err),
  message: err instanceof Error ? err.message : String(err),
});
```

Helper for `classifyError`:

```ts
function classifyError(err: unknown): 'API_ERROR' | 'INSUFFICIENT_MARGIN' | 'INVALID_PARAMS' | 'ORDER_REJECTED' | 'UNKNOWN' {
  const msg = err instanceof Error ? err.message : String(err);
  if (/insufficient/i.test(msg)) return 'INSUFFICIENT_MARGIN';
  if (/invalid/i.test(msg)) return 'INVALID_PARAMS';
  if (/rejected/i.test(msg)) return 'ORDER_REJECTED';
  if (/api|bingx|http/i.test(msg)) return 'API_ERROR';
  return 'UNKNOWN';
}
```

Inline `classifyError` near the top of `trading-bot-watch.ts` and reuse from the other four handlers by exporting it from a new module `src/lib/ai-pm/classify-error.ts`:

```ts
// src/lib/ai-pm/classify-error.ts
export function classifyError(err: unknown): 'API_ERROR' | 'INSUFFICIENT_MARGIN' | 'INVALID_PARAMS' | 'ORDER_REJECTED' | 'UNKNOWN' {
  const msg = err instanceof Error ? err.message : String(err);
  if (/insufficient/i.test(msg)) return 'INSUFFICIENT_MARGIN';
  if (/invalid/i.test(msg)) return 'INVALID_PARAMS';
  if (/rejected/i.test(msg)) return 'ORDER_REJECTED';
  if (/api|bingx|http/i.test(msg)) return 'API_ERROR';
  return 'UNKNOWN';
}
```

Repeat the wiring (with the appropriate emission point) in `dca-bot-watch.ts`, `dca-spot-bot-watch.ts`, `trailing-stop-watch.ts`, `sma-crossover-watch.ts`. The exact emission point inside each file depends on its current structure — find the place where fills are recorded and errors are caught.

- [ ] **Step 5: Run all watch handler tests**

```
npx vitest run src/inngest/functions/__tests__/
```

Expected: PASS — existing watch handler tests continue to pass; new fill-emission tests pass.

- [ ] **Step 6: Commit**

```
git add src/inngest/functions/trading-bot-watch.ts src/inngest/functions/dca-bot-watch.ts src/inngest/functions/dca-spot-bot-watch.ts src/inngest/functions/trailing-stop-watch.ts src/inngest/functions/sma-crossover-watch.ts src/lib/ai-pm/classify-error.ts src/inngest/functions/__tests__/
git commit -m "feat(ai-pm): emit fill/error events from existing bot-watch handlers (S14)"
```

---

### Task 11: POST /api/ai-pm/chat route

**Files:**
- Create: `src/app/api/ai-pm/chat/route.ts`
- Test: `src/app/api/ai-pm/chat/__tests__/route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/ai-pm/chat/__tests__/route.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/auth/server', () => ({
  getAuthenticatedUser: vi.fn().mockResolvedValue({ id: 'user-1' }),
}));

const sendMock = vi.fn();
vi.mock('@/inngest/client', () => ({
  inngest: { send: sendMock },
}));

const insertMock = vi.fn();
vi.mock('@/db', () => ({
  db: {
    insert: () => ({ values: (v: unknown) => ({ returning: async () => { insertMock(v); return [{ id: 'msg-1' }]; } }) }),
    query: {
      aiPmConfigs: { findFirst: async () => ({ id: 'cfg-1', userId: 'user-1', enabled: true }) },
    },
  },
}));

describe('POST /api/ai-pm/chat', () => {
  it('inserts user message + emits ai-pm/event.chat', async () => {
    const { POST } = await import('@/app/api/ai-pm/chat/route');
    const req = new Request('http://localhost/api/ai-pm/chat', {
      method: 'POST',
      body: JSON.stringify({ configId: 'cfg-1', message: 'how is BTC?' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(insertMock).toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'ai-pm/event.chat',
      data: expect.objectContaining({ configId: 'cfg-1', userMessage: 'how is BTC?' }),
    }));
  });

  it('returns 400 when message empty', async () => {
    const { POST } = await import('@/app/api/ai-pm/chat/route');
    const req = new Request('http://localhost/api/ai-pm/chat', {
      method: 'POST',
      body: JSON.stringify({ configId: 'cfg-1', message: '' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npx vitest run src/app/api/ai-pm/chat/__tests__/route.test.ts
```

Expected: FAIL — route does not exist.

- [ ] **Step 3: Create `src/app/api/ai-pm/chat/route.ts`**

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/db';
import { aiChatMessages, aiPmConfigs } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { inngest } from '@/inngest/client';
import { getAuthenticatedUser } from '@/lib/auth/server';
import { truncateChatMessage } from '@/lib/ai-pm/events';

const BodySchema = z.object({
  configId: z.string().uuid(),
  message: z.string().min(1).max(2000),
});

export async function POST(req: Request): Promise<NextResponse> {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof BodySchema>;
  try {
    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'Invalid body', issues: parsed.error.issues }, { status: 400 });
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const config = await db.query.aiPmConfigs.findFirst({
    where: and(eq(aiPmConfigs.id, body.configId), eq(aiPmConfigs.userId, user.id)),
  });
  if (!config) return NextResponse.json({ error: 'Config not found' }, { status: 404 });

  const truncated = truncateChatMessage(body.message);
  const [row] = await db
    .insert(aiChatMessages)
    .values({ userId: user.id, role: 'user', content: truncated })
    .returning();

  await inngest.send({
    name: 'ai-pm/event.chat',
    data: {
      configId: body.configId,
      emittedAt: new Date().toISOString(),
      symbol: null,
      chatMessageId: row.id,
      userMessage: truncated,
    },
  });

  return NextResponse.json({ ok: true, chatMessageId: row.id });
}
```

> Note: confirm the auth helper path. If your codebase uses a different module (e.g. `@/lib/auth` or `@/lib/supabase/server`), substitute the correct import and adjust the test's `vi.mock` target accordingly.

- [ ] **Step 4: Run test to verify it passes**

```
npx vitest run src/app/api/ai-pm/chat/__tests__/route.test.ts
```

Expected: PASS — both tests green.

- [ ] **Step 5: Commit**

```
git add src/app/api/ai-pm/chat/route.ts src/app/api/ai-pm/chat/__tests__/route.test.ts
git commit -m "feat(ai-pm): POST /api/ai-pm/chat route (S14)"
```

---

### Task 12: Register new Inngest functions in /api/inngest

**Files:**
- Modify: `src/app/api/inngest/route.ts`

- [ ] **Step 1: Read current registration**

```
sed -n '1,80p' src/app/api/inngest/route.ts
```

Identify the `functions: [ ... ]` array.

- [ ] **Step 2: Add imports + functions**

In `src/app/api/inngest/route.ts`:

```ts
import { aiPmEventHandler } from '@/inngest/functions/ai-pm-event-handler';
import { aiPmMonitor } from '@/inngest/functions/ai-pm-monitor';
```

Append to the `functions` array:

```ts
const handler = serve({
  client: inngest,
  functions: [
    /* ...existing fns... */
    aiPmEventHandler,
    aiPmMonitor,
  ],
});
```

- [ ] **Step 3: Build and lint**

```
npm run build
npm run lint
```

Expected: BUILD success, LINT clean.

- [ ] **Step 4: Commit**

```
git add src/app/api/inngest/route.ts
git commit -m "feat(ai-pm): register aiPmEventHandler + aiPmMonitor in /api/inngest (S14)"
```

---

### Task 13: Full-suite verification

**Files:** none — verification only.

- [ ] **Step 1: Run full test suite**

```
npx vitest run
```

Expected: ALL pass. Aim for ≥225 tests total (baseline 202 + ~23 new). Investigate any regression in existing AI PM tests; common causes: `getAiPmConfigByBingxApiKeyId` newly imported in handlers may need stubbing in older tests.

- [ ] **Step 2: Run lint**

```
npm run lint
```

Expected: clean.

- [ ] **Step 3: Run build**

```
npm run build
```

Expected: TypeScript compiles, Next.js build succeeds.

- [ ] **Step 4: Push branch**

```
git push -u origin feat/ai-pm-monitor
```

- [ ] **Step 5: Open PR with summary**

```
gh pr create --title "feat(ai-pm): Session 14 — event-driven monitor" --body "$(cat <<'EOF'
## Summary
- New `ai_events` table + throttle ledger; `ai_pm_funding_cache` for funding-flip detection.
- New Inngest function `ai-pm-event-handler` (subscribes to `ai-pm/event.{fill,error,drawdown,funding-flip,chat}`).
- New cron `ai-pm-monitor` every 5 minutes — paper-bot simulator tick, drawdown check, funding-flip detection.
- Sidecar event emission added to existing bot-watch handlers (real-bot fills/errors).
- New `POST /api/ai-pm/chat` route — emits `ai-pm/event.chat`.
- Chat pipeline v1 — reply-only (no action proposal), persists assistant message.

## Test plan
- [ ] All vitest suites pass (target ≥225 tests)
- [ ] `npm run lint` clean
- [ ] `npm run build` succeeds
- [ ] After merge: run Drizzle migration 0012 on Supabase
- [ ] After merge: trigger Inngest rsync (per feedback_inngest_resync memory)
- [ ] After merge: confirm `ai-pm-monitor` and `ai-pm-event-handler` appear in Inngest dashboard
- [ ] Manual smoke: insert paper config with maxDrawdownPct=5, force pnl to -10% of capital, wait 5min, confirm `ai_events` row + linked `ai_decisions` row
- [ ] Manual smoke: POST /api/ai-pm/chat with a message, confirm assistant reply row and `ai_events` row appear
EOF
)"
```

- [ ] **Step 6: Final commit if PR creation made changes (rare)**

Usually unnecessary. Skip if working tree is clean.

---

## Post-merge checklist (not part of TDD loop)

After PR merges to `main`:

- [ ] Run migration on Supabase: `npm run db:migrate`
- [ ] Open Inngest dashboard → AI Portfolio Manager app → Resync (per `feedback_inngest_resync` memory).
- [ ] Confirm new functions `ai-pm-event-handler`, `ai-pm-monitor` appear with green status.
- [ ] Run manual smoke from PR description.
- [ ] Update MEMORY.md with the post-merge resync reminder if anything new surfaces.
