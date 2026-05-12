import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  callHaiku,
  callSonnet,
  callSonnetTools,
  callOpus,
  callSonnetText,
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

describe('callSonnetText', () => {
  it('returns plain text when Sonnet responds with a text block', async () => {
    const factory = fakeFactory({ responseText: 'Markets look stable.' });

    const result = await callSonnetText({
      apiKey: 'sk-ant',
      systemPrompt: 'You are a trading assistant.',
      userPrompt: 'How are markets?',
      factory,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.text).toBe('Markets look stable.');
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
          { type: 'tool_use', id: 'tu_1', name: 'create_bot', input: { symbol: 'X' } },
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

describe('callSonnetTools — streaming', () => {
  it('invokes onTextChunk for each text delta and returns the assembled text', async () => {
    const chunks: string[] = [];
    function makeStreamFactory() {
      return () => ({
        messages: {
          create: vi.fn(),
          stream: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } };
              yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo!' } };
            },
            finalMessage: async () => ({
              content: [{ type: 'text', text: 'Hello!' }],
              usage: { input_tokens: 2, output_tokens: 2 },
            }),
          }),
        },
      });
    }

    const got = await callSonnetTools({
      apiKey: 'k', systemPrompt: 'sys', messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      factory: makeStreamFactory() as any,
      onTextChunk: (c) => { chunks.push(c); },
    });
    expect(got.ok).toBe(true);
    if (got.ok && got.data.kind === 'text') {
      expect(got.data.text).toBe('Hello!');
    }
    expect(chunks).toEqual(['Hel', 'lo!']);
  });

  it('streaming path forwards onToolUseStart when the model picks a tool', async () => {
    const { z } = await import('zod');
    const starts: Array<{ toolName: string; args: unknown }> = [];
    function makeFactory() {
      return () => ({
        messages: {
          create: vi.fn(),
          stream: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_5', name: 'read_portfolio', input: {} } };
            },
            finalMessage: async () => ({
              content: [{ type: 'tool_use', id: 'tu_5', name: 'read_portfolio', input: {} }],
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          }),
        },
      });
    }

    const got = await callSonnetTools({
      apiKey: 'k', systemPrompt: 'sys', messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'read_portfolio', description: 'x', schema: z.object({}) }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      factory: makeFactory() as any,
      onTextChunk: () => {},
      onToolUseStart: (info) => { starts.push(info); },
    });
    expect(got.ok).toBe(true);
    if (got.ok && got.data.kind === 'tool_use') {
      expect(got.data.toolName).toBe('read_portfolio');
    }
    expect(starts).toEqual([{ toolName: 'read_portfolio', args: {} }]);
  });

  it('streaming path returns API_ERROR when stream() throws', async () => {
    function makeFactory() {
      return () => ({
        messages: {
          create: vi.fn(),
          stream: () => { throw new Error('boom'); },
        },
      });
    }
    const got = await callSonnetTools({
      apiKey: 'k', systemPrompt: 'sys', messages: [{ role: 'user', content: 'x' }],
      tools: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      factory: makeFactory() as any,
      onTextChunk: () => {},
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.kind).toBe('API_ERROR');
  });
});
