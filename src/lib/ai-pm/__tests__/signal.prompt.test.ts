import { describe, it, expect } from 'vitest';
import { buildIndicatorSnapshot, buildUserPrompt } from '@/lib/ai-pm/signal.prompt';
import type { Kline } from '@/services/bingx.service';

function flatKlines(price: number, length: number): Kline[] {
  return Array.from({ length }, (_, i) => ({
    open: price,
    high: price * 1.001,
    low: price * 0.999,
    close: price,
    time: i * 3_600_000,
  }));
}

function bullishFvgKlines(): Kline[] {
  // Build 60 candles with a clear V-shape (high pivot then low pivot then up move) so swings + FVG both detectable
  const out: Kline[] = [];
  for (let i = 0; i < 60; i++) {
    // Wave: rises to peak at i=15, drops to trough at i=35, then climbs
    let mid: number;
    if (i <= 15) mid = 100 + i * 2;
    else if (i <= 35) mid = 130 - (i - 15) * 1.5;
    else mid = 100 + (i - 35) * 1.5;
    out.push({
      open: mid,
      high: mid + 1,
      low: mid - 1,
      close: mid + 0.2,
      time: i * 3_600_000,
    });
  }
  // Tail: bullish FVG forming at the latest index (gap up)
  const c1: Kline = { open: 110, high: 111, low: 109, close: 110.5, time: 60 * 3_600_000 };
  const c2: Kline = { open: 110.5, high: 130, low: 120, close: 125, time: 61 * 3_600_000 };
  const c3: Kline = { open: 125, high: 135, low: 115, close: 130, time: 62 * 3_600_000 };
  out.push(c1, c2, c3);
  return out;
}

describe('buildIndicatorSnapshot', () => {
  it('includes ema20 and ema50 alongside SMA', () => {
    const snap = buildIndicatorSnapshot('BTC-USDT', flatKlines(100, 60));
    expect(snap.ema20).toBeCloseTo(100, 6);
    expect(snap.ema50).toBeCloseTo(100, 6);
  });

  it('returns swingHigh and swingLow from recent candles', () => {
    const snap = buildIndicatorSnapshot('BTC-USDT', bullishFvgKlines());
    expect(snap.swingHigh).not.toBeNull();
    expect(snap.swingLow).not.toBeNull();
  });

  it('returns at least one unfilled bullish FVG when present', () => {
    const snap = buildIndicatorSnapshot('BTC-USDT', bullishFvgKlines());
    expect(snap.fvgBullish.length).toBeGreaterThan(0);
    expect(snap.fvgBullish[0]).toHaveProperty('low');
    expect(snap.fvgBullish[0]).toHaveProperty('high');
    expect(snap.fvgBullish[0]).toHaveProperty('ageBars');
  });

  it('returns stop distance in ATR units for both sides when ATR + swings exist', () => {
    const snap = buildIndicatorSnapshot('BTC-USDT', bullishFvgKlines());
    expect(typeof snap.stopDistanceAtrLong === 'number' || snap.stopDistanceAtrLong === null).toBe(true);
    expect(typeof snap.stopDistanceAtrShort === 'number' || snap.stopDistanceAtrShort === null).toBe(true);
  });
});

describe('buildUserPrompt', () => {
  it('renders ema, fvg zones, swing levels, and atr-stop distances', () => {
    const snap = buildIndicatorSnapshot('BTC-USDT', bullishFvgKlines());
    const text = buildUserPrompt([snap]);
    expect(text).toContain('ema20=');
    expect(text).toContain('ema50=');
    expect(text).toMatch(/fvgBull|fvgBear/);
    expect(text).toContain('swingHigh=');
    expect(text).toContain('swingLow=');
    expect(text).toContain('stopAtrLong=');
    expect(text).toContain('stopAtrShort=');
  });
});
