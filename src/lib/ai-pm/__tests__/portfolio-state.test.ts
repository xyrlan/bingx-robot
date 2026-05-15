import { describe, it, expect } from 'vitest';
import { loadPortfolioState } from '@/lib/ai-pm/portfolio-state';

interface FakeRow {
  id: string;
  symbol: string;
  botType: string;
  positionSizeUsdt: string;
  leverage: number;
  status: 'RUNNING' | 'STOPPED';
  apiKeyId: string;
  userId: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeDb(rows: FakeRow[]): any {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
  };
}

const userId = '00000000-0000-0000-0000-000000000001';
const apiKeyId = '00000000-0000-0000-0000-0000000000a0';

describe('loadPortfolioState', () => {
  it('returns running bots filtered by userId and bingxApiKeyId, sums capitalUsedUsdt', async () => {
    const rows: FakeRow[] = [
      { id: 'b1', symbol: 'BTC-USDT', botType: 'DCA', positionSizeUsdt: '100.5', leverage: 3, status: 'RUNNING', apiKeyId, userId },
      { id: 'b2', symbol: 'ETH-USDT', botType: 'TRAILING_STOP', positionSizeUsdt: '50', leverage: 5, status: 'RUNNING', apiKeyId, userId },
    ];

    const state = await loadPortfolioState({ userId, bingxApiKeyId: apiKeyId, db: fakeDb(rows) });

    expect(state.runningBots).toHaveLength(2);
    expect(state.capitalUsedUsdt).toBe(150.5);
    expect(state.bingxApiKeyId).toBe(apiKeyId);
    expect(state.runningBots[0]).toMatchObject({
      id: 'b1',
      symbol: 'BTC-USDT',
      strategy: 'DCA',
      capitalUsdt: 100.5,
      leverage: 3,
      status: 'RUNNING',
    });
  });

  it('returns empty state when no bots match', async () => {
    const state = await loadPortfolioState({ userId, bingxApiKeyId: apiKeyId, db: fakeDb([]) });
    expect(state.runningBots).toEqual([]);
    expect(state.capitalUsedUsdt).toBe(0);
  });

  it('loads availableBalanceUsdt from getFuturesBalance when a bingxClient is provided', async () => {
    const getFuturesBalanceFn = async () => ({
      availableUsdt: '500',
      equityUsdt: '600',
      marginUsedUsdt: '100',
      unrealizedPnlUsdt: '0',
    });
    const state = await loadPortfolioState({
      userId,
      bingxApiKeyId: apiKeyId,
      db: fakeDb([]),
      bingxClient: {} as never,
      getFuturesBalanceFn,
    });
    expect(state.availableBalanceUsdt).toBe(500);
  });

  it('leaves availableBalanceUsdt undefined when the balance fetch throws (fail-open)', async () => {
    const getFuturesBalanceFn = async () => {
      throw new Error('BingX 500');
    };
    const state = await loadPortfolioState({
      userId,
      bingxApiKeyId: apiKeyId,
      db: fakeDb([]),
      bingxClient: {} as never,
      getFuturesBalanceFn,
    });
    expect(state.availableBalanceUsdt).toBeUndefined();
  });

  it('leaves availableBalanceUsdt undefined when no bingxClient is provided', async () => {
    const state = await loadPortfolioState({ userId, bingxApiKeyId: apiKeyId, db: fakeDb([]) });
    expect(state.availableBalanceUsdt).toBeUndefined();
  });

  it('loads openPositions and openOrders from BingX when a client is provided', async () => {
    const getAllOpenPositionsFn = async () => [
      { symbol: 'BTC-USDT', positionSide: 'LONG', positionAmt: 0.5, entryPrice: 60000, unrealizedPnl: 100, leverage: 10, positionId: 'p1' },
    ];
    const getAllOpenOrdersFn = async () => [
      { orderId: 'o1', symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG', type: 'LIMIT', price: '59000', stopPrice: '0', quantity: '0.01' },
    ];
    const state = await loadPortfolioState({
      userId,
      bingxApiKeyId: apiKeyId,
      db: fakeDb([]),
      bingxClient: {} as never,
      getFuturesBalanceFn: async () => ({ availableUsdt: '0', equityUsdt: '0', marginUsedUsdt: '0', unrealizedPnlUsdt: '0' }),
      getAllOpenPositionsFn,
      getAllOpenOrdersFn,
    });
    expect(state.openPositions).toHaveLength(1);
    expect(state.openPositions?.[0].symbol).toBe('BTC-USDT');
    expect(state.openOrders).toHaveLength(1);
    expect(state.openOrders?.[0].orderId).toBe('o1');
  });

  it('returns empty arrays for openPositions/openOrders when no bingxClient is provided', async () => {
    const state = await loadPortfolioState({ userId, bingxApiKeyId: apiKeyId, db: fakeDb([]) });
    expect(state.openPositions).toEqual([]);
    expect(state.openOrders).toEqual([]);
  });

  it('fails-open with empty arrays when openPositions/openOrders fetches throw', async () => {
    const state = await loadPortfolioState({
      userId,
      bingxApiKeyId: apiKeyId,
      db: fakeDb([]),
      bingxClient: {} as never,
      getFuturesBalanceFn: async () => ({ availableUsdt: '0', equityUsdt: '0', marginUsedUsdt: '0', unrealizedPnlUsdt: '0' }),
      getAllOpenPositionsFn: async () => { throw new Error('boom'); },
      getAllOpenOrdersFn: async () => { throw new Error('boom'); },
    });
    expect(state.openPositions).toEqual([]);
    expect(state.openOrders).toEqual([]);
  });
});
