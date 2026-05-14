import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runUserTick, type RunUserTickParams } from '@/inngest/functions/ai-pm-tick';
import type { SignalOutcome } from '@/lib/ai-pm/signal';
import type { DecisionOutcome } from '@/lib/ai-pm/decision';
import type { ValidationResult } from '@/lib/ai-pm/validation';
import type { ExecutionResult } from '@/lib/ai-pm/executor';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';

const userId = '00000000-0000-0000-0000-000000000001';
const apiKeyId = '00000000-0000-0000-0000-0000000000a0';
const decisionA = '00000000-0000-0000-0000-000000000d01';
const decisionB = '00000000-0000-0000-0000-000000000d02';

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function basePortfolio(): PortfolioState {
  return {
    runningBots: [],
    capitalUsedUsdt: 0,
    bingxApiKeyId: apiKeyId,
  };
}

function baseParams(overrides: Partial<RunUserTickParams> = {}): RunUserTickParams {
  return {
    userId,
    anthropicApiKey: 'sk',
    bingxApiKeyId: apiKeyId,
    paperMode: true,
    allowedSymbols: ['BTC-USDT'],
    maxCapitalUsdt: 1000,
    maxConcurrentBots: 5,
    maxLeverage: 20,
    allowedStrategies: ['DCA', 'TRAILING_STOP', 'DCA_SPOT', 'SMA_CROSSOVER'],
    isKillSwitchActive: async () => false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    loadBingxClient: async () => ({ __fake: true } as any),
    loadPortfolio: async () => basePortfolio(),
    signalFn: async (): Promise<SignalOutcome> => ({
      ok: true,
      result: {
        candidates: [
          { symbol: 'BTC-USDT', regime: 'range', score: 80, reason: 'r' },
        ],
        signalIds: ['s1'],
        usage: { inputTokens: 500, outputTokens: 50, cachedInputTokens: 0, costUsd: 0.001, model: 'claude-haiku-4-5' },
      },
    }),
    decisionFn: async (): Promise<DecisionOutcome> => ({
      ok: true,
      result: {
        proposedActions: [
          { type: 'create_bot', symbol: 'BTC-USDT', strategy: 'DCA', capitalUsdt: 100, leverage: 3, reasoning: 'r' },
        ],
        rejectedActions: [],
        usage: { inputTokens: 800, outputTokens: 200, cachedInputTokens: 0, costUsd: 0.005, model: 'claude-sonnet-4-6' },
      },
    }),
    validateFn: async (): Promise<ValidationResult> => ({
      status: 'PROPOSED',
      decisionId: decisionA,
    }),
    executeFn: async (): Promise<ExecutionResult> => ({
      status: 'EXECUTED',
      decisionId: decisionA,
      paperBotId: 'pb-1',
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: { update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }) } as any,
    logger: silentLogger(),
    ...overrides,
  };
}

describe('runUserTick', () => {
  let p: RunUserTickParams;
  beforeEach(() => {
    p = baseParams();
  });

  it('runs full pipeline and reports COMPLETED', async () => {
    const report = await runUserTick(p);
    expect(report.status).toBe('COMPLETED');
    expect(report.proposedCount).toBe(1);
    expect(report.executedCount).toBe(1);
    expect(report.failedCount).toBe(0);
  });

  it('passes the loaded bingx client to loadPortfolio', async () => {
    const loadPortfolioSpy = vi.fn(async () => basePortfolio());
    p.loadPortfolio = loadPortfolioSpy;
    await runUserTick(p);
    expect(loadPortfolioSpy).toHaveBeenCalledWith({ __fake: true });
  });

  it('skips when kill switch active at start', async () => {
    p.isKillSwitchActive = async () => true;
    const signalSpy = vi.spyOn(p, 'signalFn');
    const report = await runUserTick(p);
    expect(report.status).toBe('SKIPPED_KILL_SWITCH');
    expect(signalSpy).not.toHaveBeenCalled();
  });

  it('aborts mid-run when kill switch flips after signal', async () => {
    let calls = 0;
    p.isKillSwitchActive = async () => {
      calls += 1;
      return calls > 1;
    };
    const executeSpy = vi.spyOn(p, 'executeFn');
    const report = await runUserTick(p);
    expect(report.status).toBe('SKIPPED_KILL_SWITCH');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('reports SKIPPED_NO_BINGX_CLIENT when client load returns null', async () => {
    p.loadBingxClient = async () => null;
    const report = await runUserTick(p);
    expect(report.status).toBe('SKIPPED_NO_BINGX_CLIENT');
  });

  it('reports SIGNAL_FAILED when signal returns error', async () => {
    p.signalFn = async () => ({ ok: false, error: { kind: 'NO_MARKET_DATA', symbol: 'BTC-USDT' } });
    const report = await runUserTick(p);
    expect(report.status).toBe('SIGNAL_FAILED');
    expect(report.proposedCount).toBe(0);
  });

  it('reports DECISION_FAILED when decision returns error', async () => {
    p.decisionFn = async () => ({ ok: false, error: { kind: 'NO_TOOL_USE', message: 'm' } });
    const report = await runUserTick(p);
    expect(report.status).toBe('DECISION_FAILED');
  });

  it('continues other actions when one execute fails', async () => {
    p.decisionFn = async () => ({
      ok: true,
      result: {
        proposedActions: [
          { type: 'create_bot', symbol: 'BTC-USDT', strategy: 'DCA', capitalUsdt: 100, leverage: 3, reasoning: 'r' },
          { type: 'no_action', reasoning: 'wait' },
        ],
        rejectedActions: [],
        usage: { inputTokens: 800, outputTokens: 200, cachedInputTokens: 0, costUsd: 0.005, model: 'claude-sonnet-4-6' },
      },
    });
    p.validateFn = async ({ action }) => ({
      status: 'PROPOSED',
      decisionId: action.type === 'create_bot' ? decisionA : decisionB,
    });
    p.executeFn = async ({ action }) =>
      action.type === 'create_bot'
        ? { status: 'EXECUTION_FAILED', decisionId: decisionA, reason: 'boom' }
        : { status: 'EXECUTED', decisionId: decisionB };

    const report = await runUserTick(p);
    expect(report.status).toBe('PARTIAL');
    expect(report.proposedCount).toBe(2);
    expect(report.executedCount).toBe(1);
    expect(report.failedCount).toBe(1);
  });

  it('counts rejections from validate without calling executor for them', async () => {
    p.validateFn = async () => ({ status: 'REJECTED_GUARDRAIL', decisionId: decisionA, reason: 'cap' });
    const executeSpy = vi.spyOn(p, 'executeFn');
    const report = await runUserTick(p);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(report.rejectedCount).toBe(1);
    expect(report.executedCount).toBe(0);
  });
});
