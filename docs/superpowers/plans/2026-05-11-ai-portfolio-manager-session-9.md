# AI Portfolio Manager — Session 9 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three-stage gate for each `ProposedAction`. (1) Hard guardrails (capital cap, concurrent cap, allowed strategy, kill switch). (2) Backtest (only for `create_bot` / `adjust_params`). (3) Opus reviewer if cumulative-capital threshold > 30% or first-time symbol. Persist `ai_decisions` row with final status.

**Architecture:** Pure dispatch over S8 actions. No execution. Decision row written on every outcome (PROPOSED, REJECTED_GUARDRAIL, REJECTED_BACKTEST, REJECTED_REVIEWER). Skip backtest + reviewer for non-create actions where they don't apply.

**Tech Stack:** TypeScript · Drizzle · Zod · Vitest · S5 backtest · S6 LLM router (`callOpus`) · S8 action types

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/lib/ai-pm/guardrails.ts` | Create | Pure synchronous gate: capital cap, concurrent cap, strategy allowlist, kill switch. No IO. |
| `src/lib/ai-pm/reviewer.ts` | Create | Opus wrapper. `reviewWithOpus({...})` returns `{approve, rationale, usage}` via S6 `callOpus`. |
| `src/lib/ai-pm/validation.ts` | Create | Orchestrator: guardrails → backtest → reviewer → persist. Public `validate(params)`. |
| `src/lib/ai-pm/__tests__/guardrails.test.ts` | Create | 4 cases per rejection branch + happy. |
| `src/lib/ai-pm/__tests__/reviewer.test.ts` | Create | Approve / veto / schema rejection / API error. |
| `src/lib/ai-pm/__tests__/validation.test.ts` | Create | End-to-end orchestration with all stub paths. |

---

## Public Surface

```ts
// guardrails.ts
export interface GuardrailConfig {
  maxCapitalUsdt: number;
  maxConcurrentBots: number;
  allowedStrategies: Array<'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER'>;
  killSwitch: boolean;
}

export type GuardrailResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'KILL_SWITCH'
        | 'CAPITAL_CAP'
        | 'CONCURRENT_CAP'
        | 'STRATEGY_NOT_ALLOWED'
        | 'UNKNOWN_BOT_ID';
      message: string;
    };

export function runGuardrails(input: {
  action: ProposedAction;
  config: GuardrailConfig;
  portfolioState: PortfolioState;
}): GuardrailResult;
```

```ts
// reviewer.ts
import { z } from 'zod';

export const ReviewerSchema = z.object({
  approve: z.boolean(),
  rationale: z.string().min(1).max(1000),
});
export type ReviewerVerdict = z.infer<typeof ReviewerSchema>;

export interface BacktestSummary {
  pnlPct: number;
  maxDrawdownPct: number;
  sharpeApprox: number;
  winRatePct: number;
  totalTrades: number;
}

export interface ReviewWithOpusParams {
  action: ProposedAction;
  backtestSummary: BacktestSummary | null;
  reasoning: string;
  anthropicApiKey: string;
  factory?: AnthropicFactory;
}

export type ReviewerError =
  | { kind: 'LLM_ERROR'; cause: LlmError }
  | { kind: 'SCHEMA_REJECTED'; issues: unknown };

export type ReviewerOutcome =
  | { ok: true; verdict: ReviewerVerdict; usage: LlmUsage }
  | { ok: false; error: ReviewerError };

export function reviewWithOpus(params: ReviewWithOpusParams): Promise<ReviewerOutcome>;
```

```ts
// validation.ts
export type ValidationStatus =
  | 'PROPOSED'
  | 'REJECTED_GUARDRAIL'
  | 'REJECTED_BACKTEST'
  | 'REJECTED_REVIEWER';

export interface ValidationResult {
  status: ValidationStatus;
  decisionId: string;          // ai_decisions.id
  reason?: string;
  backtestRunId?: string;
  reviewerUsage?: LlmUsage;
}

export interface ValidateParams {
  userId: string;
  action: ProposedAction;
  config: GuardrailConfig & {
    reviewerThresholdPct: number;   // default 30
  };
  portfolioState: PortfolioState;
  signalCandidate?: SignalCandidate;  // for ai_decisions.signal_snapshot
  anthropicApiKey: string;
  bingxClient?: BingxClient;          // required when backtest needed
  db: typeof import('@/db').db;
  runBacktestFn?: typeof import('@/lib/backtest').runBacktest;
  reviewerFn?: typeof reviewWithOpus;
  factory?: AnthropicFactory;
  triggeredBy?: AiTriggerSource;      // default 'CRON_TICK'
}

