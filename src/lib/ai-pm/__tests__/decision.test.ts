import { describe, it, expect } from 'vitest';
import { runDecision } from '@/lib/ai-pm/decision';
import type { AnthropicFactory } from '@/lib/ai-pm/llm';
import type { SignalCandidate } from '@/lib/ai-pm/signal';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';
import { buildUserPrompt, type DecisionConfig } from '@/lib/ai-pm/decision.prompt';

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

describe('buildUserPrompt — available margin', () => {
  it('shows the real available margin when known', () => {
    const prompt = buildUserPrompt({
      candidates: baseCandidates,
      portfolioState: { ...baseState, availableBalanceUsdt: 500 },
      config: baseConfig,
    });
    expect(prompt).toContain('Real available margin USDT: 500');
  });

  it('shows "unknown" for available margin when the balance fetch failed', () => {
    const prompt = buildUserPrompt({
      candidates: baseCandidates,
      portfolioState: baseState,
      config: baseConfig,
    });
    expect(prompt).toContain('Real available margin USDT: unknown');
  });

  it('shows effective spendable capped by the 90% margin headroom', () => {
    const prompt = buildUserPrompt({
      candidates: baseCandidates,
      portfolioState: { ...baseState, availableBalanceUsdt: 500 },
      config: baseConfig,
    });
    // min(maxCapital 1000 - used 100, avail 500 * 0.9) = min(900, 450) = 450
    expect(prompt).toContain('Effective spendable USDT: 450');
  });
});
