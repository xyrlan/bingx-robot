# AI Portfolio Manager — Session 16: Chat Tool-Use Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the reply-only chat backend with a full agentic tool-use loop: the LLM can read portfolio state and execute create_bot / stop_bot / pause_kill_switch through the existing validate+execute pipeline, with every tool call audited into `ai_decisions`.

**Architecture:** Multi-turn Anthropic tool-use loop driven by `chat-loop.ts`. Six tools live in `chat-tools.ts`. Tool dispatch reuses `validate()` and `execute()`. Schema adds `chat_message_id` FK on `ai_decisions` and token-usage columns on `ai_chat_messages`. A pre-inserted assistant chat message anchors the loop so decision rows can link back. UI renders `toolCalls` as an inline list under the assistant bubble.

**Tech Stack:** Drizzle ORM, Anthropic SDK (`@anthropic-ai/sdk`), zod, vitest, Next.js, next-intl, React.

**Spec:** `docs/superpowers/specs/2026-05-12-ai-pm-chat-tools-design.md`
**Branch:** `feat/ai-pm-chat-tools` (already created; spec committed at `4a83697`).

---

## File Manifest

**New:**
- `src/lib/ai-pm/chat-tools.ts`
- `src/lib/ai-pm/chat-loop.ts`
- `src/lib/ai-pm/__tests__/chat-tools.test.ts`
- `src/lib/ai-pm/__tests__/chat-loop.test.ts`
- Generated migration file under `drizzle/`

**Modified:**
- `src/db/schema.ts` (chat_message_id + token cols on `ai_chat_messages`, relation)
- `src/lib/ai-pm/llm.ts` (`callSonnetTools` export)
- `src/lib/ai-pm/validation.ts` (accept `chatMessageId`)
- `src/lib/ai-pm/executor.ts` (accept `chatMessageId`; thread through `persistDecision`)
- `src/lib/ai-pm/chat-pipeline.ts` (drive `runToolLoop`, pre-insert assistant row)
- `src/lib/ai-pm/__tests__/llm.test.ts` (extend)
- `src/lib/ai-pm/__tests__/chat-pipeline.test.ts` (extend)
- `src/components/ai-pm/chat/MessageBubble.tsx` (toolCalls renderer)
- `src/components/ai-pm/chat/ChatClient.tsx` (decode toolCalls before pass-down)
- `src/components/ai-pm/chat/__tests__/MessageBubble.test.tsx` (extend)
- `messages/en.json`, `messages/pt.json`, `messages/zh.json`

---

## Task 1: Schema migration — chat_message_id + chat token columns

**Files:**
- Modify: `src/db/schema.ts`
- Create (generated): `drizzle/NNNN_*.sql`

The migration adds:
- `ai_decisions.chat_message_id UUID REFERENCES ai_chat_messages(id) ON DELETE SET NULL` + index.
- `ai_chat_messages.tokens_input INTEGER`, `tokens_output INTEGER`, `cached_input_tokens INTEGER`, `cost_usd NUMERIC(10,6)`.

- [ ] **Step 1: Add columns to Drizzle schema**

In `src/db/schema.ts`, find the `aiDecisions` definition (around line 260). Inside the table’s object literal (after `costUsd` but before the closing `}`) add:

```ts
  chatMessageId: uuid('chat_message_id').references((): unknown => aiChatMessages.id as unknown, { onDelete: 'set null' }),
```

⚠️ Drizzle forward-reference: `aiChatMessages` is defined later in the file (around line 358). The arrow reference is the standard workaround. If the lint complains about typing, use a deferred reference helper instead — read the file and follow whichever pattern already exists for circular FKs. If none exists, define the column as `uuid('chat_message_id')` without `.references(...)` here and add the FK in the SQL migration directly (Drizzle still recognises the column).

Add an index inside the `aiDecisions` table builder’s array literal:

```ts
  index('ai_decisions_chat_message_idx').on(table.chatMessageId),
```

For `aiChatMessages` (around line 358), inside the object literal add:

```ts
  tokensInput: integer('tokens_input'),
  tokensOutput: integer('tokens_output'),
  cachedInputTokens: integer('cached_input_tokens'),
  costUsd: decimal('cost_usd', { precision: 10, scale: 6 }),
```

Also extend the existing `aiDecisionsRelations` (or add new one if absent) to declare:

```ts
  chatMessage: one(aiChatMessages, {
    fields: [aiDecisions.chatMessageId],
    references: [aiChatMessages.id],
  }),
```

And in `aiChatMessagesRelations` add the reverse:

```ts
  decisions: many(aiDecisions),
```

If `many`/`one` aren’t already imported on those relations, add them.

- [ ] **Step 2: Generate migration**

```bash
cd /Users/xyrlan/github/bingx-robot
npm run db:generate
```

Expected: a new file under `drizzle/` (next index — e.g. `0013_*.sql`). Verify it contains both ALTER TABLE statements (one for ai_decisions, one for ai_chat_messages).

- [ ] **Step 3: Apply migration to test DB**

```bash
npm run db:migrate
```

Expected: success, no errors.

- [ ] **Step 4: Verify type-check + existing tests still pass**

```bash
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "schema\|ai_decisions\|ai_chat_messages" | head -10
npx vitest run src/services/__tests__/ai-pm-activity.service.test.ts src/services/__tests__/ai-pm-chat-history.service.test.ts 2>&1 | tail -5
```

Expected: no new tsc errors related to the changed tables. All previously green tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(ai-pm): add chat_message_id FK and token usage columns"
```

---

## Task 2: `callSonnetTools` multi-turn LLM helper

**Files:**
- Modify: `src/lib/ai-pm/llm.ts`
- Modify: `src/lib/ai-pm/__tests__/llm.test.ts`

Adds a new export `callSonnetTools` that accepts a full anthropic `messages` array (including `tool_use`/`tool_result` content blocks) and returns either the first tool_use block or the text reply. Args validated against the matching tool’s zod schema.

- [ ] **Step 1: Write failing tests**

Append the following tests to `src/lib/ai-pm/__tests__/llm.test.ts`. They mirror the existing `callSonnet` test setup (single-shot mock factory at top of file).

```ts
import { z } from 'zod';
import { callSonnetTools } from '@/lib/ai-pm/llm';

const PortfolioTool = {
  name: 'read_portfolio',
  description: 'Returns portfolio',
  schema: z.object({}),
} as const;

const CreateTool = {
  name: 'create_bot',
  description: 'Creates a bot',
  schema: z.object({ symbol: z.string(), capitalUsdt: z.number() }),
} as const;

function makeFactory(opts: {
  contentBlocks?: Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }>;
  usage?: { input_tokens: number; output_tokens: number };
  throwError?: Error;
}) {
  return () => ({
    messages: {
      create: async () => {
        if (opts.throwError) throw opts.throwError;
        return {
          content: opts.contentBlocks ?? [],
          usage: opts.usage ?? { input_tokens: 5, output_tokens: 7 },
        };
      },
    },
  });
}

describe('callSonnetTools', () => {
  it('returns text when no tool_use block present', async () => {
    const got = await callSonnetTools({
      apiKey: 'k',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [PortfolioTool, CreateTool],
      factory: makeFactory({ contentBlocks: [{ type: 'text', text: 'all good' }] }),
    });
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.data.kind).toBe('text');
      if (got.data.kind === 'text') expect(got.data.text).toBe('all good');
    }
  });

  it('returns first tool_use block with validated args', async () => {
    const got = await callSonnetTools({
      apiKey: 'k',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'help' }],
      tools: [CreateTool],
      factory: makeFactory({
        contentBlocks: [
          { type: 'tool_use', id: 'tu_42', name: 'create_bot', input: { symbol: 'BTC-USDT', capitalUsdt: 100 } },
        ],
      }),
    });
    expect(got.ok).toBe(true);
    if (got.ok && got.data.kind === 'tool_use') {
      expect(got.data.toolName).toBe('create_bot');
      expect(got.data.toolUseId).toBe('tu_42');
      expect(got.data.args).toEqual({ symbol: 'BTC-USDT', capitalUsdt: 100 });
    }
  });

  it('SCHEMA_REJECTED on bad args', async () => {
    const got = await callSonnetTools({
      apiKey: 'k',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'help' }],
      tools: [CreateTool],
      factory: makeFactory({
        contentBlocks: [
          { type: 'tool_use', id: 'tu_1', name: 'create_bot', input: { symbol: 'X' } }, // missing capitalUsdt
        ],
      }),
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.kind).toBe('SCHEMA_REJECTED');
  });

  it('SCHEMA_REJECTED when tool name unknown', async () => {
    const got = await callSonnetTools({
      apiKey: 'k',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'help' }],
      tools: [CreateTool],
      factory: makeFactory({
        contentBlocks: [{ type: 'tool_use', id: 'tu_1', name: 'unknown_tool', input: {} }],
      }),
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.kind).toBe('SCHEMA_REJECTED');
  });

  it('API_ERROR when factory throws', async () => {
    const got = await callSonnetTools({
      apiKey: 'k',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'x' }],
      tools: [CreateTool],
      factory: makeFactory({ throwError: new Error('boom') }),
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.kind).toBe('API_ERROR');
  });
});
```

- [ ] **Step 2: Run tests — they fail**

```bash
npx vitest run src/lib/ai-pm/__tests__/llm.test.ts -t callSonnetTools
```
Expected: 5 failing tests (`callSonnetTools` undefined).

- [ ] **Step 3: Implement `callSonnetTools`**

Append the following to `src/lib/ai-pm/llm.ts`. Reuse the existing helpers (`zodToJsonSchema`, `extractUsage`, `buildSystem`, `MODEL_SONNET`).

```ts
export type AnthropicChatMessage = { role: 'user' | 'assistant'; content: unknown };

