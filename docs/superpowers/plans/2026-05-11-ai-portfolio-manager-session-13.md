# AI Portfolio Manager — Session 13 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/dashboard/ai-pm/activity` — a read-only feed of `ai_decisions` (cursor-paginated, filterable) plus side rails for latest signals, active paper bots, today's spend, and last cron tick.

**Architecture:** Server page → client orchestrator → presentational subcomponents (mirrors S12). Single API route `/api/ai-pm/activity` returns the combined payload in one round trip. Service layer is pure-read; no schema changes; no writes.

**Tech Stack:** Next.js App Router · HeroUI v3 · Tailwind v4 · next-intl · Drizzle · Vitest

**Branch:** `feat/ai-pm-activity-feed` (already created from `feat/ai-pm-settings-ui` to avoid sidebar conflict at merge).

**Spec:** `docs/superpowers/specs/2026-05-11-ai-pm-activity-feed-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/services/ai-pm-activity.service.ts` | Create | `listDecisions`, `listLatestSignals`, `listActivePaperBots`, `getTodaySpendSummary`, `getLastTickAt`. Cursor encode/decode + filter compilation. |
| `src/services/__tests__/ai-pm-activity.service.test.ts` | Create | Vitest service tests against real DB. |
| `src/app/api/ai-pm/activity/route.ts` | Create | GET. Parse query, auth, call service, return combined payload. |
| `src/app/api/ai-pm/activity/__tests__/route.test.ts` | Create | Vitest API route tests (mocked auth). |
| `src/app/(dashboard)/dashboard/ai-pm/activity/page.tsx` | Create | Server shell: auth + title + mounts `<ActivityClient />`. |
| `src/components/ai-pm/activity/ActivityClient.tsx` | Create | Orchestrator. Reads `useSearchParams`. Fetches + cursor state. |
| `src/components/ai-pm/activity/FilterBar.tsx` | Create | Status multi-select, action-type select, symbol input, from/to date, Reset, Refresh. |
| `src/components/ai-pm/activity/DecisionsList.tsx` | Create | Row list + "Load more" button + empty state. |
| `src/components/ai-pm/activity/DecisionRow.tsx` | Create | Collapsed row + expand toggle. |
| `src/components/ai-pm/activity/DecisionDetail.tsx` | Create | Expanded panel: reasoning, signal/params JSON, linked bot, model/cost. |
| `src/components/ai-pm/activity/SignalsRail.tsx` | Create | Top-10 signals card. |
| `src/components/ai-pm/activity/PaperBotsRail.tsx` | Create | Active paper bots card. |
| `src/components/ai-pm/activity/SpendRail.tsx` | Create | Today summary card. |
| `src/components/ai-pm/activity/CronPulseRail.tsx` | Create | Last AI tick age badge. |
| `src/components/layout/sidebar.tsx` | Modify | Add `aiActivity` nav entry. |
| `messages/en.json` | Modify | Add `Nav.aiActivity` + `AiPm.Activity.*` keys. |

**Sidebar deviation from spec:** Spec said "child link under AI PM". The current sidebar is flat (no nesting). Plan implements as a flat sibling entry `aiActivity` → `/dashboard/ai-pm/activity` with an icon. `isActive` uses `startsWith`, so `/dashboard/ai-pm` will also highlight when active — acceptable.

---

## Public Surface

### API contract

```
GET /api/ai-pm/activity
  Query:
    status?:     comma-sep
      (PROPOSED | REJECTED_GUARDRAIL | REJECTED_BACKTEST | REJECTED_REVIEWER | EXECUTED | EXECUTION_FAILED)
    actionType?: comma-sep
      (CREATE_BOT | STOP_BOT | ADJUST_PARAMS | REALLOCATE_CAPITAL | NO_ACTION)
    symbol?:     string (server uppercases, exact match)
    from?:       ISO 8601 timestamp
    to?:         ISO 8601 timestamp
    cursor?:     base64-encoded JSON { createdAt: ISO, id: uuid }
    limit?:      int 1..100 (default 50)

  200 →
    {
      decisions: AiDecisionPublic[],
      nextCursor: string | null,
      signals:    AiSignalPublic[],
      paperBots:  PaperBotPublic[],
      summary:    { decisionsToday, tokensInputToday, tokensOutputToday, costUsdToday },
      lastTickAt: string | null,
    }
```

(Full type definitions are in the spec, §6.)

---

## Task 1: Service layer — `listLatestSignals`, `listActivePaperBots`, `getTodaySpendSummary`, `getLastTickAt`

**Files:**
- Create: `src/services/ai-pm-activity.service.ts`
- Create: `src/services/__tests__/ai-pm-activity.service.test.ts`

- [ ] **Step 1: Write failing test for `listLatestSignals`**

Create `src/services/__tests__/ai-pm-activity.service.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { db } from '@/db';
import { users, aiSignals, aiDecisions, paperBots, bingxApiKeys } from '@/db/schema';
import { eq } from 'drizzle-orm';
import {
  listLatestSignals,
  listActivePaperBots,
  getTodaySpendSummary,
  getLastTickAt,
} from '@/services/ai-pm-activity.service';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000040';

async function ensureUser() {
  await db.insert(users).values({
    id: TEST_USER_ID,
    email: 'activity-test@example.com',
  }).onConflictDoNothing();
}

async function cleanup() {
  await db.delete(aiSignals).where(eq(aiSignals.userId, TEST_USER_ID));
  await db.delete(paperBots).where(eq(paperBots.userId, TEST_USER_ID));
  await db.delete(aiDecisions).where(eq(aiDecisions.userId, TEST_USER_ID));
  await db.delete(bingxApiKeys).where(eq(bingxApiKeys.userId, TEST_USER_ID));
}

describe('ai-pm-activity service', () => {
  beforeAll(async () => {
    await ensureUser();
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
  });

  it('listLatestSignals returns most recent 10 ordered DESC', async () => {
    const now = Date.now();
    const rows = Array.from({ length: 12 }, (_, i) => ({
      userId: TEST_USER_ID,
      symbol: `SYM${i}-USDT`,
      regime: 'TRENDING',
      score: 70 + i,
      reason: `r${i}`,
      createdAt: new Date(now - (12 - i) * 1000),
    }));
    await db.insert(aiSignals).values(rows);

    const got = await listLatestSignals(TEST_USER_ID);

    expect(got).toHaveLength(10);
    // Newest first
    expect(got[0].symbol).toBe('SYM11-USDT');
    expect(got[9].symbol).toBe('SYM2-USDT');
  });
});
```

- [ ] **Step 2: Run the test; expect failure (module not found)**

```bash
bun run vitest run src/services/__tests__/ai-pm-activity.service.test.ts
```

Expected: FAIL — "Cannot find module '@/services/ai-pm-activity.service'".

- [ ] **Step 3: Create the service file with `listLatestSignals`**

Create `src/services/ai-pm-activity.service.ts`:

```ts
import { db } from '@/db';
import { aiSignals, aiDecisions, paperBots } from '@/db/schema';
import { and, desc, eq, gte, sql } from 'drizzle-orm';

export interface AiSignalPublic {
  id: string;
  symbol: string;
  regime: string;
  score: number;
  reason: string | null;
  createdAt: string;
}

export async function listLatestSignals(userId: string, limit = 10): Promise<AiSignalPublic[]> {
  const rows = await db
    .select({
      id: aiSignals.id,
      symbol: aiSignals.symbol,
      regime: aiSignals.regime,
      score: aiSignals.score,
      reason: aiSignals.reason,
      createdAt: aiSignals.createdAt,
    })
    .from(aiSignals)
    .where(eq(aiSignals.userId, userId))
    .orderBy(desc(aiSignals.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    symbol: r.symbol,
    regime: r.regime,
    score: r.score,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
  }));
}
```

- [ ] **Step 4: Run the test; expect pass**

```bash
bun run vitest run src/services/__tests__/ai-pm-activity.service.test.ts
```

Expected: 1 passed.

