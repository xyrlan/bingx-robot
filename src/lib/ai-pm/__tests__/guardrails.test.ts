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
  maxLeverage: 20,
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

const baseCfg = {
  maxCapitalUsdt: 1000,
  maxConcurrentBots: 5,
  maxLeverage: 5,
  allowedStrategies: ['DCA', 'TRAILING_STOP', 'DCA_SPOT', 'SMA_CROSSOVER'] as const,
  killSwitch: false,
};

const baseStateMulti = {
  runningBots: [
    { id: 'bot-1', symbol: 'BTC-USDT', strategy: 'DCA' as const, capitalUsdt: 100, leverage: 2, status: 'RUNNING' as const },
    { id: 'bot-2', symbol: 'ETH-USDT', strategy: 'DCA' as const, capitalUsdt: 200, leverage: 3, status: 'RUNNING' as const },
  ],
  capitalUsedUsdt: 300,
  bingxApiKeyId: 'key-1',
};

describe('runGuardrails — adjust_params', () => {
  it('rejects when bot not running', () => {
    const got = runGuardrails({
      action: { type: 'adjust_params', botId: 'bot-X', params: { capitalUsdt: 200 }, reasoning: 'r' },
      config: { ...baseCfg, allowedStrategies: [...baseCfg.allowedStrategies] },
      portfolioState: baseStateMulti,
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe('UNKNOWN_BOT_ID');
  });

  it('rejects when new leverage exceeds maxLeverage', () => {
    const got = runGuardrails({
      action: { type: 'adjust_params', botId: 'bot-1', params: { leverage: 10 }, reasoning: 'r' },
      config: { ...baseCfg, allowedStrategies: [...baseCfg.allowedStrategies] },
      portfolioState: baseStateMulti,
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe('LEVERAGE_CAP');
  });

  it('rejects when new capital pushes total over maxCapitalUsdt', () => {
    const got = runGuardrails({
      action: { type: 'adjust_params', botId: 'bot-1', params: { capitalUsdt: 950 }, reasoning: 'r' },
      config: { ...baseCfg, allowedStrategies: [...baseCfg.allowedStrategies] },
      portfolioState: baseStateMulti,
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe('CAPITAL_CAP');
  });

  it('rejects when new strategy is not allowed', () => {
    const got = runGuardrails({
      action: { type: 'adjust_params', botId: 'bot-1', params: { strategy: 'NOT_A_STRATEGY' as never }, reasoning: 'r' },
      config: { ...baseCfg, allowedStrategies: ['DCA'] },
      portfolioState: baseStateMulti,
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe('STRATEGY_NOT_ALLOWED');
  });

  it('accepts well-bounded adjust', () => {
    const got = runGuardrails({
      action: { type: 'adjust_params', botId: 'bot-1', params: { capitalUsdt: 150, leverage: 3 }, reasoning: 'r' },
      config: { ...baseCfg, allowedStrategies: [...baseCfg.allowedStrategies] },
      portfolioState: baseStateMulti,
    });
    expect(got.ok).toBe(true);
  });
});

describe('runGuardrails — reallocate_capital', () => {
  it('rejects when one of the bots is not running', () => {
    const got = runGuardrails({
      action: { type: 'reallocate_capital', fromBotId: 'bot-1', toBotId: 'bot-X', amountUsdt: 50, reasoning: 'r' },
      config: { ...baseCfg, allowedStrategies: [...baseCfg.allowedStrategies] },
      portfolioState: baseStateMulti,
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe('UNKNOWN_BOT_ID');
  });

  it('rejects when from === to', () => {
    const got = runGuardrails({
      action: { type: 'reallocate_capital', fromBotId: 'bot-1', toBotId: 'bot-1', amountUsdt: 50, reasoning: 'r' },
      config: { ...baseCfg, allowedStrategies: [...baseCfg.allowedStrategies] },
      portfolioState: baseStateMulti,
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe('UNKNOWN_BOT_ID');
  });

  it('accepts when both bots are running and from !== to', () => {
    const got = runGuardrails({
      action: { type: 'reallocate_capital', fromBotId: 'bot-1', toBotId: 'bot-2', amountUsdt: 50, reasoning: 'r' },
      config: { ...baseCfg, allowedStrategies: [...baseCfg.allowedStrategies] },
      portfolioState: baseStateMulti,
    });
    expect(got.ok).toBe(true);
  });
});
