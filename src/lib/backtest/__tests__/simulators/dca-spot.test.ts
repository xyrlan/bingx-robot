import { describe, it, expect } from 'vitest';
import { simulateDcaSpot } from '@/lib/backtest/simulators/dca-spot';
import type { Kline } from '@/services/bingx.service';
import type { DCAConfig } from '@/services/bots/types';

const HOUR = 3_600_000;
const candle = (time: number, close: number): Kline => ({ time, open: close, high: close, low: close, close });

const baseParams: DCAConfig = {
  intervalMinutes: 60,
  totalOrders: 3,
  orderSizeUsdt: 100,
  ordersPlaced: 0,
  side: 'BUY',
};

describe('simulateDcaSpot', () => {
  it('produces one LONG aggregate trade on uptrend (spot is buy-only)', () => {
    const candles = [candle(0, 100), candle(HOUR, 110), candle(2 * HOUR, 120), candle(3 * HOUR, 130)];
    const r = simulateDcaSpot(candles, baseParams);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].side).toBe('LONG');
    expect(r.trades[0].notionalUsdt).toBe(300);
    expect(r.trades[0].pnlPct).toBeGreaterThan(0);
  });

  it('produces a losing aggregate trade on downtrend', () => {
    const candles = [candle(0, 130), candle(HOUR, 120), candle(2 * HOUR, 110), candle(3 * HOUR, 100)];
    const r = simulateDcaSpot(candles, baseParams);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].pnlPct).toBeLessThan(0);
  });

  it('returns empty for empty candles', () => {
    expect(simulateDcaSpot([], baseParams).trades).toEqual([]);
  });
});
