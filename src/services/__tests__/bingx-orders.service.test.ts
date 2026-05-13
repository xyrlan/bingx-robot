import { describe, it, expect, vi } from 'vitest';
import {
  placeFuturesOrder,
  cancelFuturesOrder,
  cancelAllFuturesOrders,
  closeAllPositions,
  listFuturesPositions,
  listFuturesOpenOrders,
  getFuturesBalance,
} from '@/services/bingx-orders.service';
import type { BingxClient } from '@/lib/bingx/client';

function mockClient(overrides: Partial<BingxClient>): BingxClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
    postForm: vi.fn(),
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('bingx-orders.service', () => {
  describe('placeFuturesOrder', () => {
    it('POSTs to /openApi/swap/v2/trade/order and returns orderId+status', async () => {
      const post = vi.fn().mockResolvedValue({
        order: { orderId: '12345', status: 'FILLED', avgPrice: '50000.5' },
      });
      const client = mockClient({ post });

      const got = await placeFuturesOrder(client, {
        symbol: 'BTC-USDT',
        side: 'BUY',
        positionSide: 'LONG',
        type: 'MARKET',
        quantity: '0.001',
      });

      expect(post).toHaveBeenCalledWith('/openApi/swap/v2/trade/order', expect.objectContaining({
        symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG', type: 'MARKET', quantity: '0.001',
      }));
      expect(got).toEqual({ orderId: '12345', status: 'FILLED', avgPrice: '50000.5' });
    });

    it('forwards stopLoss + takeProfit sub-objects as JSON strings', async () => {
      const post = vi.fn().mockResolvedValue({ order: { orderId: '1', status: 'NEW' } });
      const client = mockClient({ post });

      await placeFuturesOrder(client, {
        symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG', type: 'MARKET', quantity: '0.01',
        stopLoss: { type: 'STOP_MARKET', stopPrice: '49000' },
        takeProfit: { type: 'TAKE_PROFIT_MARKET', stopPrice: '52000' },
      });

      const body = post.mock.calls[0][1] as Record<string, unknown>;
      expect(body.stopLoss).toBe(JSON.stringify({ type: 'STOP_MARKET', stopPrice: '49000' }));
      expect(body.takeProfit).toBe(JSON.stringify({ type: 'TAKE_PROFIT_MARKET', stopPrice: '52000' }));
    });
  });

  describe('cancelFuturesOrder', () => {
    it('DELETEs /openApi/swap/v2/trade/order with symbol + orderId', async () => {
      const del = vi.fn().mockResolvedValue({ orderId: '12345' });
      const client = mockClient({ delete: del });
      await cancelFuturesOrder(client, 'BTC-USDT', '12345');
      expect(del).toHaveBeenCalledWith('/openApi/swap/v2/trade/order', { symbol: 'BTC-USDT', orderId: '12345' });
    });
  });

  describe('cancelAllFuturesOrders', () => {
    it('DELETEs /openApi/swap/v2/trade/allOpenOrders and returns canceledCount', async () => {
      const del = vi.fn().mockResolvedValue({ success: [{ orderId: '1' }, { orderId: '2' }] });
      const client = mockClient({ delete: del });
      const got = await cancelAllFuturesOrders(client, 'BTC-USDT');
      expect(del).toHaveBeenCalledWith('/openApi/swap/v2/trade/allOpenOrders', { symbol: 'BTC-USDT' });
      expect(got.canceledCount).toBe(2);
    });

    it('omits symbol when not provided', async () => {
      const del = vi.fn().mockResolvedValue({ success: [] });
      const client = mockClient({ delete: del });
      await cancelAllFuturesOrders(client);
      expect(del).toHaveBeenCalledWith('/openApi/swap/v2/trade/allOpenOrders', {});
    });
  });

  describe('closeAllPositions', () => {
    it('POSTs /openApi/swap/v2/trade/closeAllPositions with symbol', async () => {
      const post = vi.fn().mockResolvedValue({ success: [1, 2] });
      const client = mockClient({ post });
      const got = await closeAllPositions(client, 'BTC-USDT');
      expect(post).toHaveBeenCalledWith('/openApi/swap/v2/trade/closeAllPositions', { symbol: 'BTC-USDT' });
      expect(got.closedCount).toBe(2);
    });
  });

  describe('listFuturesPositions', () => {
    it('GETs /openApi/swap/v2/user/positions and maps fields', async () => {
      const get = vi.fn().mockResolvedValue([
        { symbol: 'BTC-USDT', positionSide: 'LONG', positionAmt: '0.5', avgPrice: '50000', markPrice: '51000', unrealizedProfit: '500', leverage: '5', liquidationPrice: '45000' },
      ]);
      const client = mockClient({ get });
      const got = await listFuturesPositions(client);
      expect(get).toHaveBeenCalledWith('/openApi/swap/v2/user/positions', {});
      expect(got).toHaveLength(1);
      expect(got[0]).toEqual({
        symbol: 'BTC-USDT', side: 'LONG', qty: '0.5', entryPrice: '50000',
        markPrice: '51000', unrealizedPnlUsdt: '500', leverage: 5, liquidationPrice: '45000',
      });
    });

    it('filters by symbol when provided', async () => {
      const get = vi.fn().mockResolvedValue([]);
      const client = mockClient({ get });
      await listFuturesPositions(client, 'ETH-USDT');
      expect(get).toHaveBeenCalledWith('/openApi/swap/v2/user/positions', { symbol: 'ETH-USDT' });
    });
  });

  describe('listFuturesOpenOrders', () => {
    it('GETs /openApi/swap/v2/trade/openOrders and maps fields', async () => {
      const get = vi.fn().mockResolvedValue({
        orders: [
          { orderId: '7', symbol: 'BTC-USDT', side: 'BUY', type: 'LIMIT', origQty: '0.01', price: '49000', stopPrice: '0', status: 'NEW', time: 1700000000000 },
        ],
      });
      const client = mockClient({ get });
      const got = await listFuturesOpenOrders(client);
      expect(get).toHaveBeenCalledWith('/openApi/swap/v2/trade/openOrders', {});
      expect(got).toHaveLength(1);
      expect(got[0].orderId).toBe('7');
      expect(got[0].symbol).toBe('BTC-USDT');
    });
  });

  describe('getFuturesBalance', () => {
    it('GETs /openApi/swap/v3/user/balance and returns USDT row', async () => {
      const get = vi.fn().mockResolvedValue([
        { asset: 'USDT', balance: '1000.5', equity: '1010', availableMargin: '900', unrealizedProfit: '9.5', usedMargin: '100' },
        { asset: 'BTC', balance: '0.5' },
      ]);
      const client = mockClient({ get });
      const got = await getFuturesBalance(client);
      expect(got).toEqual({
        availableUsdt: '900', equityUsdt: '1010', marginUsedUsdt: '100', unrealizedPnlUsdt: '9.5',
      });
    });
  });
});
