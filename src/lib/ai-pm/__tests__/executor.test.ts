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

// Variant that records every `.update().set(...)` payload so tests can assert
// what was written (e.g. resultBotId linkage onto ai_decisions).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeDbCapturing(state: DbState): { db: any; sets: any[] } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sets: any[] = [];
  const db = {
    query: { tradingBots: { findFirst: async () => state.trading[0] ?? null } },
    update: () => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      set: (p: any) => {
        sets.push(p);
        return { where: () => ({ returning: async () => state.trading.map((r) => ({ ...r })) }) };
      },
    }),
  };
  return { db, sets };
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
      setBotStatusFn: vi.fn(async () => undefined),
    });
    expect(result.status).toBe('EXECUTED');
    expect(result.realBotId).toBe('tb-1');
    expect(createBotMock).toHaveBeenCalledOnce();
    expect(createBotMock.mock.calls[0][1].apiKeyId).toBe(apiKeyId);
    expect(createBotMock.mock.calls[0][1].botType).toBe('DCA');
    expect(createPaperBotMock).not.toHaveBeenCalled();
  });

  it('real-mode create_bot starts the new bot (RUNNING) and links it to the decision', async () => {
    const action: ProposedAction = {
      type: 'create_bot', symbol: 'BTC-USDT', strategy: 'DCA',
      capitalUsdt: 100, leverage: 3, reasoning: 'r',
    };
    const setBotStatusMock = vi.fn(async () => undefined);
    const { db, sets } = fakeDbCapturing(state);
    const result = await execute({
      userId, decisionId, action, config: realConfig,
      db: db as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createBotFn: createBotMock as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createPaperBotFn: createPaperBotMock as any,
      setBotStatusFn: setBotStatusMock,
    });
    expect(result.status).toBe('EXECUTED');
    expect(result.realBotId).toBe('tb-1');
    expect(setBotStatusMock).toHaveBeenCalledWith('tb-1', userId, 'RUNNING');
    expect(sets).toContainEqual({ resultBotId: 'tb-1' });
  });

  it('paper-mode create_bot does not call setBotStatus', async () => {
    const action: ProposedAction = {
      type: 'create_bot', symbol: 'BTC-USDT', strategy: 'DCA',
      capitalUsdt: 100, leverage: 3, reasoning: 'r',
    };
    const setBotStatusMock = vi.fn(async () => undefined);
    await execute({
      userId, decisionId, action, config: paperConfig,
      db: fakeDb(state) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createBotFn: createBotMock as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createPaperBotFn: createPaperBotMock as any,
      setBotStatusFn: setBotStatusMock,
    });
    expect(setBotStatusMock).not.toHaveBeenCalled();
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

describe('execute — reallocate_capital', () => {
  it('paper mode: atomic update of both bots', async () => {
    const updateMock = vi.fn().mockReturnValue({
      set: () => ({ where: () => ({ returning: async () => [{}] }) }),
    });
    const transactionMock = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = { update: updateMock };
      return cb(tx);
    });

    const fromRow = { id: 'paper-from', userId, capitalUsdt: '200' };
    const toRow = { id: 'paper-to', userId, capitalUsdt: '100' };

    const fakePaperDb = {
      query: {
        paperBots: {
          findFirst: vi.fn()
            .mockResolvedValueOnce(fromRow)
            .mockResolvedValueOnce(toRow),
        },
      },
      transaction: transactionMock,
    };

    const action: ProposedAction = {
      type: 'reallocate_capital',
      fromBotId: 'paper-from',
      toBotId: 'paper-to',
      amountUsdt: 50,
      reasoning: 'rebalance',
    };

    const got = await execute({
      userId, decisionId, action,
      config: { bingxApiKeyId: apiKeyId, paperMode: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: fakePaperDb as any,
    });

    expect(got.status).toBe('EXECUTED');
    expect(transactionMock).toHaveBeenCalledOnce();
    expect(updateMock).toHaveBeenCalledTimes(2);
  });

  it('insufficient capital → EXECUTION_FAILED', async () => {
    const fromRow = { id: 'paper-from', userId, capitalUsdt: '40' };
    const toRow = { id: 'paper-to', userId, capitalUsdt: '100' };
    const fakePaperDb = {
      query: {
        paperBots: {
          findFirst: vi.fn().mockResolvedValueOnce(fromRow).mockResolvedValueOnce(toRow),
        },
      },
      transaction: vi.fn(),
    };

    const action: ProposedAction = {
      type: 'reallocate_capital', fromBotId: 'paper-from', toBotId: 'paper-to', amountUsdt: 50, reasoning: 'r',
    };

    const got = await execute({
      userId, decisionId, action,
      config: { bingxApiKeyId: apiKeyId, paperMode: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: fakePaperDb as any,
    });

    expect(got.status).toBe('EXECUTION_FAILED');
    expect(got.reason).toMatch(/insufficient_capital/);
    expect(fakePaperDb.transaction).not.toHaveBeenCalled();
  });

  it('real mode: atomic update of trading_bots positionSizeUsdt', async () => {
    const updateMock = vi.fn().mockReturnValue({
      set: () => ({ where: () => ({ returning: async () => [{}] }) }),
    });
    const transactionMock = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = { update: updateMock };
      return cb(tx);
    });

    const fromRow = { id: 'real-from', userId, apiKeyId, positionSizeUsdt: '200', status: 'RUNNING' };
    const toRow = { id: 'real-to', userId, apiKeyId, positionSizeUsdt: '100', status: 'RUNNING' };

    const fakeRealDb = {
      query: {
        tradingBots: {
          findFirst: vi.fn().mockResolvedValueOnce(fromRow).mockResolvedValueOnce(toRow),
        },
      },
      transaction: transactionMock,
    };

    const action: ProposedAction = {
      type: 'reallocate_capital', fromBotId: 'real-from', toBotId: 'real-to', amountUsdt: 50, reasoning: 'r',
    };

    const got = await execute({
      userId, decisionId, action,
      config: { bingxApiKeyId: apiKeyId, paperMode: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: fakeRealDb as any,
    });

    expect(got.status).toBe('EXECUTED');
    expect(transactionMock).toHaveBeenCalledOnce();
    expect(updateMock).toHaveBeenCalledTimes(2);
  });

  it('real mode: apiKeyId mismatch → EXECUTION_FAILED', async () => {
    const fromRow = { id: 'real-from', userId, apiKeyId: otherApiKeyId, positionSizeUsdt: '200' };
    const fakeRealDb = {
      query: {
        tradingBots: { findFirst: vi.fn().mockResolvedValue(fromRow) },
      },
      transaction: vi.fn(),
    };

    const action: ProposedAction = {
      type: 'reallocate_capital', fromBotId: 'real-from', toBotId: 'real-to', amountUsdt: 50, reasoning: 'r',
    };

    const got = await execute({
      userId, decisionId, action,
      config: { bingxApiKeyId: apiKeyId, paperMode: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: fakeRealDb as any,
    });

    expect(got.status).toBe('EXECUTION_FAILED');
    expect(got.reason).toMatch(/apiKeyId mismatch/i);
  });

  it('fromBotId === toBotId → EXECUTION_FAILED', async () => {
    const action: ProposedAction = {
      type: 'reallocate_capital', fromBotId: 'x', toBotId: 'x', amountUsdt: 50, reasoning: 'r',
    };
    const got = await execute({
      userId, decisionId, action,
      config: { bingxApiKeyId: apiKeyId, paperMode: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
    });
    expect(got.status).toBe('EXECUTION_FAILED');
    expect(got.reason).toMatch(/same bot/i);
  });
});

describe('execute — place_market_order', () => {
  it('paper mode simulates with bingxClient (real price → computed qty)', async () => {
    const updateMock = vi.fn().mockReturnValue({ set: () => ({ where: () => ({ returning: async () => [{}] }) }) });
    const placeFn = vi.fn();
    const got = await execute({
      userId, decisionId,
      action: { type: 'place_market_order', symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG', capitalUsdt: 100, leverage: 5, reasoning: 'r' },
      config: { bingxApiKeyId: apiKeyId, paperMode: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { update: updateMock } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bingxClient: {} as any,
      placeOrderFn: placeFn,
      getLastPriceFn: vi.fn().mockResolvedValue('50000'),
      getContractInfoFn: vi.fn().mockResolvedValue({ quantityPrecision: 4, minNotional: '1' }),
    });
    expect(got.status).toBe('EXECUTED');
    expect(got.resultOrderId).toMatch(/^paper-/);
    expect(got.reason).toMatch(/paper MARKET/);
    expect(placeFn).not.toHaveBeenCalled();
  });

  it('paper mode simulates without bingxClient (qty=0)', async () => {
    const updateMock = vi.fn().mockReturnValue({ set: () => ({ where: () => ({ returning: async () => [{}] }) }) });
    const got = await execute({
      userId, decisionId,
      action: { type: 'place_market_order', symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG', capitalUsdt: 100, leverage: 5, reasoning: 'r' },
      config: { bingxApiKeyId: apiKeyId, paperMode: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { update: updateMock } as any,
    });
    expect(got.status).toBe('EXECUTED');
    expect(got.resultOrderId).toMatch(/^paper-/);
    expect(got.reason).toMatch(/qty=0/);
  });

  it('real mode without bingxClient fails', async () => {
    const got = await execute({
      userId, decisionId,
      action: { type: 'place_market_order', symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG', capitalUsdt: 100, leverage: 5, reasoning: 'r' },
      config: { bingxApiKeyId: apiKeyId, paperMode: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
    });
    expect(got.status).toBe('EXECUTION_FAILED');
    expect(got.reason).toMatch(/missing_bingx_client/);
  });

  it('happy path returns resultOrderId and updates decision row', async () => {
    const updateMock = vi.fn().mockReturnValue({ set: () => ({ where: () => ({ returning: async () => [{}] }) }) });
    const placeFn = vi.fn().mockResolvedValue({ orderId: 'abc-123', status: 'FILLED', avgPrice: '50000' });
    const getLastPriceFn = vi.fn().mockResolvedValue('50000');
    const getContractInfoFn = vi.fn().mockResolvedValue({ quantityPrecision: 4, minNotional: '1' });

    const got = await execute({
      userId, decisionId,
      action: { type: 'place_market_order', symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG', capitalUsdt: 100, leverage: 5, reasoning: 'r' },
      config: { bingxApiKeyId: apiKeyId, paperMode: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { update: updateMock } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bingxClient: {} as any,
      placeOrderFn: placeFn,
      getLastPriceFn,
      getContractInfoFn,
    });
    expect(got.status).toBe('EXECUTED');
    expect(got.resultOrderId).toBe('abc-123');
    expect(placeFn).toHaveBeenCalledOnce();
    const placeArgs = placeFn.mock.calls[0][1] as { quantity: string };
    expect(placeArgs.quantity).toMatch(/^0\.\d+$/);
  });

  it('forwards stopLoss / takeProfit when provided', async () => {
    const placeFn = vi.fn().mockResolvedValue({ orderId: '1', status: 'FILLED' });
    const updateMock = vi.fn().mockReturnValue({ set: () => ({ where: () => ({ returning: async () => [{}] }) }) });
    await execute({
      userId, decisionId,
      action: { type: 'place_market_order', symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG', capitalUsdt: 100, leverage: 5, stopLossPercent: 2, takeProfitPercent: 5, reasoning: 'r' },
      config: { bingxApiKeyId: apiKeyId, paperMode: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { update: updateMock } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bingxClient: {} as any,
      placeOrderFn: placeFn,
      getLastPriceFn: vi.fn().mockResolvedValue('50000'),
      getContractInfoFn: vi.fn().mockResolvedValue({ quantityPrecision: 4, minNotional: '1' }),
    });
    const args = placeFn.mock.calls[0][1] as { stopLoss?: { stopPrice: string }; takeProfit?: { stopPrice: string } };
    expect(args.stopLoss?.stopPrice).toBe('49000');
    expect(args.takeProfit?.stopPrice).toBe('52500');
  });

  it('BingX error → EXECUTION_FAILED with reason', async () => {
    const placeFn = vi.fn().mockRejectedValue(new Error('Insufficient balance'));
    const got = await execute({
      userId, decisionId,
      action: { type: 'place_market_order', symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG', capitalUsdt: 100, leverage: 5, reasoning: 'r' },
      config: { bingxApiKeyId: apiKeyId, paperMode: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { update: vi.fn().mockReturnValue({ set: () => ({ where: () => ({ returning: async () => [{}] }) }) }) } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bingxClient: {} as any,
      placeOrderFn: placeFn,
      getLastPriceFn: vi.fn().mockResolvedValue('50000'),
      getContractInfoFn: vi.fn().mockResolvedValue({ quantityPrecision: 4, minNotional: '1' }),
    });
    expect(got.status).toBe('EXECUTION_FAILED');
    expect(got.reason).toMatch(/insufficient/i);
  });

  it('normalizes symbol "BTCUSDT" → "BTC-USDT" before any BingX call', async () => {
    // Repro of prod incident: AI emitted "BTCUSDT" (no dash) → BingX 109400.
    const placeFn = vi.fn().mockResolvedValue({ orderId: 'o1', status: 'FILLED' });
    const getLastPriceFn = vi.fn().mockResolvedValue('50000');
    const getContractInfoFn = vi.fn().mockResolvedValue({ quantityPrecision: 4, minNotional: '1' });
    const updateMock = vi.fn().mockReturnValue({ set: () => ({ where: () => ({ returning: async () => [{}] }) }) });

    await execute({
      userId, decisionId,
      action: { type: 'place_market_order', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG', capitalUsdt: 30, leverage: 2, reasoning: 'r' },
      config: { bingxApiKeyId: apiKeyId, paperMode: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { update: updateMock } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bingxClient: {} as any,
      placeOrderFn: placeFn,
      getLastPriceFn,
      getContractInfoFn,
    });

    expect(getLastPriceFn).toHaveBeenCalledWith(expect.anything(), 'BTC-USDT');
    expect(getContractInfoFn).toHaveBeenCalledWith('BTC-USDT');
    const placeArgs = placeFn.mock.calls[0][1] as { symbol: string };
    expect(placeArgs.symbol).toBe('BTC-USDT');
  });

  it('leaves "BTC-USDC" untouched (already canonical)', async () => {
    const placeFn = vi.fn().mockResolvedValue({ orderId: 'o2', status: 'FILLED' });
    const getLastPriceFn = vi.fn().mockResolvedValue('50000');
    const getContractInfoFn = vi.fn().mockResolvedValue({ quantityPrecision: 4, minNotional: '1' });
    const updateMock = vi.fn().mockReturnValue({ set: () => ({ where: () => ({ returning: async () => [{}] }) }) });

    await execute({
      userId, decisionId,
      action: { type: 'place_market_order', symbol: 'BTC-USDC', side: 'BUY', positionSide: 'LONG', capitalUsdt: 30, leverage: 2, reasoning: 'r' },
      config: { bingxApiKeyId: apiKeyId, paperMode: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { update: updateMock } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bingxClient: {} as any,
      placeOrderFn: placeFn,
      getLastPriceFn,
      getContractInfoFn,
    });

    expect(placeFn.mock.calls[0][1].symbol).toBe('BTC-USDC');
  });

  it('normalizes "ETHUSDC" → "ETH-USDC"', async () => {
    const placeFn = vi.fn().mockResolvedValue({ orderId: 'o3', status: 'FILLED' });
    const updateMock = vi.fn().mockReturnValue({ set: () => ({ where: () => ({ returning: async () => [{}] }) }) });

    await execute({
      userId, decisionId,
      action: { type: 'place_market_order', symbol: 'ETHUSDC', side: 'BUY', positionSide: 'LONG', capitalUsdt: 30, leverage: 2, reasoning: 'r' },
      config: { bingxApiKeyId: apiKeyId, paperMode: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { update: updateMock } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bingxClient: {} as any,
      placeOrderFn: placeFn,
      getLastPriceFn: vi.fn().mockResolvedValue('3000'),
      getContractInfoFn: vi.fn().mockResolvedValue({ quantityPrecision: 4, minNotional: '1' }),
    });

    expect(placeFn.mock.calls[0][1].symbol).toBe('ETH-USDC');
  });
});

describe('execute — cancel_order', () => {
  it('calls cancelOrderFn and returns EXECUTED', async () => {
    const cancelFn = vi.fn().mockResolvedValue(undefined);
    const got = await execute({
      userId, decisionId,
      action: { type: 'cancel_order', symbol: 'BTC-USDT', orderId: '7', reasoning: 'r' },
      config: { bingxApiKeyId: apiKeyId, paperMode: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bingxClient: {} as any,
      cancelOrderFn: cancelFn,
    });
    expect(got.status).toBe('EXECUTED');
    expect(cancelFn).toHaveBeenCalledWith(expect.anything(), 'BTC-USDT', '7');
  });

  it('paper mode does NOT call cancelOrderFn and returns EXECUTED', async () => {
    const cancelFn = vi.fn();
    const got = await execute({
      userId, decisionId,
      action: { type: 'cancel_order', symbol: 'BTC-USDT', orderId: '7', reasoning: 'r' },
      config: { bingxApiKeyId: apiKeyId, paperMode: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      cancelOrderFn: cancelFn,
    });
    expect(got.status).toBe('EXECUTED');
    expect(got.reason).toMatch(/paper cancel/);
    expect(cancelFn).not.toHaveBeenCalled();
  });
});

describe('execute — cancel_all_orders paper mode', () => {
  it('returns EXECUTED without calling exchange', async () => {
    const cancelAllFn = vi.fn();
    const got = await execute({
      userId, decisionId,
      action: { type: 'cancel_all_orders', symbol: 'BTC-USDT', reasoning: 'r' },
      config: { bingxApiKeyId: apiKeyId, paperMode: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      cancelAllOrdersFn: cancelAllFn,
    });
    expect(got.status).toBe('EXECUTED');
    expect(got.reason).toMatch(/paper cancel_all/);
    expect(cancelAllFn).not.toHaveBeenCalled();
  });
});

describe('execute — close_position', () => {
  it('paper mode simulates without exchange calls', async () => {
    const closeAllFn = vi.fn();
    const updateMock = vi.fn().mockReturnValue({ set: () => ({ where: () => ({ returning: async () => [{}] }) }) });
    const got = await execute({
      userId, decisionId,
      action: { type: 'close_position', symbol: 'BTC-USDT', side: 'LONG', percent: 50, reasoning: 'r' },
      config: { bingxApiKeyId: apiKeyId, paperMode: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { update: updateMock } as any,
      closeAllPositionsFn: closeAllFn,
    });
    expect(got.status).toBe('EXECUTED');
    expect(got.resultOrderId).toMatch(/^paper-/);
    expect(got.reason).toMatch(/paper close 50% LONG/);
    expect(closeAllFn).not.toHaveBeenCalled();
  });

  it('without side+percent calls closeAllPositionsFn', async () => {
    const closeAllFn = vi.fn().mockResolvedValue({ closedCount: 1 });
    const got = await execute({
      userId, decisionId,
      action: { type: 'close_position', symbol: 'BTC-USDT', reasoning: 'r' },
      config: { bingxApiKeyId: apiKeyId, paperMode: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bingxClient: {} as any,
      closeAllPositionsFn: closeAllFn,
    });
    expect(got.status).toBe('EXECUTED');
    expect(closeAllFn).toHaveBeenCalledWith(expect.anything(), 'BTC-USDT');
  });

  it('with side+percent computes closeQty and places reduce-only market', async () => {
    const listFn = vi.fn().mockResolvedValue([
      { symbol: 'BTC-USDT', side: 'LONG', qty: '0.5', entryPrice: '50000', markPrice: '51000', unrealizedPnlUsdt: '500', leverage: 5, liquidationPrice: '45000' },
    ]);
    const placeFn = vi.fn().mockResolvedValue({ orderId: 'close-1', status: 'FILLED' });
    const updateMock = vi.fn().mockReturnValue({ set: () => ({ where: () => ({ returning: async () => [{}] }) }) });

    const got = await execute({
      userId, decisionId,
      action: { type: 'close_position', symbol: 'BTC-USDT', side: 'LONG', percent: 50, reasoning: 'r' },
      config: { bingxApiKeyId: apiKeyId, paperMode: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { update: updateMock } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bingxClient: {} as any,
      listPositionsFn: listFn,
      placeOrderFn: placeFn,
    });
    expect(got.status).toBe('EXECUTED');
    expect(got.resultOrderId).toBe('close-1');
    const args = placeFn.mock.calls[0][1] as { side: string; positionSide: string; reduceOnly?: boolean; quantity: string };
    expect(args.side).toBe('SELL');           // inverse of LONG
    expect(args.positionSide).toBe('LONG');
    expect(args.reduceOnly).toBe(true);
    expect(args.quantity).toBe('0.25');        // 50% of 0.5
  });
});
