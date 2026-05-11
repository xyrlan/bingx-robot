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
