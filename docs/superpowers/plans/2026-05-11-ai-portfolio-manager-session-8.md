# AI Portfolio Manager — Session 8 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decision layer. Given signal candidates + portfolio state + config, call Sonnet (tool use), validate per-action, return typed `ProposedAction[]`. Caller (S9 Validation) gates each action.

**Architecture:** Pure orchestration. No DB writes beyond optional persistence of raw decision rows (deferred to S11 cron). Decision returns plain data. Atomic per-action Zod validation: malformed actions are skipped, not aborting siblings. Sonnet cached system block (S6 already defaults this).

**Tech Stack:** TypeScript · Drizzle (read-only) · Zod · Vitest · S6 router (`callSonnet`) · S7 signal types

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/lib/ai-pm/portfolio-state.ts` | Create | `loadPortfolioState({ userId, bingxApiKeyId, db })` → running-AI-bot snapshot + capital used. Read-only Drizzle query. |
| `src/lib/ai-pm/decision.prompt.ts` | Create | Per-action Zod schemas (discriminated by `type`), composite `ProposeActionsSchema`, system + user prompt builders. |
| `src/lib/ai-pm/decision.ts` | Create | Public `runDecision(params)`. Wires inputs → prompt → Sonnet → per-action validate → `ProposedAction[]`. |
| `src/lib/ai-pm/__tests__/decision.test.ts` | Create | Vitest with cassette Sonnet responses. Happy path + per-action rejection + tool-use absence + portfolio fixture. |
| `src/lib/ai-pm/__tests__/portfolio-state.test.ts` | Create | Vitest with fake Drizzle. Filters running bots scoped to `bingxApiKeyId`. |

---

## Public Surface

```ts
// portfolio-state.ts
export interface PortfolioBotSnapshot {
  id: string;
  symbol: string;
  strategy: 'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER';
  capitalUsdt: number;        // positionSizeUsdt
  leverage: number;
  status: 'RUNNING' | 'STOPPED';
}

export interface PortfolioState {
  runningBots: PortfolioBotSnapshot[];
  capitalUsedUsdt: number;    // sum of running bots' positionSizeUsdt
  bingxApiKeyId: string;
}

export function loadPortfolioState(params: {
  userId: string;
  bingxApiKeyId: string;
  db: typeof import('@/db').db;
}): Promise<PortfolioState>;
```

```ts
// decision.prompt.ts
export const AllowedStrategySchema: z.ZodEnum<['DCA', 'TRAILING_STOP', 'DCA_SPOT', 'SMA_CROSSOVER']>;

export const CreateBotActionSchema: z.ZodType<{
  type: 'create_bot';
  symbol: string;
  strategy: 'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER';
  capitalUsdt: number;        // > 0
  leverage: number;           // 1-20
  reasoning: string;
}>;

export const StopBotActionSchema: z.ZodType<{
  type: 'stop_bot';
  botId: string;              // uuid
  reasoning: string;
}>;

export const AdjustParamsActionSchema: z.ZodType<{
  type: 'adjust_params';
  botId: string;
  params: Record<string, unknown>;
  reasoning: string;
}>;

export const ReallocateCapitalActionSchema: z.ZodType<{
  type: 'reallocate_capital';
  fromBotId: string;
  toBotId: string;
  amountUsdt: number;
  reasoning: string;
}>;

export const NoActionSchema: z.ZodType<{
  type: 'no_action';
  reasoning: string;
}>;

export const ProposeActionsSchema: z.ZodType<{
  actions: unknown[];         // permissive outer; per-action validation done in decision.ts
}>;

export function buildSystemPrompt(): string;
export function buildUserPrompt(input: {
  candidates: SignalCandidate[];
  portfolioState: PortfolioState;
  config: DecisionConfig;
}): string;

export interface DecisionConfig {
  mode: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';
  maxCapitalUsdt: number;
  maxConcurrentBots: number;
  allowedStrategies: Array<'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER'>;
}
```

```ts
// decision.ts
export type ProposedAction =
  | z.infer<typeof CreateBotActionSchema>
  | z.infer<typeof StopBotActionSchema>
  | z.infer<typeof AdjustParamsActionSchema>
  | z.infer<typeof ReallocateCapitalActionSchema>
  | z.infer<typeof NoActionSchema>;

export interface RejectedAction {
  raw: unknown;
  issues: unknown;
}

export interface DecisionResult {
  proposedActions: ProposedAction[];
  rejectedActions: RejectedAction[];
  usage: LlmUsage;
}

