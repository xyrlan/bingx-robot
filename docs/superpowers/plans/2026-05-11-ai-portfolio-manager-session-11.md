# AI Portfolio Manager — Session 11 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Inngest cron `*/30 * * * *` that wires the AI PM pipeline per opted-in user. Pipeline: load config → load portfolio state → `runSignal` → `runDecision` → per `ProposedAction` `validate` → `execute`. Persistence is automatic (S9 `validate` writes `ai_decisions`).

**Architecture:** Pure orchestration. No new business logic — only wiring. Mid-run kill-switch safety: re-check `killSwitch` before execute step. Concurrency: 1 per user (Inngest), max 3 users in parallel (worker `maxWorkerConcurrency` already 5). Cron registered in BOTH `src/worker.ts` AND `src/app/api/inngest/route.ts`.

**Tech Stack:** TypeScript · Inngest · Drizzle · Vitest · S2 config service · S7 signal · S8 decision · S9 validation · S10 executor

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/services/ai-pm-config.service.ts` | Modify | Add `listEnabledAiPmConfigs()` → all configs with `enabled=true AND killSwitch=false`. |
| `src/inngest/functions/ai-pm-tick.ts` | Create | Cron function `aiPmTick`. Iterates users, runs full pipeline. |
| `src/inngest/functions/__tests__/ai-pm-tick.test.ts` | Create | End-to-end orchestration test with mocked Signal/Decision/Validation/Executor + fake config service. |
| `src/worker.ts` | Modify | Register `aiPmTick` in `functions: [...]` array. |
| `src/app/api/inngest/route.ts` | Modify | Register `aiPmTick` in `functions = [...]` array. |

---

## Public Surface

```ts
// ai-pm-config.service.ts (additions)
export async function listEnabledAiPmConfigs(): Promise<AiPmConfigDecrypted[]>;
```

```ts
// ai-pm-tick.ts
export const aiPmTick: ReturnType<typeof inngest.createFunction>;

// Exported pipeline entry point (so tests can call it directly without Inngest):
export interface RunUserTickParams {
  userId: string;
  anthropicApiKey: string;
  bingxApiKeyId: string;
  paperMode: boolean;
  allowedSymbols: string[];
  maxCapitalUsdt: number;
  maxConcurrentBots: number;
  allowedStrategies: Array<'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER'>;
  reviewerThresholdPct?: number;        // default 30
  isKillSwitchActive: () => Promise<boolean>;   // mid-run check
  loadBingxClient: () => Promise<BingxClient | null>;
  loadPortfolio: () => Promise<PortfolioState>;
  signalFn: typeof runSignal;
  decisionFn: typeof runDecision;
  validateFn: typeof validate;
  executeFn: typeof execute;
  db: typeof import('@/db').db;
  logger: { info: (msg: string, ctx?: unknown) => void; warn: (msg: string, ctx?: unknown) => void; error: (msg: string, ctx?: unknown) => void };
}

export interface UserTickReport {
  userId: string;
  status: 'COMPLETED' | 'SKIPPED_KILL_SWITCH' | 'SKIPPED_NO_BINGX_CLIENT' | 'SIGNAL_FAILED' | 'DECISION_FAILED' | 'PARTIAL';
  proposedCount: number;
  executedCount: number;
  failedCount: number;
  rejectedCount: number;
}