export type SonnetToolsResponse =
  | { kind: 'tool_use'; toolName: string; toolUseId: string; args: unknown }
  | { kind: 'text'; text: string };

export async function callSonnetTools(params: {
  apiKey: string;
  systemPrompt: string;
  messages: AnthropicChatMessage[];
  tools: ToolDefinition<unknown>[];
  factory?: AnthropicFactory;
  maxTokens?: number;
  cacheSystem?: boolean;
}): Promise<LlmResult<SonnetToolsResponse>> {
  const factory = params.factory ?? defaultFactory;
  const cacheSystem = params.cacheSystem ?? true;
  const client = factory(params.apiKey);

  const tools = params.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: zodToJsonSchema(t.schema),
  }));

  let response: AnthropicMessageResponse;
  try {
    response = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: params.maxTokens ?? 2048,
      system: buildSystem(params.systemPrompt, cacheSystem),
      tools,
      messages: params.messages,
    });
  } catch (err) {
    return {
      ok: false,
      error: { kind: 'API_ERROR', message: err instanceof Error ? err.message : String(err) },
    };
  }

  const usage = extractUsage(MODEL_SONNET, response.usage);

  const toolBlock = response.content.find(
    (c): c is AnthropicMessageContent & { type: 'tool_use'; name: string; id?: string; input?: unknown } =>
      c.type === 'tool_use',
  );
  if (toolBlock && toolBlock.name) {
    const matched = params.tools.find((t) => t.name === toolBlock.name);
    if (!matched) {
      return {
        ok: false,
        error: { kind: 'SCHEMA_REJECTED', message: `Unknown tool name: ${toolBlock.name}`, issues: [] },
        usage,
      };
    }
    const validation = matched.schema.safeParse(toolBlock.input);
    if (!validation.success) {
      return {
        ok: false,
        error: {
          kind: 'SCHEMA_REJECTED',
          message: `Tool args failed validation for ${toolBlock.name}`,
          issues: validation.error.issues,
        },
        usage,
      };
    }
    return {
      ok: true,
      data: {
        kind: 'tool_use',
        toolName: toolBlock.name,
        toolUseId: (toolBlock as { id?: string }).id ?? '',
        args: validation.data,
      },
      usage,
    };
  }

  const textParts = response.content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string);
  const text = textParts.join('\n').trim();
  if (!text) {
    return { ok: false, error: { kind: 'EMPTY_RESPONSE', message: 'Sonnet returned no tool_use or text' }, usage };
  }
  return { ok: true, data: { kind: 'text', text }, usage };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/lib/ai-pm/__tests__/llm.test.ts
```
Expected: all tests pass (existing + 5 new).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai-pm/llm.ts src/lib/ai-pm/__tests__/llm.test.ts
git commit -m "feat(ai-pm): callSonnetTools multi-turn helper"
```

---

## Task 3: Chat tool definitions + dispatcher

**Files:**
- Create: `src/lib/ai-pm/chat-tools.ts`
- Create: `src/lib/ai-pm/__tests__/chat-tools.test.ts`

Six tools, one dispatch function. Mutating tools route through `validate()` + `execute()` (reuses existing pipeline). `pause_kill_switch` writes directly via `ai-pm-config.service.setKillSwitch`.

- [ ] **Step 1: Write failing tests**

```ts
// src/lib/ai-pm/__tests__/chat-tools.test.ts
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { db } from '@/db';
import { users, aiChatMessages, aiDecisions, aiSignals, tradingBots, bingxApiKeys, aiPmConfigs } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { executeTool, ALL_TOOL_DEFINITIONS } from '@/lib/ai-pm/chat-tools';
import type { ToolExecContext } from '@/lib/ai-pm/chat-tools';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000080';
const CONFIG_ID = '00000000-0000-0000-0000-000000000081';
const API_KEY_ID = '00000000-0000-0000-0000-000000000082';

function makeCtx(overrides: Partial<ToolExecContext> = {}): ToolExecContext {
  return {
    userId: TEST_USER_ID,
    configId: CONFIG_ID,
    chatMessageId: null,
    portfolioState: { runningBots: [], capitalUsedUsdt: 0, bingxApiKeyId: API_KEY_ID },
    config: {
      id: CONFIG_ID,
      userId: TEST_USER_ID,
      bingxApiKeyId: API_KEY_ID,
      anthropicApiKey: 'sk-test',
      enabled: true,
      mode: 'BALANCED',
      maxCapitalUsdt: '1000',
      maxDrawdownPct: '20',
      maxLeverage: 5,
      allowedSymbols: ['BTC-USDT'],
      allowedStrategies: ['DCA', 'TRAILING_STOP', 'DCA_SPOT', 'SMA_CROSSOVER'],
      maxConcurrentBots: 5,
      monthlyLlmBudgetUsd: '100',
      killSwitch: false,
      paperMode: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    db,
    validateFn: vi.fn(),
    executeFn: vi.fn(),
    setKillSwitchFn: vi.fn(),
    ...overrides,
  };
}

async function ensureUser() {
  await db.insert(users).values({ id: TEST_USER_ID, email: 'chat-tools@example.com' }).onConflictDoNothing();
  await db.insert(bingxApiKeys).values({
    id: API_KEY_ID,
    userId: TEST_USER_ID,
    label: 'test-key',
    apiKey: 'plain',
    secretKeyEncrypted: 'enc',
  }).onConflictDoNothing();
}

async function cleanup() {
  await db.delete(aiDecisions).where(eq(aiDecisions.userId, TEST_USER_ID));
  await db.delete(aiSignals).where(eq(aiSignals.userId, TEST_USER_ID));
  await db.delete(tradingBots).where(eq(tradingBots.userId, TEST_USER_ID));
  await db.delete(aiChatMessages).where(eq(aiChatMessages.userId, TEST_USER_ID));
  await db.delete(aiPmConfigs).where(eq(aiPmConfigs.userId, TEST_USER_ID));
}

describe('chat-tools', () => {
  beforeAll(async () => {
    await ensureUser();
    await cleanup();
  });
  afterEach(async () => {
    await cleanup();
  });

  it('exports ALL_TOOL_DEFINITIONS with 6 tools', () => {
    expect(ALL_TOOL_DEFINITIONS.map(t => t.name).sort()).toEqual(
      ['create_bot', 'pause_kill_switch', 'read_decisions', 'read_portfolio', 'read_signals', 'stop_bot'].sort(),
    );
  });

  it('read_portfolio returns the snapshot', async () => {
    const ctx = makeCtx({ portfolioState: { runningBots: [{ id: 'b1', symbol: 'BTC-USDT', strategy: 'DCA', capitalUsdt: 100, leverage: 2, status: 'RUNNING' }], capitalUsedUsdt: 100, bingxApiKeyId: API_KEY_ID } });
    const got = await executeTool('read_portfolio', {}, ctx);
    expect(got.status).toBe('EXECUTED');
    expect(got.decisionId).toBeNull();
    expect(got.payload).toEqual(ctx.portfolioState);
    expect(got.summary).toMatch(/1 bot/);
  });

  it('read_signals queries db and returns rows', async () => {
    await db.insert(aiSignals).values([
      { userId: TEST_USER_ID, symbol: 'BTC-USDT', regime: 'TRENDING', score: 80, reason: 'r' },
    ]);
    const ctx = makeCtx();
    const got = await executeTool('read_signals', { limit: 5 }, ctx);
    expect(got.status).toBe('EXECUTED');
    expect(got.decisionId).toBeNull();
    expect(Array.isArray(got.payload)).toBe(true);
    expect((got.payload as unknown[]).length).toBe(1);
  });

  it('read_decisions filters by status when provided', async () => {
    await db.insert(aiDecisions).values([
      { userId: TEST_USER_ID, triggeredBy: 'CHAT', actionType: 'NO_ACTION', status: 'EXECUTED' },
      { userId: TEST_USER_ID, triggeredBy: 'CHAT', actionType: 'NO_ACTION', status: 'REJECTED_GUARDRAIL' },
    ]);
    const ctx = makeCtx();
    const got = await executeTool('read_decisions', { limit: 10, status: 'EXECUTED' }, ctx);
    expect(got.status).toBe('EXECUTED');
    expect((got.payload as Array<{ status: string }>).every(d => d.status === 'EXECUTED')).toBe(true);
  });

  it('create_bot routes through validate+execute and returns decisionId', async () => {
    const validateFn = vi.fn().mockResolvedValue({ status: 'PROPOSED', decisionId: 'dec-1' });
    const executeFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: 'dec-1', paperBotId: 'paper-1' });
    const ctx = makeCtx({ validateFn, executeFn });
    const got = await executeTool('create_bot', {
      symbol: 'BTC-USDT',
      strategy: 'DCA',
      capitalUsdt: 100,
      leverage: 2,
      reasoning: 'test',
    }, ctx);
    expect(validateFn).toHaveBeenCalledOnce();
    expect(executeFn).toHaveBeenCalledOnce();
    expect(got.status).toBe('EXECUTED');
    expect(got.decisionId).toBe('dec-1');
  });

  it('create_bot returns REJECTED_GUARDRAIL when validate rejects', async () => {
    const validateFn = vi.fn().mockResolvedValue({ status: 'REJECTED_GUARDRAIL', decisionId: 'dec-2', reason: 'leverage too high' });
    const executeFn = vi.fn();
    const ctx = makeCtx({ validateFn, executeFn });
    const got = await executeTool('create_bot', {
      symbol: 'BTC-USDT',
      strategy: 'DCA',
      capitalUsdt: 100,
      leverage: 30,
      reasoning: 'test',
    }, ctx);
    expect(executeFn).not.toHaveBeenCalled();
    expect(got.status).toBe('REJECTED_GUARDRAIL');
    expect(got.summary).toMatch(/leverage/);
  });

  it('stop_bot routes through validate+execute', async () => {
    const validateFn = vi.fn().mockResolvedValue({ status: 'PROPOSED', decisionId: 'dec-3' });
    const executeFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: 'dec-3' });
    const ctx = makeCtx({ validateFn, executeFn });
    const got = await executeTool('stop_bot', {
      botId: '00000000-0000-0000-0000-000000000099',
      reasoning: 'risk off',
    }, ctx);
    expect(got.status).toBe('EXECUTED');
    expect(got.decisionId).toBe('dec-3');
  });

  it('pause_kill_switch flips switch and inserts NO_ACTION decision', async () => {
    await db.insert(aiPmConfigs).values({
      id: CONFIG_ID,
      userId: TEST_USER_ID,
      bingxApiKeyId: API_KEY_ID,
      anthropicApiKeyEncrypted: 'enc',
      enabled: true,
    });
    const setKillSwitchFn = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ setKillSwitchFn });
    const got = await executeTool('pause_kill_switch', { reason: 'too volatile' }, ctx);
    expect(setKillSwitchFn).toHaveBeenCalledWith(CONFIG_ID, true);
    expect(got.status).toBe('EXECUTED');
    expect(got.decisionId).toBeTruthy();
    const rows = await db.select().from(aiDecisions).where(eq(aiDecisions.userId, TEST_USER_ID));
    expect(rows[0].actionType).toBe('NO_ACTION');
    expect(rows[0].reasoning).toBe('too volatile');
  });

  it('mutating tools refuse when kill switch is active', async () => {
    const validateFn = vi.fn();
    const executeFn = vi.fn();
    const ctx = makeCtx({
      validateFn,
      executeFn,
      config: { ...makeCtx().config, killSwitch: true },
    });
    const got = await executeTool('create_bot', {
      symbol: 'BTC-USDT', strategy: 'DCA', capitalUsdt: 100, leverage: 2, reasoning: 'r',
    }, ctx);
    expect(validateFn).not.toHaveBeenCalled();
    expect(got.status).toBe('EXECUTION_FAILED');
    expect(got.summary).toMatch(/kill switch/i);
  });
});
```

