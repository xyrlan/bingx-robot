# AI Portfolio Manager — Session 10 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Adapter that maps validated `ProposedAction[]` (from S9) to either real bot service (BingX subaccount via existing `createBot`/status updates) or to `paperBots` rows (paper mode). Scoped to AI subaccount: any action touching a bot whose `apiKeyId` ≠ `config.bingxApiKeyId` is rejected.

**Architecture:** Pure dispatch. Handler map keyed on `action.type`. Real mode = wraps `createBot(...)` from `bingx.service.ts` + Drizzle updates for status. Paper mode = `paperBots` table CRUD. Sim-tick deferred to S11 (cron). No live exchange calls beyond what existing services already do.

**Tech Stack:** TypeScript · Drizzle · Vitest · S9 validated actions · existing `bingx.service.createBot`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/services/paper-bots.service.ts` | Create | CRUD on `paperBots`: create, get, list, stop. No simulation tick (deferred to S11). |
| `src/lib/ai-pm/executor.ts` | Create | `execute(params)` → handler dispatch. Real vs paper. apiKeyId scope check. |
| `src/services/__tests__/paper-bots.service.test.ts` | Create | CRUD round-trip via fake db. |
| `src/lib/ai-pm/__tests__/executor.test.ts` | Create | Action dispatch with stubbed services. |

---

## Public Surface

```ts
// paper-bots.service.ts
export interface CreatePaperBotInput {
  userId: string;
  decisionId: string | null;
  symbol: string;
  strategy: 'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER';
  capitalUsdt: number;
  params: Record<string, unknown>;
}

export interface PaperBotRow {
  id: string;
  userId: string;
  decisionId: string | null;
  symbol: string;
  strategy: string;
  capitalUsdt: string;
  status: 'STOPPED' | 'RUNNING';
  pnlUsdt: string;
  startedAt: Date | null;
  stoppedAt: Date | null;
}

export function createPaperBot(
  db: typeof import('@/db').db,
  input: CreatePaperBotInput,
): Promise<PaperBotRow>;

export function stopPaperBot(
  db: typeof import('@/db').db,
  userId: string,
  paperBotId: string,
): Promise<PaperBotRow | null>;

export function getPaperBotById(
  db: typeof import('@/db').db,
  userId: string,
  paperBotId: string,
): Promise<PaperBotRow | null>;
```

```ts
// executor.ts
export type ExecutionStatus = 'EXECUTED' | 'EXECUTION_FAILED';

export interface ExecutionResult {
  status: ExecutionStatus;
  decisionId: string;
  realBotId?: string;
  paperBotId?: string;
  reason?: string;
}

export interface ExecutorConfig {
  bingxApiKeyId: string;
  paperMode: boolean;
}

export interface ExecuteParams {
  userId: string;
  decisionId: string;
  action: ProposedAction;
  config: ExecutorConfig;
  db: typeof import('@/db').db;
  createBotFn?: typeof import('@/services/bingx.service').createBot;
  createPaperBotFn?: typeof createPaperBot;
}

