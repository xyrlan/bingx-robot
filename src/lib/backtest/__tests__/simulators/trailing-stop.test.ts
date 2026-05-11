import { describe, it, expect } from 'vitest';
import { simulateTrailingStop } from '@/lib/backtest/simulators/trailing-stop';
import type { Kline } from '@/services/bingx.service';
import type { TrailingStopConfig } from '@/services/bots/types';

const HOUR = 3_600_000;
const candle = (time: number, close: number): Kline => ({ time, open: close, high: close, low: close, close });

const baseParams: TrailingStopConfig = {
  activationPricePct: 5,
  trailingPct: 2,
  positionSizeUsdt: 100,
  highestPrice: 0,
  isActivated: false,
  entryOrderId: null,
};

describe('simulateTrailingStop', () => {
  it('returns no trades on empty candles', () => {
    expect(simulateTrailingStop([], baseParams).trades).toEqual([]);
  });

  it('opens position on first candle and closes when trailing stop triggers', () => {
    const candles = [
      candle(0 * HOUR, 100),
      candle(1 * HOUR, 105),
      candle(2 * HOUR, 110),
      candle(3 * HOUR, 107),
    ];
    const r = simulateTrailingStop(candles, baseParams);
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.side).toBe('LONG');
    expect(t.entryPrice).toBe(100);
    expect(t.exitPrice).toBe(107);
    expect(t.notionalUsdt).toBe(100);
    expect(t.pnlPct).toBeCloseTo(7, 6);
  });

  it('force-closes open position at final candle if no stop hit', () => {
    const candles = [candle(0, 100), candle(HOUR, 102), candle(2 * HOUR, 103)];
    const r = simulateTrailingStop(candles, baseParams);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].exitPrice).toBe(103);
  });
});
