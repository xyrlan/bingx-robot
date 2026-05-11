import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  callHaiku,
  callSonnet,
  callOpus,
  type AnthropicFactory,
  type LlmError,
} from '@/lib/ai-pm/llm';
import { MODEL_HAIKU, calculateCostUsd } from '@/lib/ai-pm/llm.constants';

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

  it('strips ```json code fence before parsing', async () => {
    const schema = z.object({ x: z.number() });
    const factory = fakeFactory({ responseText: '```json\n{"x":7}\n```' });

    const result = await callHaiku({
      apiKey: 'sk-ant',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      schema,
      factory,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data).toEqual({ x: 7 });
  });

  it('strips bare ``` code fence before parsing', async () => {
    const schema = z.object({ x: z.number() });
    const factory = fakeFactory({ responseText: '```\n{"x":9}\n```' });

    const result = await callHaiku({
      apiKey: 'sk-ant',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      schema,
      factory,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data).toEqual({ x: 9 });
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
      toolUse: { name: 'create_bot', input: { symbol: 'BTC-USDT' } },
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