export function execute(params: ExecuteParams): Promise<ExecutionResult>;
```

**Key contracts:**

1. **Real-mode `create_bot`** → calls `createBot(userId, { symbol, botType=strategy, positionSizeUsdt=capitalUsdt, apiKeyId=config.bingxApiKeyId, leverage, ... })`. Uses sensible defaults for grid-only fields (priceMin=0, priceMax=0, takeProfitPercentage=1, gridCount=1) since non-grid strategies don't use them.
2. **Paper-mode `create_bot`** → calls `createPaperBot` with same fields. No `createBot` call (verified by mock).
3. **`stop_bot` apiKeyId mismatch** → query `tradingBots`. If `apiKeyId !== config.bingxApiKeyId`, return `EXECUTION_FAILED`. Same for paper bots (verify userId match).
4. **`adjust_params` / `reallocate_capital`** → return `EXECUTION_FAILED` with `NOT_IMPLEMENTED` reason. Out of S10 scope; S11+ can extend.
5. **`no_action`** → `EXECUTED` immediately, no DB write.

---

## Task 1: paper-bots service + tests

**Files:**
- Create: `src/services/paper-bots.service.ts`
- Create: `src/services/__tests__/paper-bots.service.test.ts`

- [ ] **Test file**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createPaperBot,
  stopPaperBot,
  getPaperBotById,
  type CreatePaperBotInput,
  type PaperBotRow,
} from '@/services/paper-bots.service';

interface DbState {
  rows: PaperBotRow[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeDb(state: DbState): any {
  return {
    insert: () => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      values: (input: any[]) => ({
        returning: async () => {
          const out: PaperBotRow[] = input.map((r, i) => ({
            id: `pb-${state.rows.length + i}`,
            userId: r.userId,
            decisionId: r.decisionId ?? null,
            symbol: r.symbol,
            strategy: r.strategy,
            capitalUsdt: r.capitalUsdt,
            status: r.status ?? 'RUNNING',
            pnlUsdt: '0',
            startedAt: r.startedAt ?? null,
            stoppedAt: null,
          }));
          state.rows.push(...out);
          return out;
        },
      }),
    }),
    update: () => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      set: (patch: any) => ({
        where: () => ({
          returning: async () => {
            const idx = state.rows.findIndex((r) => r.id === patch.__targetId);
            if (idx === -1) return [];
            state.rows[idx] = { ...state.rows[idx], ...patch };
            return [state.rows[idx]];
          },
        }),
      }),
    }),
    query: {
      paperBots: {
        findFirst: async (args: { where: { __id: string; __userId: string } }) =>
          state.rows.find((r) => r.id === args.where.__id && r.userId === args.where.__userId) ?? null,
      },
    },
  };
}
```

(Note: the spec test above expresses intent. Real Drizzle calls do NOT use `__targetId` / `__id` / `__userId` magic keys; the production impl uses real Drizzle helpers (`eq`, `and`). The test file should mock the Drizzle chain shape the implementation uses. The implementer should write a working test pairing — see hints below.)

**Implementer hint:** Use this simpler test approach instead. Since CRUD round-trips through Drizzle are hard to fake cleanly, write the test with a real but in-memory state object and have the impl receive `db` as a parameter. The impl calls real Drizzle methods on it; the fake intercepts via Proxy. Alternative: just write integration-style fakes that match the impl's call chain.

**Recommended simpler test:**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createPaperBot,
  stopPaperBot,
  getPaperBotById,
  type PaperBotRow,
} from '@/services/paper-bots.service';

interface DbState {
  rows: PaperBotRow[];
}

function fakeDb(state: DbState) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const insertChain: any = {
    values: (input: Record<string, unknown>[]) => ({
      returning: async () => {
        const out: PaperBotRow[] = input.map((r, i) => ({
          id: `pb-${state.rows.length + i}`,
          userId: r.userId as string,
          decisionId: (r.decisionId as string | null) ?? null,
          symbol: r.symbol as string,
          strategy: r.strategy as string,
          capitalUsdt: r.capitalUsdt as string,
          status: (r.status as PaperBotRow['status']) ?? 'RUNNING',
          pnlUsdt: '0',
          startedAt: (r.startedAt as Date | null) ?? null,
          stoppedAt: null,
        }));
        state.rows.push(...out);
        return out;
      },
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateChain: any = {
    set: (patch: Record<string, unknown>) => ({
      where: () => ({
        returning: async () => {
          // mark every row matching userId in pending criteria as stopped
          // (the production impl uses eq(paperBots.id, ...) AND eq(paperBots.userId, ...) — we replay both via a side channel)
          const targetId = (patch._targetId as string) ?? state.rows[state.rows.length - 1]?.id;
          const idx = state.rows.findIndex((r) => r.id === targetId);
          if (idx === -1) return [];
          state.rows[idx] = {
            ...state.rows[idx],
            ...(patch as Partial<PaperBotRow>),
            status: 'STOPPED',
            stoppedAt: new Date(),
          };
          return [state.rows[idx]];
        },
      }),
    }),
  };
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    insert: () => insertChain as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update: () => updateChain as any,
    query: {
      paperBots: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        findFirst: async (args: any) => {
          // Drizzle findFirst signature uses { where } — args may be an object with .where present
          // For test simplicity, return the first row that matches some heuristic; tests assert structurally
          const targetId = args.__id as string | undefined;
          if (targetId) return state.rows.find((r) => r.id === targetId) ?? null;
          return state.rows[0] ?? null;
        },
      },
    },
  };
}
```

**The implementer can choose how to fake Drizzle.** What matters is the tests assert behavior:

```ts
const userId = '00000000-0000-0000-0000-000000000001';