- [ ] **Step 5: Add failing test for `listActivePaperBots`**

Append to the same test file:

```ts
it('listActivePaperBots returns only RUNNING bots ordered DESC by createdAt', async () => {
  const [running] = await db.insert(paperBots).values({
    userId: TEST_USER_ID,
    symbol: 'BTC-USDT',
    strategy: 'GRID',
    params: {},
    capitalUsdt: '100',
    status: 'RUNNING',
    pnlUsdt: '12.5',
    trades: [{ t: 1 }, { t: 2 }, { t: 3 }],
    startedAt: new Date(),
  }).returning();

  await db.insert(paperBots).values({
    userId: TEST_USER_ID,
    symbol: 'ETH-USDT',
    strategy: 'GRID',
    params: {},
    capitalUsdt: '100',
    status: 'STOPPED',
    pnlUsdt: '0',
    trades: [],
  });

  const got = await listActivePaperBots(TEST_USER_ID);

  expect(got).toHaveLength(1);
  expect(got[0].id).toBe(running.id);
  expect(got[0].tradesCount).toBe(3);
  expect(got[0].status).toBe('RUNNING');
});
```

- [ ] **Step 6: Run test; expect failure (export missing)**

```bash
bun run vitest run src/services/__tests__/ai-pm-activity.service.test.ts -t listActivePaperBots
```

Expected: FAIL.

- [ ] **Step 7: Add `listActivePaperBots` to service**

Append to `src/services/ai-pm-activity.service.ts`:

```ts
export interface PaperBotPublic {
  id: string;
  symbol: string;
  strategy: string;
  status: string;
  pnlUsdt: string;
  capitalUsdt: string;
  tradesCount: number;
  startedAt: string | null;
  createdAt: string;
}

export async function listActivePaperBots(userId: string): Promise<PaperBotPublic[]> {
  const rows = await db
    .select()
    .from(paperBots)
    .where(and(eq(paperBots.userId, userId), eq(paperBots.status, 'RUNNING')))
    .orderBy(desc(paperBots.createdAt));

  return rows.map((r) => ({
    id: r.id,
    symbol: r.symbol,
    strategy: r.strategy,
    status: r.status,
    pnlUsdt: r.pnlUsdt ?? '0',
    capitalUsdt: r.capitalUsdt,
    tradesCount: Array.isArray(r.trades) ? r.trades.length : 0,
    startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }));
}
```

- [ ] **Step 8: Run test; expect pass**

```bash
bun run vitest run src/services/__tests__/ai-pm-activity.service.test.ts -t listActivePaperBots
```

Expected: 1 passed.

- [ ] **Step 9: Add failing test for `getTodaySpendSummary`**

Append:

```ts
it('getTodaySpendSummary sums only rows from today', async () => {
  const today = new Date();
  const todayMidnight = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const yesterday = new Date(todayMidnight.getTime() - 1000);

  await db.insert(aiDecisions).values([
    {
      userId: TEST_USER_ID,
      triggeredBy: 'CRON_TICK',
      actionType: 'CREATE_BOT',
      status: 'EXECUTED',
      tokensInput: 100,
      tokensOutput: 50,
      costUsd: '0.005',
      createdAt: new Date(),
    },
    {
      userId: TEST_USER_ID,
      triggeredBy: 'CRON_TICK',
      actionType: 'NO_ACTION',
      status: 'EXECUTED',
      tokensInput: 200,
      tokensOutput: 100,
      costUsd: '0.010',
      createdAt: new Date(),
    },
    {
      userId: TEST_USER_ID,
      triggeredBy: 'CRON_TICK',
      actionType: 'NO_ACTION',
      status: 'EXECUTED',
      tokensInput: 999,
      tokensOutput: 999,
      costUsd: '99.99',
      createdAt: yesterday,
    },
  ]);

  const got = await getTodaySpendSummary(TEST_USER_ID);

  expect(got.decisionsToday).toBe(2);
  expect(got.tokensInputToday).toBe(300);
  expect(got.tokensOutputToday).toBe(150);
  expect(got.costUsdToday).toBe('0.015000');
});
```

- [ ] **Step 10: Run test; expect failure (export missing)**

```bash
bun run vitest run src/services/__tests__/ai-pm-activity.service.test.ts -t getTodaySpendSummary
```

Expected: FAIL.

- [ ] **Step 11: Add `getTodaySpendSummary` to service**

Append to `src/services/ai-pm-activity.service.ts`:

```ts
export interface SpendSummary {
  decisionsToday: number;
  tokensInputToday: number;
  tokensOutputToday: number;
  costUsdToday: string;
}

function todayMidnightUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function getTodaySpendSummary(userId: string): Promise<SpendSummary> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      tokensIn: sql<number>`coalesce(sum(${aiDecisions.tokensInput}), 0)::int`,
      tokensOut: sql<number>`coalesce(sum(${aiDecisions.tokensOutput}), 0)::int`,
      costSum: sql<string>`coalesce(sum(${aiDecisions.costUsd}), 0)::text`,
    })
    .from(aiDecisions)
    .where(and(eq(aiDecisions.userId, userId), gte(aiDecisions.createdAt, todayMidnightUtc())));

  return {
    decisionsToday: row.count,
    tokensInputToday: row.tokensIn,
    tokensOutputToday: row.tokensOut,
    costUsdToday: row.costSum,
  };
}
```

- [ ] **Step 12: Run test; expect pass**

```bash
bun run vitest run src/services/__tests__/ai-pm-activity.service.test.ts -t getTodaySpendSummary
```

Expected: 1 passed.

- [ ] **Step 13: Add failing test for `getLastTickAt`**

Append:

```ts
it('getLastTickAt returns the newest createdAt or null', async () => {
  expect(await getLastTickAt(TEST_USER_ID)).toBeNull();

  const ts = new Date('2026-05-11T10:00:00Z');
  await db.insert(aiDecisions).values({
    userId: TEST_USER_ID,
    triggeredBy: 'CRON_TICK',
    actionType: 'NO_ACTION',
    status: 'EXECUTED',
    createdAt: ts,
  });

  const got = await getLastTickAt(TEST_USER_ID);
  expect(got).toBe(ts.toISOString());
});
```

- [ ] **Step 14: Run test; expect failure**

```bash
bun run vitest run src/services/__tests__/ai-pm-activity.service.test.ts -t getLastTickAt
```

Expected: FAIL.

- [ ] **Step 15: Add `getLastTickAt` to service**

Append:

```ts
export async function getLastTickAt(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ max: sql<Date | null>`max(${aiDecisions.createdAt})` })
    .from(aiDecisions)
    .where(eq(aiDecisions.userId, userId));

  if (!row || !row.max) return null;
  return row.max instanceof Date ? row.max.toISOString() : new Date(row.max).toISOString();
}
```

- [ ] **Step 16: Run full service test file; expect all green**

```bash
bun run vitest run src/services/__tests__/ai-pm-activity.service.test.ts
```

Expected: 4 passed.

- [ ] **Step 17: Commit**

```bash
git add src/services/ai-pm-activity.service.ts src/services/__tests__/ai-pm-activity.service.test.ts
git commit -m "feat(ai-pm): activity service — signals, paper bots, spend, tick"
```

---

## Task 2: Service layer — `listDecisions` with cursor + filters

**Files:**
- Modify: `src/services/ai-pm-activity.service.ts`
- Modify: `src/services/__tests__/ai-pm-activity.service.test.ts`

- [ ] **Step 1: Add failing test for unfiltered `listDecisions`**

Append to the test file:

