import { describe, it, expect, beforeEach, vi } from 'vitest';
import { execute, type ExecutorConfig } from '@/lib/ai-pm/executor';
import type { ProposedAction } from '@/lib/ai-pm/decision.prompt';

const userId = '00000000-0000-0000-0000-000000000001';
const decisionId = '00000000-0000-0000-0000-000000000d10';
const apiKeyId = '00000000-0000-0000-0000-0000000000a0';
const otherApiKeyId = '00000000-0000-0000-0000-0000000000a1';
const botId = '00000000-0000-0000-0000-0000000000b0';

const realConfig: ExecutorConfig = { bingxApiKeyId: apiKeyId, paperMode: false };
const paperConfig: ExecutorConfig = { bingxApiKeyId: apiKeyId, paperMode: true };

interface TradingBotRow {
  id: string;
  userId: string;
  apiKeyId: string | null;
  status: 'RUNNING' | 'STOPPED';
}

interface DbState {
  trading: TradingBotRow[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeDb(state: DbState): any {
  return {
    query: {
      tradingBots: {
        findFirst: async () => state.trading[0] ?? null,
      },
    },
    update: () => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
      set: (_p: any) => ({
        where: () => ({
          returning: async () => state.trading.map((r) => ({ ...r, status: 'STOPPED' })),
        }),
      }),
    }),
  };
}

describe('execute', () => {
  let state: DbState;
  let createBotMock: ReturnType<typeof vi.fn>;
  let createPaperBotMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    state = { trading: [] };
    createBotMock = vi.fn(async () => ({ id: 'tb-1', userId, symbol: 'BTC-USDT' }));
    createPaperBotMock = vi.fn(async () => ({
      id: 'pb-1', userId, decisionId, symbol: 'BTC-USDT', strategy: 'DCA',
      capitalUsdt: '100', status: 'RUNNING' as const, pnlUsdt: '0',
      startedAt: new Date(), stoppedAt: null,
    }));
  });

  it('real-mode create_bot calls createBot with scoped apiKeyId', async () => {
    const action: ProposedAction = {
      type: 'create_bot', symbol: 'BTC-USDT', strategy: 'DCA',
      capitalUsdt: 100, leverage: 3, reasoning: 'r',
    };
    const result = await execute({
      userId, decisionId, action, config: realConfig,
      db: fakeDb(state) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createBotFn: createBotMock as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createPaperBotFn: createPaperBotMock as any,
    });
    expect(result.status).toBe('EXECUTED');
    expect(result.realBotId).toBe('tb-1');
    expect(createBotMock).toHaveBeenCalledOnce();
    expect(createBotMock.mock.calls[0][1].apiKeyId).toBe(apiKeyId);
    expect(createBotMock.mock.calls[0][1].botType).toBe('DCA');
    expect(createPaperBotMock).not.toHaveBeenCalled();
  });

  it('paper-mode create_bot writes paper_bots, skips real createBot', async () => {
    const action: ProposedAction = {
      type: 'create_bot', symbol: 'BTC-USDT', strategy: 'DCA',
      capitalUsdt: 100, leverage: 3, reasoning: 'r',
    };
    const result = await execute({
      userId, decisionId, action, config: paperConfig,
      db: fakeDb(state) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createBotFn: createBotMock as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createPaperBotFn: createPaperBotMock as any,
    });
    expect(result.status).toBe('EXECUTED');
    expect(result.paperBotId).toBe('pb-1');
    expect(createPaperBotMock).toHaveBeenCalledOnce();
    expect(createBotMock).not.toHaveBeenCalled();
  });

  it('stop_bot rejects when bot apiKeyId does not match config.bingxApiKeyId', async () => {
    state.trading.push({ id: botId, userId, apiKeyId: otherApiKeyId, status: 'RUNNING' });
    const action: ProposedAction = { type: 'stop_bot', botId, reasoning: 'risk' };
    const result = await execute({
      userId, decisionId, action, config: realConfig,
      db: fakeDb(state) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createBotFn: createBotMock as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createPaperBotFn: createPaperBotMock as any,
    });
    expect(result.status).toBe('EXECUTION_FAILED');
    expect(result.reason).toMatch(/apiKeyId/i);
  });

  it('stop_bot succeeds when apiKeyId matches', async () => {
    state.trading.push({ id: botId, userId, apiKeyId, status: 'RUNNING' });
    const action: ProposedAction = { type: 'stop_bot', botId, reasoning: 'risk' };
    const result = await execute({
      userId, decisionId, action, config: realConfig,
      db: fakeDb(state) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createBotFn: createBotMock as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createPaperBotFn: createPaperBotMock as any,
    });
    expect(result.status).toBe('EXECUTED');
  });

  it('no_action returns EXECUTED with no side effects', async () => {
    const result = await execute({
      userId, decisionId, action: { type: 'no_action', reasoning: 'idle' },
      config: realConfig, db: fakeDb(state) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createBotFn: createBotMock as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createPaperBotFn: createPaperBotMock as any,
    });
    expect(result.status).toBe('EXECUTED');
    expect(createBotMock).not.toHaveBeenCalled();
    expect(createPaperBotMock).not.toHaveBeenCalled();
  });

  it('reallocate_capital returns EXECUTION_FAILED (not implemented)', async () => {
    const result = await execute({
      userId, decisionId,
      action: {
        type: 'reallocate_capital',
        fromBotId: botId,
        toBotId: '00000000-0000-0000-0000-0000000000b1',
        amountUsdt: 50,
        reasoning: 'r',
      },
      config: realConfig, db: fakeDb(state) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createBotFn: createBotMock as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createPaperBotFn: createPaperBotMock as any,
    });
    expect(result.status).toBe('EXECUTION_FAILED');
    expect(result.reason).toMatch(/NOT_IMPLEMENTED/);
  });
});