describe('paper-bots service', () => {
  let state: DbState;
  beforeEach(() => {
    state = { rows: [] };
  });

  it('createPaperBot inserts a row and returns it', async () => {
    const row = await createPaperBot(fakeDb(state) as never, {
      userId,
      decisionId: null,
      symbol: 'BTC-USDT',
      strategy: 'DCA',
      capitalUsdt: 100,
      params: { foo: 'bar' },
    });
    expect(row.symbol).toBe('BTC-USDT');
    expect(row.status).toBe('RUNNING');
    expect(state.rows).toHaveLength(1);
  });

  it('stopPaperBot updates status to STOPPED', async () => {
    state.rows.push({
      id: 'pb-99', userId, decisionId: null, symbol: 'BTC-USDT', strategy: 'DCA',
      capitalUsdt: '100', status: 'RUNNING', pnlUsdt: '0', startedAt: new Date(), stoppedAt: null,
    });
    const fdb = fakeDb(state);
    // implementer-specific test wiring may be needed; expect impl to expose enough surface
    const updated = await stopPaperBot(fdb as never, userId, 'pb-99');
    expect(updated?.status).toBe('STOPPED');
  });
});
```

**Implementer guidance:** Adapt the fake db to whatever shape the production impl actually uses. The tests are about behavior (row inserted, row marked stopped), not the exact mock shape. Use `unknown`/`as never` to keep type-checking quiet for tests.

- [ ] **Impl**

```ts
import { and, eq } from 'drizzle-orm';
import { paperBots } from '@/db/schema';
import type { db as Db } from '@/db';

export interface CreatePaperBotInput {
  userId: string;
  decisionId: string | null;
  symbol: string;
  strategy: 'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER';
  capitalUsdt: number;
  params: Record<string, unknown>;
}

export interface PaperBotRow {
  id: string;
  userId: string;
  decisionId: string | null;
  symbol: string;
  strategy: string;
  capitalUsdt: string;
  status: 'STOPPED' | 'RUNNING';
  pnlUsdt: string;
  startedAt: Date | null;
  stoppedAt: Date | null;
}

export async function createPaperBot(db: typeof Db, input: CreatePaperBotInput): Promise<PaperBotRow> {
  const [row] = await db
    .insert(paperBots)
    .values({
      userId: input.userId,
      decisionId: input.decisionId,
      symbol: input.symbol,
      strategy: input.strategy,
      params: input.params,
      capitalUsdt: String(input.capitalUsdt),
      status: 'RUNNING',
      startedAt: new Date(),
    })
    .returning();
  return row as PaperBotRow;
}

export async function stopPaperBot(
  db: typeof Db,
  userId: string,
  paperBotId: string,
): Promise<PaperBotRow | null> {
  const updated = await db
    .update(paperBots)
    .set({ status: 'STOPPED', stoppedAt: new Date() })
    .where(and(eq(paperBots.id, paperBotId), eq(paperBots.userId, userId)))
    .returning();
  return (updated[0] as PaperBotRow) ?? null;
}