```ts
import type { ListDecisionsParams } from '@/services/ai-pm-activity.service';
import { listDecisions } from '@/services/ai-pm-activity.service';

async function seedDecisions(n: number) {
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    await db.insert(aiDecisions).values({
      userId: TEST_USER_ID,
      triggeredBy: 'CRON_TICK',
      actionType: i % 2 === 0 ? 'CREATE_BOT' : 'NO_ACTION',
      status: i % 3 === 0 ? 'EXECUTED' : 'REJECTED_GUARDRAIL',
      symbol: i % 2 === 0 ? 'BTC-USDT' : 'ETH-USDT',
      createdAt: new Date(now - i * 1000),
    });
  }
}

it('listDecisions returns rows DESC and emits nextCursor when more rows exist', async () => {
  await seedDecisions(5);

  const page1 = await listDecisions({ userId: TEST_USER_ID, limit: 3 });

  expect(page1.decisions).toHaveLength(3);
  expect(page1.nextCursor).not.toBeNull();
  // Newest first
  const ts0 = new Date(page1.decisions[0].createdAt).getTime();
  const ts1 = new Date(page1.decisions[1].createdAt).getTime();
  expect(ts0).toBeGreaterThan(ts1);
});
```

- [ ] **Step 2: Run; expect failure**

```bash
bun run vitest run src/services/__tests__/ai-pm-activity.service.test.ts -t "listDecisions returns rows DESC"
```

Expected: FAIL — `listDecisions` not exported.

- [ ] **Step 3: Implement `listDecisions` (no filters, no cursor yet)**

Append to `src/services/ai-pm-activity.service.ts`:

```ts
import { lt, or } from 'drizzle-orm';
import { tradingBots } from '@/db/schema';

export type AiDecisionStatus =
  | 'PROPOSED'
  | 'REJECTED_GUARDRAIL'
  | 'REJECTED_BACKTEST'
  | 'REJECTED_REVIEWER'
  | 'EXECUTED'
  | 'EXECUTION_FAILED';

export type AiActionType =
  | 'CREATE_BOT'
  | 'STOP_BOT'
  | 'ADJUST_PARAMS'
  | 'REALLOCATE_CAPITAL'
  | 'NO_ACTION';

const ALL_STATUSES: AiDecisionStatus[] = [
  'PROPOSED', 'REJECTED_GUARDRAIL', 'REJECTED_BACKTEST',
  'REJECTED_REVIEWER', 'EXECUTED', 'EXECUTION_FAILED',
];
const ALL_ACTION_TYPES: AiActionType[] = [
  'CREATE_BOT', 'STOP_BOT', 'ADJUST_PARAMS', 'REALLOCATE_CAPITAL', 'NO_ACTION',
];

export interface ListDecisionsParams {
  userId: string;
  status?: AiDecisionStatus[];
  actionType?: AiActionType[];
  symbol?: string;
  from?: Date;
  to?: Date;
  cursor?: { createdAt: Date; id: string };
  limit?: number;
}

export interface PaperBotInline {
  id: string;
  symbol: string;
  strategy: string;
  status: string;
  pnlUsdt: string;
  tradesCount: number;
}

export interface AiDecisionPublic {
  id: string;
  triggeredBy: string;
  triggerDetail: string | null;
  actionType: AiActionType;
  status: AiDecisionStatus;
  symbol: string | null;
  strategy: string | null;
  params: unknown;
  reasoning: string | null;
  signalSnapshot: unknown;
  rejectionReason: string | null;
  modelUsed: string | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  costUsd: string | null;
  resultBotId: string | null;
  paperBot: PaperBotInline | null;
  executedAt: string | null;
  createdAt: string;
}

export interface ListDecisionsResult {
  decisions: AiDecisionPublic[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export function encodeCursor(c: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ createdAt: c.createdAt.toISOString(), id: c.id })).toString('base64');
}

export function decodeCursor(s: string): { createdAt: Date; id: string } {
  let parsed: { createdAt?: unknown; id?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
  } catch {
    throw new Error('Invalid cursor');
  }
  if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') {
    throw new Error('Invalid cursor');
  }
  const createdAt = new Date(parsed.createdAt);
  if (Number.isNaN(createdAt.getTime())) throw new Error('Invalid cursor');
  return { createdAt, id: parsed.id };
}

export async function listDecisions(params: ListDecisionsParams): Promise<ListDecisionsResult> {
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const conditions = [eq(aiDecisions.userId, params.userId)];
  if (params.status?.length) {
    conditions.push(sql`${aiDecisions.status} = ANY(${sql.raw(`ARRAY[${params.status.map((s) => `'${s}'`).join(',')}]::ai_decision_status[]`)})`);
  }
  if (params.actionType?.length) {
    conditions.push(sql`${aiDecisions.actionType} = ANY(${sql.raw(`ARRAY[${params.actionType.map((a) => `'${a}'`).join(',')}]::ai_action_type[]`)})`);
  }
  if (params.symbol) {
    conditions.push(eq(aiDecisions.symbol, params.symbol.toUpperCase()));
  }
  if (params.from) conditions.push(gte(aiDecisions.createdAt, params.from));
  if (params.to) conditions.push(sql`${aiDecisions.createdAt} <= ${params.to}`);
  if (params.cursor) {
    conditions.push(
      or(
        lt(aiDecisions.createdAt, params.cursor.createdAt),
        and(eq(aiDecisions.createdAt, params.cursor.createdAt), lt(aiDecisions.id, params.cursor.id)),
      )!,
    );
  }

  // Fetch limit+1 to detect "has more"
  const rows = await db
    .select({
      d: aiDecisions,
      pb: paperBots,
    })
    .from(aiDecisions)
    .leftJoin(paperBots, eq(paperBots.decisionId, aiDecisions.id))
    .where(and(...conditions))
    .orderBy(desc(aiDecisions.createdAt), desc(aiDecisions.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const kept = hasMore ? rows.slice(0, limit) : rows;
  const last = kept[kept.length - 1];

  const decisions: AiDecisionPublic[] = kept.map(({ d, pb }) => ({
    id: d.id,
    triggeredBy: d.triggeredBy,
    triggerDetail: d.triggerDetail,
    actionType: d.actionType as AiActionType,
    status: d.status as AiDecisionStatus,
    symbol: d.symbol,
    strategy: d.strategy,
    params: d.params,
    reasoning: d.reasoning,
    signalSnapshot: d.signalSnapshot,
    rejectionReason: d.rejectionReason,
    modelUsed: d.modelUsed,
    tokensInput: d.tokensInput,
    tokensOutput: d.tokensOutput,
    costUsd: d.costUsd,
    resultBotId: d.resultBotId,
    paperBot: pb
      ? {
          id: pb.id,
          symbol: pb.symbol,
          strategy: pb.strategy,
          status: pb.status,
          pnlUsdt: pb.pnlUsdt ?? '0',
          tradesCount: Array.isArray(pb.trades) ? pb.trades.length : 0,
        }
      : null,
    executedAt: d.executedAt ? d.executedAt.toISOString() : null,
    createdAt: d.createdAt.toISOString(),
  }));

  const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.d.createdAt, id: last.d.id }) : null;
  return { decisions, nextCursor };
}

export { ALL_STATUSES, ALL_ACTION_TYPES };
```

Note: `tradingBots` import is added for future cross-table linkage; remove if lint flags it unused.

- [ ] **Step 4: Run the test; expect pass**

```bash
bun run vitest run src/services/__tests__/ai-pm-activity.service.test.ts -t "listDecisions returns rows DESC"
```

Expected: 1 passed.

- [ ] **Step 5: Add cursor walk test**

Append:

```ts
it('listDecisions walks pages via cursor without dupes or gaps', async () => {
  await seedDecisions(5);

  const page1 = await listDecisions({ userId: TEST_USER_ID, limit: 2 });
  expect(page1.decisions).toHaveLength(2);
  expect(page1.nextCursor).not.toBeNull();

  const cursor1 = decodeCursor(page1.nextCursor!);
  const page2 = await listDecisions({ userId: TEST_USER_ID, limit: 2, cursor: cursor1 });
  expect(page2.decisions).toHaveLength(2);
  expect(page2.nextCursor).not.toBeNull();

  const cursor2 = decodeCursor(page2.nextCursor!);
  const page3 = await listDecisions({ userId: TEST_USER_ID, limit: 2, cursor: cursor2 });
  expect(page3.decisions).toHaveLength(1);
  expect(page3.nextCursor).toBeNull();

  const ids = [...page1.decisions, ...page2.decisions, ...page3.decisions].map((d) => d.id);
  expect(new Set(ids).size).toBe(5);
});
```