describe('execute — adjust_params', () => {
  it('paper mode: updates capitalUsdt + params jsonb', async () => {
    const updateMock = vi.fn().mockReturnValue({
      set: (vals: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => [{ id: 'paper-1', capitalUsdt: vals.capitalUsdt ?? '0' }],
        }),
      }),
    });
    const findMock = vi.fn().mockResolvedValue({
      id: 'paper-1', userId, capitalUsdt: '100', params: { leverage: 2 }, strategy: 'DCA',
    });
    const fakePaperDb = {
      query: { paperBots: { findFirst: findMock } },
      update: updateMock,
    };

    const action: ProposedAction = {
      type: 'adjust_params',
      botId: 'paper-1',
      params: { capitalUsdt: 150, leverage: 3 },
      reasoning: 'rebalance',
    };

    const got = await execute({
      userId, decisionId, action,
      config: { bingxApiKeyId: apiKeyId, paperMode: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: fakePaperDb as any,
    });

    expect(got.status).toBe('EXECUTED');
    expect(got.paperBotId).toBe('paper-1');
    expect(updateMock).toHaveBeenCalled();
  });

  it('real mode: direct-field update + optional setLeverage', async () => {
    const updateRes = { id: botId, positionSizeUsdt: '150', leverage: 3, status: 'RUNNING' as const };
    const updateMock = vi.fn().mockReturnValue({
      set: () => ({ where: () => ({ returning: async () => [updateRes] }) }),
    });
    const findMock = vi.fn().mockResolvedValue({
      id: botId, userId, apiKeyId, botType: 'DCA', symbol: 'BTC-USDT', positionSizeUsdt: '100', leverage: 2, status: 'RUNNING',
    });
    const setLeverageMock = vi.fn().mockResolvedValue(undefined);

    const action: ProposedAction = {
      type: 'adjust_params',
      botId,
      params: { capitalUsdt: 150, leverage: 3 },
      reasoning: 'r',
    };

    const got = await execute({
      userId, decisionId, action,
      config: { bingxApiKeyId: apiKeyId, paperMode: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { query: { tradingBots: { findFirst: findMock } }, update: updateMock } as any,
      setLeverageFn: setLeverageMock,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bingxClient: { fake: true } as any,
    });

    expect(got.status).toBe('EXECUTED');
    expect(got.realBotId).toBe(botId);
    expect(setLeverageMock).toHaveBeenCalledWith(expect.anything(), 'BTC-USDT', 3);
  });

  it('real mode: setLeverage throws → still EXECUTED (warned)', async () => {
    const updateMock = vi.fn().mockReturnValue({
      set: () => ({ where: () => ({ returning: async () => [{ id: botId, leverage: 3 }] }) }),
    });
    const findMock = vi.fn().mockResolvedValue({
      id: botId, userId, apiKeyId, botType: 'DCA', symbol: 'BTC-USDT', positionSizeUsdt: '100', leverage: 2, status: 'RUNNING',
    });
    const setLeverageMock = vi.fn().mockRejectedValue(new Error('exchange rejected'));

    const action: ProposedAction = {
      type: 'adjust_params', botId, params: { leverage: 3 }, reasoning: 'r',
    };

    const got = await execute({
      userId, decisionId, action,
      config: { bingxApiKeyId: apiKeyId, paperMode: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { query: { tradingBots: { findFirst: findMock } }, update: updateMock } as any,
      setLeverageFn: setLeverageMock,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bingxClient: {} as any,
    });

    expect(got.status).toBe('EXECUTED');
  });

  it('real mode: strategy change → stops + recreates, returns newBotId', async () => {
    const updateMock = vi.fn().mockReturnValue({
      set: () => ({ where: () => ({ returning: async () => [{ id: botId, status: 'STOPPED' }] }) }),
    });
    const findMock = vi.fn().mockResolvedValue({
      id: botId, userId, apiKeyId, botType: 'DCA', symbol: 'BTC-USDT', positionSizeUsdt: '100', leverage: 2, takeProfitPercentage: '1', gridCount: 1, priceMin: '0', priceMax: '0', status: 'RUNNING',
    });
    const createBotMock = vi.fn().mockResolvedValue({ id: 'new-bot-1' });

    const action: ProposedAction = {
      type: 'adjust_params', botId, params: { strategy: 'SMA_CROSSOVER' }, reasoning: 'r',
    };

    const got = await execute({
      userId, decisionId, action,
      config: { bingxApiKeyId: apiKeyId, paperMode: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { query: { tradingBots: { findFirst: findMock } }, update: updateMock } as any,
      createBotFn: createBotMock,
    });

    expect(got.status).toBe('EXECUTED');
    expect(got.realBotId).toBe(botId);
    expect(got.newBotId).toBe('new-bot-1');
    expect(createBotMock).toHaveBeenCalled();
    expect(createBotMock.mock.calls[0][1].botType).toBe('SMA_CROSSOVER');
  });

  it('real mode: recreate fails → EXECUTION_FAILED, old bot stays STOPPED', async () => {
    const updateMock = vi.fn().mockReturnValue({
      set: () => ({ where: () => ({ returning: async () => [{ id: botId, status: 'STOPPED' }] }) }),
    });
    const findMock = vi.fn().mockResolvedValue({
      id: botId, userId, apiKeyId, botType: 'DCA', symbol: 'BTC-USDT', positionSizeUsdt: '100', leverage: 2, takeProfitPercentage: '1', gridCount: 1, priceMin: '0', priceMax: '0', status: 'RUNNING',
    });
    const createBotMock = vi.fn().mockRejectedValue(new Error('boom'));

    const action: ProposedAction = {
      type: 'adjust_params', botId, params: { strategy: 'SMA_CROSSOVER' }, reasoning: 'r',
    };

    const got = await execute({
      userId, decisionId, action,
      config: { bingxApiKeyId: apiKeyId, paperMode: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { query: { tradingBots: { findFirst: findMock } }, update: updateMock } as any,
      createBotFn: createBotMock,
    });

    expect(got.status).toBe('EXECUTION_FAILED');
    expect(got.reason).toMatch(/recreate_failed/);
  });

  it('bot not found → EXECUTION_FAILED', async () => {
    const action: ProposedAction = {
      type: 'adjust_params', botId, params: { capitalUsdt: 200 }, reasoning: 'r',
    };
    const got = await execute({
      userId, decisionId, action,
      config: { bingxApiKeyId: apiKeyId, paperMode: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { query: { tradingBots: { findFirst: async () => null } } } as any,
    });
    expect(got.status).toBe('EXECUTION_FAILED');
    expect(got.reason).toMatch(/not found/i);
  });
});