export type DecisionError =
  | { kind: 'LLM_ERROR'; cause: LlmError }
  | { kind: 'NO_TOOL_USE'; message: string }
  | { kind: 'SCHEMA_REJECTED'; issues: unknown };

export type DecisionOutcome =
  | { ok: true; result: DecisionResult }
  | { ok: false; error: DecisionError };

export interface RunDecisionParams {
  userId: string;
  candidates: SignalCandidate[];
  portfolioState: PortfolioState;
  config: DecisionConfig;
  anthropicApiKey: string;
  factory?: AnthropicFactory;
  cacheSystem?: boolean;       // default true (Sonnet caching)
}

export function runDecision(params: RunDecisionParams): Promise<DecisionOutcome>;
```

**Key contracts:**

1. **Single Sonnet tool** named `propose_actions` with arg schema `{ actions: unknown[] }`. Each element is then validated against the discriminated action schemas. This matches Anthropic's tool-use surface and keeps `callSonnet` (S6) unchanged.
2. **Per-action rejection ≠ abort.** Invalid action goes to `rejectedActions`. Valid siblings still flow.
3. **Sonnet cache on.** `cacheSystem` defaults `true` (S6 default for Sonnet). Test asserts the call was made; cache verification deferred (real API only).
4. **No DB writes.** Decision is pure transformation. S11 cron persists `aiDecisions` rows.
5. **Trust boundary.** Sonnet may propose stop_bot for unknown bot IDs — that's caller's job (Validation S9) to verify membership in `portfolioState.runningBots`.

---

## Task 1: Portfolio state loader

**Files:**
- Create: `src/lib/ai-pm/portfolio-state.ts`
- Create: `src/lib/ai-pm/__tests__/portfolio-state.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { loadPortfolioState } from '@/lib/ai-pm/portfolio-state';

interface FakeRow {
  id: string;
  symbol: string;
  botType: string;
  positionSizeUsdt: string;
  leverage: number;
  status: 'RUNNING' | 'STOPPED';
  apiKeyId: string;
  userId: string;
}

function fakeDb(rows: FakeRow[]): any {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
  };
}

const userId = '00000000-0000-0000-0000-000000000001';
const apiKeyId = '00000000-0000-0000-0000-0000000000a0';

describe('loadPortfolioState', () => {
  it('returns running bots filtered by userId and bingxApiKeyId, sums capitalUsedUsdt', async () => {
    const rows: FakeRow[] = [
      { id: 'b1', symbol: 'BTC-USDT', botType: 'DCA', positionSizeUsdt: '100.5', leverage: 3, status: 'RUNNING', apiKeyId, userId },
      { id: 'b2', symbol: 'ETH-USDT', botType: 'TRAILING_STOP', positionSizeUsdt: '50', leverage: 5, status: 'RUNNING', apiKeyId, userId },
    ];

    const state = await loadPortfolioState({ userId, bingxApiKeyId: apiKeyId, db: fakeDb(rows) });

    expect(state.runningBots).toHaveLength(2);
    expect(state.capitalUsedUsdt).toBe(150.5);
    expect(state.bingxApiKeyId).toBe(apiKeyId);
    expect(state.runningBots[0]).toMatchObject({
      id: 'b1',
      symbol: 'BTC-USDT',
      strategy: 'DCA',
      capitalUsdt: 100.5,
      leverage: 3,
      status: 'RUNNING',
    });
  });

  it('returns empty state when no bots match', async () => {
    const state = await loadPortfolioState({ userId, bingxApiKeyId: apiKeyId, db: fakeDb([]) });
    expect(state.runningBots).toEqual([]);
    expect(state.capitalUsedUsdt).toBe(0);
  });
});
```

- [ ] **Step 2: Implement**

```ts
import { and, eq } from 'drizzle-orm';
import { tradingBots } from '@/db/schema';
import type { db as Db } from '@/db';

export interface PortfolioBotSnapshot {
  id: string;
  symbol: string;
  strategy: 'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER';
  capitalUsdt: number;
  leverage: number;
  status: 'RUNNING' | 'STOPPED';
}

export interface PortfolioState {
  runningBots: PortfolioBotSnapshot[];
  capitalUsedUsdt: number;
  bingxApiKeyId: string;
}