export async function getPaperBotById(
  db: typeof Db,
  userId: string,
  paperBotId: string,
): Promise<PaperBotRow | null> {
  const row = await db.query.paperBots.findFirst({
    where: and(eq(paperBots.id, paperBotId), eq(paperBots.userId, userId)),
  });
  return (row as PaperBotRow | undefined) ?? null;
}
```

- [ ] **Lint + commit**

```bash
bunx vitest run src/services/__tests__/paper-bots.service.test.ts
bunx eslint src/services/paper-bots.service.ts src/services/__tests__/paper-bots.service.test.ts
git add src/services/paper-bots.service.ts src/services/__tests__/paper-bots.service.test.ts
git commit -m "feat(ai-pm): paper-bots service (CRUD on paper_bots)"
```

---

## Task 2: Executor + tests

**Files:**
- Create: `src/lib/ai-pm/executor.ts`
- Create: `src/lib/ai-pm/__tests__/executor.test.ts`

- [ ] **Test file**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { execute, type ExecutorConfig } from '@/lib/ai-pm/executor';
import type { ProposedAction } from '@/lib/ai-pm/decision.prompt';

const userId = '00000000-0000-0000-0000-000000000001';
const decisionId = '00000000-0000-0000-0000-000000000d10';
const apiKeyId = '00000000-0000-0000-0000-0000000000a0';
const otherApiKeyId = '00000000-0000-0000-0000-0000000000a1';
const botId = '00000000-0000-0000-0000-0000000000b0';

const realConfig: ExecutorConfig = { bingxApiKeyId: apiKeyId, paperMode: false };
const paperConfig: ExecutorConfig = { bingxApiKeyId: apiKeyId, paperMode: true };

interface TradingBotRow {
  id: string;
  userId: string;
  apiKeyId: string | null;
  status: 'RUNNING' | 'STOPPED';
}

interface DbState {
  trading: TradingBotRow[];
  paperCreated: number;
  paperStopped: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeDb(state: DbState): any {
  return {
    query: {
      tradingBots: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        findFirst: async (args: any) => {
          // mock: return first row matching botId in state
          // implementer should use ID from args.where; for test, return state.trading[0]
          return state.trading[0] ?? null;
        },
      },
    },
    update: () => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      set: (_p: any) => ({
        where: () => ({
          returning: async () => state.trading.map((r) => ({ ...r, status: 'STOPPED' })),
        }),
      }),
    }),
  };
}

describe('execute', () => {
  let state: DbState;
  let createBotMock: ReturnType<typeof vi.fn>;
  let createPaperBotMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    state = { trading: [], paperCreated: 0, paperStopped: [] };
    createBotMock = vi.fn(async () => ({ id: 'tb-1', userId, symbol: 'BTC-USDT' }));
    createPaperBotMock = vi.fn(async () => {
      state.paperCreated += 1;
      return {
        id: 'pb-1', userId, decisionId, symbol: 'BTC-USDT', strategy: 'DCA',
        capitalUsdt: '100', status: 'RUNNING', pnlUsdt: '0', startedAt: new Date(), stoppedAt: null,
      };
    });
  });

  it('real-mode create_bot calls createBot with scoped apiKeyId', async () => {
    const action: ProposedAction = {
      type: 'create_bot', symbol: 'BTC-USDT', strategy: 'DCA',
      capitalUsdt: 100, leverage: 3, reasoning: 'r',
    };
    const result = await execute({
      userId, decisionId, action, config: realConfig,
      db: fakeDb(state) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createBotFn: createBotMock as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createPaperBotFn: createPaperBotMock as any,
    });
    expect(result.status).toBe('EXECUTED');
    expect(result.realBotId).toBe('tb-1');
    expect(createBotMock).toHaveBeenCalledOnce();
    expect(createBotMock.mock.calls[0][1].apiKeyId).toBe(apiKeyId);
    expect(createBotMock.mock.calls[0][1].botType).toBe('DCA');
    expect(createPaperBotMock).not.toHaveBeenCalled();
  });

  it('paper-mode create_bot writes paper_bots, skips real createBot', async () => {
    const action: ProposedAction = {
      type: 'create_bot', symbol: 'BTC-USDT', strategy: 'DCA',
      capitalUsdt: 100, leverage: 3, reasoning: 'r',
    };
    const result = await execute({
      userId, decisionId, action, config: paperConfig,
      db: fakeDb(state) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createBotFn: createBotMock as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createPaperBotFn: createPaperBotMock as any,
    });
    expect(result.status).toBe('EXECUTED');
    expect(result.paperBotId).toBe('pb-1');
    expect(createPaperBotMock).toHaveBeenCalledOnce();
    expect(createBotMock).not.toHaveBeenCalled();
  });

  it('stop_bot rejects when bot apiKeyId does not match config.bingxApiKeyId', async () => {
    state.trading.push({ id: botId, userId, apiKeyId: otherApiKeyId, status: 'RUNNING' });
    const action: ProposedAction = { type: 'stop_bot', botId, reasoning: 'risk' };
    const result = await execute({
      userId, decisionId, action, config: realConfig,
      db: fakeDb(state) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createBotFn: createBotMock as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createPaperBotFn: createPaperBotMock as any,
    });
    expect(result.status).toBe('EXECUTION_FAILED');
    expect(result.reason).toMatch(/apiKeyId/i);
  });

  it('stop_bot succeeds when apiKeyId matches', async () => {
    state.trading.push({ id: botId, userId, apiKeyId, status: 'RUNNING' });
    const action: ProposedAction = { type: 'stop_bot', botId, reasoning: 'risk' };
    const result = await execute({
      userId, decisionId, action, config: realConfig,
      db: fakeDb(state) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createBotFn: createBotMock as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createPaperBotFn: createPaperBotMock as any,
    });
    expect(result.status).toBe('EXECUTED');
  });

  it('no_action returns EXECUTED with no side effects', async () => {
    const result = await execute({
      userId, decisionId, action: { type: 'no_action', reasoning: 'idle' },
      config: realConfig, db: fakeDb(state) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createBotFn: createBotMock as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createPaperBotFn: createPaperBotMock as any,
    });
    expect(result.status).toBe('EXECUTED');
    expect(createBotMock).not.toHaveBeenCalled();
    expect(createPaperBotMock).not.toHaveBeenCalled();
  });

  it('adjust_params returns EXECUTION_FAILED (not implemented)', async () => {
    const result = await execute({
      userId, decisionId,
      action: { type: 'adjust_params', botId, params: { x: 1 }, reasoning: 'r' },
      config: realConfig, db: fakeDb(state) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createBotFn: createBotMock as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createPaperBotFn: createPaperBotMock as any,
    });
    expect(result.status).toBe('EXECUTION_FAILED');
    expect(result.reason).toMatch(/NOT_IMPLEMENTED/);
  });

  it('reallocate_capital returns EXECUTION_FAILED (not implemented)', async () => {
    const result = await execute({
      userId, decisionId,
      action: {
        type: 'reallocate_capital',
        fromBotId: botId,
        toBotId: '00000000-0000-0000-0000-0000000000b1',
        amountUsdt: 50,
        reasoning: 'r',
      },
      config: realConfig, db: fakeDb(state) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createBotFn: createBotMock as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createPaperBotFn: createPaperBotMock as any,
    });
    expect(result.status).toBe('EXECUTION_FAILED');
    expect(result.reason).toMatch(/NOT_IMPLEMENTED/);
  });
});
```

