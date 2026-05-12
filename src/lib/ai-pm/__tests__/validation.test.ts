import { describe, it, expect, beforeEach } from 'vitest';
import { validate } from '@/lib/ai-pm/validation';
import type { ProposedAction } from '@/lib/ai-pm/decision.prompt';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';
import type { AnthropicFactory } from '@/lib/ai-pm/llm';
import type { BacktestResult } from '@/lib/backtest/types';

interface InsertedRow {
  id: string;
  userId: string;
  actionType: string;
  status: string;
  symbol: string | null;
  strategy: string | null;
  rejectionReason: string | null;
  backtestRunId: string | null;
}

interface DbState {
  rows: InsertedRow[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeDb(state: DbState): any {
  return {
    insert: () => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      values: (rows: any[]) => ({
        returning: async () => {
          const out = rows.map((r, i) => ({ ...r, id: `dec-${state.rows.length + i}` }));
          state.rows.push(...out);
          return out;
        },
      }),
    }),
  };
}

const userId = '00000000-0000-0000-0000-000000000001';
const botId = '00000000-0000-0000-0000-0000000000b0';

const baseState: PortfolioState = {
  runningBots: [{ id: botId, symbol: 'BTC-USDT', strategy: 'DCA', capitalUsdt: 100, leverage: 3, status: 'RUNNING' }],
  capitalUsedUsdt: 100,
  bingxApiKeyId: '00000000-0000-0000-0000-0000000000a0',
};

const baseConfig = {
  maxCapitalUsdt: 1000,
  maxConcurrentBots: 5,
  maxLeverage: 20,
  allowedStrategies: ['DCA', 'TRAILING_STOP', 'DCA_SPOT', 'SMA_CROSSOVER'] as const,
  killSwitch: false,
  reviewerThresholdPct: 30,
};

const fakeBingxClient = { __fake: true };

function backtestFn(result: Partial<BacktestResult>) {
  return async (): Promise<BacktestResult> => ({
    cached: false,
    pnlPct: 5,
    maxDrawdownPct: 8,
    sharpeApprox: 1.1,
    winRatePct: 60,
    totalTrades: 25,
    paramsHash: 'h1',
    runId: 'bt-1',
    ...result,
  });
}

function reviewerFn(verdict: { approve: boolean; rationale: string }) {
  return async () => ({ ok: true as const, verdict, usage: { inputTokens: 1200, outputTokens: 200, cachedInputTokens: 0, costUsd: 0.025, model: 'claude-opus-4-7' as const } });
}

function vetoReviewer() {
  return reviewerFn({ approve: false, rationale: 'too risky' });
}

const fakeFactory: AnthropicFactory = () => ({ messages: { create: async () => { throw new Error('should not be called when reviewerFn injected'); } } });

const noAction: ProposedAction = { type: 'no_action', reasoning: 'idle' };
const createSmall: ProposedAction = { type: 'create_bot', symbol: 'ETH-USDT', strategy: 'DCA', capitalUsdt: 50, leverage: 3, reasoning: 'r' };
const createLarge: ProposedAction = { type: 'create_bot', symbol: 'ETH-USDT', strategy: 'DCA', capitalUsdt: 400, leverage: 3, reasoning: 'r' };
const createOverCap: ProposedAction = { type: 'create_bot', symbol: 'ETH-USDT', strategy: 'DCA', capitalUsdt: 950, leverage: 3, reasoning: 'r' };