- [ ] **Step 2: Run tests — they fail**

```bash
npx vitest run src/lib/ai-pm/__tests__/chat-tools.test.ts
```
Expected: 9 failing (module not found).

- [ ] **Step 3: Implement chat-tools.ts**

```ts
// src/lib/ai-pm/chat-tools.ts
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  aiDecisions,
  aiSignals,
  aiChatMessages,
} from '@/db/schema';
import type { db as Db } from '@/db';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';
import type { AiPmConfigDecrypted } from '@/services/ai-pm-config.service';
import { setKillSwitch as defaultSetKillSwitch } from '@/services/ai-pm-config.service';
import { validate as defaultValidate, type ValidateParams, type ValidationResult } from '@/lib/ai-pm/validation';
import { execute as defaultExecute, type ExecuteParams, type ExecutionResult } from '@/lib/ai-pm/executor';
import type { BingxClient } from '@/lib/bingx/client';
import type { ProposedAction } from '@/lib/ai-pm/decision.prompt';
import type { ToolDefinition } from '@/lib/ai-pm/llm';

export type ToolName =
  | 'read_portfolio'
  | 'read_signals'
  | 'read_decisions'
  | 'create_bot'
  | 'stop_bot'
  | 'pause_kill_switch';

const DECISION_STATUSES = [
  'PROPOSED', 'REJECTED_GUARDRAIL', 'REJECTED_BACKTEST',
  'REJECTED_REVIEWER', 'EXECUTED', 'EXECUTION_FAILED',
] as const;

export const ReadPortfolioArgs = z.object({});
export const ReadSignalsArgs = z.object({ limit: z.number().int().min(1).max(20).optional() });
export const ReadDecisionsArgs = z.object({
  limit: z.number().int().min(1).max(20).optional(),
  status: z.enum(DECISION_STATUSES).optional(),
});
export const CreateBotArgs = z.object({
  symbol: z.string().min(1),
  strategy: z.enum(['DCA', 'TRAILING_STOP', 'DCA_SPOT', 'SMA_CROSSOVER']),
  capitalUsdt: z.number().positive(),
  leverage: z.number().int().min(1).max(20),
  reasoning: z.string().min(1).max(500),
});
export const StopBotArgs = z.object({
  botId: z.string().uuid(),
  reasoning: z.string().min(1).max(500),
});
export const PauseKillSwitchArgs = z.object({
  reason: z.string().min(1).max(500),
});

export const ALL_TOOL_DEFINITIONS: ToolDefinition<unknown>[] = [
  { name: 'read_portfolio', description: 'Returns the current portfolio snapshot.', schema: ReadPortfolioArgs },
  { name: 'read_signals', description: 'Returns the most recent AI signals.', schema: ReadSignalsArgs },
  { name: 'read_decisions', description: 'Returns recent AI decisions, optionally filtered by status.', schema: ReadDecisionsArgs },
  { name: 'create_bot', description: 'Creates a new trading bot via validate+execute.', schema: CreateBotArgs },
  { name: 'stop_bot', description: 'Stops a running trading bot via validate+execute.', schema: StopBotArgs },
  { name: 'pause_kill_switch', description: 'Activates the kill switch immediately.', schema: PauseKillSwitchArgs },
];

export interface ToolExecContext {
  userId: string;
  configId: string;
  chatMessageId: string | null;
  portfolioState: PortfolioState;
  config: AiPmConfigDecrypted;
  db: typeof Db;
  bingxClient?: BingxClient;
  validateFn?: typeof defaultValidate;
  executeFn?: typeof defaultExecute;
  setKillSwitchFn?: typeof defaultSetKillSwitch;
}

export type ToolStatus =
  | 'EXECUTED'
  | 'REJECTED_GUARDRAIL'
  | 'REJECTED_BACKTEST'
  | 'REJECTED_REVIEWER'
  | 'EXECUTION_FAILED';

export interface ToolExecResult {
  status: ToolStatus;
  decisionId: string | null;
  summary: string;
  payload: unknown;
}

export async function executeTool(
  name: ToolName,
  args: unknown,
  ctx: ToolExecContext,
): Promise<ToolExecResult> {
  switch (name) {
    case 'read_portfolio':
      return readPortfolio(ctx);
    case 'read_signals':
      return readSignals(ReadSignalsArgs.parse(args), ctx);
    case 'read_decisions':
      return readDecisions(ReadDecisionsArgs.parse(args), ctx);
    case 'create_bot':
      return createBotTool(CreateBotArgs.parse(args), ctx);
    case 'stop_bot':
      return stopBotTool(StopBotArgs.parse(args), ctx);
    case 'pause_kill_switch':
      return pauseKillSwitchTool(PauseKillSwitchArgs.parse(args), ctx);
  }
}

function readPortfolio(ctx: ToolExecContext): ToolExecResult {
  const n = ctx.portfolioState.runningBots.length;
  return {
    status: 'EXECUTED',
    decisionId: null,
    summary: `${n} bot${n === 1 ? '' : 's'} running, $${ctx.portfolioState.capitalUsedUsdt.toFixed(2)} used`,
    payload: ctx.portfolioState,
  };
}

async function readSignals(args: z.infer<typeof ReadSignalsArgs>, ctx: ToolExecContext): Promise<ToolExecResult> {
  const rows = await ctx.db
    .select()
    .from(aiSignals)
    .where(eq(aiSignals.userId, ctx.userId))
    .orderBy(desc(aiSignals.createdAt))
    .limit(args.limit ?? 10);
  return {
    status: 'EXECUTED',
    decisionId: null,
    summary: `${rows.length} signal${rows.length === 1 ? '' : 's'} returned`,
    payload: rows.map((r) => ({
      id: r.id,
      symbol: r.symbol,
      regime: r.regime,
      score: r.score,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

async function readDecisions(args: z.infer<typeof ReadDecisionsArgs>, ctx: ToolExecContext): Promise<ToolExecResult> {
  const whereExpr = args.status
    ? and(eq(aiDecisions.userId, ctx.userId), eq(aiDecisions.status, args.status))
    : eq(aiDecisions.userId, ctx.userId);
  const rows = await ctx.db
    .select()
    .from(aiDecisions)
    .where(whereExpr)
    .orderBy(desc(aiDecisions.createdAt))
    .limit(args.limit ?? 10);
  return {
    status: 'EXECUTED',
    decisionId: null,
    summary: `${rows.length} decision${rows.length === 1 ? '' : 's'} returned`,
    payload: rows.map((r) => ({
      id: r.id,
      actionType: r.actionType,
      status: r.status,
      symbol: r.symbol,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

function killSwitchRefusal(ctx: ToolExecContext): ToolExecResult {
  return {
    status: 'EXECUTION_FAILED',
    decisionId: null,
    summary: 'Kill switch is active — mutating tools refused.',
    payload: { configId: ctx.configId, killSwitch: true },
  };
}

async function createBotTool(args: z.infer<typeof CreateBotArgs>, ctx: ToolExecContext): Promise<ToolExecResult> {
  if (ctx.config.killSwitch) return killSwitchRefusal(ctx);
  const action: ProposedAction = { type: 'create_bot', ...args };
  const validateFn = ctx.validateFn ?? defaultValidate;
  const executeFn = ctx.executeFn ?? defaultExecute;

  const validation = await validateFn({
    userId: ctx.userId,
    action,
    config: {
      mode: ctx.config.mode,
      maxCapitalUsdt: Number(ctx.config.maxCapitalUsdt ?? 0),
      maxDrawdownPct: Number(ctx.config.maxDrawdownPct ?? 100),
      maxLeverage: ctx.config.maxLeverage ?? 20,
      allowedSymbols: ctx.config.allowedSymbols ?? [],
      allowedStrategies: ctx.config.allowedStrategies ?? [],
      maxConcurrentBots: ctx.config.maxConcurrentBots ?? 5,
      reviewerThresholdPct: 50,
    },
    portfolioState: ctx.portfolioState,
    anthropicApiKey: ctx.config.anthropicApiKey,
    bingxClient: ctx.bingxClient,
    db: ctx.db,
    triggeredBy: 'CHAT',
    chatMessageId: ctx.chatMessageId,
  });

  if (validation.status !== 'PROPOSED') {
    return {
      status: validation.status,
      decisionId: validation.decisionId,
      summary: `create_bot rejected: ${validation.reason ?? validation.status}`,
      payload: { decisionId: validation.decisionId, reason: validation.reason },
    };
  }

  try {
    const exec = await executeFn({
      userId: ctx.userId,
      decisionId: validation.decisionId,
      action,
      config: { bingxApiKeyId: ctx.config.bingxApiKeyId, paperMode: ctx.config.paperMode },
      db: ctx.db,
    });
    return {
      status: exec.status,
      decisionId: exec.decisionId,
      summary: exec.status === 'EXECUTED'
        ? `create_bot ${args.symbol} ${args.strategy} executed (bot ${(exec.realBotId ?? exec.paperBotId ?? '?').slice(0,8)})`
        : `create_bot failed: ${exec.reason ?? 'unknown'}`,
      payload: exec,
    };
  } catch (err) {
    return {
      status: 'EXECUTION_FAILED',
      decisionId: validation.decisionId,
      summary: `create_bot threw: ${err instanceof Error ? err.message : String(err)}`,
      payload: null,
    };
  }
}

async function stopBotTool(args: z.infer<typeof StopBotArgs>, ctx: ToolExecContext): Promise<ToolExecResult> {
  if (ctx.config.killSwitch) return killSwitchRefusal(ctx);
  const action: ProposedAction = { type: 'stop_bot', ...args };
  const validateFn = ctx.validateFn ?? defaultValidate;
  const executeFn = ctx.executeFn ?? defaultExecute;

  const validation = await validateFn({
    userId: ctx.userId,
    action,
    config: {
      mode: ctx.config.mode,
      maxCapitalUsdt: Number(ctx.config.maxCapitalUsdt ?? 0),
      maxDrawdownPct: Number(ctx.config.maxDrawdownPct ?? 100),
      maxLeverage: ctx.config.maxLeverage ?? 20,
      allowedSymbols: ctx.config.allowedSymbols ?? [],
      allowedStrategies: ctx.config.allowedStrategies ?? [],
      maxConcurrentBots: ctx.config.maxConcurrentBots ?? 5,
      reviewerThresholdPct: 50,
    },
    portfolioState: ctx.portfolioState,
    anthropicApiKey: ctx.config.anthropicApiKey,
    bingxClient: ctx.bingxClient,
    db: ctx.db,
    triggeredBy: 'CHAT',
    chatMessageId: ctx.chatMessageId,
  });

  if (validation.status !== 'PROPOSED') {
    return {
      status: validation.status,
      decisionId: validation.decisionId,
      summary: `stop_bot rejected: ${validation.reason ?? validation.status}`,
      payload: { decisionId: validation.decisionId, reason: validation.reason },
    };
  }

  try {
    const exec = await executeFn({
      userId: ctx.userId,
      decisionId: validation.decisionId,
      action,
      config: { bingxApiKeyId: ctx.config.bingxApiKeyId, paperMode: ctx.config.paperMode },
      db: ctx.db,
    });
    return {
      status: exec.status,
      decisionId: exec.decisionId,
      summary: exec.status === 'EXECUTED' ? `stop_bot ${args.botId.slice(0,8)} executed` : `stop_bot failed: ${exec.reason ?? 'unknown'}`,
      payload: exec,
    };
  } catch (err) {
    return {
      status: 'EXECUTION_FAILED',
      decisionId: validation.decisionId,
      summary: `stop_bot threw: ${err instanceof Error ? err.message : String(err)}`,
      payload: null,
    };
  }
}

async function pauseKillSwitchTool(args: z.infer<typeof PauseKillSwitchArgs>, ctx: ToolExecContext): Promise<ToolExecResult> {
  const setSwitch = ctx.setKillSwitchFn ?? defaultSetKillSwitch;
  try {
    await setSwitch(ctx.configId, true);
    const [row] = await ctx.db
      .insert(aiDecisions)
      .values({
        userId: ctx.userId,
        triggeredBy: 'CHAT',
        actionType: 'NO_ACTION',
        status: 'EXECUTED',
        reasoning: args.reason,
        chatMessageId: ctx.chatMessageId,
      })
      .returning();
    return {
      status: 'EXECUTED',
      decisionId: row.id,
      summary: 'Kill switch activated.',
      payload: { configId: ctx.configId, killSwitch: true },
    };
  } catch (err) {
    return {
      status: 'EXECUTION_FAILED',
      decisionId: null,
      summary: `pause_kill_switch failed: ${err instanceof Error ? err.message : String(err)}`,
      payload: null,
    };
  }
}
```