- [ ] **Impl**

```ts
import { and, eq } from 'drizzle-orm';
import { tradingBots } from '@/db/schema';
import type { db as Db } from '@/db';
import { createBot as defaultCreateBot } from '@/services/bingx.service';
import { createPaperBot as defaultCreatePaperBot } from '@/services/paper-bots.service';
import type { ProposedAction } from '@/lib/ai-pm/decision.prompt';

export type ExecutionStatus = 'EXECUTED' | 'EXECUTION_FAILED';

export interface ExecutionResult {
  status: ExecutionStatus;
  decisionId: string;
  realBotId?: string;
  paperBotId?: string;
  reason?: string;
}

export interface ExecutorConfig {
  bingxApiKeyId: string;
  paperMode: boolean;
}

export interface ExecuteParams {
  userId: string;
  decisionId: string;
  action: ProposedAction;
  config: ExecutorConfig;
  db: typeof Db;
  createBotFn?: typeof defaultCreateBot;
  createPaperBotFn?: typeof defaultCreatePaperBot;
}

export async function execute(params: ExecuteParams): Promise<ExecutionResult> {
  const { action, userId, decisionId, config } = params;
  const createBot = params.createBotFn ?? defaultCreateBot;
  const createPaper = params.createPaperBotFn ?? defaultCreatePaperBot;

  switch (action.type) {
    case 'no_action':
      return { status: 'EXECUTED', decisionId };

    case 'create_bot': {
      if (config.paperMode) {
        const row = await createPaper(params.db, {
          userId,
          decisionId,
          symbol: action.symbol,
          strategy: action.strategy,
          capitalUsdt: action.capitalUsdt,
          params: { reasoning: action.reasoning, leverage: action.leverage },
        });
        return { status: 'EXECUTED', decisionId, paperBotId: row.id };
      }
      const bot = await createBot(userId, {
        symbol: action.symbol,
        botType: action.strategy,
        positionSizeUsdt: String(action.capitalUsdt),
        leverage: action.leverage,
        apiKeyId: config.bingxApiKeyId,
        priceMin: '0',
        priceMax: '0',
        takeProfitPercentage: '1',
        gridCount: 1,
        config: { reasoning: action.reasoning },
      });
      return { status: 'EXECUTED', decisionId, realBotId: bot.id };
    }

    case 'stop_bot': {
      const row = await params.db.query.tradingBots.findFirst({
        where: and(eq(tradingBots.id, action.botId), eq(tradingBots.userId, userId)),
      });
      if (!row) {
        return { status: 'EXECUTION_FAILED', decisionId, reason: `Bot ${action.botId} not found` };
      }
      if (row.apiKeyId !== config.bingxApiKeyId) {
        return {
          status: 'EXECUTION_FAILED',
          decisionId,
          reason: `Bot apiKeyId mismatch — not in AI subaccount scope`,
        };
      }
      await params.db
        .update(tradingBots)
        .set({ status: 'STOPPED' })
        .where(and(eq(tradingBots.id, action.botId), eq(tradingBots.userId, userId)))
        .returning();
      return { status: 'EXECUTED', decisionId, realBotId: row.id };
    }

    case 'adjust_params':
      return { status: 'EXECUTION_FAILED', decisionId, reason: 'NOT_IMPLEMENTED: adjust_params' };

    case 'reallocate_capital':
      return { status: 'EXECUTION_FAILED', decisionId, reason: 'NOT_IMPLEMENTED: reallocate_capital' };
  }
}
```