const NON_GRID_STRATEGIES = ['DCA', 'TRAILING_STOP', 'DCA_SPOT', 'SMA_CROSSOVER'] as const;
type NonGridStrategy = (typeof NON_GRID_STRATEGIES)[number];

function isNonGrid(s: string): s is NonGridStrategy {
  return (NON_GRID_STRATEGIES as readonly string[]).includes(s);
}

export async function loadPortfolioState(params: {
  userId: string;
  bingxApiKeyId: string;
  db: typeof Db;
}): Promise<PortfolioState> {
  const rows = await params.db
    .select()
    .from(tradingBots)
    .where(
      and(
        eq(tradingBots.userId, params.userId),
        eq(tradingBots.apiKeyId, params.bingxApiKeyId),
        eq(tradingBots.status, 'RUNNING'),
      ),
    );

  const runningBots: PortfolioBotSnapshot[] = [];
  let capitalUsedUsdt = 0;

  for (const row of rows) {
    if (!isNonGrid(row.botType)) continue;
    const capital = Number(row.positionSizeUsdt);
    runningBots.push({
      id: row.id,
      symbol: row.symbol,
      strategy: row.botType,
      capitalUsdt: capital,
      leverage: row.leverage,
      status: row.status,
    });
    capitalUsedUsdt += capital;
  }

  return { runningBots, capitalUsedUsdt, bingxApiKeyId: params.bingxApiKeyId };
}
```

- [ ] **Step 3: Tests + lint + commit**

```bash
bunx vitest run src/lib/ai-pm/__tests__/portfolio-state.test.ts
bunx eslint src/lib/ai-pm/portfolio-state.ts src/lib/ai-pm/__tests__/portfolio-state.test.ts
git add src/lib/ai-pm/portfolio-state.ts src/lib/ai-pm/__tests__/portfolio-state.test.ts
git commit -m "feat(ai-pm): portfolio state loader for non-grid AI bots"
```

---

## Task 2: Decision prompt module

**Files:**
- Create: `src/lib/ai-pm/decision.prompt.ts`

- [ ] **Step 1: Write the file**

```ts
import { z } from 'zod';
import type { SignalCandidate } from '@/lib/ai-pm/signal';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';

export const ALLOWED_STRATEGIES = ['DCA', 'TRAILING_STOP', 'DCA_SPOT', 'SMA_CROSSOVER'] as const;
export const AllowedStrategySchema = z.enum(ALLOWED_STRATEGIES);

const ReasoningSchema = z.string().min(1).max(500);

export const CreateBotActionSchema = z.object({
  type: z.literal('create_bot'),
  symbol: z.string().min(1),
  strategy: AllowedStrategySchema,
  capitalUsdt: z.number().positive(),
  leverage: z.number().int().min(1).max(20),
  reasoning: ReasoningSchema,
});

export const StopBotActionSchema = z.object({
  type: z.literal('stop_bot'),
  botId: z.string().uuid(),
  reasoning: ReasoningSchema,
});

export const AdjustParamsActionSchema = z.object({
  type: z.literal('adjust_params'),
  botId: z.string().uuid(),
  params: z.record(z.string(), z.unknown()),
  reasoning: ReasoningSchema,
});

export const ReallocateCapitalActionSchema = z.object({
  type: z.literal('reallocate_capital'),
  fromBotId: z.string().uuid(),
  toBotId: z.string().uuid(),
  amountUsdt: z.number().positive(),
  reasoning: ReasoningSchema,
});

export const NoActionSchema = z.object({
  type: z.literal('no_action'),
  reasoning: ReasoningSchema,
});

export const ActionSchema = z.discriminatedUnion('type', [
  CreateBotActionSchema,
  StopBotActionSchema,
  AdjustParamsActionSchema,
  ReallocateCapitalActionSchema,
  NoActionSchema,
]);

export const ProposeActionsSchema = z.object({
  actions: z.array(z.unknown()),
});

export type ProposedAction = z.infer<typeof ActionSchema>;

export interface DecisionConfig {
  mode: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';
  maxCapitalUsdt: number;
  maxConcurrentBots: number;
  allowedStrategies: Array<(typeof ALLOWED_STRATEGIES)[number]>;
}