export function runUserTick(params: RunUserTickParams): Promise<UserTickReport>;
```

**Key contracts:**

1. **Per-user concurrency limit 1** via Inngest function-level `concurrency: { key: 'event.data.userId', limit: 1 }`. Step-level fan-out: cron event lists users, fans out one event per user. Each per-user run is sequential.
2. **Mid-run kill switch:** `runUserTick` calls `isKillSwitchActive()` before the execute loop AND between each action. First true → abort with `SKIPPED_KILL_SWITCH` (further executes flagged `EXECUTION_FAILED` with `KILL_SWITCH` reason).
3. **Signal/Decision errors propagate up** as report statuses (`SIGNAL_FAILED`, `DECISION_FAILED`). `ai_decisions` rows for proposed actions are still written by `validate` before execute.
4. **Per-action execute isolation.** One action's failure doesn't block siblings. Report accumulates counts.
5. **No new DB writes here.** All persistence already happens in `validate` (S9). After execute, status update on the row is done in this layer via a small update query.

---

## Task 1: `listEnabledAiPmConfigs` helper

**Files:**
- Modify: `src/services/ai-pm-config.service.ts`
- Modify: `src/services/__tests__/ai-pm-config.service.test.ts` (add test if file exists; else create)

- [ ] **Step 1:** Add to `ai-pm-config.service.ts`:

```ts
export async function listEnabledAiPmConfigs(): Promise<AiPmConfigDecrypted[]> {
  const rows = await db.query.aiPmConfigs.findMany({
    where: and(eq(aiPmConfigs.enabled, true), eq(aiPmConfigs.killSwitch, false)),
  });
  return rows.map((row) => {
    const { anthropicApiKeyEncrypted, ...rest } = row;
    return { ...rest, anthropicApiKey: decryptSecret(anthropicApiKeyEncrypted) };
  });
}
```

(Adjust imports: ensure `and` from `drizzle-orm` is imported alongside existing `eq`.)

- [ ] **Step 2:** Test in `__tests__/ai-pm-config.service.test.ts`. If the existing test file uses real DB or a specific db-mock pattern, mirror it. Otherwise, add a unit test that asserts the query shape via spy.

Skip if existing test infra makes adding this test high-effort. The function is mechanical; integration coverage from the cron test is sufficient.

- [ ] **Step 3:** Lint clean, commit:
```bash
git add src/services/ai-pm-config.service.ts
git commit -m "feat(ai-pm): listEnabledAiPmConfigs helper"
```

---

## Task 2: Cron function + tests

**Files:**
- Create: `src/inngest/functions/ai-pm-tick.ts`
- Create: `src/inngest/functions/__tests__/ai-pm-tick.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runUserTick, type RunUserTickParams } from '@/inngest/functions/ai-pm-tick';
import type { SignalOutcome } from '@/lib/ai-pm/signal';
import type { DecisionOutcome } from '@/lib/ai-pm/decision';
import type { ValidationResult } from '@/lib/ai-pm/validation';
import type { ExecutionResult } from '@/lib/ai-pm/executor';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';

const userId = '00000000-0000-0000-0000-000000000001';
const apiKeyId = '00000000-0000-0000-0000-0000000000a0';
const decisionA = '00000000-0000-0000-0000-000000000d01';
const decisionB = '00000000-0000-0000-0000-000000000d02';

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function basePortfolio(): PortfolioState {
  return {
    runningBots: [],
    capitalUsedUsdt: 0,
    bingxApiKeyId: apiKeyId,
  };
}

function baseParams(overrides: Partial<RunUserTickParams> = {}): RunUserTickParams {
  return {
    userId,
    anthropicApiKey: 'sk',
    bingxApiKeyId: apiKeyId,
    paperMode: true,
    allowedSymbols: ['BTC-USDT'],
    maxCapitalUsdt: 1000,
    maxConcurrentBots: 5,
    allowedStrategies: ['DCA', 'TRAILING_STOP', 'DCA_SPOT', 'SMA_CROSSOVER'],
    isKillSwitchActive: async () => false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    loadBingxClient: async () => ({ __fake: true } as any),
    loadPortfolio: async () => basePortfolio(),
    signalFn: async (): Promise<SignalOutcome> => ({
      ok: true,
      result: {
        candidates: [
          { symbol: 'BTC-USDT', regime: 'range', score: 80, reason: 'r' },
        ],
        signalIds: ['s1'],
        usage: { inputTokens: 500, outputTokens: 50, cachedInputTokens: 0, costUsd: 0.001, model: 'claude-haiku-4-5' },
      },
    }),
    decisionFn: async (): Promise<DecisionOutcome> => ({
      ok: true,
      result: {
        proposedActions: [
          { type: 'create_bot', symbol: 'BTC-USDT', strategy: 'DCA', capitalUsdt: 100, leverage: 3, reasoning: 'r' },
        ],
        rejectedActions: [],
        usage: { inputTokens: 800, outputTokens: 200, cachedInputTokens: 0, costUsd: 0.005, model: 'claude-sonnet-4-6' },
      },
    }),
    validateFn: async (): Promise<ValidationResult> => ({
      status: 'PROPOSED',
      decisionId: decisionA,
    }),
    executeFn: async (): Promise<ExecutionResult> => ({
      status: 'EXECUTED',
      decisionId: decisionA,
      paperBotId: 'pb-1',
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: { update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }) } as any,
    logger: silentLogger(),
    ...overrides,
  };
}

