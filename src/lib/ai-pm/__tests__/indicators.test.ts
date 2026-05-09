import { describe, it, expect } from 'vitest';
import { sma, rsi, atr, bollinger, crossoverState } from '@/lib/ai-pm/indicators';

const closes = (xs: number[]) => xs.map((c) => ({ close: c }));
const ohlc = (rows: [number, number, number][]) =>
  rows.map(([h, l, c]) => ({ high: h, low: l, close: c }));

describe('sma', () => {
  it('returns null when window shorter than period', () => {
    expect(sma(closes([1, 2, 3]), 5)).toBeNull();
  });

  it('averages last N closes', () => {
    expect(sma(closes([1, 2, 3, 4, 5]), 5)).toBe(3);
    expect(sma(closes([1, 2, 3, 4, 5]), 3)).toBe(4);
  });
});

describe('rsi', () => {
  it('returns null when fewer than period+1 candles', () => {
    expect(rsi(closes([1, 2, 3]), 14)).toBeNull();
  });

  it('flat series → 50 (no losses, no gains)', () => {
    expect(rsi(closes(Array(20).fill(100)), 14)).toBe(50);
  });

  it('strict uptrend → > 70', () => {
    const series = Array.from({ length: 20 }, (_, i) => 100 + i);
    const v = rsi(closes(series), 14);
    expect(v).not.toBeNull();
    expect(v as number).toBeGreaterThan(70);
  });

  it('strict downtrend → < 30', () => {
    const series = Array.from({ length: 20 }, (_, i) => 100 - i);
    const v = rsi(closes(series), 14);
    expect(v).not.toBeNull();
    expect(v as number).toBeLessThan(30);
  });
});

describe('atr', () => {
  it('returns null when fewer than period+1 candles', () => {
    expect(atr(ohlc([[1, 1, 1]]), 14)).toBeNull();
  });

  it('constant TR series → ATR equals that constant', () => {
    const rows: [number, number, number][] = Array.from({ length: 16 }, () => [11, 9, 10]);
    expect(atr(ohlc(rows), 14)).toBeCloseTo(2, 9);
  });
});

describe('bollinger', () => {
  it('returns null when fewer than period candles', () => {
    expect(bollinger(closes([1, 2, 3]), 20, 2)).toBeNull();
  });

  it('flat series → upper=middle=lower', () => {
    const result = bollinger(closes(Array(20).fill(100)), 20, 2);
    expect(result).not.toBeNull();
    expect(result!.middle).toBe(100);
    expect(result!.upper).toBe(100);
    expect(result!.lower).toBe(100);
  });

  it('symmetric series produces symmetric bands around mean', () => {
    const r = bollinger(closes([1, 2, 3, 4, 5]), 5, 2);
    expect(r).not.toBeNull();
    expect(r!.middle).toBe(3);
    expect(r!.upper - r!.middle).toBeCloseTo(r!.middle - r!.lower, 9);
  });
});

describe('crossoverState', () => {
  it('NONE when series too short', () => {
    expect(crossoverState([1], [2])).toBe('NONE');
  });

  it('CROSS_UP when short crosses above long', () => {
    expect(crossoverState([9, 11], [10, 10])).toBe('CROSS_UP');
  });

  it('CROSS_DOWN when short crosses below long', () => {
    expect(crossoverState([11, 9], [10, 10])).toBe('CROSS_DOWN');
  });

  it('NONE when no crossing', () => {
    expect(crossoverState([8, 9], [10, 10])).toBe('NONE');
    expect(crossoverState([12, 13], [10, 10])).toBe('NONE');
  });
});