⚠️ This implementation calls `validateFn(...)` with `chatMessageId` in the params. Task 4 wires that parameter end-to-end through `validate()` and `persistDecision()`. Tests in this task mock `validateFn`/`executeFn` so they don't touch that yet. Re-run after Task 4 to verify the integration.

- [ ] **Step 4: Run tests — they pass**

```bash
npx vitest run src/lib/ai-pm/__tests__/chat-tools.test.ts
```
Expected: 9/9 green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai-pm/chat-tools.ts src/lib/ai-pm/__tests__/chat-tools.test.ts
git commit -m "feat(ai-pm): six chat tools with validate+execute dispatch"
```

---

## Task 4: Wire `chatMessageId` through validate + executor

**Files:**
- Modify: `src/lib/ai-pm/validation.ts`
- Modify: `src/lib/ai-pm/executor.ts`

Both files need to accept an optional `chatMessageId: string | null` parameter and forward it to the row inserted by `persistDecision()`.

- [ ] **Step 1: Modify `ValidateParams`**

In `src/lib/ai-pm/validation.ts`, find:
```ts
export interface ValidateParams {
  userId: string;
  action: ProposedAction;
  ...
  triggeredBy?: 'CRON_TICK' | 'EVENT_DRAWDOWN' | 'EVENT_FUNDING_FLIP' | 'EVENT_FILL' | 'EVENT_ERROR' | 'CHAT';
}
```
Add a new optional field after `triggeredBy`:
```ts
  chatMessageId?: string | null;
```

- [ ] **Step 2: Update `persistDecision` to forward `chatMessageId`**

In the same file, find the `persistDecision` function. Inside the `.values([{ ... }])` object, add right after `triggeredBy: params.triggeredBy ?? 'CRON_TICK',`:
```ts
      chatMessageId: params.chatMessageId ?? null,
```

- [ ] **Step 3: Mirror change in executor**

In `src/lib/ai-pm/executor.ts`, executor itself does NOT call `persistDecision` (it updates existing decision rows or creates side-effect rows like paper bots). Inspect the current `execute()` body — it does not insert into `ai_decisions`, only updates `trading_bots` and inserts via `createPaper`. **No change to executor.ts needed.** Skip if the inspection confirms.

Verify by:
```bash
grep -n "insert(aiDecisions)" src/lib/ai-pm/executor.ts
```
Expected: no matches.

- [ ] **Step 4: Run all ai-pm tests to confirm no regression**

```bash
npx vitest run src/lib/ai-pm/__tests__/ 2>&1 | tail -5
```
Expected: all green (chat-tools tests in Task 3 also re-validate via this path on next run).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai-pm/validation.ts
git commit -m "feat(ai-pm): thread chatMessageId through validate/persistDecision"
```

---

## Task 5: Tool loop driver

**Files:**
- Create: `src/lib/ai-pm/chat-loop.ts`
- Create: `src/lib/ai-pm/__tests__/chat-loop.test.ts`

Multi-turn loop that calls `callSonnetTools`, dispatches tools via `executeTool`, accumulates entries, enforces budgets, surfaces kill-switch mid-loop.

- [ ] **Step 1: Write failing tests**