describe('runUserTick', () => {
  let p: RunUserTickParams;
  beforeEach(() => {
    p = baseParams();
  });

  it('runs full pipeline and reports COMPLETED', async () => {
    const report = await runUserTick(p);
    expect(report.status).toBe('COMPLETED');
    expect(report.proposedCount).toBe(1);
    expect(report.executedCount).toBe(1);
    expect(report.failedCount).toBe(0);
  });

  it('skips when kill switch active at start', async () => {
    p.isKillSwitchActive = async () => true;
    const signalSpy = vi.spyOn(p, 'signalFn');
    const report = await runUserTick(p);
    expect(report.status).toBe('SKIPPED_KILL_SWITCH');
    expect(signalSpy).not.toHaveBeenCalled();
  });

  it('aborts mid-run when kill switch flips after signal', async () => {
    let calls = 0;
    p.isKillSwitchActive = async () => {
      calls += 1;
      return calls > 1;
    };
    const executeSpy = vi.spyOn(p, 'executeFn');
    const report = await runUserTick(p);
    expect(report.status).toBe('SKIPPED_KILL_SWITCH');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('reports SKIPPED_NO_BINGX_CLIENT when client load returns null', async () => {
    p.loadBingxClient = async () => null;
    const report = await runUserTick(p);
    expect(report.status).toBe('SKIPPED_NO_BINGX_CLIENT');
  });

  it('reports SIGNAL_FAILED when signal returns error', async () => {
    p.signalFn = async () => ({ ok: false, error: { kind: 'NO_MARKET_DATA', symbol: 'BTC-USDT' } });
    const report = await runUserTick(p);
    expect(report.status).toBe('SIGNAL_FAILED');
    expect(report.proposedCount).toBe(0);
  });

  it('reports DECISION_FAILED when decision returns error', async () => {
    p.decisionFn = async () => ({ ok: false, error: { kind: 'NO_TOOL_USE', message: 'm' } });
    const report = await runUserTick(p);
    expect(report.status).toBe('DECISION_FAILED');
  });

  it('continues other actions when one execute fails', async () => {
    p.decisionFn = async () => ({
      ok: true,
      result: {
        proposedActions: [
          { type: 'create_bot', symbol: 'BTC-USDT', strategy: 'DCA', capitalUsdt: 100, leverage: 3, reasoning: 'r' },
          { type: 'no_action', reasoning: 'wait' },
        ],
        rejectedActions: [],
        usage: { inputTokens: 800, outputTokens: 200, cachedInputTokens: 0, costUsd: 0.005, model: 'claude-sonnet-4-6' },
      },
    });
    p.validateFn = async ({ action }) => ({
      status: 'PROPOSED',
      decisionId: action.type === 'create_bot' ? decisionA : decisionB,
    });
    p.executeFn = async ({ action }) =>
      action.type === 'create_bot'
        ? { status: 'EXECUTION_FAILED', decisionId: decisionA, reason: 'boom' }
        : { status: 'EXECUTED', decisionId: decisionB };

    const report = await runUserTick(p);
    expect(report.status).toBe('PARTIAL');
    expect(report.proposedCount).toBe(2);
    expect(report.executedCount).toBe(1);
    expect(report.failedCount).toBe(1);
  });

  it('counts rejections from validate without calling executor for them', async () => {
    p.validateFn = async () => ({ status: 'REJECTED_GUARDRAIL', decisionId: decisionA, reason: 'cap' });
    const executeSpy = vi.spyOn(p, 'executeFn');
    const report = await runUserTick(p);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(report.rejectedCount).toBe(1);
    expect(report.executedCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests** — fail (module not found).

- [ ] **Step 3: Implement `ai-pm-tick.ts`**

```ts
import { eq } from 'drizzle-orm';
import { inngest } from '@/inngest/client';
import { aiDecisions, aiPmConfigs } from '@/db/schema';
import { db } from '@/db';
import { listEnabledAiPmConfigs, getAiPmConfig } from '@/services/ai-pm-config.service';
import { getBingxClientByApiKeyId } from '@/services/bingx.service';
import { runSignal, type SignalOutcome } from '@/lib/ai-pm/signal';
import { runDecision, type DecisionOutcome } from '@/lib/ai-pm/decision';
import { validate, type ValidationResult } from '@/lib/ai-pm/validation';
import { execute, type ExecutionResult } from '@/lib/ai-pm/executor';
import { loadPortfolioState, type PortfolioState } from '@/lib/ai-pm/portfolio-state';
import type { BingxClient } from '@/lib/bingx/client';
import type { ProposedAction } from '@/lib/ai-pm/decision.prompt';

const DEFAULT_REVIEWER_THRESHOLD_PCT = 30;
const DEFAULT_MAX_CAPITAL = 1000;
const DEFAULT_MAX_CONCURRENT = 5;
const DEFAULT_STRATEGIES: Array<'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER'> = [
  'DCA',
  'TRAILING_STOP',
  'DCA_SPOT',
  'SMA_CROSSOVER',
];

export interface RunUserTickParams {
  userId: string;
  anthropicApiKey: string;
  bingxApiKeyId: string;
  paperMode: boolean;
  allowedSymbols: string[];
  maxCapitalUsdt: number;
  maxConcurrentBots: number;
  allowedStrategies: Array<'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER'>;
  reviewerThresholdPct?: number;
  isKillSwitchActive: () => Promise<boolean>;
  loadBingxClient: () => Promise<BingxClient | null>;
  loadPortfolio: () => Promise<PortfolioState>;
  signalFn: typeof runSignal;
  decisionFn: typeof runDecision;
  validateFn: typeof validate;
  executeFn: typeof execute;
  db: typeof db;
  logger: { info: (msg: string, ctx?: unknown) => void; warn: (msg: string, ctx?: unknown) => void; error: (msg: string, ctx?: unknown) => void };
}

export interface UserTickReport {
  userId: string;
  status:
    | 'COMPLETED'
    | 'SKIPPED_KILL_SWITCH'
    | 'SKIPPED_NO_BINGX_CLIENT'
    | 'SIGNAL_FAILED'
    | 'DECISION_FAILED'
    | 'PARTIAL';
  proposedCount: number;
  executedCount: number;
  failedCount: number;
  rejectedCount: number;
}

async function updateDecisionStatus(
  database: typeof db,
  decisionId: string,
  status: 'EXECUTED' | 'EXECUTION_FAILED',
  reason: string | null,
): Promise<void> {
  await database
    .update(aiDecisions)
    .set({
      status,
      rejectionReason: reason,
      executedAt: status === 'EXECUTED' ? new Date() : null,
    })
    .where(eq(aiDecisions.id, decisionId))
    .returning();
}

export async function runUserTick(params: RunUserTickParams): Promise<UserTickReport> {
  const report: UserTickReport = {
    userId: params.userId,
    status: 'COMPLETED',
    proposedCount: 0,
    executedCount: 0,
    failedCount: 0,
    rejectedCount: 0,
  };

  if (await params.isKillSwitchActive()) {
    params.logger.info('kill_switch_at_start', { userId: params.userId });
    return { ...report, status: 'SKIPPED_KILL_SWITCH' };
  }

  const client = await params.loadBingxClient();
  if (!client) {
    params.logger.warn('no_bingx_client', { userId: params.userId });
    return { ...report, status: 'SKIPPED_NO_BINGX_CLIENT' };
  }

  const portfolioState = await params.loadPortfolio();

  const signalOutcome: SignalOutcome = await params.signalFn({
    userId: params.userId,
    allowedSymbols: params.allowedSymbols,
    anthropicApiKey: params.anthropicApiKey,
    bingxClient: client,
    db: params.db,
  });

  if (!signalOutcome.ok) {
    params.logger.warn('signal_failed', { userId: params.userId, kind: signalOutcome.error.kind });
    return { ...report, status: 'SIGNAL_FAILED' };
  }

  if (await params.isKillSwitchActive()) {
    return { ...report, status: 'SKIPPED_KILL_SWITCH' };
  }

  const decisionOutcome: DecisionOutcome = await params.decisionFn({
    userId: params.userId,
    candidates: signalOutcome.result.candidates,
    portfolioState,
    config: {
      mode: 'BALANCED',
      maxCapitalUsdt: params.maxCapitalUsdt,
      maxConcurrentBots: params.maxConcurrentBots,
      allowedStrategies: params.allowedStrategies,
    },
    anthropicApiKey: params.anthropicApiKey,
  });

  if (!decisionOutcome.ok) {
    params.logger.warn('decision_failed', { userId: params.userId, kind: decisionOutcome.error.kind });
    return { ...report, status: 'DECISION_FAILED' };
  }

  const actions: ProposedAction[] = decisionOutcome.result.proposedActions;
  report.proposedCount = actions.length;

  for (const action of actions) {
    if (await params.isKillSwitchActive()) {
      return { ...report, status: 'SKIPPED_KILL_SWITCH' };
    }

    let validation: ValidationResult;
    try {
      validation = await params.validateFn({
        userId: params.userId,
        action,
        config: {
          maxCapitalUsdt: params.maxCapitalUsdt,
          maxConcurrentBots: params.maxConcurrentBots,
          allowedStrategies: params.allowedStrategies,
          killSwitch: false,
          reviewerThresholdPct: params.reviewerThresholdPct ?? DEFAULT_REVIEWER_THRESHOLD_PCT,
        },
        portfolioState,
        anthropicApiKey: params.anthropicApiKey,
        bingxClient: client,
        db: params.db,
      });
    } catch (err) {
      params.logger.error('validate_threw', { userId: params.userId, err: err instanceof Error ? err.message : String(err) });
      report.failedCount += 1;
      continue;
    }

    if (validation.status !== 'PROPOSED') {
      report.rejectedCount += 1;
      continue;
    }

    let execution: ExecutionResult;
    try {
      execution = await params.executeFn({
        userId: params.userId,
        decisionId: validation.decisionId,
        action,
        config: { bingxApiKeyId: params.bingxApiKeyId, paperMode: params.paperMode },
        db: params.db,
      });
    } catch (err) {
      params.logger.error('execute_threw', { userId: params.userId, err: err instanceof Error ? err.message : String(err) });
      report.failedCount += 1;
      await updateDecisionStatus(params.db, validation.decisionId, 'EXECUTION_FAILED', 'execute threw');
      continue;
    }

    if (execution.status === 'EXECUTED') {
      report.executedCount += 1;
      await updateDecisionStatus(params.db, validation.decisionId, 'EXECUTED', null);
    } else {
      report.failedCount += 1;
      await updateDecisionStatus(params.db, validation.decisionId, 'EXECUTION_FAILED', execution.reason ?? null);
    }
  }

  if (report.failedCount > 0 && report.executedCount > 0) {
    report.status = 'PARTIAL';
  } else if (report.failedCount > 0 && report.executedCount === 0 && report.proposedCount > 0) {
    report.status = 'PARTIAL';
  }

  return report;
}

export const aiPmTick = inngest.createFunction(
  {
    id: 'ai-pm-tick',
    name: 'AI Portfolio Manager Tick',
    retries: 0,
    concurrency: { limit: 3 },
  },
  { cron: '*/30 * * * *' },
  async ({ step, logger }) => {
    const configs = await step.run('load-enabled-configs', async () => {
      return listEnabledAiPmConfigs();
    });

    if (configs.length === 0) {
      logger.info('no enabled AI PM configs');
      return { tickAt: Date.now(), users: 0 };
    }

    const reports: UserTickReport[] = [];
    for (const cfg of configs) {
      const report = await step.run(`user-${cfg.userId}`, async () => {
        return runUserTick({
          userId: cfg.userId,
          anthropicApiKey: cfg.anthropicApiKey,
          bingxApiKeyId: cfg.bingxApiKeyId,
          paperMode: cfg.paperMode,
          allowedSymbols: cfg.allowedSymbols ?? [],
          maxCapitalUsdt: Number(cfg.maxCapitalUsdt ?? DEFAULT_MAX_CAPITAL),
          maxConcurrentBots: cfg.maxConcurrentBots ?? DEFAULT_MAX_CONCURRENT,
          allowedStrategies: (cfg.allowedStrategies ?? DEFAULT_STRATEGIES) as Array<'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER'>,
          reviewerThresholdPct: DEFAULT_REVIEWER_THRESHOLD_PCT,
          isKillSwitchActive: async () => {
            const fresh = await getAiPmConfig(cfg.userId);
            return Boolean(fresh?.killSwitch);
          },
          loadBingxClient: async () => getBingxClientByApiKeyId(cfg.bingxApiKeyId),
          loadPortfolio: async () =>
            loadPortfolioState({ userId: cfg.userId, bingxApiKeyId: cfg.bingxApiKeyId, db }),
          signalFn: runSignal,
          decisionFn: runDecision,
          validateFn: validate,
          executeFn: execute,
          db,
          logger: {
            info: (msg, ctx) => logger.info(msg, ctx ?? {}),
            warn: (msg, ctx) => logger.warn(msg, ctx ?? {}),
            error: (msg, ctx) => logger.error(msg, ctx ?? {}),
          },
        });
      });
      reports.push(report);
    }

    return { tickAt: Date.now(), users: configs.length, reports };
  },
);
```

- [ ] **Step 4: Tests pass** (8/8 new).

- [ ] **Step 5: Full suite + lint + build**

- [ ] **Step 6: Commit**

```bash
git add src/inngest/functions/ai-pm-tick.ts src/inngest/functions/__tests__/ai-pm-tick.test.ts
git commit -m "feat(ai-pm): ai-pm-tick cron orchestrator"
```

---

## Task 3: Register cron in BOTH worker.ts AND inngest route

**Files:**
- Modify: `src/worker.ts`
- Modify: `src/app/api/inngest/route.ts`

- [ ] **Step 1:** Add to `src/worker.ts`:

```ts
// Add import:
import { aiPmTick } from '@/inngest/functions/ai-pm-tick';

// Add to functions array (after smaCrossoverWatch):
functions: [
  masterTick,
  tradingBotWatch,
  dcaBotWatch,
  trailingStopWatch,
  dcaSpotBotWatch,
  smaCrossoverWatch,
  aiPmTick,
],
```

- [ ] **Step 2:** Add to `src/app/api/inngest/route.ts`:

```ts
// Add import:
import { aiPmTick } from "@/inngest/functions/ai-pm-tick";

// Add to functions array:
const functions = [
  masterTick,
  tradingBotWatch,
  dcaBotWatch,
  trailingStopWatch,
  dcaSpotBotWatch,
  smaCrossoverWatch,
  aiPmTick,
];
```

- [ ] **Step 3:** Lint + build + commit

```bash
bunx eslint src/worker.ts src/app/api/inngest/route.ts
bun run build
git add src/worker.ts src/app/api/inngest/route.ts
git commit -m "chore(ai-pm): register ai-pm-tick in worker + Inngest route"
```

---

## Self-Review

- **Spec coverage:** Cron `*/30 * * * *`, function visible in Inngest UI, manual trigger produces ai_decisions chain ending in EXECUTED or deterministic rejection, kill switch mid-run aborts.
- **Persistence:** `validate` already writes `ai_decisions` on every call. Execute outcome updates the same row (status → EXECUTED or EXECUTION_FAILED).
- **Concurrency:** Function-level limit=3 in Inngest. Per-user iteration sequential within the function.
- **Out of scope:** Monitor (event-driven), UI.

## Done Criteria

1. `listEnabledAiPmConfigs` exported.
2. `runUserTick`, `aiPmTick`, `RunUserTickParams`, `UserTickReport` exported.
3. 8 tests pass.
4. `aiPmTick` registered in worker.ts + route.ts.
5. Full suite + lint + build clean.