export function buildSystemPrompt(): string {
  return [
    'You are a portfolio manager for a crypto futures trading account.',
    'Given Signal candidates + current portfolio state + risk config, decide actions.',
    '',
    'Use the `propose_actions` tool. Return an `actions` array of typed objects.',
    'Each action has a `type` field discriminating the shape:',
    '',
    '- create_bot: open a new bot. Fields: symbol, strategy, capitalUsdt, leverage, reasoning.',
    '- stop_bot: stop a running bot. Fields: botId (uuid), reasoning.',
    '- adjust_params: change a running bot config. Fields: botId, params (object), reasoning.',
    '- reallocate_capital: move capital between bots. Fields: fromBotId, toBotId, amountUsdt, reasoning.',
    '- no_action: skip this tick. Fields: reasoning.',
    '',
    'Constraints:',
    '- Only use strategies from config.allowedStrategies.',
    '- Total capital across running bots + new create_bot capital must not exceed config.maxCapitalUsdt.',
    '- Active bots after actions must not exceed config.maxConcurrentBots.',
    '- Each action requires a one-sentence reasoning (plain English, no markdown).',
    '',
    'If no candidate is compelling, return a single no_action with reasoning.',
  ].join('\n');
}

export function buildUserPrompt(input: {
  candidates: SignalCandidate[];
  portfolioState: PortfolioState;
  config: DecisionConfig;
}): string {
  const candLines = input.candidates
    .map((c) => `- ${c.symbol} regime=${c.regime} score=${c.score} reason=${c.reason}`)
    .join('\n');
  const botLines = input.portfolioState.runningBots
    .map(
      (b) =>
        `- id=${b.id} symbol=${b.symbol} strategy=${b.strategy} capital=${b.capitalUsdt} leverage=${b.leverage}`,
    )
    .join('\n');

  return [
    `Mode: ${input.config.mode}`,
    `Max capital USDT: ${input.config.maxCapitalUsdt}`,
    `Max concurrent bots: ${input.config.maxConcurrentBots}`,
    `Allowed strategies: ${input.config.allowedStrategies.join(', ')}`,
    `Capital used USDT: ${input.portfolioState.capitalUsedUsdt}`,
    '',
    'Signal candidates:',
    candLines || '(none)',
    '',
    'Running AI bots:',
    botLines || '(none)',
    '',
    'Decide actions via `propose_actions` tool.',
  ].join('\n');
}
```

- [ ] **Step 2: Lint + commit**

```bash
bunx eslint src/lib/ai-pm/decision.prompt.ts
git add src/lib/ai-pm/decision.prompt.ts
git commit -m "feat(ai-pm): decision prompt schemas and templates"
```

---

## Task 3: Decision runner + tests (TDD)

**Files:**
- Create: `src/lib/ai-pm/decision.ts`
- Create: `src/lib/ai-pm/__tests__/decision.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { runDecision } from '@/lib/ai-pm/decision';
import type { AnthropicFactory } from '@/lib/ai-pm/llm';
import type { SignalCandidate } from '@/lib/ai-pm/signal';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';
import type { DecisionConfig } from '@/lib/ai-pm/decision.prompt';