export function validate(params: ValidateParams): Promise<ValidationResult>;
```

**Key contracts:**

1. **Backtest scope.** Run only for `create_bot` and `adjust_params`. Other actions skip directly to reviewer-or-persist.
2. **Reviewer trigger.** Run Opus when EITHER (a) `create_bot` + symbol not in `portfolioState.runningBots` (first-time), OR (b) `create_bot` and `(capitalUsedUsdt + action.capitalUsdt) / config.maxCapitalUsdt > 0.30`. Other action types: no reviewer.
3. **Persistence is unconditional.** Every call writes one `ai_decisions` row. Status field captures outcome. Stop-loss for audit trail.
4. **Strategy filter via config.allowedStrategies** + mnemo rule (4 non-grid). No grid types ever pass guardrails (enforced via `allowedStrategies` not including them; not re-checked in S9).
5. **Trust boundaries.** `stop_bot.botId` / `adjust_params.botId` / `reallocate_capital.{from,to}BotId` must reference a running bot in `portfolioState`; else `UNKNOWN_BOT_ID`. `no_action` passes guardrails immediately.

---

## Task 1: Guardrails + tests (pure)

**Files:**
- Create: `src/lib/ai-pm/guardrails.ts`
- Create: `src/lib/ai-pm/__tests__/guardrails.test.ts`

- [ ] **Test file**

```ts
import { describe, it, expect } from 'vitest';
import { runGuardrails, type GuardrailConfig } from '@/lib/ai-pm/guardrails';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';
import type { ProposedAction } from '@/lib/ai-pm/decision.prompt';

const botId = '00000000-0000-0000-0000-0000000000b0';

const baseState: PortfolioState = {
  runningBots: [{ id: botId, symbol: 'BTC-USDT', strategy: 'DCA', capitalUsdt: 100, leverage: 3, status: 'RUNNING' }],
  capitalUsedUsdt: 100,
  bingxApiKeyId: '00000000-0000-0000-0000-0000000000a0',
};

const baseConfig: GuardrailConfig = {
  maxCapitalUsdt: 1000,
  maxConcurrentBots: 5,
  allowedStrategies: ['DCA', 'TRAILING_STOP', 'DCA_SPOT', 'SMA_CROSSOVER'],
  killSwitch: false,
};