```ts
// src/lib/ai-pm/__tests__/chat-loop.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runToolLoop } from '@/lib/ai-pm/chat-loop';
import type { ToolExecContext, ToolExecResult } from '@/lib/ai-pm/chat-tools';

function ctxStub(overrides: Partial<ToolExecContext> = {}): ToolExecContext {
  return {
    userId: 'u',
    configId: 'c',
    chatMessageId: null,
    portfolioState: { runningBots: [], capitalUsedUsdt: 0, bingxApiKeyId: 'k' },
    config: {
      id: 'c', userId: 'u', bingxApiKeyId: 'k', anthropicApiKey: 'sk',
      enabled: true, mode: 'BALANCED', maxCapitalUsdt: '1000', maxDrawdownPct: '20',
      maxLeverage: 5, allowedSymbols: [], allowedStrategies: [],
      maxConcurrentBots: 5, monthlyLlmBudgetUsd: '100',
      killSwitch: false, paperMode: true,
      createdAt: new Date(), updatedAt: new Date(),
    } as ToolExecContext['config'],
    db: {} as ToolExecContext['db'],
    ...overrides,
  };
}

function llmOk(result: { kind: 'text'; text: string } | { kind: 'tool_use'; toolName: string; toolUseId: string; args: unknown }, cost = 0.001) {
  return { ok: true as const, data: result, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: cost, model: 'claude-sonnet-4-6' as const } };
}

describe('runToolLoop', () => {
  it('returns text reply when LLM responds with text on first turn', async () => {
    const llmFn = vi.fn().mockResolvedValueOnce(llmOk({ kind: 'text', text: 'hello back' }));
    const executeToolFn = vi.fn();
    const got = await runToolLoop({
      userMessage: 'hi', history: [], ctx: ctxStub(),
      llmFn, executeToolFn,
    });
    expect(got.assistantText).toBe('hello back');
    expect(got.toolCallEntries).toEqual([]);
    expect(executeToolFn).not.toHaveBeenCalled();
  });

  it('dispatches one tool then returns text on next turn', async () => {
    const llmFn = vi.fn()
      .mockResolvedValueOnce(llmOk({ kind: 'tool_use', toolName: 'read_portfolio', toolUseId: 'tu1', args: {} }))
      .mockResolvedValueOnce(llmOk({ kind: 'text', text: 'done' }));
    const executeToolFn = vi.fn<(name: string, args: unknown, ctx: ToolExecContext) => Promise<ToolExecResult>>().mockResolvedValue({ status: 'EXECUTED', decisionId: null, summary: 'ok', payload: {} });

    const got = await runToolLoop({
      userMessage: 'p', history: [], ctx: ctxStub(),
      llmFn, executeToolFn,
    });
    expect(got.assistantText).toBe('done');
    expect(got.toolCallEntries).toHaveLength(1);
    expect(got.toolCallEntries[0].toolName).toBe('read_portfolio');
    expect(executeToolFn).toHaveBeenCalledTimes(1);
  });

  it('terminates at MAX_TURNS', async () => {
    const llmFn = vi.fn().mockResolvedValue(llmOk({ kind: 'tool_use', toolName: 'read_portfolio', toolUseId: 'tu', args: {} }));
    const executeToolFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: null, summary: 'ok', payload: {} });
    const got = await runToolLoop({
      userMessage: 'x', history: [], ctx: ctxStub(),
      llmFn, executeToolFn,
      budgets: { maxTurns: 3 },
    });
    expect(got.toolCallEntries).toHaveLength(3);
    expect(got.assistantText).toMatch(/limit/i);
  });

  it('terminates when cost cap exceeded', async () => {
    const llmFn = vi.fn().mockResolvedValue(llmOk({ kind: 'tool_use', toolName: 'read_portfolio', toolUseId: 'tu', args: {} }, 0.4));
    const executeToolFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: null, summary: 'ok', payload: {} });
    const got = await runToolLoop({
      userMessage: 'x', history: [], ctx: ctxStub(),
      llmFn, executeToolFn,
      budgets: { maxCostUsdPerTurn: 0.5 },
    });
    expect(got.assistantText).toMatch(/budget/i);
  });

  it('aborts when kill switch flips mid-loop', async () => {
    const ctx = ctxStub();
    let killOn = false;
    const llmFn = vi.fn().mockResolvedValue(llmOk({ kind: 'tool_use', toolName: 'create_bot', toolUseId: 'tu', args: { symbol: 'X', strategy: 'DCA', capitalUsdt: 1, leverage: 1, reasoning: 'r' } }));
    const executeToolFn = vi.fn().mockImplementation(async () => {
      killOn = true;
      return { status: 'EXECUTED', decisionId: 'd1', summary: 'ok', payload: {} };
    });
    const isKillSwitchOnFn = vi.fn().mockImplementation(async () => killOn);
    const got = await runToolLoop({
      userMessage: 'x', history: [], ctx,
      llmFn, executeToolFn, isKillSwitchOnFn,
    });
    expect(got.assistantText).toMatch(/kill switch/i);
    expect(got.toolCallEntries).toHaveLength(1);
    expect(executeToolFn).toHaveBeenCalledTimes(1);
  });

  it('on LLM api error returns text describing the error and any accumulated entries', async () => {
    const llmFn = vi.fn()
      .mockResolvedValueOnce(llmOk({ kind: 'tool_use', toolName: 'read_portfolio', toolUseId: 'tu', args: {} }))
      .mockResolvedValueOnce({ ok: false as const, error: { kind: 'API_ERROR', message: 'boom' } });
    const executeToolFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: null, summary: 'ok', payload: {} });
    const got = await runToolLoop({
      userMessage: 'x', history: [], ctx: ctxStub(),
      llmFn, executeToolFn,
    });
    expect(got.assistantText).toMatch(/AI service error/i);
    expect(got.toolCallEntries).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests — they fail**

```bash
npx vitest run src/lib/ai-pm/__tests__/chat-loop.test.ts
```
Expected: 6 failing.

- [ ] **Step 3: Implement `chat-loop.ts`**

```ts
// src/lib/ai-pm/chat-loop.ts
import { callSonnetTools, type AnthropicChatMessage, type SonnetToolsResponse } from '@/lib/ai-pm/llm';
import type { LlmResult, LlmUsage } from '@/lib/ai-pm/llm';
import { ALL_TOOL_DEFINITIONS, executeTool as defaultExecuteTool, type ToolExecContext, type ToolName, type ToolStatus } from '@/lib/ai-pm/chat-tools';

export interface ToolCallEntry {
  toolName: ToolName;
  args: unknown;
  status: ToolStatus;
  decisionId: string | null;
  summary: string;
}

export interface RunToolLoopParams {
  userMessage: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  ctx: ToolExecContext;
  llmFn?: (params: Parameters<typeof callSonnetTools>[0]) => Promise<LlmResult<SonnetToolsResponse>>;
  executeToolFn?: typeof defaultExecuteTool;
  isKillSwitchOnFn?: (configId: string) => Promise<boolean>;
  budgets?: { maxTurns?: number; maxCostUsdPerTurn?: number };
  systemPrompt?: string;
}

export interface RunToolLoopResult {
  assistantText: string;
  toolCallEntries: ToolCallEntry[];
  cumulativeUsage: LlmUsage;
}

const DEFAULT_MAX_TURNS = 8;
const DEFAULT_MAX_COST = 0.5;
const DEFAULT_MODEL = 'claude-sonnet-4-6' as const;

function defaultSystemPrompt(): string {
  return [
    'You are the AI Portfolio Manager. You can read portfolio state and execute',
    'create_bot / stop_bot / pause_kill_switch actions through tools.',
    'Always include a reasoning string when mutating. Prefer reading before acting.',
    'When a guardrail rejects a tool call, adjust and retry once. Stop after a final summary.',
  ].join(' ');
}

function isMutating(name: ToolName): boolean {
  return name === 'create_bot' || name === 'stop_bot' || name === 'pause_kill_switch';
}

export async function runToolLoop(params: RunToolLoopParams): Promise<RunToolLoopResult> {
  const llmFn = params.llmFn ?? callSonnetTools;
  const executeToolFn = params.executeToolFn ?? defaultExecuteTool;
  const maxTurns = params.budgets?.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxCost = params.budgets?.maxCostUsdPerTurn ?? DEFAULT_MAX_COST;
  const isKillSwitchOn = params.isKillSwitchOnFn ?? (async () => false);
  const systemPrompt = params.systemPrompt ?? defaultSystemPrompt();

  const messages: AnthropicChatMessage[] = [
    ...params.history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: params.userMessage },
  ];

  const toolCallEntries: ToolCallEntry[] = [];
  let cumulativeUsage: LlmUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, model: DEFAULT_MODEL };

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const llmRes = await llmFn({
      apiKey: params.ctx.config.anthropicApiKey,
      systemPrompt,
      messages,
      tools: ALL_TOOL_DEFINITIONS,
    });

    if (!llmRes.ok) {
      return {
        assistantText: `AI service error: ${llmRes.error.kind}`,
        toolCallEntries,
        cumulativeUsage,
      };
    }

    cumulativeUsage = mergeUsage(cumulativeUsage, llmRes.usage);

    if (llmRes.data.kind === 'text') {
      return { assistantText: llmRes.data.text, toolCallEntries, cumulativeUsage };
    }

    if (cumulativeUsage.costUsd > maxCost) {
      return {
        assistantText: `Budget exhausted after ${toolCallEntries.length} tool call${toolCallEntries.length === 1 ? '' : 's'}, stopping.`,
        toolCallEntries,
        cumulativeUsage,
      };
    }

    const tu = llmRes.data;
    if (isMutating(tu.toolName as ToolName) && (await isKillSwitchOn(params.ctx.configId))) {
      return {
        assistantText: 'Kill switch flipped mid-conversation; stopped.',
        toolCallEntries,
        cumulativeUsage,
      };
    }

    const exec = await executeToolFn(tu.toolName as ToolName, tu.args, params.ctx);
    toolCallEntries.push({
      toolName: tu.toolName as ToolName,
      args: tu.args,
      status: exec.status,
      decisionId: exec.decisionId,
      summary: exec.summary,
    });

    // After executing a mutating tool we must re-check the kill switch for the *next* turn.
    if (isMutating(tu.toolName as ToolName) && (await isKillSwitchOn(params.ctx.configId))) {
      return {
        assistantText: 'Kill switch flipped mid-conversation; stopped.',
        toolCallEntries,
        cumulativeUsage,
      };
    }

    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: tu.toolUseId, name: tu.toolName, input: tu.args }],
    });
    messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: tu.toolUseId,
        content: JSON.stringify({ summary: exec.summary, payload: exec.payload, status: exec.status }),
        is_error: exec.status !== 'EXECUTED',
      }],
    });
  }

  return {
    assistantText: `Hit ${maxTurns}-call limit; here is what I did.`,
    toolCallEntries,
    cumulativeUsage,
  };
}

function mergeUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    costUsd: a.costUsd + b.costUsd,
    model: b.model,
  };
}
```

- [ ] **Step 4: Run tests — they pass**

```bash
npx vitest run src/lib/ai-pm/__tests__/chat-loop.test.ts
```
Expected: 6/6 green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai-pm/chat-loop.ts src/lib/ai-pm/__tests__/chat-loop.test.ts
git commit -m "feat(ai-pm): multi-turn chat tool loop with budget enforcement"
```

---

## Task 6: Replace chat-pipeline body with tool loop

**Files:**
- Modify: `src/lib/ai-pm/chat-pipeline.ts`
- Modify: `src/lib/ai-pm/__tests__/chat-pipeline.test.ts` (if exists)

Pre-insert empty assistant row → run tool loop → update assistant row with content + toolCalls + usage + decisionId.

- [ ] **Step 1: Read current chat-pipeline.ts to confirm structure**

```bash
cat src/lib/ai-pm/chat-pipeline.ts
```

Confirm it exports `runChatPipeline(params)` with `params: { payload, aiEventId, config, portfolioState, db, isKillSwitchActive, logger, ... }` and currently inserts a single assistant row at the end. (This matches what we saw during brainstorming.)

- [ ] **Step 2: Replace `runChatPipeline` implementation**

Rewrite the file content as:

```ts
// src/lib/ai-pm/chat-pipeline.ts
import { aiChatMessages } from '@/db/schema';
import type { db as Db } from '@/db';
import type { ChatPayload } from '@/lib/ai-pm/events';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';
import type { AiPmConfigDecrypted } from '@/services/ai-pm-config.service';
import { eq } from 'drizzle-orm';
import { runToolLoop, type ToolCallEntry } from '@/lib/ai-pm/chat-loop';
import type { ToolExecContext } from '@/lib/ai-pm/chat-tools';
import type { LlmUsage } from '@/lib/ai-pm/llm';

export interface ChatPipelineResult {
  decisionId: string | null;
  assistantText: string;
  toolCallEntries: ToolCallEntry[];
  usage: LlmUsage;
}

export interface RunChatPipelineParams {
  payload: ChatPayload;
  aiEventId: string;
  config: AiPmConfigDecrypted & { id: string; userId: string; bingxApiKeyId: string; killSwitch: boolean };
  portfolioState: PortfolioState;
  db: typeof Db;
  loadChatHistoryFn: (userId: string, limit: number) => Promise<Array<{ role: 'user' | 'assistant'; content: string }>>;
  isKillSwitchActive: () => Promise<boolean>;
  runToolLoopFn?: typeof runToolLoop;
  logger: {
    info: (msg: string, ctx?: unknown) => void;
    warn: (msg: string, ctx?: unknown) => void;
    error: (msg: string, ctx?: unknown) => void;
  };
}

const HISTORY_LIMIT = 20;

export async function runChatPipeline(params: RunChatPipelineParams): Promise<ChatPipelineResult> {
  const loop = params.runToolLoopFn ?? runToolLoop;

  if (await params.isKillSwitchActive()) {
    const text = 'AI is currently disabled (kill switch active).';
    const [row] = await params.db
      .insert(aiChatMessages)
      .values({ userId: params.config.userId, role: 'assistant', content: text, toolCalls: [], decisionId: null })
      .returning();
    return { decisionId: null, assistantText: text, toolCallEntries: [], usage: zeroUsage() };
  }

  // Pre-insert empty assistant row so decision rows can FK to it.
  const [placeholder] = await params.db
    .insert(aiChatMessages)
    .values({ userId: params.config.userId, role: 'assistant', content: '', toolCalls: [], decisionId: null })
    .returning();

  const history = await params.loadChatHistoryFn(params.config.userId, HISTORY_LIMIT);

  const ctx: ToolExecContext = {
    userId: params.config.userId,
    configId: params.config.id,
    chatMessageId: placeholder.id,
    portfolioState: params.portfolioState,
    config: params.config,
    db: params.db,
    // bingxClient intentionally omitted for now — backtest path will hit guardrail rejection without one
  };

  let result: Awaited<ReturnType<typeof runToolLoop>>;
  try {
    result = await loop({
      userMessage: params.payload.userMessage,
      history,
      ctx,
      isKillSwitchOnFn: async () => (await params.isKillSwitchActive()),
    });
  } catch (err) {
    params.logger.error('chat tool loop threw', { err });
    await params.db
      .update(aiChatMessages)
      .set({ content: 'Internal error during chat processing.' })
      .where(eq(aiChatMessages.id, placeholder.id));
    return { decisionId: null, assistantText: 'Internal error during chat processing.', toolCallEntries: [], usage: zeroUsage() };
  }

  const firstDecisionId = result.toolCallEntries.find((e) => e.decisionId)?.decisionId ?? null;

  await params.db
    .update(aiChatMessages)
    .set({
      content: result.assistantText,
      toolCalls: result.toolCallEntries,
      decisionId: firstDecisionId,
      tokensInput: result.cumulativeUsage.inputTokens,
      tokensOutput: result.cumulativeUsage.outputTokens,
      cachedInputTokens: result.cumulativeUsage.cachedInputTokens,
      costUsd: String(result.cumulativeUsage.costUsd),
    })
    .where(eq(aiChatMessages.id, placeholder.id));

  return {
    decisionId: firstDecisionId,
    assistantText: result.assistantText,
    toolCallEntries: result.toolCallEntries,
    usage: result.cumulativeUsage,
  };
}

function zeroUsage(): LlmUsage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, model: 'claude-sonnet-4-6' };
}
```

- [ ] **Step 3: Update / write tests**

Open `src/lib/ai-pm/__tests__/chat-pipeline.test.ts`. If it exists and references `runChatDecision` directly, replace those tests with the following. If the file does not exist, create it with this content:

