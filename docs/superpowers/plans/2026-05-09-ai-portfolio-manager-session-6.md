# AI Portfolio Manager — Session 6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Single entry point for AI calls. Routes between Haiku 4.5, Sonnet 4.6, and Opus 4.7. Decrypts the user's BYOK Anthropic key (Session 2). Validates LLM output via Zod schemas. Computes cost per call (USD) from a constants table. Returns `{ data, usage }` for downstream auditing.

**Architecture:** Pure dispatch layer. The router does NOT make decisions, write to DB, or know about portfolio state. Callers (Signal, Decision, Reviewer) hand it a prompt + schema; it hands back parsed data + usage. Errors map to a small enum. Prompt caching (system block) is enabled by default for Sonnet calls; Haiku and Opus default to non-cached but can opt in.

**Tech Stack:** TypeScript · `@anthropic-ai/sdk` · Zod · Vitest · Bun

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/lib/ai-pm/llm.constants.ts` | Create | Model IDs + per-million-token USD prices |
| `src/lib/ai-pm/llm.ts` | Create | Public router: `getClient`, `callHaiku`, `callSonnet`, `callOpus`. Cost computation, error classification |
| `src/lib/ai-pm/__tests__/llm.test.ts` | Create | Vitest coverage with injected fake Anthropic client. Cost math, schema parsing, error paths |

The router uses the same factory-injection pattern that the BYOK service settled on in Session 2 (where vitest's ESM `vi.doMock` did not interact cleanly with already-imported modules). Factory shape:

```ts
type AnthropicFactory = (apiKey: string) => AnthropicLike;
```

Default factory wraps the real SDK. Tests inject a fake.

---

## Task 1: Constants module

**Files:**
- Create: `src/lib/ai-pm/llm.constants.ts`

- [ ] **Step 1: Write the file**

```ts
/**
 * Model IDs and per-million-token USD prices for the LLM router.
 *
 * Update these values when Anthropic publishes new pricing or models.
 * Prices are USD per 1,000,000 tokens. The router converts them to per-token
 * before computing call costs.
 *
 * Source: https://www.anthropic.com/pricing (verify periodically).
 */

export const MODEL_HAIKU = 'claude-haiku-4-5';
export const MODEL_SONNET = 'claude-sonnet-4-6';
export const MODEL_OPUS = 'claude-opus-4-7';

export type ModelId = typeof MODEL_HAIKU | typeof MODEL_SONNET | typeof MODEL_OPUS;

export interface ModelPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
}

export const PRICING: Record<ModelId, ModelPricing> = {
  [MODEL_HAIKU]: {
    inputUsdPerMillion: 1.0,
    outputUsdPerMillion: 5.0,
    cachedInputUsdPerMillion: 0.10,
  },
  [MODEL_SONNET]: {
    inputUsdPerMillion: 3.0,
    outputUsdPerMillion: 15.0,
    cachedInputUsdPerMillion: 0.30,
  },
  [MODEL_OPUS]: {
    inputUsdPerMillion: 15.0,
    outputUsdPerMillion: 75.0,
    cachedInputUsdPerMillion: 1.50,
  },
};

export interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export function calculateCostUsd(model: ModelId, usage: UsageBreakdown): number {
  const pricing = PRICING[model];
  const regularInput = usage.inputTokens - usage.cachedInputTokens;
  const inputCost = (regularInput / 1_000_000) * pricing.inputUsdPerMillion;
  const cachedCost =
    pricing.cachedInputUsdPerMillion != null
      ? (usage.cachedInputTokens / 1_000_000) * pricing.cachedInputUsdPerMillion
      : 0;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputUsdPerMillion;
  return inputCost + cachedCost + outputCost;
}
```

- [ ] **Step 2: Lint** — `bunx eslint src/lib/ai-pm/llm.constants.ts` clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/ai-pm/llm.constants.ts
git commit -m "feat(ai-pm): add LLM model IDs and pricing constants"
```

---

## Task 2: Router + tests (TDD)

