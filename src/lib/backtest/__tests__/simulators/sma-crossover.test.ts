import { describe, it, expect } from 'vitest';
import { simulateSmaCrossover } from '@/lib/backtest/simulators/sma-crossover';
import type { Kline } from '@/services/bingx.service';
import type { SMAConfig } from '@/services/bots/types';

const HOUR = 3_600_000;
const candle = (time: number, close: number): Kline => ({
  time,
  open: close,
  high: close * 1.01,
  low: close * 0.99,
  close,
});

const baseParams: SMAConfig = {
  symbols: ['TEST-USDT'],
  timeframe: '1h',
  fastPeriod: 5,
  mediumPeriod: 10,
  trendPeriod: 20,
  adxPeriod: 14,
  adxThreshold: 0,
  atrPeriod: 14,
  activationAtrMult: 1,
  trailingAtrMult: 1,
  initialStopAtrMult: 2,
  positionSizeUsdt: 100,
  leverage: 1,
  marginType: 'CROSSED',
  symbolStates: {},
};

describe('simulateSmaCrossover', () => {
  it('returns no trades on empty candles', () => {
    expect(simulateSmaCrossover([], baseParams).trades).toEqual([]);
  });

  it('returns no trades when too few candles to compute trend SMA', () => {
    const c = Array.from({ length: 5 }, (_, i) => candle(i * HOUR, 100));
    expect(simulateSmaCrossover(c, baseParams).trades).toEqual([]);
  });

  it('opens and force-closes a position over a strong uptrend', () => {
    // Phase 1 (20 candles): mild ramp 100→120 — generates DX values so ADX(14)
    // becomes computable (needs ≥29 candles with non-zero DM; flat candles produce
    // zero DM and never satisfy the dxValues.length≥period check).
    // Phase 2 (10 candles): hold at 120 — fast SMA reverts below medium SMA,
    // resetting the crossover state.
    // Phase 3 (30 candles): strong ramp 120→178 — triggers a fresh bullish
    // crossover at candle ~31, when ADX is already ≥ 0, so the entry intent fires.
    // Total: 60 candles; ADX ready at ~28, crossover at ~31.
    const c: Kline[] = [];
    let t = 0;
    for (let i = 0; i < 20; i++) c.push(candle(t++ * HOUR, 100 + i));       // ramp
    for (let i = 0; i < 10; i++) c.push(candle(t++ * HOUR, 120));            // flat
    for (let i = 0; i < 30; i++) c.push(candle(t++ * HOUR, 120 + i * 2));   // ramp
    const r = simulateSmaCrossover(c, baseParams);
    expect(r.trades.length).toBeGreaterThanOrEqual(1);
    const last = r.trades[r.trades.length - 1];
    expect(last.exitPrice).toBeGreaterThan(0);
    expect(r.equityCurve).toHaveLength(c.length);
    // The 3-phase fixture is a strong uptrend (phase 3 ramps 120→178); a LONG trade
    // must terminate with positive P&L for the simulator's sign handling to be correct.
    expect(last.side).toBe('LONG');
    expect(last.pnlPct).toBeGreaterThan(0);
    expect(last.pnlUsdt).toBeGreaterThan(0);
    expect(last.entryPrice).toBeGreaterThan(100);
    expect(last.exitPrice).toBeGreaterThan(last.entryPrice);
  });
});