Add the import at top (next to existing service imports):

```ts
import { decodeCursor } from '@/services/ai-pm-activity.service';
```

- [ ] **Step 6: Run test; expect pass**

```bash
bun run vitest run src/services/__tests__/ai-pm-activity.service.test.ts -t "walks pages"
```

Expected: 1 passed.

- [ ] **Step 7: Add filter tests (status, actionType, symbol, date range)**

Append:

```ts
it('listDecisions filters by status', async () => {
  await seedDecisions(6);
  const got = await listDecisions({ userId: TEST_USER_ID, status: ['EXECUTED'] });
  expect(got.decisions.every((d) => d.status === 'EXECUTED')).toBe(true);
  expect(got.decisions.length).toBeGreaterThan(0);
});

it('listDecisions filters by actionType', async () => {
  await seedDecisions(6);
  const got = await listDecisions({ userId: TEST_USER_ID, actionType: ['CREATE_BOT'] });
  expect(got.decisions.every((d) => d.actionType === 'CREATE_BOT')).toBe(true);
});

it('listDecisions filters by symbol (uppercased)', async () => {
  await seedDecisions(6);
  const got = await listDecisions({ userId: TEST_USER_ID, symbol: 'btc-usdt' });
  expect(got.decisions.every((d) => d.symbol === 'BTC-USDT')).toBe(true);
});

it('listDecisions filters by date range', async () => {
  const old = new Date('2026-01-01T00:00:00Z');
  const recent = new Date();

  await db.insert(aiDecisions).values([
    { userId: TEST_USER_ID, triggeredBy: 'CRON_TICK', actionType: 'NO_ACTION', status: 'EXECUTED', createdAt: old },
    { userId: TEST_USER_ID, triggeredBy: 'CRON_TICK', actionType: 'NO_ACTION', status: 'EXECUTED', createdAt: recent },
  ]);

  const got = await listDecisions({
    userId: TEST_USER_ID,
    from: new Date('2026-04-01T00:00:00Z'),
  });

  expect(got.decisions).toHaveLength(1);
});

it('listDecisions returns linked paperBot when present', async () => {
  const [d] = await db.insert(aiDecisions).values({
    userId: TEST_USER_ID,
    triggeredBy: 'CRON_TICK',
    actionType: 'CREATE_BOT',
    status: 'EXECUTED',
    symbol: 'BTC-USDT',
  }).returning();

  await db.insert(paperBots).values({
    userId: TEST_USER_ID,
    decisionId: d.id,
    symbol: 'BTC-USDT',
    strategy: 'GRID',
    params: {},
    capitalUsdt: '100',
    status: 'RUNNING',
    pnlUsdt: '5.5',
    trades: [{}, {}],
  });

  const got = await listDecisions({ userId: TEST_USER_ID });
  const found = got.decisions.find((x) => x.id === d.id);
  expect(found?.paperBot?.symbol).toBe('BTC-USDT');
  expect(found?.paperBot?.tradesCount).toBe(2);
});
```

- [ ] **Step 8: Run; expect all green**

```bash
bun run vitest run src/services/__tests__/ai-pm-activity.service.test.ts
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/services/ai-pm-activity.service.ts src/services/__tests__/ai-pm-activity.service.test.ts
git commit -m "feat(ai-pm): activity service — listDecisions with cursor + filters"
```

---

## Task 3: API route `/api/ai-pm/activity`

**Files:**
- Create: `src/app/api/ai-pm/activity/route.ts`
- Create: `src/app/api/ai-pm/activity/__tests__/route.test.ts`

- [ ] **Step 1: Write failing test for 200 happy path**

Create `src/app/api/ai-pm/activity/__tests__/route.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { db } from '@/db';
import { users, aiDecisions, aiSignals, paperBots } from '@/db/schema';
import { eq } from 'drizzle-orm';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000050';
const OTHER_USER_ID = '00000000-0000-0000-0000-000000000051';

let currentUserId: string | null = TEST_USER_ID;

vi.mock('@/services/auth.service', () => ({
  requireAuth: vi.fn(() => {
    if (currentUserId === null) {
      throw new Error('Authentication required. User is not logged in.');
    }
    return Promise.resolve({ id: currentUserId });
  }),
}));

import { GET } from '../route';

async function ensureUsers() {
  await db.insert(users).values({ id: TEST_USER_ID, email: 'activity-route@example.com' }).onConflictDoNothing();
  await db.insert(users).values({ id: OTHER_USER_ID, email: 'activity-other@example.com' }).onConflictDoNothing();
}

async function cleanup() {
  for (const uid of [TEST_USER_ID, OTHER_USER_ID]) {
    await db.delete(aiSignals).where(eq(aiSignals.userId, uid));
    await db.delete(paperBots).where(eq(paperBots.userId, uid));
    await db.delete(aiDecisions).where(eq(aiDecisions.userId, uid));
  }
}

function req(url = 'http://localhost/api/ai-pm/activity'): Request {
  return new Request(url, { method: 'GET' });
}

describe('GET /api/ai-pm/activity', () => {
  beforeAll(async () => {
    await ensureUsers();
    await cleanup();
    currentUserId = TEST_USER_ID;
  });

  afterEach(async () => {
    await cleanup();
    currentUserId = TEST_USER_ID;
  });

  it('returns combined payload shape', async () => {
    await db.insert(aiDecisions).values({
      userId: TEST_USER_ID,
      triggeredBy: 'CRON_TICK',
      actionType: 'CREATE_BOT',
      status: 'EXECUTED',
      symbol: 'BTC-USDT',
      tokensInput: 100,
      tokensOutput: 50,
      costUsd: '0.005',
    });

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(Array.isArray(body.decisions)).toBe(true);
    expect(body.decisions).toHaveLength(1);
    expect(Array.isArray(body.signals)).toBe(true);
    expect(Array.isArray(body.paperBots)).toBe(true);
    expect(body.summary).toBeDefined();
    expect(typeof body.summary.decisionsToday).toBe('number');
    expect(body.summary.tokensInputToday).toBe(100);
    expect(body.lastTickAt).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test; expect failure (module not found)**

```bash
bun run vitest run src/app/api/ai-pm/activity/__tests__/route.test.ts
```

Expected: FAIL — cannot find `../route`.

- [ ] **Step 3: Implement the route handler**

Create `src/app/api/ai-pm/activity/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { requireAuth } from '@/services/auth.service';
import {
  listDecisions,
  listLatestSignals,
  listActivePaperBots,
  getTodaySpendSummary,
  getLastTickAt,
  decodeCursor,
  ALL_STATUSES,
  ALL_ACTION_TYPES,
  type AiDecisionStatus,
  type AiActionType,
} from '@/services/ai-pm-activity.service';

function parseList<T extends string>(raw: string | null, allowed: readonly T[]): T[] | undefined {
  if (!raw) return undefined;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return undefined;
  const bad = parts.find((p) => !(allowed as readonly string[]).includes(p));
  if (bad) throw new Error(`Invalid value: ${bad}`);
  return parts as T[];
}