function fakeFactory(opts: {
  toolUseInput?: unknown;
  noToolUse?: boolean;
  shouldThrow?: Error;
}): AnthropicFactory {
  return () => ({
    messages: {
      create: async () => {
        if (opts.shouldThrow) throw opts.shouldThrow;
        const content = opts.noToolUse
          ? [{ type: 'text', text: 'no tool here' }]
          : [{ type: 'tool_use', id: 'tu_1', name: 'propose_actions', input: opts.toolUseInput }];
        return {
          id: 'msg_1',
          model: 'claude-sonnet-4-6',
          role: 'assistant',
          content,
          stop_reason: 'end_turn',
          stop_sequence: null,
          type: 'message',
          usage: { input_tokens: 800, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        };
      },
    },
  });
}

const userId = '00000000-0000-0000-0000-000000000001';
const botId = '00000000-0000-0000-0000-0000000000b0';

const baseState: PortfolioState = {
  runningBots: [{ id: botId, symbol: 'BTC-USDT', strategy: 'DCA', capitalUsdt: 100, leverage: 3, status: 'RUNNING' }],
  capitalUsedUsdt: 100,
  bingxApiKeyId: '00000000-0000-0000-0000-0000000000a0',
};

const baseConfig: DecisionConfig = {
  mode: 'BALANCED',
  maxCapitalUsdt: 1000,
  maxConcurrentBots: 5,
  allowedStrategies: ['DCA', 'TRAILING_STOP', 'DCA_SPOT', 'SMA_CROSSOVER'],
};

const baseCandidates: SignalCandidate[] = [
  { symbol: 'ETH-USDT', regime: 'trend_up', score: 80, reason: 'higher highs' },
];

describe('runDecision', () => {
  it('parses well-formed actions and returns usage', async () => {
    const input = {
      actions: [
        { type: 'create_bot', symbol: 'ETH-USDT', strategy: 'TRAILING_STOP', capitalUsdt: 50, leverage: 5, reasoning: 'r' },
        { type: 'no_action', reasoning: 'wait on BTC' },
      ],
    };
    const result = await runDecision({
      userId,
      candidates: baseCandidates,
      portfolioState: baseState,
      config: baseConfig,
      anthropicApiKey: 'sk-ant',
      factory: fakeFactory({ toolUseInput: input }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.result.proposedActions).toHaveLength(2);
    expect(result.result.proposedActions[0].type).toBe('create_bot');
    expect(result.result.proposedActions[1].type).toBe('no_action');
    expect(result.result.rejectedActions).toHaveLength(0);
    expect(result.result.usage.inputTokens).toBe(800);
  });

  it('rejects malformed actions per-element without aborting valid siblings', async () => {
    const input = {
      actions: [
        { type: 'create_bot', symbol: 'ETH-USDT', strategy: 'TRAILING_STOP', capitalUsdt: 50, leverage: 5, reasoning: 'r' },
        { type: 'create_bot', symbol: 'ETH-USDT', strategy: 'TRAILING_STOP', capitalUsdt: -10, leverage: 5, reasoning: 'r' },
        { type: 'stop_bot', botId: 'not-a-uuid', reasoning: 'r' },
        { type: 'unknown_type', foo: 'bar' },
        { type: 'no_action', reasoning: 'ok' },
      ],
    };
    const result = await runDecision({
      userId,
      candidates: baseCandidates,
      portfolioState: baseState,
      config: baseConfig,
      anthropicApiKey: 'sk-ant',
      factory: fakeFactory({ toolUseInput: input }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.result.proposedActions).toHaveLength(2);
    expect(result.result.proposedActions.map((a) => a.type)).toEqual(['create_bot', 'no_action']);
    expect(result.result.rejectedActions).toHaveLength(3);
  });

  it('returns SCHEMA_REJECTED when tool input lacks actions array', async () => {
    const result = await runDecision({
      userId,
      candidates: baseCandidates,
      portfolioState: baseState,
      config: baseConfig,
      anthropicApiKey: 'sk-ant',
      factory: fakeFactory({ toolUseInput: { wrong: 'shape' } }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.kind).toBe('SCHEMA_REJECTED');
  });

  it('returns NO_TOOL_USE when Sonnet returns only text', async () => {
    const result = await runDecision({
      userId,
      candidates: baseCandidates,
      portfolioState: baseState,
      config: baseConfig,
      anthropicApiKey: 'sk-ant',
      factory: fakeFactory({ noToolUse: true }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.kind).toBe('NO_TOOL_USE');
  });

  it('returns LLM_ERROR when SDK throws', async () => {
    const result = await runDecision({
      userId,
      candidates: baseCandidates,
      portfolioState: baseState,
      config: baseConfig,
      anthropicApiKey: 'sk-ant',
      factory: fakeFactory({ shouldThrow: new Error('429 rate limited') }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.kind).toBe('LLM_ERROR');
  });

  it('accepts empty actions array (no_action implied)', async () => {
    const result = await runDecision({
      userId,
      candidates: baseCandidates,
      portfolioState: baseState,
      config: baseConfig,
      anthropicApiKey: 'sk-ant',
      factory: fakeFactory({ toolUseInput: { actions: [] } }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.result.proposedActions).toEqual([]);
    expect(result.result.rejectedActions).toEqual([]);
  });
});
```

- [ ] **Step 2: Run failing tests** — module not found.

- [ ] **Step 3: Implement**

```ts
import { callSonnet, type AnthropicFactory, type LlmError, type LlmUsage } from '@/lib/ai-pm/llm';
import {
  ActionSchema,
  ProposeActionsSchema,
  buildSystemPrompt,
  buildUserPrompt,
  type ProposedAction,
  type DecisionConfig,
} from '@/lib/ai-pm/decision.prompt';
import type { SignalCandidate } from '@/lib/ai-pm/signal';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';

export interface RejectedAction {
  raw: unknown;
  issues: unknown;
}

export interface DecisionResult {
  proposedActions: ProposedAction[];
  rejectedActions: RejectedAction[];
  usage: LlmUsage;
}

export type DecisionError =
  | { kind: 'LLM_ERROR'; cause: LlmError }
  | { kind: 'NO_TOOL_USE'; message: string }
  | { kind: 'SCHEMA_REJECTED'; issues: unknown };

export type DecisionOutcome =
  | { ok: true; result: DecisionResult }
  | { ok: false; error: DecisionError };

export interface RunDecisionParams {
  userId: string;
  candidates: SignalCandidate[];
  portfolioState: PortfolioState;
  config: DecisionConfig;
  anthropicApiKey: string;
  factory?: AnthropicFactory;
  cacheSystem?: boolean;
}

const TOOL_NAME = 'propose_actions';

export async function runDecision(params: RunDecisionParams): Promise<DecisionOutcome> {
  const llm = await callSonnet({
    apiKey: params.anthropicApiKey,
    systemPrompt: buildSystemPrompt(),
    userPrompt: buildUserPrompt({
      candidates: params.candidates,
      portfolioState: params.portfolioState,
      config: params.config,
    }),
    tools: [
      {
        name: TOOL_NAME,
        description: 'Propose a list of trading actions in response to current portfolio state.',
        schema: ProposeActionsSchema,
      },
    ],
    factory: params.factory,
    cacheSystem: params.cacheSystem ?? true,
  });

  if (!llm.ok) {
    if (llm.error.kind === 'NO_TOOL_USE') {
      return { ok: false, error: { kind: 'NO_TOOL_USE', message: llm.error.message } };
    }
    if (llm.error.kind === 'SCHEMA_REJECTED') {
      return { ok: false, error: { kind: 'SCHEMA_REJECTED', issues: llm.error.issues } };
    }
    return { ok: false, error: { kind: 'LLM_ERROR', cause: llm.error } };
  }

  const raw = llm.data.args as { actions: unknown[] };
  const proposedActions: ProposedAction[] = [];
  const rejectedActions: RejectedAction[] = [];

  for (const entry of raw.actions) {
    const parsed = ActionSchema.safeParse(entry);
    if (parsed.success) {
      proposedActions.push(parsed.data);
    } else {
      rejectedActions.push({ raw: entry, issues: parsed.error.issues });
    }
  }

  return { ok: true, result: { proposedActions, rejectedActions, usage: llm.usage } };
}
```

- [ ] **Step 4: Run tests** — expect 6/6 pass.

- [ ] **Step 5: Full suite + lint + build**

```bash
bunx vitest run
bunx eslint src/lib/ai-pm/decision.ts src/lib/ai-pm/__tests__/decision.test.ts
bun run build
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/ai-pm/decision.ts src/lib/ai-pm/__tests__/decision.test.ts
git commit -m "feat(ai-pm): decision runner with per-action validation"
```

---

## Self-Review

- **Spec coverage:** `runDecision({ userId, candidates, portfolioState, config }): ProposedAction[]` — implemented as `runDecision(params): Promise<DecisionOutcome>` with `result.proposedActions`. Widened params to inject `anthropicApiKey` and `factory` (same pattern as S7). All 5 action types covered. Per-action rejection without abort. Cassette tests for Sonnet.
- **Single tool vs multi-tool:** Spec lists 5 tool names; implementation uses ONE tool `propose_actions` with a discriminated-union array. Equivalent expressiveness, atomic call, easier per-action validation. Documented choice.
- **Cache:** `cacheSystem` defaults true (S6 already does this for Sonnet). Live cache verification deferred.
- **Portfolio state:** Filters to non-grid strategies (`DCA, TRAILING_STOP, DCA_SPOT, SMA_CROSSOVER`) — matches mnemo rule "AI PM restricted to 4 non-grid strategies".

## Done Criteria

1. `loadPortfolioState`, `PortfolioState`, `PortfolioBotSnapshot` exported.
2. All 5 action schemas + `ActionSchema` discriminated union + `ProposeActionsSchema` + `DecisionConfig` + `ProposedAction` type exported from `decision.prompt.ts`.
3. `runDecision`, `DecisionResult`, `DecisionError`, `DecisionOutcome`, `RunDecisionParams`, `RejectedAction` exported from `decision.ts`.
4. 8 tests pass: 2 portfolio-state + 6 decision (happy, per-action reject, SCHEMA_REJECTED, NO_TOOL_USE, LLM_ERROR, empty actions).
5. Full suite passes (120 + 8 = 128).
6. Lint + build clean.