```ts
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { db } from '@/db';
import { users, aiChatMessages, aiDecisions, bingxApiKeys } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { runChatPipeline } from '@/lib/ai-pm/chat-pipeline';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000090';
const CONFIG_ID = '00000000-0000-0000-0000-000000000091';
const API_KEY_ID = '00000000-0000-0000-0000-000000000092';

async function ensureUser() {
  await db.insert(users).values({ id: TEST_USER_ID, email: 'cp@example.com' }).onConflictDoNothing();
  await db.insert(bingxApiKeys).values({ id: API_KEY_ID, userId: TEST_USER_ID, label: 'k', apiKey: 'a', secretKeyEncrypted: 'b' }).onConflictDoNothing();
}

async function cleanup() {
  await db.delete(aiDecisions).where(eq(aiDecisions.userId, TEST_USER_ID));
  await db.delete(aiChatMessages).where(eq(aiChatMessages.userId, TEST_USER_ID));
}

const baseConfig = {
  id: CONFIG_ID,
  userId: TEST_USER_ID,
  bingxApiKeyId: API_KEY_ID,
  anthropicApiKey: 'sk-test',
  enabled: true,
  mode: 'BALANCED' as const,
  maxCapitalUsdt: '1000',
  maxDrawdownPct: '20',
  maxLeverage: 5,
  allowedSymbols: [],
  allowedStrategies: [],
  maxConcurrentBots: 5,
  monthlyLlmBudgetUsd: '100',
  killSwitch: false,
  paperMode: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('runChatPipeline', () => {
  beforeAll(async () => {
    await ensureUser();
    await cleanup();
  });
  afterEach(async () => {
    await cleanup();
  });

  it('writes canned message and skips loop when kill switch is active', async () => {
    const runToolLoopFn = vi.fn();
    const got = await runChatPipeline({
      payload: { configId: CONFIG_ID, userMessage: 'hi', symbol: null, chatMessageId: 'src1', emittedAt: new Date().toISOString() },
      aiEventId: 'evt',
      config: baseConfig,
      portfolioState: { runningBots: [], capitalUsedUsdt: 0, bingxApiKeyId: API_KEY_ID },
      db,
      loadChatHistoryFn: async () => [],
      isKillSwitchActive: async () => true,
      runToolLoopFn,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    expect(runToolLoopFn).not.toHaveBeenCalled();
    expect(got.assistantText).toMatch(/kill switch/i);
    const rows = await db.select().from(aiChatMessages).where(eq(aiChatMessages.userId, TEST_USER_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toMatch(/kill switch/i);
  });

  it('pre-inserts assistant row, runs loop, and persists toolCalls + usage', async () => {
    const runToolLoopFn = vi.fn().mockImplementation(async ({ ctx }) => {
      expect(ctx.chatMessageId).toBeTruthy(); // placeholder was inserted before loop
      return {
        assistantText: 'all done',
        toolCallEntries: [
          { toolName: 'read_portfolio', args: {}, status: 'EXECUTED', decisionId: null, summary: 'snapshot' },
          { toolName: 'pause_kill_switch', args: { reason: 'risk' }, status: 'EXECUTED', decisionId: 'dec-xyz', summary: 'kill on' },
        ],
        cumulativeUsage: { inputTokens: 10, outputTokens: 20, cachedInputTokens: 0, costUsd: 0.002, model: 'claude-sonnet-4-6' },
      };
    });

    const got = await runChatPipeline({
      payload: { configId: CONFIG_ID, userMessage: 'do it', symbol: null, chatMessageId: 'src2', emittedAt: new Date().toISOString() },
      aiEventId: 'evt',
      config: baseConfig,
      portfolioState: { runningBots: [], capitalUsedUsdt: 0, bingxApiKeyId: API_KEY_ID },
      db,
      loadChatHistoryFn: async () => [],
      isKillSwitchActive: async () => false,
      runToolLoopFn,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    expect(got.assistantText).toBe('all done');
    expect(got.decisionId).toBe('dec-xyz');

    const rows = await db.select().from(aiChatMessages).where(eq(aiChatMessages.userId, TEST_USER_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('all done');
    expect(rows[0].decisionId).toBe('dec-xyz');
    expect(rows[0].tokensInput).toBe(10);
    expect(rows[0].tokensOutput).toBe(20);
    expect(Array.isArray(rows[0].toolCalls)).toBe(true);
    expect((rows[0].toolCalls as unknown[]).length).toBe(2);
  });

  it('survives loop throwing — placeholder row updated with error text', async () => {
    const runToolLoopFn = vi.fn().mockRejectedValue(new Error('boom'));
    const got = await runChatPipeline({
      payload: { configId: CONFIG_ID, userMessage: 'x', symbol: null, chatMessageId: 'src3', emittedAt: new Date().toISOString() },
      aiEventId: 'evt',
      config: baseConfig,
      portfolioState: { runningBots: [], capitalUsedUsdt: 0, bingxApiKeyId: API_KEY_ID },
      db,
      loadChatHistoryFn: async () => [],
      isKillSwitchActive: async () => false,
      runToolLoopFn,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    expect(got.assistantText).toMatch(/internal error/i);
    const rows = await db.select().from(aiChatMessages).where(eq(aiChatMessages.userId, TEST_USER_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toMatch(/internal error/i);
  });
});
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/lib/ai-pm/__tests__/chat-pipeline.test.ts
```
Expected: 3/3 green.

- [ ] **Step 5: Run wider check that the swap didn't break anything**

```bash
npx vitest run 2>&1 | tail -10
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "chat-pipeline\|chat-loop\|chat-tools" | head -20
```
Expected: 0 failing tests, 0 TS errors mentioning the new files.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ai-pm/chat-pipeline.ts src/lib/ai-pm/__tests__/chat-pipeline.test.ts
git commit -m "feat(ai-pm): chat pipeline drives tool loop and persists usage"
```

---

## Task 7: i18n + MessageBubble tool-call renderer

**Files:**
- Modify: `messages/en.json`, `messages/pt.json`, `messages/zh.json`
- Modify: `src/components/ai-pm/chat/MessageBubble.tsx`
- Modify: `src/components/ai-pm/chat/__tests__/MessageBubble.test.tsx`

Adds new i18n keys, renders `toolCalls` jsonb as a list of one-line entries under the assistant content. Each row: icon + tool name + summary, optionally linked to activity feed if `decisionId` is set.

- [ ] **Step 1: Update i18n — append to `AiPm.Chat` block**

In each of `messages/en.json`, `messages/pt.json`, `messages/zh.json`, add the following keys inside the existing `AiPm.Chat` object (alongside `typing`, `viewDecision`, etc).

`en.json`:
```json
"toolCallsHeader": "Actions",
"toolStatus.executed": "executed",
"toolStatus.rejected": "rejected",
"toolStatus.failed": "failed",
"budgetExhausted": "AI hit the per-turn budget; stopping.",
"maxTurnsHit": "AI hit the call limit.",
"killSwitchMidLoop": "Kill switch flipped mid-conversation; stopped."
```

`pt.json`:
```json
"toolCallsHeader": "Ações",
"toolStatus.executed": "executada",
"toolStatus.rejected": "rejeitada",
"toolStatus.failed": "falhou",
"budgetExhausted": "IA atingiu o limite de custo da rodada; parando.",
"maxTurnsHit": "IA atingiu o limite de chamadas.",
"killSwitchMidLoop": "Kill switch ativado durante a conversa; parando."
```

`zh.json`:
```json
"toolCallsHeader": "操作",
"toolStatus.executed": "已执行",
"toolStatus.rejected": "已拒绝",
"toolStatus.failed": "失败",
"budgetExhausted": "AI 达到本轮预算上限；停止。",
"maxTurnsHit": "AI 达到调用次数上限。",
"killSwitchMidLoop": "对话中 Kill switch 被触发；停止。"
```

- [ ] **Step 2: Verify JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('messages/en.json','utf8'))" && \
node -e "JSON.parse(require('fs').readFileSync('messages/pt.json','utf8'))" && \
node -e "JSON.parse(require('fs').readFileSync('messages/zh.json','utf8'))"
```
Expected: silent success.

- [ ] **Step 3: Add failing tests for MessageBubble**

Append to `src/components/ai-pm/chat/__tests__/MessageBubble.test.tsx` (keep existing `messages` object — but ensure it has the new keys). Update the local `messages` constant inside the test file to add the new keys:

```ts
const messages = {
  AiPm: {
    Chat: {
      typing: 'Thinking...',
      viewDecision: 'View decision',
      sendFailed: "Couldn't send. Tap to retry.",
      you: 'You',
      assistant: 'AI',
      toolCallsHeader: 'Actions',
      'toolStatus.executed': 'executed',
      'toolStatus.rejected': 'rejected',
      'toolStatus.failed': 'failed',
    },
  },
};
```

Append these new test cases:

```ts
  it('renders toolCalls list when provided', () => {
    render(wrap(
      <MessageBubble
        role="assistant"
        content="all good"
        decisionId={null}
        toolCalls={[
          { toolName: 'read_portfolio', args: {}, status: 'EXECUTED', decisionId: null, summary: '1 bot' },
          { toolName: 'create_bot', args: { symbol: 'BTC-USDT' }, status: 'EXECUTED', decisionId: 'dec-1', summary: 'created bot abc' },
          { toolName: 'create_bot', args: { symbol: 'ETH-USDT' }, status: 'REJECTED_GUARDRAIL', decisionId: 'dec-2', summary: 'guardrail tripped' },
        ]}
        createdAt="2026-05-12T00:00:00Z"
      />,
    ));
    expect(screen.getByText('Actions')).toBeInTheDocument();
    expect(screen.getByText(/read_portfolio/)).toBeInTheDocument();
    expect(screen.getByText(/1 bot/)).toBeInTheDocument();
    expect(screen.getByText(/created bot abc/)).toBeInTheDocument();
    expect(screen.getByText(/guardrail tripped/)).toBeInTheDocument();

    const links = screen.getAllByRole('link');
    const decisionLinks = links.filter((l) => l.getAttribute('href')?.includes('focus=dec-'));
    expect(decisionLinks).toHaveLength(2);
    expect(decisionLinks[0]).toHaveAttribute('href', '/dashboard/ai-pm/activity?focus=dec-1');
    expect(decisionLinks[1]).toHaveAttribute('href', '/dashboard/ai-pm/activity?focus=dec-2');
  });

  it('does not render header when toolCalls is empty or missing', () => {
    render(wrap(
      <MessageBubble
        role="assistant"
        content="hi"
        decisionId={null}
        toolCalls={[]}
        createdAt="2026-05-12T00:00:00Z"
      />,
    ));
    expect(screen.queryByText('Actions')).not.toBeInTheDocument();
  });
```

- [ ] **Step 4: Run tests — they fail**

```bash
npx vitest run src/components/ai-pm/chat/__tests__/MessageBubble.test.tsx
```
Expected: 2 new tests fail.

- [ ] **Step 5: Implement toolCalls renderer in MessageBubble**

Open `src/components/ai-pm/chat/MessageBubble.tsx`. Replace the entire file with:

