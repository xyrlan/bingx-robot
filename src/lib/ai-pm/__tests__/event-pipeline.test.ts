import { describe, it, expect, vi } from 'vitest';
import { runScopedPipeline } from '@/lib/ai-pm/event-pipeline';
import type { FillPayload } from '@/lib/ai-pm/events';

const fakeBingxClient = {} as never;
const fakePortfolio = { totalEquityUsdt: 1000, openPositions: [], openBots: [] } as never;

function fakeConfig() {
  return {
    id: 'cfg1',
    userId: 'user-1',
    bingxApiKeyId: 'key-1',
    paperMode: true,
    enabled: true,
    killSwitch: false,
    maxCapitalUsdt: '1000',
    maxConcurrentBots: 5,
    allowedSymbols: ['BTC-USDT'],
    allowedStrategies: ['DCA'] as Array<'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER'>,
    anthropicApiKey: 'sk-test',
  };
}

describe('runScopedPipeline', () => {
  it('runs signal scoped to the event symbol only and executes a no_action result', async () => {
    const signalFn = vi.fn().mockResolvedValue({
      ok: true,
      result: { candidates: [{ symbol: 'BTC-USDT', regime: 'TRENDING_UP', score: 80, reason: '' }], signalIds: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } },
    });
    const decisionFn = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        proposedActions: [{ type: 'no_action', reasoning: 'nothing to do' }],
        rejectedActions: [],
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      },
    });
    const validateFn = vi.fn().mockResolvedValue({ status: 'PROPOSED', decisionId: 'dec-1' });
    const executeFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: 'dec-1' });
    const updateDecisionStatusFn = vi.fn().mockResolvedValue(undefined);

    const payload: FillPayload = {
      configId: 'cfg1',
      emittedAt: new Date().toISOString(),
      symbol: 'BTC-USDT',
      botId: 'bot-1',
      botKind: 'paper',
      side: 'LONG',
      fillPrice: '50000',
      quantity: '0.01',
      orderType: 'ENTRY',
    };

    const result = await runScopedPipeline({
      eventType: 'EVENT_FILL',
      symbol: payload.symbol,
      payload,
      aiEventId: 'ev-1',
      config: fakeConfig(),
      bingxClient: fakeBingxClient,
      portfolioState: fakePortfolio,
      db: {} as never,
      signalFn,
      decisionFn,
      validateFn,
      executeFn,
      updateDecisionStatusFn,
      isKillSwitchActive: async () => false,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(signalFn).toHaveBeenCalledWith(expect.objectContaining({
      allowedSymbols: ['BTC-USDT'],
    }));
    expect(decisionFn).toHaveBeenCalledWith(expect.objectContaining({ autonomous: true }));
    expect(result.executedDecisionId).toBe('dec-1');
    expect(result.proposedCount).toBe(1);
    expect(result.executedCount).toBe(1);
  });

  it('aborts when kill switch flips to true between steps', async () => {
    const signalFn = vi.fn().mockResolvedValue({ ok: true, result: { candidates: [], signalIds: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } } });
    const decisionFn = vi.fn();
    let killCount = 0;
    const isKillSwitchActive = vi.fn(async () => ++killCount > 1);

    const payload: FillPayload = {
      configId: 'cfg1',
      emittedAt: new Date().toISOString(),
      symbol: 'BTC-USDT',
      botId: 'bot-1',
      botKind: 'paper',
      side: 'LONG',
      fillPrice: '50000',
      quantity: '0.01',
      orderType: 'ENTRY',
    };

    const result = await runScopedPipeline({
      eventType: 'EVENT_FILL',
      symbol: payload.symbol,
      payload,
      aiEventId: 'ev-1',
      config: fakeConfig(),
      bingxClient: fakeBingxClient,
      portfolioState: fakePortfolio,
      db: {} as never,
      signalFn,
      decisionFn,
      validateFn: vi.fn(),
      executeFn: vi.fn(),
      updateDecisionStatusFn: vi.fn(),
      isKillSwitchActive,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(decisionFn).not.toHaveBeenCalled();
    expect(result.status).toBe('SKIPPED_KILL_SWITCH');
  });

  it('returns SIGNAL_FAILED when signal returns ok=false', async () => {
    const signalFn = vi.fn().mockResolvedValue({ ok: false, error: { kind: 'NO_MARKET_DATA', symbol: 'BTC-USDT' } });

    const payload: FillPayload = {
      configId: 'cfg1', emittedAt: '', symbol: 'BTC-USDT', botId: 'b', botKind: 'paper',
      side: 'LONG', fillPrice: '0', quantity: '0', orderType: 'ENTRY',
    };

    const result = await runScopedPipeline({
      eventType: 'EVENT_FILL', symbol: 'BTC-USDT', payload, aiEventId: 'ev-1',
      config: fakeConfig(), bingxClient: fakeBingxClient, portfolioState: fakePortfolio,
      db: {} as never, signalFn,
      decisionFn: vi.fn(), validateFn: vi.fn(), executeFn: vi.fn(),
      updateDecisionStatusFn: vi.fn(),
      isKillSwitchActive: async () => false,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(result.status).toBe('SIGNAL_FAILED');
  });
});
