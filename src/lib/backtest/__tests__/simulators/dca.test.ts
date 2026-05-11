import { describe, it, expect } from 'vitest';
import { simulateDca } from '@/lib/backtest/simulators/dca';
import type { Kline } from '@/services/bingx.service';
import type { DCAConfig } from '@/services/bots/types';

const HOUR = 3_600_000;

const candle = (time: number, close: number): Kline => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
});

const baseParams: DCAConfig = {
  intervalMinutes: 60,
  totalOrders: 3,
  orderSizeUsdt: 100,
  ordersPlaced: 0,
  side: 'BUY',
};

describe('simulateDca', () => {
  it('returns no trades when no candles supplied', () => {
    const r = simulateDca([], baseParams);
    expect(r.trades).toEqual([]);
    expect(r.equityCurve).toEqual([]);
  });

  it('produces one aggregate trade after force-close, BUY side, with positive pnl on uptrend', () => {
    const candles = [
      candle(0 * HOUR, 100),
      candle(1 * HOUR, 110),
      candle(2 * HOUR, 120),
      candle(3 * HOUR, 130),
    ];
    const r = simulateDca(candles, baseParams);
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.side).toBe('LONG');
    expect(t.entryPrice).toBeCloseTo(110, 9);
    expect(t.exitPrice).toBe(130);
    expect(t.notionalUsdt).toBe(300);
    expect(t.pnlPct).toBeCloseTo((130 - 110) / 110 * 100, 6);
    expect(t.pnlUsdt).toBeCloseTo(300 * t.pnlPct / 100, 6);
    expect(r.equityCurve).toHaveLength(candles.length);
    expect(r.equityCurve[r.equityCurve.length - 1]).toBeCloseTo(t.pnlUsdt, 6);
  });

  it('SELL side flips P&L sign on uptrend', () => {
    const candles = [candle(0, 100), candle(HOUR, 110), candle(2 * HOUR, 120), candle(3 * HOUR, 130)];
    const r = simulateDca(candles, { ...baseParams, side: 'SELL' });
    expect(r.trades[0].side).toBe('SHORT');
    expect(r.trades[0].pnlPct).toBeLessThan(0);
  });

  it('caps orders at totalOrders', () => {
    const candles = Array.from({ length: 10 }, (_, i) => candle(i * HOUR, 100));
    const r = simulateDca(candles, { ...baseParams, totalOrders: 2 });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].notionalUsdt).toBe(200);
  });

  it('produces no trades when totalOrders=0', () => {
    const candles = [candle(0, 100), candle(HOUR, 110)];
    const r = simulateDca(candles, { ...baseParams, totalOrders: 0 });
    expect(r.trades).toEqual([]);
  });
});