describe('validate', () => {
  let dbState: DbState;
  beforeEach(() => {
    dbState = { rows: [] };
  });

  it('persists PROPOSED row for no_action without backtest or reviewer', async () => {
    const res = await validate({
      userId, action: noAction, config: baseConfig, portfolioState: baseState,
      anthropicApiKey: 'sk', db: fakeDb(dbState), factory: fakeFactory,
    });
    expect(res.status).toBe('PROPOSED');
    expect(dbState.rows).toHaveLength(1);
    expect(dbState.rows[0].status).toBe('PROPOSED');
    expect(dbState.rows[0].actionType).toBe('NO_ACTION');
  });

  it('persists REJECTED_GUARDRAIL for over-cap create_bot', async () => {
    const res = await validate({
      userId, action: createOverCap, config: baseConfig, portfolioState: baseState,
      anthropicApiKey: 'sk', db: fakeDb(dbState), factory: fakeFactory,
    });
    expect(res.status).toBe('REJECTED_GUARDRAIL');
    expect(res.reason).toMatch(/Capital/);
    expect(dbState.rows[0].status).toBe('REJECTED_GUARDRAIL');
    expect(dbState.rows[0].rejectionReason).toMatch(/Capital/);
  });

  it('runs backtest for small create_bot below threshold; PROPOSED on positive PnL; no reviewer', async () => {
    const stateWithEth: PortfolioState = {
      ...baseState,
      runningBots: [
        ...baseState.runningBots,
        { id: '00000000-0000-0000-0000-0000000000b1', symbol: 'ETH-USDT', strategy: 'DCA', capitalUsdt: 30, leverage: 3, status: 'RUNNING' },
      ],
    };
    const res = await validate({
      userId, action: createSmall, config: baseConfig, portfolioState: stateWithEth,
      anthropicApiKey: 'sk', bingxClient: fakeBingxClient as never,
      db: fakeDb(dbState),
      runBacktestFn: backtestFn({ pnlPct: 7 }),
      reviewerFn: vetoReviewer(),
      factory: fakeFactory,
    });
    expect(res.status).toBe('PROPOSED');
    expect(res.backtestRunId).toBe('bt-1');
    expect(res.reviewerUsage).toBeUndefined();
    expect(dbState.rows[0].backtestRunId).toBe('bt-1');
  });

  it('persists REJECTED_BACKTEST when pnl is negative', async () => {
    const stateWithEth: PortfolioState = {
      ...baseState,
      runningBots: [
        ...baseState.runningBots,
        { id: '00000000-0000-0000-0000-0000000000b1', symbol: 'ETH-USDT', strategy: 'DCA', capitalUsdt: 30, leverage: 3, status: 'RUNNING' },
      ],
    };
    const res = await validate({
      userId, action: createSmall, config: baseConfig, portfolioState: stateWithEth,
      anthropicApiKey: 'sk', bingxClient: fakeBingxClient as never,
      db: fakeDb(dbState),
      runBacktestFn: backtestFn({ pnlPct: -2 }),
      reviewerFn: vetoReviewer(),
      factory: fakeFactory,
    });
    expect(res.status).toBe('REJECTED_BACKTEST');
    expect(dbState.rows[0].status).toBe('REJECTED_BACKTEST');
    expect(dbState.rows[0].backtestRunId).toBe('bt-1');
  });

  it('invokes reviewer when create_bot pushes capital above 30% threshold; veto → REJECTED_REVIEWER', async () => {
    const stateWithEth: PortfolioState = {
      ...baseState,
      runningBots: [
        ...baseState.runningBots,
        { id: '00000000-0000-0000-0000-0000000000b1', symbol: 'ETH-USDT', strategy: 'DCA', capitalUsdt: 30, leverage: 3, status: 'RUNNING' },
      ],
    };
    const res = await validate({
      userId, action: createLarge, config: baseConfig, portfolioState: stateWithEth,
      anthropicApiKey: 'sk', bingxClient: fakeBingxClient as never,
      db: fakeDb(dbState),
      runBacktestFn: backtestFn({ pnlPct: 5 }),
      reviewerFn: vetoReviewer(),
      factory: fakeFactory,
    });
    expect(res.status).toBe('REJECTED_REVIEWER');
    expect(res.reviewerUsage).toBeDefined();
    expect(dbState.rows[0].status).toBe('REJECTED_REVIEWER');
  });

  it('invokes reviewer for first-time symbol even below capital threshold; approve → PROPOSED', async () => {
    const res = await validate({
      userId, action: createSmall, config: baseConfig, portfolioState: baseState,
      anthropicApiKey: 'sk', bingxClient: fakeBingxClient as never,
      db: fakeDb(dbState),
      runBacktestFn: backtestFn({ pnlPct: 5 }),
      reviewerFn: reviewerFn({ approve: true, rationale: 'first-time but solid' }),
      factory: fakeFactory,
    });
    expect(res.status).toBe('PROPOSED');
    expect(res.reviewerUsage).toBeDefined();
  });

  it('skips backtest+reviewer for stop_bot; persists PROPOSED', async () => {
    const stopAction: ProposedAction = { type: 'stop_bot', botId, reasoning: 'risk' };
    const res = await validate({
      userId, action: stopAction, config: baseConfig, portfolioState: baseState,
      anthropicApiKey: 'sk', db: fakeDb(dbState), factory: fakeFactory,
    });
    expect(res.status).toBe('PROPOSED');
    expect(res.backtestRunId).toBeUndefined();
    expect(res.reviewerUsage).toBeUndefined();
  });
});