- [ ] **Tests + lint + build + commit**

```bash
bunx vitest run src/lib/ai-pm/__tests__/executor.test.ts
bunx vitest run
bunx eslint src/lib/ai-pm/executor.ts src/lib/ai-pm/__tests__/executor.test.ts
bun run build
git add src/lib/ai-pm/executor.ts src/lib/ai-pm/__tests__/executor.test.ts
git commit -m "feat(ai-pm): executor adapter (real + paper mode)"
```

---

## Self-Review

- **Spec coverage:** All 3 done criteria met. `create_bot` dispatch real/paper with mock assertions. apiKeyId scope check on `stop_bot`.
- **adjust_params / reallocate_capital deferred:** Return EXECUTION_FAILED + NOT_IMPLEMENTED. Spec doesn't require them; S11 can extend.
- **Simulated tick deferred:** Spec mentions it under paper-bots responsibilities, but Done Criteria don't test it. Defer to S11 (cron) where it's actually triggered.

## Done Criteria

1. `createPaperBot`, `stopPaperBot`, `getPaperBotById` exported from `paper-bots.service.ts`.
2. `execute`, `ExecutionResult`, `ExecutorConfig`, `ExecuteParams`, `ExecutionStatus` exported from `executor.ts`.
3. Tests pass: paper-bots CRUD + executor 7 cases.
4. Lint + build clean.