function parseDate(raw: string | null, field: string): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid ${field}`);
  return d;
}

function parseLimit(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 100) throw new Error('Invalid limit');
  return n;
}

export async function GET(req: Request) {
  try {
    const user = await requireAuth();
    const url = new URL(req.url);
    const params = url.searchParams;

    let status: AiDecisionStatus[] | undefined;
    let actionType: AiActionType[] | undefined;
    let from: Date | undefined;
    let to: Date | undefined;
    let cursor: { createdAt: Date; id: string } | undefined;
    let limit: number | undefined;

    try {
      status = parseList<AiDecisionStatus>(params.get('status'), ALL_STATUSES);
      actionType = parseList<AiActionType>(params.get('actionType'), ALL_ACTION_TYPES);
      from = parseDate(params.get('from'), 'from');
      to = parseDate(params.get('to'), 'to');
      limit = parseLimit(params.get('limit'));
      const cursorRaw = params.get('cursor');
      if (cursorRaw) cursor = decodeCursor(cursorRaw);
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : 'Bad request';
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    const symbol = params.get('symbol') ?? undefined;

    const [decisionsRes, signals, paperBots, summary, lastTickAt] = await Promise.all([
      listDecisions({ userId: user.id, status, actionType, symbol, from, to, cursor, limit }),
      listLatestSignals(user.id, 10),
      listActivePaperBots(user.id),
      getTodaySpendSummary(user.id),
      getLastTickAt(user.id),
    ]);

    return NextResponse.json({
      decisions: decisionsRes.decisions,
      nextCursor: decisionsRes.nextCursor,
      signals,
      paperBots,
      summary,
      lastTickAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed';
    if (message.includes('Authentication')) {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run; expect pass**

```bash
bun run vitest run src/app/api/ai-pm/activity/__tests__/route.test.ts -t "combined payload shape"
```

Expected: 1 passed.

- [ ] **Step 5: Add auth + validation tests**

Append to `route.test.ts`:

```ts
it('returns 401 when unauthenticated', async () => {
  currentUserId = null;
  const res = await GET(req());
  expect(res.status).toBe(401);
});

it('returns 400 on invalid cursor', async () => {
  const res = await GET(req('http://localhost/api/ai-pm/activity?cursor=not-base64-json'));
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toMatch(/cursor/i);
});

it('returns 400 on invalid status value', async () => {
  const res = await GET(req('http://localhost/api/ai-pm/activity?status=BOGUS'));
  expect(res.status).toBe(400);
});

it('returns 400 on limit out of range', async () => {
  const res = await GET(req('http://localhost/api/ai-pm/activity?limit=999'));
  expect(res.status).toBe(400);
});

it('isolates rows by user id', async () => {
  await db.insert(aiDecisions).values({
    userId: OTHER_USER_ID,
    triggeredBy: 'CRON_TICK',
    actionType: 'NO_ACTION',
    status: 'EXECUTED',
    symbol: 'ETH-USDT',
  });

  const res = await GET(req());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.decisions).toHaveLength(0);
});

it('passes status filter through to service', async () => {
  await db.insert(aiDecisions).values([
    { userId: TEST_USER_ID, triggeredBy: 'CRON_TICK', actionType: 'CREATE_BOT', status: 'EXECUTED' },
    { userId: TEST_USER_ID, triggeredBy: 'CRON_TICK', actionType: 'CREATE_BOT', status: 'REJECTED_GUARDRAIL' },
  ]);

  const res = await GET(req('http://localhost/api/ai-pm/activity?status=EXECUTED'));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.decisions.every((d: { status: string }) => d.status === 'EXECUTED')).toBe(true);
});
```

- [ ] **Step 6: Run full route test; expect all green**

```bash
bun run vitest run src/app/api/ai-pm/activity/__tests__/route.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/ai-pm/activity
git commit -m "feat(ai-pm): GET /api/ai-pm/activity route + tests"
```

---

## Task 4: Page shell + i18n keys

**Files:**
- Create: `src/app/(dashboard)/dashboard/ai-pm/activity/page.tsx`
- Modify: `messages/en.json`

- [ ] **Step 1: Add i18n keys**

In `messages/en.json`, find the `"AiPm"` object and add an `"Activity"` sibling next to `"Settings"`:

```json
"Activity": {
  "title": "AI Activity",
  "subtitle": "Decisions, signals, paper bots, and spend.",
  "refresh": "Refresh",
  "reset": "Reset",
  "loadMore": "Load more",
  "loading": "Loading…",
  "errorBanner": "Failed to load activity",
  "retry": "Retry",
  "emptyAll": "No AI decisions yet. Enable AI on a subaccount in Settings.",
  "emptyFiltered": "No decisions match filters.",
  "filterStatus": "Status",
  "filterAction": "Action",
  "filterSymbol": "Symbol",
  "filterFrom": "From",
  "filterTo": "To",
  "status": {
    "PROPOSED": "Proposed",
    "REJECTED_GUARDRAIL": "Rejected (guardrail)",
    "REJECTED_BACKTEST": "Rejected (backtest)",
    "REJECTED_REVIEWER": "Rejected (reviewer)",
    "EXECUTED": "Executed",
    "EXECUTION_FAILED": "Execution failed"
  },
  "action": {
    "CREATE_BOT": "Create bot",
    "STOP_BOT": "Stop bot",
    "ADJUST_PARAMS": "Adjust params",
    "REALLOCATE_CAPITAL": "Reallocate capital",
    "NO_ACTION": "No action"
  },
  "detail": {
    "reasoning": "Reasoning",
    "rejection": "Rejection reason",
    "signal": "Signal snapshot",
    "params": "Params",
    "linkedBot": "Linked bot",
    "linkedPaperBot": "Linked paper bot",
    "noLink": "—",
    "model": "Model",
    "tokensIn": "Tokens in",
    "tokensOut": "Tokens out",
    "cost": "Cost (USD)"
  },
  "rails": {
    "signalsTitle": "Latest signals",
    "signalsEmpty": "No signals yet.",
    "paperBotsTitle": "Active paper bots",
    "paperBotsEmpty": "No paper bots active.",
    "spendTitle": "Today",
    "decisions": "Decisions",
    "cronTitle": "Last AI tick",
    "cronNever": "Never"
  }
}
```

Also add a `Nav.aiActivity` key. Find the `"Nav"` block and add:

```json
"aiActivity": "AI Activity"
```

- [ ] **Step 2: Create the page shell**

Create `src/app/(dashboard)/dashboard/ai-pm/activity/page.tsx`:

```tsx
import { requireAuth } from '@/services/auth.service';
import { getTranslations } from 'next-intl/server';
import { ActivityClient } from '@/components/ai-pm/activity/ActivityClient';