describe('runGuardrails', () => {
  it('passes a valid create_bot', () => {
    const action: ProposedAction = {
      type: 'create_bot',
      symbol: 'ETH-USDT',
      strategy: 'DCA',
      capitalUsdt: 50,
      leverage: 5,
      reasoning: 'r',
    };
    expect(runGuardrails({ action, config: baseConfig, portfolioState: baseState })).toEqual({ ok: true });
  });

  it('rejects when kill switch on', () => {
    const result = runGuardrails({
      action: { type: 'no_action', reasoning: 'idle' },
      config: { ...baseConfig, killSwitch: true },
      portfolioState: baseState,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fail');
    expect(result.reason).toBe('KILL_SWITCH');
  });

  it('rejects create_bot exceeding capital cap', () => {
    const result = runGuardrails({
      action: { type: 'create_bot', symbol: 'ETH-USDT', strategy: 'DCA', capitalUsdt: 950, leverage: 5, reasoning: 'r' },
      config: baseConfig,
      portfolioState: baseState,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fail');
    expect(result.reason).toBe('CAPITAL_CAP');
  });

  it('rejects create_bot exceeding concurrent cap', () => {
    const filledState: PortfolioState = {
      runningBots: Array.from({ length: 5 }, (_, i) => ({
        id: `00000000-0000-0000-0000-0000000000b${i}`,
        symbol: `SYM${i}-USDT`,
        strategy: 'DCA',
        capitalUsdt: 50,
        leverage: 1,
        status: 'RUNNING',
      })),
      capitalUsedUsdt: 250,
      bingxApiKeyId: baseState.bingxApiKeyId,
    };
    const result = runGuardrails({
      action: { type: 'create_bot', symbol: 'ETH-USDT', strategy: 'DCA', capitalUsdt: 50, leverage: 1, reasoning: 'r' },
      config: baseConfig,
      portfolioState: filledState,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fail');
    expect(result.reason).toBe('CONCURRENT_CAP');
  });

  it('rejects create_bot with strategy not in allowed list', () => {
    const result = runGuardrails({
      action: { type: 'create_bot', symbol: 'ETH-USDT', strategy: 'TRAILING_STOP', capitalUsdt: 50, leverage: 1, reasoning: 'r' },
      config: { ...baseConfig, allowedStrategies: ['DCA'] },
      portfolioState: baseState,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fail');
    expect(result.reason).toBe('STRATEGY_NOT_ALLOWED');
  });

  it('rejects stop_bot with unknown botId', () => {
    const result = runGuardrails({
      action: { type: 'stop_bot', botId: '00000000-0000-0000-0000-0000000000ff', reasoning: 'r' },
      config: baseConfig,
      portfolioState: baseState,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fail');
    expect(result.reason).toBe('UNKNOWN_BOT_ID');
  });

  it('passes no_action even when capital is at cap', () => {
    const fullState: PortfolioState = { ...baseState, capitalUsedUsdt: 1000 };
    expect(
      runGuardrails({
        action: { type: 'no_action', reasoning: 'r' },
        config: baseConfig,
        portfolioState: fullState,
      }),
    ).toEqual({ ok: true });
  });
});
```

- [ ] **Impl**

```ts
import type { ProposedAction } from '@/lib/ai-pm/decision.prompt';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';

export interface GuardrailConfig {
  maxCapitalUsdt: number;
  maxConcurrentBots: number;
  allowedStrategies: Array<'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER'>;
  killSwitch: boolean;
}

export type GuardrailReason =
  | 'KILL_SWITCH'
  | 'CAPITAL_CAP'
  | 'CONCURRENT_CAP'
  | 'STRATEGY_NOT_ALLOWED'
  | 'UNKNOWN_BOT_ID';

export type GuardrailResult =
  | { ok: true }
  | { ok: false; reason: GuardrailReason; message: string };

export function runGuardrails(input: {
  action: ProposedAction;
  config: GuardrailConfig;
  portfolioState: PortfolioState;
}): GuardrailResult {
  const { action, config, portfolioState } = input;

  if (config.killSwitch) {
    return { ok: false, reason: 'KILL_SWITCH', message: 'Kill switch is engaged' };
  }

  const runningBotIds = new Set(portfolioState.runningBots.map((b) => b.id));

  switch (action.type) {
    case 'no_action':
      return { ok: true };

    case 'create_bot': {
      if (!config.allowedStrategies.includes(action.strategy)) {
        return {
          ok: false,
          reason: 'STRATEGY_NOT_ALLOWED',
          message: `Strategy ${action.strategy} not in allowedStrategies`,
        };
      }
      if (portfolioState.runningBots.length >= config.maxConcurrentBots) {
        return {
          ok: false,
          reason: 'CONCURRENT_CAP',
          message: `Active bots (${portfolioState.runningBots.length}) at cap (${config.maxConcurrentBots})`,
        };
      }
      if (portfolioState.capitalUsedUsdt + action.capitalUsdt > config.maxCapitalUsdt) {
        return {
          ok: false,
          reason: 'CAPITAL_CAP',
          message: `Capital used + new ${action.capitalUsdt} exceeds cap ${config.maxCapitalUsdt}`,
        };
      }
      return { ok: true };
    }

    case 'stop_bot':
      if (!runningBotIds.has(action.botId)) {
        return { ok: false, reason: 'UNKNOWN_BOT_ID', message: `Bot ${action.botId} not running` };
      }
      return { ok: true };

    case 'adjust_params':
      if (!runningBotIds.has(action.botId)) {
        return { ok: false, reason: 'UNKNOWN_BOT_ID', message: `Bot ${action.botId} not running` };
      }
      return { ok: true };

    case 'reallocate_capital':
      if (!runningBotIds.has(action.fromBotId) || !runningBotIds.has(action.toBotId)) {
        return { ok: false, reason: 'UNKNOWN_BOT_ID', message: `Bot id(s) not running` };
      }
      return { ok: true };
  }
}
```

- [ ] **Lint + commit**

```bash
bunx vitest run src/lib/ai-pm/__tests__/guardrails.test.ts
bunx eslint src/lib/ai-pm/guardrails.ts src/lib/ai-pm/__tests__/guardrails.test.ts
git add src/lib/ai-pm/guardrails.ts src/lib/ai-pm/__tests__/guardrails.test.ts
git commit -m "feat(ai-pm): guardrails gate (pure synchronous)"
```

---

## Task 2: Reviewer + tests

**Files:**
- Create: `src/lib/ai-pm/reviewer.ts`
- Create: `src/lib/ai-pm/__tests__/reviewer.test.ts`

- [ ] **Test file**

```ts
import { describe, it, expect } from 'vitest';
import { reviewWithOpus, type BacktestSummary } from '@/lib/ai-pm/reviewer';
import type { AnthropicFactory } from '@/lib/ai-pm/llm';
import type { ProposedAction } from '@/lib/ai-pm/decision.prompt';

function fakeFactory(opts: { responseText?: string; shouldThrow?: Error }): AnthropicFactory {
  return () => ({
    messages: {
      create: async () => {
        if (opts.shouldThrow) throw opts.shouldThrow;
        return {
          id: 'msg_1',
          model: 'claude-opus-4-7',
          role: 'assistant',
          content: [{ type: 'text', text: opts.responseText ?? '{}' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          type: 'message',
          usage: { input_tokens: 1200, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        };
      },
    },
  });
}

const action: ProposedAction = {
  type: 'create_bot',
  symbol: 'BTC-USDT',
  strategy: 'DCA',
  capitalUsdt: 500,
  leverage: 5,
  reasoning: 'strong setup',
};

const summary: BacktestSummary = {
  pnlPct: 4.5,
  maxDrawdownPct: 8.0,
  sharpeApprox: 1.2,
  winRatePct: 62,
  totalTrades: 25,
};

describe('reviewWithOpus', () => {
  it('parses approval verdict', async () => {
    const result = await reviewWithOpus({
      action,
      backtestSummary: summary,
      reasoning: 'historical backtest positive, accept',
      anthropicApiKey: 'sk-ant',
      factory: fakeFactory({ responseText: '{"approve":true,"rationale":"reasonable risk-reward"}' }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.verdict.approve).toBe(true);
    expect(result.usage.inputTokens).toBe(1200);
  });

  it('parses veto verdict', async () => {
    const result = await reviewWithOpus({
      action,
      backtestSummary: { ...summary, pnlPct: -3.2 },
      reasoning: 'reanalysis',
      anthropicApiKey: 'sk-ant',
      factory: fakeFactory({ responseText: '{"approve":false,"rationale":"drawdown too steep"}' }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.verdict.approve).toBe(false);
    expect(result.verdict.rationale).toMatch(/drawdown/);
  });

  it('returns SCHEMA_REJECTED on malformed JSON shape', async () => {
    const result = await reviewWithOpus({
      action,
      backtestSummary: summary,
      reasoning: 'r',
      anthropicApiKey: 'sk-ant',
      factory: fakeFactory({ responseText: '{"approve":"maybe"}' }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.kind).toBe('SCHEMA_REJECTED');
  });

  it('returns LLM_ERROR on SDK throw', async () => {
    const result = await reviewWithOpus({
      action,
      backtestSummary: summary,
      reasoning: 'r',
      anthropicApiKey: 'sk-ant',
      factory: fakeFactory({ shouldThrow: new Error('500') }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.kind).toBe('LLM_ERROR');
  });

  it('accepts null backtestSummary (action types without backtest)', async () => {
    const stopAction: ProposedAction = { type: 'stop_bot', botId: '00000000-0000-0000-0000-0000000000b1', reasoning: 'risk' };
    const result = await reviewWithOpus({
      action: stopAction,
      backtestSummary: null,
      reasoning: 'r',
      anthropicApiKey: 'sk-ant',
      factory: fakeFactory({ responseText: '{"approve":true,"rationale":"safe stop"}' }),
    });
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Impl**

```ts
import { z } from 'zod';
import { callOpus, type AnthropicFactory, type LlmError, type LlmUsage } from '@/lib/ai-pm/llm';
import type { ProposedAction } from '@/lib/ai-pm/decision.prompt';

export const ReviewerSchema = z.object({
  approve: z.boolean(),
  rationale: z.string().min(1).max(1000),
});

export type ReviewerVerdict = z.infer<typeof ReviewerSchema>;

export interface BacktestSummary {
  pnlPct: number;
  maxDrawdownPct: number;
  sharpeApprox: number;
  winRatePct: number;
  totalTrades: number;
}

export interface ReviewWithOpusParams {
  action: ProposedAction;
  backtestSummary: BacktestSummary | null;
  reasoning: string;
  anthropicApiKey: string;
  factory?: AnthropicFactory;
}

export type ReviewerError =
  | { kind: 'LLM_ERROR'; cause: LlmError }
  | { kind: 'SCHEMA_REJECTED'; issues: unknown };

export type ReviewerOutcome =
  | { ok: true; verdict: ReviewerVerdict; usage: LlmUsage }
  | { ok: false; error: ReviewerError };

function buildSystemPrompt(): string {
  return [
    'You are a senior risk reviewer for a crypto trading portfolio.',
    'Given a proposed action, its rationale, and (when applicable) a backtest summary,',
    'decide whether to approve or veto.',
    '',
    'Approve only if the action has acceptable risk-reward given the data.',
    'Return JSON only: {"approve":boolean,"rationale":"one sentence"}.',
  ].join('\n');
}

function buildUserPrompt(params: ReviewWithOpusParams): string {
  const summaryLine = params.backtestSummary
    ? `Backtest: pnl=${params.backtestSummary.pnlPct.toFixed(2)}% dd=${params.backtestSummary.maxDrawdownPct.toFixed(2)}% sharpe=${params.backtestSummary.sharpeApprox.toFixed(2)} winRate=${params.backtestSummary.winRatePct.toFixed(2)}% trades=${params.backtestSummary.totalTrades}`
    : 'Backtest: (not applicable)';
  return [
    `Action: ${JSON.stringify(params.action)}`,
    `Original reasoning: ${params.reasoning}`,
    summaryLine,
    '',
    'Return verdict as JSON.',
  ].join('\n');
}

export async function reviewWithOpus(params: ReviewWithOpusParams): Promise<ReviewerOutcome> {
  const llm = await callOpus({
    apiKey: params.anthropicApiKey,
    systemPrompt: buildSystemPrompt(),
    userPrompt: buildUserPrompt(params),
    schema: ReviewerSchema,
    factory: params.factory,
  });

  if (!llm.ok) {
    if (llm.error.kind === 'SCHEMA_REJECTED') {
      return { ok: false, error: { kind: 'SCHEMA_REJECTED', issues: llm.error.issues } };
    }
    return { ok: false, error: { kind: 'LLM_ERROR', cause: llm.error } };
  }

  return { ok: true, verdict: llm.data, usage: llm.usage };
}
```

- [ ] **Lint + commit**

```bash
bunx vitest run src/lib/ai-pm/__tests__/reviewer.test.ts
bunx eslint src/lib/ai-pm/reviewer.ts src/lib/ai-pm/__tests__/reviewer.test.ts
git add src/lib/ai-pm/reviewer.ts src/lib/ai-pm/__tests__/reviewer.test.ts
git commit -m "feat(ai-pm): Opus reviewer wrapper with verdict schema"
```

---

## Task 3: Validation orchestrator + tests

**Files:**
- Create: `src/lib/ai-pm/validation.ts`
- Create: `src/lib/ai-pm/__tests__/validation.test.ts`

- [ ] **Test file**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { validate } from '@/lib/ai-pm/validation';
import type { ProposedAction } from '@/lib/ai-pm/decision.prompt';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';
import type { AnthropicFactory } from '@/lib/ai-pm/llm';
import type { BacktestResult } from '@/lib/backtest/types';

interface InsertedRow {
  id: string;
  userId: string;
  actionType: string;
  status: string;
  symbol: string | null;
  strategy: string | null;
  rejectionReason: string | null;
  backtestRunId: string | null;
}

interface DbState {
  rows: InsertedRow[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeDb(state: DbState): any {
  return {
    insert: () => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      values: (rows: any[]) => ({
        returning: async () => {
          const out = rows.map((r, i) => ({ ...r, id: `dec-${state.rows.length + i}` }));
          state.rows.push(...out);
          return out;
        },
      }),
    }),
  };
}

const userId = '00000000-0000-0000-0000-000000000001';
const botId = '00000000-0000-0000-0000-0000000000b0';

const baseState: PortfolioState = {
  runningBots: [{ id: botId, symbol: 'BTC-USDT', strategy: 'DCA', capitalUsdt: 100, leverage: 3, status: 'RUNNING' }],
  capitalUsedUsdt: 100,
  bingxApiKeyId: '00000000-0000-0000-0000-0000000000a0',
};

const baseConfig = {
  maxCapitalUsdt: 1000,
  maxConcurrentBots: 5,
  allowedStrategies: ['DCA', 'TRAILING_STOP', 'DCA_SPOT', 'SMA_CROSSOVER'] as const,
  killSwitch: false,
  reviewerThresholdPct: 30,
};

const fakeBingxClient = { __fake: true };

function backtestFn(result: Partial<BacktestResult>) {
  return async (): Promise<BacktestResult> => ({
    cached: false,
    pnlPct: 5,
    maxDrawdownPct: 8,
    sharpeApprox: 1.1,
    winRatePct: 60,
    totalTrades: 25,
    paramsHash: 'h1',
    runId: 'bt-1',
    ...result,
  });
}

function reviewerFn(verdict: { approve: boolean; rationale: string }) {
  return async () => ({ ok: true as const, verdict, usage: { inputTokens: 1200, outputTokens: 200, cachedInputTokens: 0, costUsd: 0.025, model: 'claude-opus-4-7' as const } });
}

function vetoReviewer() {
  return reviewerFn({ approve: false, rationale: 'too risky' });
}

const fakeFactory: AnthropicFactory = () => ({ messages: { create: async () => { throw new Error('should not be called when reviewerFn injected'); } } });

const noAction: ProposedAction = { type: 'no_action', reasoning: 'idle' };
const createSmall: ProposedAction = { type: 'create_bot', symbol: 'ETH-USDT', strategy: 'DCA', capitalUsdt: 50, leverage: 3, reasoning: 'r' };
const createLarge: ProposedAction = { type: 'create_bot', symbol: 'ETH-USDT', strategy: 'DCA', capitalUsdt: 400, leverage: 3, reasoning: 'r' };
const createOverCap: ProposedAction = { type: 'create_bot', symbol: 'ETH-USDT', strategy: 'DCA', capitalUsdt: 950, leverage: 3, reasoning: 'r' };

describe('validate', () => {
  let dbState: DbState;
  beforeEach(() => {
    dbState = { rows: [] };
  });

  it('persists PROPOSED row for no_action without backtest or reviewer', async () => {
    const res = await validate({
      userId, action: noAction, config: baseConfig, portfolioState: baseState,
      anthropicApiKey: 'sk', db: fakeDb(dbState), factory: fakeFactory,
    });
    expect(res.status).toBe('PROPOSED');
    expect(dbState.rows).toHaveLength(1);
    expect(dbState.rows[0].status).toBe('PROPOSED');
    expect(dbState.rows[0].actionType).toBe('NO_ACTION');
  });

  it('persists REJECTED_GUARDRAIL for over-cap create_bot', async () => {
    const res = await validate({
      userId, action: createOverCap, config: baseConfig, portfolioState: baseState,
      anthropicApiKey: 'sk', db: fakeDb(dbState), factory: fakeFactory,
    });
    expect(res.status).toBe('REJECTED_GUARDRAIL');
    expect(res.reason).toMatch(/Capital/);
    expect(dbState.rows[0].status).toBe('REJECTED_GUARDRAIL');
    expect(dbState.rows[0].rejectionReason).toMatch(/Capital/);
  });

  it('runs backtest for small create_bot below threshold; PROPOSED on positive PnL; no reviewer', async () => {
    const res = await validate({
      userId, action: createSmall, config: baseConfig, portfolioState: baseState,
      anthropicApiKey: 'sk', bingxClient: fakeBingxClient as never,
      db: fakeDb(dbState),
      runBacktestFn: backtestFn({ pnlPct: 7 }),
      reviewerFn: vetoReviewer(),  // should NOT be invoked
      factory: fakeFactory,
    });
    expect(res.status).toBe('PROPOSED');
    expect(res.backtestRunId).toBe('bt-1');
    expect(res.reviewerUsage).toBeUndefined();
    expect(dbState.rows[0].backtestRunId).toBe('bt-1');
  });

  it('persists REJECTED_BACKTEST when pnl is negative', async () => {
    const res = await validate({
      userId, action: createSmall, config: baseConfig, portfolioState: baseState,
      anthropicApiKey: 'sk', bingxClient: fakeBingxClient as never,
      db: fakeDb(dbState),
      runBacktestFn: backtestFn({ pnlPct: -2 }),
      reviewerFn: vetoReviewer(),
      factory: fakeFactory,
    });
    expect(res.status).toBe('REJECTED_BACKTEST');
    expect(dbState.rows[0].status).toBe('REJECTED_BACKTEST');
    expect(dbState.rows[0].backtestRunId).toBe('bt-1');
  });

  it('invokes reviewer when create_bot pushes capital above 30% threshold; veto → REJECTED_REVIEWER', async () => {
    const res = await validate({
      userId, action: createLarge, config: baseConfig, portfolioState: baseState,
      anthropicApiKey: 'sk', bingxClient: fakeBingxClient as never,
      db: fakeDb(dbState),
      runBacktestFn: backtestFn({ pnlPct: 5 }),
      reviewerFn: vetoReviewer(),
      factory: fakeFactory,
    });
    expect(res.status).toBe('REJECTED_REVIEWER');
    expect(res.reviewerUsage).toBeDefined();
    expect(dbState.rows[0].status).toBe('REJECTED_REVIEWER');
  });

  it('invokes reviewer for first-time symbol even below capital threshold; approve → PROPOSED', async () => {
    const stateNoEth: PortfolioState = { ...baseState };  // no ETH bot
    const res = await validate({
      userId, action: createSmall, config: baseConfig, portfolioState: stateNoEth,
      anthropicApiKey: 'sk', bingxClient: fakeBingxClient as never,
      db: fakeDb(dbState),
      runBacktestFn: backtestFn({ pnlPct: 5 }),
      reviewerFn: reviewerFn({ approve: true, rationale: 'first-time but solid' }),
      factory: fakeFactory,
    });
    expect(res.status).toBe('PROPOSED');
    expect(res.reviewerUsage).toBeDefined();
  });

  it('skips backtest+reviewer for stop_bot; persists PROPOSED', async () => {
    const stopAction: ProposedAction = { type: 'stop_bot', botId, reasoning: 'risk' };
    const res = await validate({
      userId, action: stopAction, config: baseConfig, portfolioState: baseState,
      anthropicApiKey: 'sk', db: fakeDb(dbState), factory: fakeFactory,
    });
    expect(res.status).toBe('PROPOSED');
    expect(res.backtestRunId).toBeUndefined();
    expect(res.reviewerUsage).toBeUndefined();
  });
});
```

- [ ] **Impl**

```ts
import { aiDecisions } from '@/db/schema';
import type { db as Db } from '@/db';
import type { ProposedAction } from '@/lib/ai-pm/decision.prompt';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';
import type { SignalCandidate } from '@/lib/ai-pm/signal';
import { runGuardrails, type GuardrailConfig } from '@/lib/ai-pm/guardrails';
import { reviewWithOpus } from '@/lib/ai-pm/reviewer';
import type { AnthropicFactory, LlmUsage } from '@/lib/ai-pm/llm';
import type { BingxClient } from '@/lib/bingx/client';
import { runBacktest } from '@/lib/backtest';
import type { BacktestResult } from '@/lib/backtest/types';

export type ValidationStatus =
  | 'PROPOSED'
  | 'REJECTED_GUARDRAIL'
  | 'REJECTED_BACKTEST'
  | 'REJECTED_REVIEWER';

export interface ValidationResult {
  status: ValidationStatus;
  decisionId: string;
  reason?: string;
  backtestRunId?: string;
  reviewerUsage?: LlmUsage;
}

export interface ValidateParams {
  userId: string;
  action: ProposedAction;
  config: GuardrailConfig & { reviewerThresholdPct: number };
  portfolioState: PortfolioState;
  signalCandidate?: SignalCandidate;
  anthropicApiKey: string;
  bingxClient?: BingxClient;
  db: typeof Db;
  runBacktestFn?: typeof runBacktest;
  reviewerFn?: typeof reviewWithOpus;
  factory?: AnthropicFactory;
  triggeredBy?: 'CRON_TICK' | 'EVENT_DRAWDOWN' | 'EVENT_FUNDING_FLIP' | 'EVENT_FILL' | 'EVENT_ERROR' | 'CHAT';
}

const ACTION_TYPE_MAP: Record<ProposedAction['type'], 'CREATE_BOT' | 'STOP_BOT' | 'ADJUST_PARAMS' | 'REALLOCATE_CAPITAL' | 'NO_ACTION'> = {
  create_bot: 'CREATE_BOT',
  stop_bot: 'STOP_BOT',
  adjust_params: 'ADJUST_PARAMS',
  reallocate_capital: 'REALLOCATE_CAPITAL',
  no_action: 'NO_ACTION',
};

function actionSymbol(action: ProposedAction): string | null {
  return action.type === 'create_bot' ? action.symbol : null;
}

function actionStrategy(action: ProposedAction): ProposedAction extends { strategy: infer S } ? S : string | null {
  return (action.type === 'create_bot' ? action.strategy : null) as never;
}

function needsBacktest(action: ProposedAction): boolean {
  return action.type === 'create_bot' || action.type === 'adjust_params';
}

function needsReviewer(action: ProposedAction, portfolio: PortfolioState, thresholdPct: number, maxCapital: number): boolean {
  if (action.type !== 'create_bot') return false;
  const firstTime = !portfolio.runningBots.some((b) => b.symbol === action.symbol);
  const ratio = ((portfolio.capitalUsedUsdt + action.capitalUsdt) / maxCapital) * 100;
  return firstTime || ratio > thresholdPct;
}

async function persistDecision(
  params: ValidateParams,
  status: ValidationStatus,
  reason?: string,
  backtestRunId?: string,
  reviewerUsage?: LlmUsage,
): Promise<string> {
  const action = params.action;
  const inserted = await params.db
    .insert(aiDecisions)
    .values([{
      userId: params.userId,
      triggeredBy: params.triggeredBy ?? 'CRON_TICK',
      actionType: ACTION_TYPE_MAP[action.type],
      status,
      symbol: actionSymbol(action),
      strategy: action.type === 'create_bot' ? action.strategy : null,
      params: action,
      reasoning: 'reasoning' in action ? action.reasoning : null,
      signalSnapshot: params.signalCandidate ?? null,
      backtestRunId: backtestRunId ?? null,
      rejectionReason: reason ?? null,
      modelUsed: reviewerUsage ? reviewerUsage.model : null,
      tokensInput: reviewerUsage ? reviewerUsage.inputTokens : null,
      tokensOutput: reviewerUsage ? reviewerUsage.outputTokens : null,
      costUsd: reviewerUsage ? String(reviewerUsage.costUsd) : null,
    }])
    .returning();
  return inserted[0].id;
}

export async function validate(params: ValidateParams): Promise<ValidationResult> {
  const gate = runGuardrails({
    action: params.action,
    config: params.config,
    portfolioState: params.portfolioState,
  });

  if (!gate.ok) {
    const decisionId = await persistDecision(params, 'REJECTED_GUARDRAIL', gate.message);
    return { status: 'REJECTED_GUARDRAIL', decisionId, reason: gate.message };
  }

  let backtestRunId: string | undefined;
  let backtestSummary: BacktestResult | null = null;

  if (needsBacktest(params.action) && params.action.type === 'create_bot') {
    if (!params.bingxClient) {
      const decisionId = await persistDecision(params, 'REJECTED_GUARDRAIL', 'BingxClient required for backtest');
      return { status: 'REJECTED_GUARDRAIL', decisionId, reason: 'BingxClient required for backtest' };
    }
    const fn = params.runBacktestFn ?? runBacktest;
    backtestSummary = await fn({
      client: params.bingxClient,
      symbol: params.action.symbol,
      strategy: params.action.strategy,
      params: { initialCapitalUsdt: params.action.capitalUsdt } as never,
      initialCapitalUsdt: params.action.capitalUsdt,
    });
    backtestRunId = backtestSummary.runId;

    if (backtestSummary.pnlPct < 0) {
      const decisionId = await persistDecision(
        params,
        'REJECTED_BACKTEST',
        `Backtest pnl ${backtestSummary.pnlPct.toFixed(2)}% < 0`,
        backtestRunId,
      );
      return { status: 'REJECTED_BACKTEST', decisionId, reason: 'Backtest negative P&L', backtestRunId };
    }
  }

  if (
    needsReviewer(
      params.action,
      params.portfolioState,
      params.config.reviewerThresholdPct,
      params.config.maxCapitalUsdt,
    )
  ) {
    const reviewer = params.reviewerFn ?? reviewWithOpus;
    const review = await reviewer({
      action: params.action,
      backtestSummary: backtestSummary
        ? {
            pnlPct: backtestSummary.pnlPct,
            maxDrawdownPct: backtestSummary.maxDrawdownPct,
            sharpeApprox: backtestSummary.sharpeApprox,
            winRatePct: backtestSummary.winRatePct,
            totalTrades: backtestSummary.totalTrades,
          }
        : null,
      reasoning: 'reasoning' in params.action ? params.action.reasoning : '',
      anthropicApiKey: params.anthropicApiKey,
      factory: params.factory,
    });

    if (!review.ok) {
      const decisionId = await persistDecision(
        params,
        'REJECTED_REVIEWER',
        `Reviewer error: ${review.error.kind}`,
        backtestRunId,
      );
      return { status: 'REJECTED_REVIEWER', decisionId, reason: `Reviewer error: ${review.error.kind}`, backtestRunId };
    }

    if (!review.verdict.approve) {
      const decisionId = await persistDecision(
        params,
        'REJECTED_REVIEWER',
        review.verdict.rationale,
        backtestRunId,
        review.usage,
      );
      return {
        status: 'REJECTED_REVIEWER',
        decisionId,
        reason: review.verdict.rationale,
        backtestRunId,
        reviewerUsage: review.usage,
      };
    }

    const decisionId = await persistDecision(params, 'PROPOSED', undefined, backtestRunId, review.usage);
    return { status: 'PROPOSED', decisionId, backtestRunId, reviewerUsage: review.usage };
  }

  const decisionId = await persistDecision(params, 'PROPOSED', undefined, backtestRunId);
  return { status: 'PROPOSED', decisionId, backtestRunId };
}
```

- [ ] **Tests + full suite + lint + build + commit**

```bash
bunx vitest run src/lib/ai-pm/__tests__/validation.test.ts
bunx vitest run
bunx eslint src/lib/ai-pm/validation.ts src/lib/ai-pm/__tests__/validation.test.ts
bun run build
git add src/lib/ai-pm/validation.ts src/lib/ai-pm/__tests__/validation.test.ts
git commit -m "feat(ai-pm): three-stage validation gate with ai_decisions persistence"
```

---

## Self-Review

- **Spec coverage:** `validate(...)` widens spec signature to inject deps (db, apiKey, factory, fns) — matches S7/S8 pattern. Three-stage gate implemented: guardrails → backtest → reviewer. Each rejection persists row to ai_decisions.
- **Reviewer trigger:** First-time symbol OR cumulative capital > 30% (threshold configurable).
- **Backtest scope:** Only `create_bot` and `adjust_params` (per spec out-of-scope notes; adjust_params has same risk profile). My impl runs only on `create_bot` — adjust_params skipped to avoid double-backtesting bot configs without clear param mapping. **Note this in PR description.**
- **Persistence: every call writes a row.** No silent rejections.

## Done Criteria

1. `runGuardrails`, `GuardrailConfig`, `GuardrailResult`, `GuardrailReason` exported from `guardrails.ts`.
2. `reviewWithOpus`, `ReviewerSchema`, `ReviewerVerdict`, `BacktestSummary`, `ReviewerOutcome`, `ReviewerError` exported from `reviewer.ts`.
3. `validate`, `ValidationResult`, `ValidationStatus`, `ValidateParams` exported from `validation.ts`.
4. 7 guardrails + 5 reviewer + 7 validation tests = 19 new tests. Full suite passes (163 + 19 = 182).
5. Lint + build clean.