```tsx
'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

export interface ToolCallEntry {
  toolName: string;
  args: unknown;
  status: 'EXECUTED' | 'REJECTED_GUARDRAIL' | 'REJECTED_BACKTEST' | 'REJECTED_REVIEWER' | 'EXECUTION_FAILED';
  decisionId: string | null;
  summary: string;
}

export interface MessageBubbleProps {
  role: 'user' | 'assistant';
  content: string;
  decisionId: string | null;
  toolCalls: ToolCallEntry[] | null;
  createdAt: string;
  pending?: boolean;
  failed?: boolean;
}

function statusIcon(status: ToolCallEntry['status']): string {
  return status === 'EXECUTED' ? '🔧' : '❌';
}

export function MessageBubble(props: MessageBubbleProps) {
  const t = useTranslations('AiPm.Chat');
  const isUser = props.role === 'user';

  const containerClass = isUser ? 'flex justify-end mb-3' : 'flex justify-start mb-3';
  const bubbleBase = 'max-w-[80%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap break-words';
  const userTint = props.failed
    ? 'bg-danger/10 border border-danger/40 text-danger-foreground'
    : 'bg-accent/15 text-foreground';
  const assistantTint = 'bg-default-100 border border-default-200 text-foreground';

  const hasToolCalls = Array.isArray(props.toolCalls) && props.toolCalls.length > 0;

  return (
    <div className={containerClass}>
      <div className="flex flex-col gap-1 max-w-full">
        <div className={`${bubbleBase} ${isUser ? userTint : assistantTint}`}>
          {props.pending ? (
            <span className="inline-flex items-center gap-1 text-muted" aria-label={t('typing')}>
              <Dot delay={0} /><Dot delay={150} /><Dot delay={300} />
              <span className="ml-2">{t('typing')}</span>
            </span>
          ) : (
            props.content
          )}
        </div>

        {props.failed && (
          <span className="text-xs text-danger pl-2">{t('sendFailed')}</span>
        )}

        {!props.pending && !isUser && hasToolCalls && (
          <div className="text-xs text-muted pl-2 mt-1 space-y-0.5">
            <div className="font-semibold">{t('toolCallsHeader')}</div>
            <ul className="space-y-0.5">
              {(props.toolCalls as ToolCallEntry[]).map((entry, i) => {
                const inner = (
                  <span>
                    <span className="mr-1">{statusIcon(entry.status)}</span>
                    <span className="font-mono mr-1">{entry.toolName}</span>
                    <span>— {entry.summary}</span>
                  </span>
                );
                return (
                  <li key={`${entry.toolName}-${i}`}>
                    {entry.decisionId ? (
                      <Link
                        href={`/dashboard/ai-pm/activity?focus=${entry.decisionId}`}
                        className="hover:underline text-accent"
                      >
                        {inner}
                      </Link>
                    ) : (
                      inner
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {!props.pending && !isUser && !hasToolCalls && props.decisionId && (
          <Link
            href={`/dashboard/ai-pm/activity?focus=${props.decisionId}`}
            className="text-xs text-accent hover:underline pl-2"
          >
            {t('viewDecision')}
          </Link>
        )}
      </div>
    </div>
  );
}

function Dot({ delay }: { delay: number }) {
  return (
    <span
      className="inline-block w-1.5 h-1.5 rounded-full bg-muted animate-pulse"
      style={{ animationDelay: `${delay}ms` }}
    />
  );
}
```

⚠️ Prop type changed from `toolCalls: unknown | null` to `toolCalls: ToolCallEntry[] | null`. `ChatClient` will be updated in Task 8 to decode the jsonb before passing in.

- [ ] **Step 6: Run tests**

```bash
npx vitest run src/components/ai-pm/chat/__tests__/MessageBubble.test.tsx
```
Expected: all green (existing 5 + 2 new = 7).

- [ ] **Step 7: Commit**

```bash
git add src/components/ai-pm/chat/MessageBubble.tsx src/components/ai-pm/chat/__tests__/MessageBubble.test.tsx messages/en.json messages/pt.json messages/zh.json
git commit -m "feat(ai-pm): render tool-call entries under assistant bubble + i18n"
```

---

## Task 8: ChatClient decodes toolCalls before pass-down

**Files:**
- Modify: `src/components/ai-pm/chat/ChatClient.tsx`
- Modify: `src/components/ai-pm/chat/MessageList.tsx`

The history API returns `toolCalls` as the raw jsonb shape stored in DB. Adapt the rendering pipeline so `MessageBubble` receives a typed `ToolCallEntry[] | null`.

- [ ] **Step 1: Modify `MessageList` to forward `toolCalls` properly**

Open `src/components/ai-pm/chat/MessageList.tsx`. Find the `<MessageBubble ... toolCalls={m.toolCalls}>` line and replace with:

```tsx
toolCalls={Array.isArray(m.toolCalls) ? (m.toolCalls as ToolCallEntry[]) : null}
```

Add import at top:
```tsx
import type { ToolCallEntry } from './MessageBubble';
```

- [ ] **Step 2: Modify `ChatClient` similarly for the pending bubble**

In `ChatClient.tsx`, the pending bubble in `MessageList` already receives `toolCalls={null}` indirectly — no change needed. Confirm by reading.

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "ai-pm/chat" | head -10
```
Expected: no errors related to chat components.

- [ ] **Step 4: Re-run all chat component tests**

```bash
npx vitest run src/components/ai-pm/chat/__tests__/
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/components/ai-pm/chat/MessageList.tsx src/components/ai-pm/chat/ChatClient.tsx
git commit -m "feat(ai-pm): MessageList forwards typed toolCalls array to bubbles"
```

---

## Task 9: Full integration check + PR

**Files:** none (verification only).

- [ ] **Step 1: Full suite**

```bash
npx vitest run 2>&1 | tail -10
npm run build 2>&1 | tail -15
npm run lint 2>&1 | tail -10
```
Expected: 0 failing tests; build succeeds; lint shows no NEW errors in touched files (`git diff main..HEAD --name-only`).

- [ ] **Step 2: Manual smoke**

Start dev server (`npm run dev` + `npm run inngest`), open `/dashboard/ai-pm/chat`, log in. Verify:
1. Send "show me my portfolio" → assistant returns a text reply that references the portfolio (tools used: `read_portfolio`). Bubble shows an "Actions" list with `🔧 read_portfolio — ...`.
2. Send "stop the bot for ETH" with no bots → assistant explains nothing to stop, possibly via `read_portfolio` then text.
3. Toggle kill switch in `/dashboard/ai-pm` → reload chat → red `KILL` chip visible; sending a message returns the canned message.
4. Activity feed (`/dashboard/ai-pm/activity`) shows new decisions with `triggered_by=CHAT` for any successful tool calls.

Don't block on failures; document them as follow-up issues if encountered.

- [ ] **Step 3: Open PR**

```bash
git push -u origin feat/ai-pm-chat-tools
gh pr create --title "feat(ai-pm): Session 16 — chat tool-use (agentic)" --body "$(cat <<'EOF'
## Summary
- Multi-turn Anthropic tool-use loop drives the chat backend
- 6 tools: read_portfolio, read_signals, read_decisions, create_bot, stop_bot, pause_kill_switch
- Reuses existing validate() + execute() pipeline; every tool call audited into ai_decisions with triggered_by=CHAT
- Schema: ai_decisions.chat_message_id FK + ai_chat_messages token/cost columns
- UI: assistant bubble lists tool calls inline, each clickable to activity feed
- i18n en/pt/zh

## Test plan
- [ ] vitest green
- [ ] build green
- [ ] Manual: read_portfolio via chat populates Actions list
- [ ] Manual: kill switch active → canned reply
- [ ] Manual: create_bot via chat appears in activity feed

Spec: \`docs/superpowers/specs/2026-05-12-ai-pm-chat-tools-design.md\`
Plan: \`docs/superpowers/plans/2026-05-12-ai-portfolio-manager-session-16.md\`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Six tools — Task 3 ✓
- Multi-turn loop with MAX_TURNS / cost cap / kill-switch mid-loop — Task 5 ✓
- `callSonnetTools` LLM helper — Task 2 ✓
- Schema migration (chat_message_id + token cols) — Task 1 ✓
- `chatMessageId` threaded through validate — Task 4 ✓
- Pre-insert assistant row pattern — Task 6 ✓
- chat-pipeline replacement with tool loop — Task 6 ✓
- Token usage persisted on `ai_chat_messages` — Task 6 ✓
- UI renderer for toolCalls — Task 7 ✓
- ChatClient decode toolCalls — Task 8 ✓
- i18n keys — Task 7 ✓
- Tests at all four levels (llm / chat-tools / chat-loop / chat-pipeline / MessageBubble) — Tasks 2/3/5/6/7 ✓

**Placeholder scan:** none — every step shows concrete code. Two warnings explicitly call out task ordering (Task 3 mocks validate; Task 4 wires it; Task 7 changes prop type; Task 8 fixes call sites) — these are documentation, not unfinished work.

**Type consistency:** `ToolCallEntry` defined in Task 5 (`chat-loop.ts`). Task 7 redefines it as a UI type in `MessageBubble.tsx`. **Intentional**: the loop type and the UI type are structurally identical but live in different modules to avoid coupling UI to lib internals. If you want to dedupe later, re-export from one source.

`ToolStatus` from `chat-tools.ts` matches `ToolCallEntry.status` in `chat-loop.ts` (both reference `'EXECUTED' | 'REJECTED_GUARDRAIL' | 'REJECTED_BACKTEST' | 'REJECTED_REVIEWER' | 'EXECUTION_FAILED'`).

`ToolExecContext.config` uses `AiPmConfigDecrypted` from `@/services/ai-pm-config.service` — same import used by existing chat-pipeline.

**Known gaps / accepted:**
- `bingxClient` not threaded into the chat pipeline path; `create_bot` will hit the backtest-requires-client guardrail and reject. That's intentional v1: paper-mode users can still create bots (executor branches before backtest is needed). Real-mode bot creation via chat would require wiring `bingxClient` into `runChatPipeline`. Note in PR.
- `adjust_params` and `reallocate_capital` deferred (executor stubs not ready).
