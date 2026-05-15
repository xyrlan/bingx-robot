import { describe, it, expect } from 'vitest';
import { runDecision } from '@/lib/ai-pm/decision';
import type { AnthropicFactory } from '@/lib/ai-pm/llm';
import type { SignalCandidate } from '@/lib/ai-pm/signal';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';
import {
  buildUserPrompt,
  buildAutonomousUserPrompt,
  buildAutonomousSystemPrompt,
  AutonomousActionSchema,
  type DecisionConfig,
} from '@/lib/ai-pm/decision.prompt';

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

describe('buildAutonomousSystemPrompt', () => {
  it('describes only direct-order actions and excludes bot-management types', () => {
    const sys = buildAutonomousSystemPrompt();
    // Direct-order surface
    expect(sys).toContain('place_market_order');
    expect(sys).toContain('place_limit_order');
    expect(sys).toContain('place_stop_order');
    expect(sys).toContain('place_take_profit');
    expect(sys).toContain('place_trailing_stop');
    expect(sys).toContain('close_position');
    expect(sys).toContain('cancel_order');
    expect(sys).toContain('cancel_all_orders');
    expect(sys).toContain('no_action');
    // Bot-management actions deprecated in autonomous mode
    expect(sys).not.toContain('create_bot');
    expect(sys).not.toContain('stop_bot');
    expect(sys).not.toContain('adjust_params');
    expect(sys).not.toContain('reallocate_capital');
  });

  it('reminds the model to reconcile with reported open positions', () => {
    const sys = buildAutonomousSystemPrompt();
    expect(sys.toLowerCase()).toContain('reconcile');
    expect(sys.toLowerCase()).toContain('open position');
  });
});

describe('buildAutonomousUserPrompt', () => {
  const stateWithLive: PortfolioState = {
    ...baseState,
    availableBalanceUsdt: 500,
    openPositions: [
      { symbol: 'BTC-USDT', positionSide: 'LONG', positionAmt: 0.5, entryPrice: 60000, unrealizedPnl: 120, leverage: 10, positionId: 'p1' },
    ],
    openOrders: [
      { orderId: 'o7', symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG', type: 'LIMIT', price: '59000', stopPrice: '0', quantity: '0.01' },
    ],
  };

  it('shows real positions with entry/qty/pnl/leverage', () => {
    const prompt = buildAutonomousUserPrompt({
      candidates: baseCandidates,
      portfolioState: stateWithLive,
      config: baseConfig,
    });
    expect(prompt).toContain('Open positions:');
    expect(prompt).toContain('BTC-USDT');
    expect(prompt).toContain('LONG');
    expect(prompt).toContain('entry=60000');
    expect(prompt).toContain('qty=0.5');
    expect(prompt).toContain('pnl=120');
    expect(prompt).toContain('lev=10');
  });

  it('shows open orders with id/type/side/price', () => {
    const prompt = buildAutonomousUserPrompt({
      candidates: baseCandidates,
      portfolioState: stateWithLive,
      config: baseConfig,
    });
    expect(prompt).toContain('Open orders:');
    expect(prompt).toContain('id=o7');
    expect(prompt).toContain('type=LIMIT');
    expect(prompt).toContain('side=BUY');
    expect(prompt).toContain('price=59000');
  });

  it('shows available margin and effective spendable', () => {
    const prompt = buildAutonomousUserPrompt({
      candidates: baseCandidates,
      portfolioState: stateWithLive,
      config: baseConfig,
    });
    expect(prompt).toContain('Real available margin USDT: 500');
    expect(prompt).toContain('Effective spendable USDT:');
  });

  it('shows signal candidates and (none) placeholders for empties', () => {
    const prompt = buildAutonomousUserPrompt({
      candidates: baseCandidates,
      portfolioState: { ...baseState, openPositions: [], openOrders: [] },
      config: baseConfig,
    });
    expect(prompt).toContain('Signal candidates:');
    expect(prompt).toContain('ETH-USDT');
    expect(prompt).toContain('Open positions:\n(none)');
    expect(prompt).toContain('Open orders:\n(none)');
  });

  it('omits the legacy "Running AI bots" section', () => {
    const prompt = buildAutonomousUserPrompt({
      candidates: baseCandidates,
      portfolioState: stateWithLive,
      config: baseConfig,
    });
    expect(prompt).not.toContain('Running AI bots');
  });
});

describe('AutonomousActionSchema', () => {
  it('accepts direct-order action shapes', () => {
    expect(AutonomousActionSchema.safeParse({ type: 'no_action', reasoning: 'r' }).success).toBe(true);
    expect(
      AutonomousActionSchema.safeParse({
        type: 'place_market_order',
        symbol: 'BTC-USDT',
        side: 'BUY',
        positionSide: 'LONG',
        capitalUsdt: 50,
        leverage: 5,
        reasoning: 'r',
      }).success,
    ).toBe(true);
    expect(AutonomousActionSchema.safeParse({ type: 'close_position', symbol: 'BTC-USDT', reasoning: 'r' }).success).toBe(true);
    expect(
      AutonomousActionSchema.safeParse({ type: 'cancel_order', symbol: 'BTC-USDT', orderId: 'o1', reasoning: 'r' }).success,
    ).toBe(true);
  });

  it('rejects bot-management action shapes', () => {
    expect(
      AutonomousActionSchema.safeParse({ type: 'create_bot', symbol: 'X', strategy: 'DCA', capitalUsdt: 10, leverage: 1, reasoning: 'r' }).success,
    ).toBe(false);
    expect(AutonomousActionSchema.safeParse({ type: 'stop_bot', botId: '00000000-0000-0000-0000-000000000001', reasoning: 'r' }).success).toBe(false);
    expect(
      AutonomousActionSchema.safeParse({ type: 'adjust_params', botId: '00000000-0000-0000-0000-000000000001', params: {}, reasoning: 'r' }).success,
    ).toBe(false);
    expect(
      AutonomousActionSchema.safeParse({
        type: 'reallocate_capital',
        fromBotId: '00000000-0000-0000-0000-000000000001',
        toBotId: '00000000-0000-0000-0000-000000000002',
        amountUsdt: 10,
        reasoning: 'r',
      }).success,
    ).toBe(false);
  });
});

describe('runDecision — autonomous mode', () => {
  it('drops bot-management actions and keeps direct-order actions', async () => {
    const input = {
      actions: [
        { type: 'create_bot', symbol: 'BTC-USDT', strategy: 'DCA', capitalUsdt: 50, leverage: 3, reasoning: 'r' },
        {
          type: 'place_market_order',
          symbol: 'ETH-USDT',
          side: 'BUY',
          positionSide: 'LONG',
          capitalUsdt: 80,
          leverage: 5,
          reasoning: 'r',
        },
        { type: 'no_action', reasoning: 'wait' },
      ],
    };
    const result = await runDecision({
      userId,
      candidates: baseCandidates,
      portfolioState: baseState,
      config: baseConfig,
      anthropicApiKey: 'sk-ant',
      factory: fakeFactory({ toolUseInput: input }),
      autonomous: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.result.proposedActions.map((a) => a.type)).toEqual(['place_market_order', 'no_action']);
    expect(result.result.rejectedActions).toHaveLength(1);
  });
});