**Files:**
- Create: `src/lib/ai-pm/llm.ts`
- Create: `src/lib/ai-pm/__tests__/llm.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/lib/ai-pm/__tests__/llm.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  callHaiku,
  callSonnet,
  callOpus,
  type AnthropicFactory,
  type LlmError,
} from '@/lib/ai-pm/llm';
import { MODEL_HAIKU, MODEL_SONNET, MODEL_OPUS, calculateCostUsd } from '@/lib/ai-pm/llm.constants';

function fakeFactory(opts: {
  responseText?: string;
  toolUse?: { name: string; input: unknown };
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  shouldThrow?: Error;
}): AnthropicFactory {
  return () => ({
    messages: {
      create: async () => {
        if (opts.shouldThrow) throw opts.shouldThrow;
        const content = opts.toolUse
          ? [{ type: 'tool_use', id: 'tu_1', name: opts.toolUse.name, input: opts.toolUse.input }]
          : [{ type: 'text', text: opts.responseText ?? '{}' }];
        return {
          id: 'msg_1',
          model: 'claude-test',
          role: 'assistant',
          content,
          stop_reason: 'end_turn',
          stop_sequence: null,
          type: 'message',
          usage: {
            input_tokens: opts.inputTokens ?? 100,
            output_tokens: opts.outputTokens ?? 20,
            cache_read_input_tokens: opts.cachedInputTokens ?? 0,
            cache_creation_input_tokens: 0,
          },
        };
      },
    },
  });
}

describe('callHaiku', () => {
  it('parses JSON text response with Zod schema and returns data + usage', async () => {
    const schema = z.object({ regime: z.enum(['range', 'trend_up']), score: z.number() });
    const factory = fakeFactory({
      responseText: '{"regime":"range","score":75}',
      inputTokens: 1000,
      outputTokens: 50,
    });

    const result = await callHaiku({
      apiKey: 'sk-ant',
      systemPrompt: 'You are a market analyst.',
      userPrompt: 'Classify BTC.',
      schema,
      factory,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.regime).toBe('range');
    expect(result.data.score).toBe(75);
    expect(result.usage.inputTokens).toBe(1000);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.usage.costUsd).toBeCloseTo(
      calculateCostUsd(MODEL_HAIKU, { inputTokens: 1000, outputTokens: 50, cachedInputTokens: 0 }),
      6,
    );
  });

  it('returns SCHEMA_REJECTED when response does not match schema', async () => {
    const schema = z.object({ regime: z.string(), score: z.number() });
    const factory = fakeFactory({ responseText: '{"regime":"range"}' });

    const result = await callHaiku({
      apiKey: 'sk-ant',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      schema,
      factory,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect((result.error as LlmError).kind).toBe('SCHEMA_REJECTED');
  });

  it('returns INVALID_JSON when response is not valid JSON', async () => {
    const schema = z.object({ x: z.number() });
    const factory = fakeFactory({ responseText: 'not json at all' });

    const result = await callHaiku({
      apiKey: 'sk-ant',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      schema,
      factory,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect((result.error as LlmError).kind).toBe('INVALID_JSON');
  });

  it('returns API_ERROR when SDK throws', async () => {
    const factory = fakeFactory({ shouldThrow: new Error('401 unauthorized') });

    const result = await callHaiku({
      apiKey: 'sk-ant',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      schema: z.object({}),
      factory,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect((result.error as LlmError).kind).toBe('API_ERROR');
    expect((result.error as LlmError).message).toMatch(/401/);
  });

  it('factors cached input tokens into cost calculation', async () => {
    const schema = z.object({ ok: z.boolean() });
    const factory = fakeFactory({
      responseText: '{"ok":true}',
      inputTokens: 10_000,
      cachedInputTokens: 9_000,
      outputTokens: 100,
    });

    const result = await callHaiku({
      apiKey: 'sk-ant',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      schema,
      factory,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.usage.cachedInputTokens).toBe(9_000);
    expect(result.usage.costUsd).toBeCloseTo(
      calculateCostUsd(MODEL_HAIKU, { inputTokens: 10_000, outputTokens: 100, cachedInputTokens: 9_000 }),
      6,
    );
  });
});

describe('callSonnet', () => {
  it('returns parsed tool-use args when SDK responds with tool_use block', async () => {
    const toolSchema = z.object({ symbol: z.string(), strategy: z.string() });
    const factory = fakeFactory({
      toolUse: { name: 'create_bot', input: { symbol: 'BTC-USDT', strategy: 'DCA' } },
    });

    const result = await callSonnet({
      apiKey: 'sk-ant',
      systemPrompt: 'You decide bot actions.',
      userPrompt: 'Decide.',
      tools: [{ name: 'create_bot', description: 'Create a bot', schema: toolSchema }],
      factory,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.toolName).toBe('create_bot');
    expect(result.data.args).toEqual({ symbol: 'BTC-USDT', strategy: 'DCA' });
  });

  it('rejects tool-use args that fail the matching schema', async () => {
    const toolSchema = z.object({ symbol: z.string(), capital: z.number() });
    const factory = fakeFactory({
      toolUse: { name: 'create_bot', input: { symbol: 'BTC-USDT' } }, // missing capital
    });

    const result = await callSonnet({
      apiKey: 'sk-ant',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      tools: [{ name: 'create_bot', description: 'd', schema: toolSchema }],
      factory,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect((result.error as LlmError).kind).toBe('SCHEMA_REJECTED');
  });

  it('returns NO_TOOL_USE when response has only text (no tool block)', async () => {
    const toolSchema = z.object({ x: z.number() });
    const factory = fakeFactory({ responseText: 'I refuse to use tools.' });

    const result = await callSonnet({
      apiKey: 'sk-ant',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      tools: [{ name: 't', description: 'd', schema: toolSchema }],
      factory,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect((result.error as LlmError).kind).toBe('NO_TOOL_USE');
  });
});

describe('callOpus', () => {
  it('parses text response with Zod schema, like callHaiku', async () => {
    const schema = z.object({ verdict: z.enum(['approve', 'veto']), rationale: z.string() });
    const factory = fakeFactory({
      responseText: '{"verdict":"approve","rationale":"backtest positive"}',
    });

    const result = await callOpus({
      apiKey: 'sk-ant',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      schema,
      factory,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.verdict).toBe('approve');
  });
});
```

