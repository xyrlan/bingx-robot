import { describe, it, expect } from 'vitest';
import {
  sma,
  rsi,
  atr,
  bollinger,
  crossoverState,
  ema,
  fairValueGaps,
  swings,
} from '@/lib/ai-pm/indicators';

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

describe('ema', () => {
  it('returns null when fewer than period candles', () => {
    expect(ema(closes([1, 2, 3]), 5)).toBeNull();
  });

  it('flat series → EMA equals that value', () => {
    expect(ema(closes(Array(20).fill(100)), 10)).toBeCloseTo(100, 9);
  });

  it('reacts faster than SMA to recent price changes', () => {
    const series = [...Array(19).fill(100), 200];
    const e = ema(closes(series), 10);
    const s = sma(closes(series), 10);
    expect(e).not.toBeNull();
    expect(s).not.toBeNull();
    expect(e as number).toBeGreaterThan(s as number);
  });

  it('seeds with SMA of first period bars, then smooths', () => {
    // First 5 closes mean 3; alpha = 2/(5+1) = 1/3
    // After close=10 (bar 6): 3 + 1/3 * (10 - 3) = 5.333...
    const v = ema(closes([1, 2, 3, 4, 5, 10]), 5);
    expect(v).not.toBeNull();
    expect(v as number).toBeCloseTo(5.3333333, 5);
  });
});

describe('fairValueGaps', () => {
  it('returns empty arrays when fewer than 3 candles', () => {
    const r = fairValueGaps(ohlc([[10, 9, 9.5], [11, 10, 10.5]]));
    expect(r.bullish).toEqual([]);
    expect(r.bearish).toEqual([]);
  });

  it('detects bullish FVG when candle[i-2].high < candle[i].low', () => {
    // i=0: [h=10, l=9], i=1: [h=12, l=11] (big up bar), i=2: [h=13, l=10.5]
    // c[i-2].high=10 < c[i].low=10.5 → bullish FVG zone [10, 10.5]
    const r = fairValueGaps(
      ohlc([
        [10, 9, 9.5],
        [12, 11, 11.5],
        [13, 10.5, 12],
      ]),
    );
    expect(r.bullish).toHaveLength(1);
    expect(r.bullish[0]).toMatchObject({ low: 10, high: 10.5 });
    expect(r.bearish).toEqual([]);
  });

  it('detects bearish FVG when candle[i-2].low > candle[i].high', () => {
    // c[i-2].low=11, c[i].high=10 → bearish FVG zone [10, 11]
    const r = fairValueGaps(
      ohlc([
        [12, 11, 11.5],
        [11, 9, 9.5],
        [10, 8, 8.5],
      ]),
    );
    expect(r.bearish).toHaveLength(1);
    expect(r.bearish[0]).toMatchObject({ low: 10, high: 11 });
    expect(r.bullish).toEqual([]);
  });

  it('drops bullish FVG once a later candle closes/fills it (price returns below low)', () => {
    // FVG forms at index 2 ([10, 10.5]). Later candle at index 4 has low=9.8 < 10 → filled.
    const r = fairValueGaps(
      ohlc([
        [10, 9, 9.5],
        [12, 11, 11.5],
        [13, 10.5, 12],
        [12, 11, 11.5],
        [11, 9.8, 10.2], // low pierces fvg low → filled
      ]),
    );
    expect(r.bullish).toEqual([]);
  });

  it('tags each FVG with age_bars (distance from latest candle)', () => {
    const r = fairValueGaps(
      ohlc([
        [10, 9, 9.5],
        [12, 11, 11.5],
        [13, 10.5, 12], // FVG formed here (index 2)
        [13, 11.5, 12.5],
        [13.5, 12, 13], // latest = index 4
      ]),
    );
    expect(r.bullish).toHaveLength(1);
    expect(r.bullish[0].ageBars).toBe(2);
  });
});

describe('swings', () => {
  it('returns nulls when fewer than 2*lookback+1 candles', () => {
    const r = swings(ohlc([[10, 9, 9.5], [11, 10, 10.5]]), 3);
    expect(r.swingHigh).toBeNull();
    expect(r.swingLow).toBeNull();
  });

  it('finds most recent swing high (pivot with N bars lower on each side)', () => {
    // Pivot high at index 3 (high=15), with 2 lower neighbors each side
    const r = swings(
      ohlc([
        [10, 9, 9.5],
        [12, 11, 11.5],
        [13, 12, 12.5],
        [15, 14, 14.5], // pivot high
        [13, 12, 12.5],
        [12, 11, 11.5],
        [11, 10, 10.5],
      ]),
      2,
    );
    expect(r.swingHigh).toBe(15);
  });

  it('finds most recent swing low (pivot with N bars higher on each side)', () => {
    const r = swings(
      ohlc([
        [15, 14, 14.5],
        [13, 12, 12.5],
        [12, 11, 11.5],
        [10, 9, 9.5], // pivot low
        [12, 11, 11.5],
        [13, 12, 12.5],
        [15, 14, 14.5],
      ]),
      2,
    );
    expect(r.swingLow).toBe(9);
  });

  it('picks the most recent confirmed pivot when several exist', () => {
    // Two swing highs at index 2 (h=15) and index 6 (h=17), lookback=2
    const r = swings(
      ohlc([
        [11, 10, 10.5],
        [13, 12, 12.5],
        [15, 14, 14.5], // older swing high
        [13, 12, 12.5],
        [12, 11, 11.5],
        [14, 13, 13.5],
        [17, 16, 16.5], // newer swing high (not yet confirmed: needs 2 bars after)
        [15, 14, 14.5],
        [13, 12, 12.5],
      ]),
      2,
    );
    expect(r.swingHigh).toBe(17);
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
