// src/lib/backtest/__tests__/run-backtest.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/bingx/market-data', () => ({ fetchKlines: vi.fn() }));
vi.mock('@/lib/backtest/cache', async () => {
  const actual = await vi.importActual<typeof import('@/lib/backtest/cache')>('@/lib/backtest/cache');
  return {
    ...actual,
    findCached: vi.fn(),
    writeCache: vi.fn(),
  };
});

import { fetchKlines } from '@/lib/bingx/market-data';
import { findCached, writeCache } from '@/lib/backtest/cache';
import { runBacktest } from '@/lib/backtest';
import type { BingxClient } from '@/lib/bingx/client';
import type { DCAConfig } from '@/services/bots/types';
import type { Kline } from '@/services/bingx.service';

const HOUR = 3_600_000;
const stubClient = {} as BingxClient;
const candle = (t: number, close: number): Kline => ({ time: t, open: close, high: close, low: close, close });

const dcaParams: DCAConfig = {
  intervalMinutes: 60,
  totalOrders: 3,
  orderSizeUsdt: 100,
  ordersPlaced: 0,
  side: 'BUY',
};

beforeEach(() => {
  vi.mocked(fetchKlines).mockReset();
  vi.mocked(findCached).mockReset();
  vi.mocked(writeCache).mockReset();
});

describe('runBacktest', () => {
  it('returns cached result without re-running on cache hit', async () => {
    vi.mocked(findCached).mockResolvedValue({
      id: 'cached-id',
      symbol: 'BTC-USDT',
      strategy: 'DCA',
      paramsHash: 'h',
      params: dcaParams,
      windowDays: 30,
      pnlPct: '5.0000',
      maxDrawdownPct: '1.0000',
      sharpeApprox: '0.7500',
      winRatePct: '100.00',
      totalTrades: 1,
      metricsJson: null,
      createdAt: new Date(),
    } as never);

    const r = await runBacktest({ client: stubClient, symbol: 'BTC-USDT', strategy: 'DCA', params: dcaParams });
    expect(r.cached).toBe(true);
    expect(r.runId).toBe('cached-id');
    expect(r.pnlPct).toBeCloseTo(5, 9);
    expect(fetchKlines).not.toHaveBeenCalled();
    expect(writeCache).not.toHaveBeenCalled();
  });

  it('runs the simulator and writes cache on miss', async () => {
    vi.mocked(findCached).mockResolvedValue(null);
    vi.mocked(fetchKlines).mockResolvedValue([
      candle(0, 100), candle(HOUR, 110), candle(2 * HOUR, 120), candle(3 * HOUR, 130),
    ]);
    vi.mocked(writeCache).mockResolvedValue({ id: 'new-id' } as never);

    const r = await runBacktest({ client: stubClient, symbol: 'BTC-USDT', strategy: 'DCA', params: dcaParams, windowDays: 30 });

    expect(fetchKlines).toHaveBeenCalledWith(stubClient, 'BTC-USDT', '1h', 30 * 24);
    expect(writeCache).toHaveBeenCalledOnce();
    expect(r.cached).toBe(false);
    expect(r.runId).toBe('new-id');
    expect(r.totalTrades).toBe(1);
    expect(r.pnlPct).toBeGreaterThan(0);
  });

  it('throws when fetchKlines returns empty (no data to backtest)', async () => {
    vi.mocked(findCached).mockResolvedValue(null);
    vi.mocked(fetchKlines).mockResolvedValue([]);
    await expect(
      runBacktest({ client: stubClient, symbol: 'BTC-USDT', strategy: 'DCA', params: dcaParams }),
    ).rejects.toThrow(/no klines/i);
  });

  it('throws on unsupported strategy', async () => {
    vi.mocked(findCached).mockResolvedValue(null);
    vi.mocked(fetchKlines).mockResolvedValue([candle(0, 100)]);
    await expect(
      // @ts-expect-error testing runtime guard
      runBacktest({ client: stubClient, symbol: 'BTC-USDT', strategy: 'GRID_LONG', params: {} }),
    ).rejects.toThrow(/unsupported strategy/i);
  });
});