- [ ] **Step 2: Run failing tests** — module not found.

- [ ] **Step 3: Implement the router**

Create `src/lib/ai-pm/llm.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import {
  MODEL_HAIKU,
  MODEL_SONNET,
  MODEL_OPUS,
  type ModelId,
  calculateCostUsd,
} from '@/lib/ai-pm/llm.constants';

interface AnthropicMessageContent {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicMessageResponse {
  content: AnthropicMessageContent[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

interface AnthropicLike {
  messages: {
    create: (params: Record<string, unknown>) => Promise<AnthropicMessageResponse>;
  };
}

export type AnthropicFactory = (apiKey: string) => AnthropicLike;

const defaultFactory: AnthropicFactory = (apiKey) =>
  new Anthropic({ apiKey }) as unknown as AnthropicLike;

export type LlmError =
  | { kind: 'API_ERROR'; message: string }
  | { kind: 'INVALID_JSON'; message: string; raw: string }
  | { kind: 'SCHEMA_REJECTED'; message: string; issues: unknown }
  | { kind: 'NO_TOOL_USE'; message: string }
  | { kind: 'EMPTY_RESPONSE'; message: string };

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  model: ModelId;
}

export type LlmResult<T> =
  | { ok: true; data: T; usage: LlmUsage }
  | { ok: false; error: LlmError; usage?: LlmUsage };

interface BaseCallParams {
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
  factory?: AnthropicFactory;
  maxTokens?: number;
  cacheSystem?: boolean;
}

interface JsonCallParams<T> extends BaseCallParams {
  schema: z.ZodType<T>;
}

export interface ToolDefinition<T> {
  name: string;
  description: string;
  schema: z.ZodType<T>;
}

interface ToolCallParams<T> extends BaseCallParams {
  tools: ToolDefinition<T>[];
}

function extractUsage(model: ModelId, raw: AnthropicMessageResponse['usage']): LlmUsage {
  const inputTokens = raw.input_tokens;
  const outputTokens = raw.output_tokens;
  const cachedInputTokens = raw.cache_read_input_tokens ?? 0;
  const costUsd = calculateCostUsd(model, { inputTokens, outputTokens, cachedInputTokens });
  return { inputTokens, outputTokens, cachedInputTokens, costUsd, model };
}

function buildSystem(prompt: string, cacheSystem: boolean): unknown {
  if (!cacheSystem) return prompt;
  return [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }];
}

async function callJsonModel<T>(
  model: ModelId,
  params: JsonCallParams<T>,
  defaultCache: boolean,
): Promise<LlmResult<T>> {
  const factory = params.factory ?? defaultFactory;
  const cacheSystem = params.cacheSystem ?? defaultCache;
  const client = factory(params.apiKey);

  let response: AnthropicMessageResponse;
  try {
    response = await client.messages.create({
      model,
      max_tokens: params.maxTokens ?? 1024,
      system: buildSystem(params.systemPrompt, cacheSystem),
      messages: [{ role: 'user', content: params.userPrompt }],
    });
  } catch (err) {
    return {
      ok: false,
      error: { kind: 'API_ERROR', message: err instanceof Error ? err.message : String(err) },
    };
  }

  const usage = extractUsage(model, response.usage);
  const textBlock = response.content.find((c) => c.type === 'text' && typeof c.text === 'string');
  if (!textBlock || !textBlock.text) {
    return { ok: false, error: { kind: 'EMPTY_RESPONSE', message: 'No text content' }, usage };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: 'INVALID_JSON',
        message: err instanceof Error ? err.message : String(err),
        raw: textBlock.text,
      },
      usage,
    };
  }

  const result = params.schema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: {
        kind: 'SCHEMA_REJECTED',
        message: 'Zod validation failed',
        issues: result.error.issues,
      },
      usage,
    };
  }

  return { ok: true, data: result.data, usage };
}

export function callHaiku<T>(params: JsonCallParams<T>): Promise<LlmResult<T>> {
  return callJsonModel(MODEL_HAIKU, params, false);
}

export function callOpus<T>(params: JsonCallParams<T>): Promise<LlmResult<T>> {
  return callJsonModel(MODEL_OPUS, params, false);
}

export interface SonnetToolResult {
  toolName: string;
  args: unknown;
}

export async function callSonnet<T>(
  params: ToolCallParams<T>,
): Promise<LlmResult<SonnetToolResult>> {
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
      messages: [{ role: 'user', content: params.userPrompt }],
    });
  } catch (err) {
    return {
      ok: false,
      error: { kind: 'API_ERROR', message: err instanceof Error ? err.message : String(err) },
    };
  }

  const usage = extractUsage(MODEL_SONNET, response.usage);
  const toolBlock = response.content.find((c) => c.type === 'tool_use');
  if (!toolBlock || !toolBlock.name) {
    return {
      ok: false,
      error: { kind: 'NO_TOOL_USE', message: 'Sonnet returned no tool_use block' },
      usage,
    };
  }

  const matched = params.tools.find((t) => t.name === toolBlock.name);
  if (!matched) {
    return {
      ok: false,
      error: {
        kind: 'SCHEMA_REJECTED',
        message: `Unknown tool name: ${toolBlock.name}`,
        issues: [],
      },
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
    data: { toolName: toolBlock.name, args: validation.data },
    usage,
  };
}

/**
 * Minimal Zod-to-JSON-Schema converter for Anthropic tool input schemas.
 * Only supports the subset of Zod we use: z.object, z.string, z.number,
 * z.boolean, z.array, z.enum, z.optional, z.literal.
 *
 * Larger projects should use a library like `zod-to-json-schema`. We avoid
 * the dependency for now; widen this function as new schema shapes appear.
 */
function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const def = (schema as unknown as { _def: { typeName: string; [key: string]: unknown } })._def;

  switch (def.typeName) {
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodLiteral':
      return { const: (def as { value: unknown }).value };
    case 'ZodEnum':
      return { type: 'string', enum: (def as { values: string[] }).values };
    case 'ZodArray': {
      const inner = (def as { type: z.ZodType }).type;
      return { type: 'array', items: zodToJsonSchema(inner) };
    }
    case 'ZodOptional': {
      const inner = (def as { innerType: z.ZodType }).innerType;
      return zodToJsonSchema(inner);
    }
    case 'ZodObject': {
      const shape = (def as { shape: () => Record<string, z.ZodType> }).shape();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
        const innerDef = (value as unknown as { _def: { typeName: string } })._def;
        if (innerDef.typeName !== 'ZodOptional') required.push(key);
      }
      return { type: 'object', properties, required };
    }
    default:
      // Fallback: permissive object so the tool definition still works.
      return { type: 'object' };
  }
}
```

