import { describe, it, expect, vi } from 'vitest';
import { getAllOpenOrders, getAllOpenPositions, getOpenPositions } from '@/services/bingx.service';

function clientReturning(data: unknown) {
  return { get: vi.fn().mockResolvedValue(data) } as never;
}

describe('bingx positions — unrealized pnl', () => {
  it('getAllOpenPositions returns open positions with unrealizedPnl populated', async () => {
    const client = clientReturning([
      {
        symbol: 'BTC-USDT',
        positionSide: 'LONG',
        positionAmt: '0.5',
        entryPrice: '60000',
        unrealizedProfit: '120.5',
        leverage: '10',
        positionId: '99',
      },
      {
        symbol: 'ETH-USDT',
        positionSide: 'SHORT',
        positionAmt: '0',
        entryPrice: '3000',
        unrealizedProfit: '0',
      },
    ]);

    const positions = await getAllOpenPositions(client);

    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ symbol: 'BTC-USDT', unrealizedPnl: 120.5 });
  });

  it('getOpenPositions includes unrealizedPnl', async () => {
    const client = clientReturning([
      {
        symbol: 'BTC-USDT',
        positionSide: 'LONG',
        positionAmt: '1',
        entryPrice: '50000',
        unrealizedProfit: '-75.25',
      },
    ]);

    const positions = await getOpenPositions(client, 'BTC-USDT');

    expect(positions[0].unrealizedPnl).toBeCloseTo(-75.25);
  });
});

describe('getAllOpenOrders', () => {
  it('hits /openApi/swap/v2/trade/openOrders without symbol filter and normalises', async () => {
    const get = vi.fn().mockResolvedValue({
      orders: [
        {
          orderId: '12345678901234567890',
          symbol: 'BTC-USDT',
          side: 'BUY',
          positionSide: 'LONG',
          type: 'LIMIT',
          price: '60000',
          stopPrice: '0',
          origQty: '0.01',
          status: 'NEW',
          time: 1700000000000,
        },
        {
          orderId: 7,
          symbol: 'ETH-USDT',
          side: 'SELL',
          positionSide: 'SHORT',
          type: 'TAKE_PROFIT_MARKET',
          price: '0',
          stopPrice: '3500',
          origQty: '0.5',
          status: 'NEW',
          time: 1700000000001,
        },
      ],
    });
    const client = { get } as never;

    const orders = await getAllOpenOrders(client);

    expect(get).toHaveBeenCalledWith('/openApi/swap/v2/trade/openOrders', {});
    expect(orders).toHaveLength(2);
    // BigInt-safe ID preserved as string, no precision loss
    expect(orders[0].orderId).toBe('12345678901234567890');
    expect(typeof orders[0].orderId).toBe('string');
    expect(orders[0].symbol).toBe('BTC-USDT');
    expect(orders[0].side).toBe('BUY');
    expect(orders[0].positionSide).toBe('LONG');
    expect(orders[0].type).toBe('LIMIT');
    expect(orders[1].orderId).toBe('7');
  });

  it('returns empty array when API throws', async () => {
    const get = vi.fn().mockRejectedValue(new Error('boom'));
    const client = { get } as never;
    const orders = await getAllOpenOrders(client);
    expect(orders).toEqual([]);
  });

  it('handles bare-array response shape', async () => {
    const get = vi.fn().mockResolvedValue([
      { orderId: '99', symbol: 'SOL-USDT', side: 'BUY', positionSide: 'LONG', type: 'LIMIT', price: '150', stopPrice: '0', origQty: '1', status: 'NEW', time: 1700000000002 },
    ]);
    const client = { get } as never;
    const orders = await getAllOpenOrders(client);
    expect(orders).toHaveLength(1);
    expect(orders[0].orderId).toBe('99');
    expect(orders[0].symbol).toBe('SOL-USDT');
  });
});