export default async function AiPmActivityPage() {
  await requireAuth();
  const t = await getTranslations('AiPm.Activity');
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-muted mt-1">{t('subtitle')}</p>
      </div>
      <ActivityClient />
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add messages/en.json "src/app/(dashboard)/dashboard/ai-pm/activity"
git commit -m "feat(ai-pm): activity page shell + i18n keys"
```

---

## Task 5: Rail components (Signals · PaperBots · Spend · CronPulse)

**Files:**
- Create: `src/components/ai-pm/activity/SignalsRail.tsx`
- Create: `src/components/ai-pm/activity/PaperBotsRail.tsx`
- Create: `src/components/ai-pm/activity/SpendRail.tsx`
- Create: `src/components/ai-pm/activity/CronPulseRail.tsx`

- [ ] **Step 1: Create `SignalsRail`**

```tsx
'use client';

import { useTranslations } from 'next-intl';
import type { AiSignalPublic } from '@/services/ai-pm-activity.service';

function relativeAge(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diffMs / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export function SignalsRail({ signals }: { signals: AiSignalPublic[] }) {
  const t = useTranslations('AiPm.Activity.rails');

  return (
    <div className="rounded-lg border border-default-200 bg-background p-4">
      <h3 className="text-sm font-semibold mb-3">{t('signalsTitle')}</h3>
      {signals.length === 0 ? (
        <p className="text-xs text-muted">{t('signalsEmpty')}</p>
      ) : (
        <ul className="space-y-2">
          {signals.map((s) => (
            <li key={s.id} className="flex items-center justify-between text-xs">
              <span className="font-mono">{s.symbol}</span>
              <span className="px-1.5 py-0.5 rounded bg-default-100 text-[10px] uppercase">{s.regime}</span>
              <span className="font-mono">{s.score}</span>
              <span className="text-muted">{relativeAge(s.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create `PaperBotsRail`**

```tsx
'use client';

import { useTranslations } from 'next-intl';
import type { PaperBotPublic } from '@/services/ai-pm-activity.service';

export function PaperBotsRail({ bots }: { bots: PaperBotPublic[] }) {
  const t = useTranslations('AiPm.Activity.rails');

  return (
    <div className="rounded-lg border border-default-200 bg-background p-4">
      <h3 className="text-sm font-semibold mb-3">{t('paperBotsTitle')}</h3>
      {bots.length === 0 ? (
        <p className="text-xs text-muted">{t('paperBotsEmpty')}</p>
      ) : (
        <ul className="space-y-2">
          {bots.map((b) => {
            const pnl = Number(b.pnlUsdt);
            const pnlClass = pnl > 0 ? 'text-emerald-500' : pnl < 0 ? 'text-rose-500' : 'text-muted';
            return (
              <li key={b.id} className="text-xs flex items-center justify-between">
                <div className="flex flex-col">
                  <span className="font-mono">{b.symbol}</span>
                  <span className="text-[10px] text-muted">{b.strategy} · {b.tradesCount} trades</span>
                </div>
                <span className={`font-mono ${pnlClass}`}>{pnl.toFixed(2)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create `SpendRail`**

```tsx
'use client';

import { useTranslations } from 'next-intl';
import type { SpendSummary } from '@/services/ai-pm-activity.service';

export function SpendRail({ summary }: { summary: SpendSummary }) {
  const t = useTranslations('AiPm.Activity.rails');
  const detailT = useTranslations('AiPm.Activity.detail');
  const cost = Number(summary.costUsdToday).toFixed(4);

  return (
    <div className="rounded-lg border border-default-200 bg-background p-4">
      <h3 className="text-sm font-semibold mb-3">{t('spendTitle')}</h3>
      <dl className="grid grid-cols-2 gap-y-1 text-xs">
        <dt className="text-muted">{t('decisions')}</dt>
        <dd className="text-right font-mono">{summary.decisionsToday}</dd>
        <dt className="text-muted">{detailT('tokensIn')}</dt>
        <dd className="text-right font-mono">{summary.tokensInputToday.toLocaleString()}</dd>
        <dt className="text-muted">{detailT('tokensOut')}</dt>
        <dd className="text-right font-mono">{summary.tokensOutputToday.toLocaleString()}</dd>
        <dt className="text-muted">{detailT('cost')}</dt>
        <dd className="text-right font-mono">${cost}</dd>
      </dl>
    </div>
  );
}
```

- [ ] **Step 4: Create `CronPulseRail`**

```tsx
'use client';

import { useTranslations } from 'next-intl';

export function CronPulseRail({ lastTickAt }: { lastTickAt: string | null }) {
  const t = useTranslations('AiPm.Activity.rails');

  if (!lastTickAt) {
    return (
      <div className="rounded-lg border border-default-200 bg-background p-4">
        <h3 className="text-sm font-semibold mb-2">{t('cronTitle')}</h3>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-rose-500" />
          <span className="text-xs">{t('cronNever')}</span>
        </div>
      </div>
    );
  }

  const diffMin = Math.floor((Date.now() - new Date(lastTickAt).getTime()) / 60_000);
  const color = diffMin < 30 ? 'bg-emerald-500' : diffMin < 60 ? 'bg-amber-500' : 'bg-rose-500';
  const label = diffMin < 1 ? 'now' : diffMin < 60 ? `${diffMin}m ago` : `${Math.floor(diffMin / 60)}h ago`;

  return (
    <div className="rounded-lg border border-default-200 bg-background p-4">
      <h3 className="text-sm font-semibold mb-2">{t('cronTitle')}</h3>
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${color}`} />
        <span className="text-xs">{label}</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Lint rails**

```bash
bunx eslint src/components/ai-pm/activity
```

Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/ai-pm/activity
git commit -m "feat(ai-pm): activity rail components"
```

---

## Task 6: Decision row + detail + list

**Files:**
- Create: `src/components/ai-pm/activity/DecisionRow.tsx`
- Create: `src/components/ai-pm/activity/DecisionDetail.tsx`
- Create: `src/components/ai-pm/activity/DecisionsList.tsx`

- [ ] **Step 1: Create `DecisionDetail`**

```tsx
'use client';

import { useTranslations } from 'next-intl';
import type { AiDecisionPublic } from '@/services/ai-pm-activity.service';

export function DecisionDetail({ decision }: { decision: AiDecisionPublic }) {
  const t = useTranslations('AiPm.Activity.detail');

  return (
    <div className="space-y-4 px-4 py-3 bg-default-50 border-t border-default-200">
      {(decision.reasoning || decision.rejectionReason) && (
        <section>
          <h4 className="text-xs font-semibold uppercase text-muted mb-1">{t('reasoning')}</h4>
          {decision.reasoning && <p className="text-sm whitespace-pre-wrap">{decision.reasoning}</p>}
          {decision.rejectionReason && (
            <p className="text-sm mt-2">
              <span className="text-muted">{t('rejection')}: </span>
              <span>{decision.rejectionReason}</span>
            </p>
          )}
        </section>
      )}

      <section>
        <details>
          <summary className="cursor-pointer text-xs font-semibold uppercase text-muted">{t('signal')}</summary>
          <pre className="text-xs mt-2 overflow-x-auto bg-background p-2 rounded border border-default-200">
            {JSON.stringify(decision.signalSnapshot, null, 2)}
          </pre>
        </details>
      </section>

      <section>
        <details>
          <summary className="cursor-pointer text-xs font-semibold uppercase text-muted">{t('params')}</summary>
          <pre className="text-xs mt-2 overflow-x-auto bg-background p-2 rounded border border-default-200">
            {JSON.stringify(decision.params, null, 2)}
          </pre>
        </details>
      </section>

      <section>
        <h4 className="text-xs font-semibold uppercase text-muted mb-1">
          {decision.paperBot ? t('linkedPaperBot') : t('linkedBot')}
        </h4>
        {decision.paperBot ? (
          <div className="text-sm font-mono">
            {decision.paperBot.symbol} · {decision.paperBot.strategy} · {decision.paperBot.status} · pnl {Number(decision.paperBot.pnlUsdt).toFixed(2)}
          </div>
        ) : decision.resultBotId ? (
          <a className="text-sm text-accent underline" href={`/dashboard/bots/${decision.resultBotId}`}>
            {decision.resultBotId}
          </a>
        ) : (
          <span className="text-sm text-muted">{t('noLink')}</span>
        )}
      </section>

      <section>
        <dl className="grid grid-cols-4 gap-2 text-xs">
          <div>
            <dt className="text-muted">{t('model')}</dt>
            <dd className="font-mono">{decision.modelUsed ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-muted">{t('tokensIn')}</dt>
            <dd className="font-mono">{decision.tokensInput ?? 0}</dd>
          </div>
          <div>
            <dt className="text-muted">{t('tokensOut')}</dt>
            <dd className="font-mono">{decision.tokensOutput ?? 0}</dd>
          </div>
          <div>
            <dt className="text-muted">{t('cost')}</dt>
            <dd className="font-mono">${Number(decision.costUsd ?? '0').toFixed(6)}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Create `DecisionRow`**

```tsx
'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { AiDecisionPublic, AiDecisionStatus } from '@/services/ai-pm-activity.service';
import { DecisionDetail } from './DecisionDetail';

function statusClass(s: AiDecisionStatus): string {
  switch (s) {
    case 'EXECUTED': return 'bg-emerald-500/10 text-emerald-500';
    case 'PROPOSED': return 'bg-sky-500/10 text-sky-500';
    case 'REJECTED_GUARDRAIL':
    case 'REJECTED_BACKTEST': return 'bg-amber-500/10 text-amber-500';
    case 'REJECTED_REVIEWER': return 'bg-orange-500/10 text-orange-500';
    case 'EXECUTION_FAILED': return 'bg-rose-500/10 text-rose-500';
  }
}

function relativeAge(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diffMs / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function DecisionRow({ decision }: { decision: AiDecisionPublic }) {
  const [open, setOpen] = useState(false);
  const tStatus = useTranslations('AiPm.Activity.status');
  const tAction = useTranslations('AiPm.Activity.action');

  return (
    <li className="border-b border-default-200 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-default-50"
      >
        {open ? <ChevronDown className="w-4 h-4 text-muted" /> : <ChevronRight className="w-4 h-4 text-muted" />}
        <span className={`px-2 py-0.5 rounded text-[10px] uppercase font-semibold ${statusClass(decision.status)}`}>
          {tStatus(decision.status)}
        </span>
        <span className="text-sm">{tAction(decision.actionType)}</span>
        <span className="text-sm font-mono">{decision.symbol ?? '—'}</span>
        <span className="ml-auto text-xs text-muted">{relativeAge(decision.createdAt)}</span>
      </button>
      {open && <DecisionDetail decision={decision} />}
    </li>
  );
}
```

- [ ] **Step 3: Create `DecisionsList`**

```tsx
'use client';

import { useTranslations } from 'next-intl';
import type { AiDecisionPublic } from '@/services/ai-pm-activity.service';
import { DecisionRow } from './DecisionRow';

interface Props {
  decisions: AiDecisionPublic[];
  nextCursor: string | null;
  loading: boolean;
  hasFilters: boolean;
  onLoadMore: () => void;
}

export function DecisionsList({ decisions, nextCursor, loading, hasFilters, onLoadMore }: Props) {
  const t = useTranslations('AiPm.Activity');

  if (decisions.length === 0 && !loading) {
    return (
      <div className="rounded-lg border border-default-200 bg-background p-8 text-center text-sm text-muted">
        {hasFilters ? t('emptyFiltered') : t('emptyAll')}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-default-200 bg-background">
      <ul>
        {decisions.map((d) => (
          <DecisionRow key={d.id} decision={d} />
        ))}
      </ul>
      {nextCursor && (
        <div className="border-t border-default-200 p-3 flex justify-center">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loading}
            className="text-sm px-4 py-2 rounded-lg bg-default-100 hover:bg-default-200 disabled:opacity-50"
          >
            {loading ? t('loading') : t('loadMore')}
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Lint**

```bash
bunx eslint src/components/ai-pm/activity
```

Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/ai-pm/activity
git commit -m "feat(ai-pm): activity decision row + detail + list"
```

---

## Task 7: Filter bar

**Files:**
- Create: `src/components/ai-pm/activity/FilterBar.tsx`

- [ ] **Step 1: Create `FilterBar`**

```tsx
'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { RefreshCw } from 'lucide-react';
import { ALL_STATUSES, ALL_ACTION_TYPES } from '@/services/ai-pm-activity.service';

interface Props {
  loading: boolean;
  onRefresh: () => void;
}

export function FilterBar({ loading, onRefresh }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const t = useTranslations('AiPm.Activity');
  const tStatus = useTranslations('AiPm.Activity.status');
  const tAction = useTranslations('AiPm.Activity.action');

  const selectedStatuses = new Set((params.get('status') ?? '').split(',').filter(Boolean));
  const selectedAction = params.get('actionType') ?? '';
  const symbol = params.get('symbol') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params.toString());
    if (value === null || value === '') next.delete(key);
    else next.set(key, value);
    router.replace(`?${next.toString()}`);
  }

  function toggleStatus(s: string) {
    const next = new Set(selectedStatuses);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    setParam('status', next.size ? Array.from(next).join(',') : null);
  }

  function reset() {
    router.replace('?');
  }

  return (
    <div className="rounded-lg border border-default-200 bg-background p-3 space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        <span className="text-xs font-semibold text-muted">{t('filterStatus')}:</span>
        {ALL_STATUSES.map((s) => {
          const active = selectedStatuses.has(s);
          return (
            <button
              key={s}
              type="button"
              onClick={() => toggleStatus(s)}
              className={`text-[10px] px-2 py-1 rounded uppercase font-semibold ${
                active ? 'bg-accent text-background' : 'bg-default-100 text-muted hover:text-foreground'
              }`}
            >
              {tStatus(s)}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <label className="flex items-center gap-2 text-xs">
          <span className="text-muted">{t('filterAction')}:</span>
          <select
            value={selectedAction}
            onChange={(e) => setParam('actionType', e.target.value || null)}
            className="text-xs bg-default-100 rounded px-2 py-1"
          >
            <option value="">—</option>
            {ALL_ACTION_TYPES.map((a) => (
              <option key={a} value={a}>{tAction(a)}</option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs">
          <span className="text-muted">{t('filterSymbol')}:</span>
          <input
            type="text"
            defaultValue={symbol}
            placeholder="BTC-USDT"
            onBlur={(e) => setParam('symbol', e.target.value.trim() || null)}
            className="text-xs bg-default-100 rounded px-2 py-1 w-32 font-mono"
          />
        </label>

        <label className="flex items-center gap-2 text-xs">
          <span className="text-muted">{t('filterFrom')}:</span>
          <input
            type="date"
            defaultValue={from ? from.slice(0, 10) : ''}
            onChange={(e) => setParam('from', e.target.value ? `${e.target.value}T00:00:00Z` : null)}
            className="text-xs bg-default-100 rounded px-2 py-1"
          />
        </label>

        <label className="flex items-center gap-2 text-xs">
          <span className="text-muted">{t('filterTo')}:</span>
          <input
            type="date"
            defaultValue={to ? to.slice(0, 10) : ''}
            onChange={(e) => setParam('to', e.target.value ? `${e.target.value}T23:59:59Z` : null)}
            className="text-xs bg-default-100 rounded px-2 py-1"
          />
        </label>

        <button
          type="button"
          onClick={reset}
          className="ml-auto text-xs text-muted hover:text-foreground underline"
        >
          {t('reset')}
        </button>

        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="text-xs px-3 py-1 rounded-lg bg-accent text-background flex items-center gap-1 disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          {t('refresh')}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Lint**

```bash
bunx eslint src/components/ai-pm/activity/FilterBar.tsx
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/ai-pm/activity/FilterBar.tsx
git commit -m "feat(ai-pm): activity filter bar"
```

---

## Task 8: Orchestrator `ActivityClient` + sidebar link

**Files:**
- Create: `src/components/ai-pm/activity/ActivityClient.tsx`
- Modify: `src/components/layout/sidebar.tsx`

- [ ] **Step 1: Create `ActivityClient`**

```tsx
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type {
  AiDecisionPublic,
  AiSignalPublic,
  PaperBotPublic,
  SpendSummary,
} from '@/services/ai-pm-activity.service';
import { FilterBar } from './FilterBar';
import { DecisionsList } from './DecisionsList';
import { SignalsRail } from './SignalsRail';
import { PaperBotsRail } from './PaperBotsRail';
import { SpendRail } from './SpendRail';
import { CronPulseRail } from './CronPulseRail';

interface ActivityResponse {
  decisions: AiDecisionPublic[];
  nextCursor: string | null;
  signals: AiSignalPublic[];
  paperBots: PaperBotPublic[];
  summary: SpendSummary;
  lastTickAt: string | null;
}

function buildQuery(params: URLSearchParams, cursor: string | null): string {
  const out = new URLSearchParams();
  for (const k of ['status', 'actionType', 'symbol', 'from', 'to']) {
    const v = params.get(k);
    if (v) out.set(k, v);
  }
  if (cursor) out.set('cursor', cursor);
  const s = out.toString();
  return s ? `?${s}` : '';
}

export function ActivityClient() {
  const params = useSearchParams();
  const t = useTranslations('AiPm.Activity');

  const [data, setData] = useState<ActivityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter signature derived only from URL — cursor is internal
  const filterSig = useMemo(() => {
    return ['status', 'actionType', 'symbol', 'from', 'to']
      .map((k) => `${k}=${params.get(k) ?? ''}`)
      .join('&');
  }, [params]);

  const fetchFresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/ai-pm/activity${buildQuery(params, null)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as ActivityResponse;
      setData(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setLoading(false);
    }
  }, [params]);

  const fetchMore = useCallback(async () => {
    if (!data?.nextCursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/ai-pm/activity${buildQuery(params, data.nextCursor)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as ActivityResponse;
      setData({
        ...data,
        decisions: [...data.decisions, ...body.decisions],
        nextCursor: body.nextCursor,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setLoading(false);
    }
  }, [data, loading, params]);

  // Refetch when filter signature changes
  useEffect(() => {
    fetchFresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterSig]);

  const hasFilters = filterSig.split('&').some((p) => !p.endsWith('='));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-4">
        <FilterBar loading={loading} onRefresh={fetchFresh} />

        {error && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 flex items-center justify-between">
            <span className="text-sm">{t('errorBanner')}: {error}</span>
            <button
              type="button"
              onClick={fetchFresh}
              className="text-xs px-3 py-1 rounded bg-background"
            >
              {t('retry')}
            </button>
          </div>
        )}

        <DecisionsList
          decisions={data?.decisions ?? []}
          nextCursor={data?.nextCursor ?? null}
          loading={loading}
          hasFilters={hasFilters}
          onLoadMore={fetchMore}
        />
      </div>

      <aside className="space-y-4">
        <CronPulseRail lastTickAt={data?.lastTickAt ?? null} />
        <SpendRail summary={data?.summary ?? { decisionsToday: 0, tokensInputToday: 0, tokensOutputToday: 0, costUsdToday: '0' }} />
        <SignalsRail signals={data?.signals ?? []} />
        <PaperBotsRail bots={data?.paperBots ?? []} />
      </aside>
    </div>
  );
}
```

- [ ] **Step 2: Modify sidebar — add `aiActivity` entry**

In `src/components/layout/sidebar.tsx`, import `Activity` from lucide-react and append after the existing `aiPm` entry:

```tsx
import {
  LayoutDashboard,
  Bot,
  KeyRound,
  Settings,
  Sparkles,
  Activity,
} from 'lucide-react';
```

Modify `navItems`:

```tsx
const navItems = [
  { href: '/dashboard', icon: LayoutDashboard, labelKey: 'overview' },
  { href: '/dashboard/bots', icon: Bot, labelKey: 'bots' },
  { href: '/dashboard/ai-pm', icon: Sparkles, labelKey: 'aiPm' },
  { href: '/dashboard/ai-pm/activity', icon: Activity, labelKey: 'aiActivity' },
  { href: '/dashboard/accounts', icon: KeyRound, labelKey: 'accounts' },
  { href: '/dashboard/settings', icon: Settings, labelKey: 'settings' },
] as const;
```

The existing `isActive` uses `startsWith`, so `/dashboard/ai-pm` would highlight when on `/activity`. Fix by ordering child route before parent in detection. Replace the helper with:

```tsx
const isActive = (href: string) => {
  if (href === '/dashboard') return pathname === '/dashboard';
  if (href === '/dashboard/ai-pm') return pathname === '/dashboard/ai-pm';
  return pathname.startsWith(href);
};
```

- [ ] **Step 3: Lint full surface**

```bash
bunx eslint src/components/ai-pm/activity src/components/layout/sidebar.tsx src/app/api/ai-pm/activity src/services/ai-pm-activity.service.ts "src/app/(dashboard)/dashboard/ai-pm/activity"
```

Expected: 0 errors.

- [ ] **Step 4: Run full test suite**

```bash
bun run vitest run
```

Expected: all tests pass (existing + new).

- [ ] **Step 5: Run build**

```bash
bun run build
```

Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/components/ai-pm/activity/ActivityClient.tsx src/components/layout/sidebar.tsx
git commit -m "feat(ai-pm): activity client orchestrator + sidebar link"
```

---

## Task 9: Manual smoke

- [ ] **Step 1: Start dev server**

```bash
npm run dev
```

- [ ] **Step 2: Verify empty + error paths**

1. Log in. Open `/dashboard/ai-pm/activity`.
2. Sidebar shows "AI Activity" entry; click highlights it (and not "AI Portfolio Manager").
3. With no decisions yet: page shows empty-state copy from `AiPm.Activity.emptyAll`.
4. Rails render: signals empty, paper-bots empty, today all zeros, cron pulse "Never" (red dot).
5. Click "Refresh" — spinner spins, returns to same state, no errors.

- [ ] **Step 3: Verify populated paths**

1. Trigger an ai-pm-tick run (manual Inngest invoke or wait for cron). At least one row should hit `ai_decisions`.
2. Reload `/dashboard/ai-pm/activity`. Decisions list populates with newest row first.
3. Status badge color matches outcome (executed=green, rejected=amber/orange, failed=red).
4. Expand a row: reasoning shows, signal+params JSON collapsibles work, model/cost section populates.
5. Cron pulse shows "<30m ago" (green dot).
6. If paper mode was on and decision created a paper bot: `paperBot` block renders inside detail; `PaperBotsRail` shows the bot.

- [ ] **Step 4: Verify filters**

1. Click an `EXECUTED` status pill — URL updates to `?status=EXECUTED`, list shrinks to that status.
2. Type a symbol — list filters; refresh-safe (reload preserves URL state).
3. Pick a `from` date — list filters by date range.
4. "Reset" — URL clears, all rows return.

- [ ] **Step 5: Verify pagination**

1. Lower `limit` for testing by appending `&limit=2` to URL.
2. Click "Load more" — older rows append below; button hides when no `nextCursor`.

- [ ] **Step 6: Commit smoke notes** (only if test fixtures or doc adjustments are needed). Otherwise skip.

---

## Self-Review

- **Spec §1 Goal — feed of ai_decisions + rails:** Covered by Tasks 1–8.
- **Spec §2 Non-Goals:** No subaccount filter (deferred), no realtime (manual refresh button), no pt/zh (EN only).
- **Spec §3 Architecture:** Server page → ActivityClient → service layer. One API round trip per refresh + one per "Load more".
- **Spec §4 File Structure:** All files in this plan match. Sidebar deviation called out.
- **Spec §5 API contract:** Implemented in Task 3.
- **Spec §6 Public types:** `AiDecisionPublic`, `AiSignalPublic`, `PaperBotPublic`, `SpendSummary` defined in service (Tasks 1–2).
- **Spec §7 Cursor pagination:** Implemented in Task 2 (`encodeCursor`/`decodeCursor`, fetch limit+1, stable tiebreak on id).
- **Spec §8 Filter compilation:** Done in `listDecisions`. Enum validation in route handler (Task 3).
- **Spec §9 URL state:** `FilterBar` writes to URL via `router.replace`. Cursor not in URL. `ActivityClient` re-fetches on `filterSig` change.
- **Spec §10 Side rails:** Four rail components in Task 5, all backed by service queries.
- **Spec §11 Decision row UX:** `DecisionRow` + `DecisionDetail` cover status colors, expand, four sections.
- **Spec §12 Error/empty/loading:** Error banner in `ActivityClient`, empty states in `DecisionsList`, "Load more" disabled when loading.
- **Spec §13 Testing:** Service tests in Task 1–2, route tests in Task 3.
- **Spec §14 Manual smoke:** Task 9.
- **Spec §15 Security:** Auth-required route; user-id never client-supplied; jsonb rendered inside `<pre>` — no XSS.
- **Spec §16 Done criteria:** Covered by Tasks 1–9.

No placeholders. Types consistent (`AiDecisionPublic`, `AiSignalPublic`, `PaperBotPublic`, `SpendSummary` all named identically across tasks). Service exports `ALL_STATUSES`, `ALL_ACTION_TYPES` used by both route and FilterBar.

## Done Criteria

1. `GET /api/ai-pm/activity` returns combined payload with correct filter/cursor semantics.
2. Service tests + API route tests all pass under Vitest.
3. `/dashboard/ai-pm/activity` renders, sidebar entry highlights correctly.
4. Filters reflect in URL; refresh-safe; "Reset" clears.
5. "Load more" walks cursor without dupes or gaps.
6. Side rails populate independently of filters.
7. Lint + build clean.
8. Manual smoke captured in PR description.