- [ ] **Step 4: Run tests** — expect 9/9 pass.

- [ ] **Step 5: Run full suite** — expect 84 + 9 = 93.

- [ ] **Step 6: Lint** — `bunx eslint src/lib/ai-pm/llm.ts src/lib/ai-pm/__tests__/llm.test.ts` clean.

- [ ] **Step 7: Build** — `bun run build` clean (no TypeScript errors).

- [ ] **Step 8: Commit**

```bash
git add src/lib/ai-pm/llm.ts src/lib/ai-pm/__tests__/llm.test.ts
git commit -m "feat(ai-pm): add LLM router with cost tracking and schema validation"
```

---

## Self-Review

- **Spec coverage:** S6 entry asks for `getClient(userId)`, `callHaiku`, `callSonnet`, `callOpus` returning `{ data, usage }`. Implementation provides all three call functions. `getClient(userId)` is intentionally NOT exported here — Session 7+ callers will hand the API key in directly (already decrypted via the BYOK service from Session 2). Centralizing decryption inside the router would force the router to import the DB layer and break its purity.
- **Cost tracking:** `LlmUsage.costUsd` computed from constants table; cached input tokens factored.
- **Error classification:** `API_ERROR`, `INVALID_JSON`, `SCHEMA_REJECTED`, `NO_TOOL_USE`, `EMPTY_RESPONSE` — covers the failure modes the spec calls out.
- **Prompt caching:** Sonnet defaults to cached system block (matches spec); Haiku/Opus default off to keep simple cases simple. Caller can opt in via `cacheSystem: true`.
- **No DB, no IO outside Anthropic:** router stays a pure dispatch.

## Done Criteria

1. `MODEL_HAIKU`, `MODEL_SONNET`, `MODEL_OPUS`, `PRICING`, `calculateCostUsd` exported.
2. `callHaiku`, `callSonnet`, `callOpus`, `AnthropicFactory`, `LlmError`, `LlmUsage`, `LlmResult` exported.
3. 9 tests pass covering: text-JSON happy path, schema rejection, invalid JSON, API error, cached cost calc, tool-use happy path, tool-arg rejection, no-tool-use response, Opus text path.
4. Full suite passes (93 tests).
5. Lint + build clean.
