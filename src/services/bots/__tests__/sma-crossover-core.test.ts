import { describe, it, expect } from 'vitest';
import { initialState, tick, type Snapshot, type Intent } from '@/services/bots/sma-crossover/core';
import type { SMAConfig } from '@/services/bots/types';
import type { Kline } from '@/services/bingx.service';

const baseConfig = (overrides: Partial<SMAConfig> = {}): SMAConfig => ({
  symbols: ['BTC-USDT'],
  timeframe: '1h',
  fastPeriod: 9,
  mediumPeriod: 21,
  trendPeriod: 50,
  adxPeriod: 14,
  adxThreshold: 25,
  atrPeriod: 14,
  activationAtrMult: 1.5,
  trailingAtrMult: 1.0,
  initialStopAtrMult: 2.0,
  positionSizeUsdt: 100,
  leverage: 5,
  marginType: 'SEPARATE_ISOLATED',
  symbolStates: {},
  ...overrides,
});

// Helper to build a Kline with time=0 (tests don't use time)
function kline(open: number, high: number, low: number, close: number): Kline {
  return { open, high, low, close, time: 0 };
}

// Build candles where SMA9 crosses above SMA21 on the last (60th) candle.
// 58 candles with slight drift (base + i%3*0.5) to provide enough directional movement
// for ADX to return a non-null value, then one flat candle and one big upmove to trigger
// the crossover on the final candle.
function trendUpCandles(): Kline[] {
  const candles: Kline[] = [];
  for (let i = 0; i < 58; i++) {
    const base = 100 + (i % 3) * 0.5;
    candles.push(kline(base, base + 1, base - 1, base));
  }
  // One more flat candle so previous SMA9 <= SMA21
  candles.push(kline(100, 101, 99, 100));
  // Final upmove — crossover fires here
  candles.push(kline(110, 111, 109, 110));
  return candles;
}

// Build candles where prices are completely flat — no crossover possible.
// Using all identical close prices so SMA9 and SMA21 are always equal.
function flatChoppyCandles(): Kline[] {
  const candles: Kline[] = [];
  for (let i = 0; i < 100; i++) {
    candles.push(kline(100, 100.5, 99.5, 100));
  }
  return candles;
}

describe('SMA_CROSSOVER core', () => {
  it('initialState returns a fresh symbol state', () => {
    const config = baseConfig();
    const s = initialState(config);
    expect(s.position).toBeNull();
    expect(s.entryPrice).toBeNull();
    expect(s.entryOrderId).toBeNull();
    expect(s.trailingActivated).toBe(false);
  });

  it('emits ENTER_LONG when fast crosses medium up + close above trend + ADX above threshold', () => {
    const config = baseConfig({ adxThreshold: 0 }); // disable ADX gate for this test
    const candles = trendUpCandles();
    const snap: Snapshot = {
      symbol: 'BTC-USDT',
      candles,
      currentPrice: candles[candles.length - 1].close,
      hasOpenPosition: false,
      config,
    };

    const result = tick(initialState(config), snap);

    const enter = result.intents.find(i => i.kind === 'ENTER_LONG') as
      | Extract<Intent, { kind: 'ENTER_LONG' }>
      | undefined;
    expect(enter).toBeDefined();
    expect(enter!.usdtAmount).toBe(100);
  });

  it('does NOT emit ENTER on flat/choppy market (no crossover)', () => {
    const config = baseConfig({ adxThreshold: 0 });
    const candles = flatChoppyCandles();
    const snap: Snapshot = {
      symbol: 'BTC-USDT',
      candles,
      currentPrice: candles[candles.length - 1].close,
      hasOpenPosition: false,
      config,
    };

    const result = tick(initialState(config), snap);

    expect(result.intents.find(i => i.kind === 'ENTER_LONG')).toBeUndefined();
    expect(result.intents.find(i => i.kind === 'ENTER_SHORT')).toBeUndefined();
  });

  it('does NOT emit ENTER if a position is already open', () => {
    const config = baseConfig({ adxThreshold: 0 });
    const candles = trendUpCandles();
    const state = initialState(config);
    state.position = 'LONG';
    state.entryPrice = candles[candles.length - 1].close;
    state.entryOrderId = 'order-1';

    const snap: Snapshot = {
      symbol: 'BTC-USDT',
      candles,
      currentPrice: candles[candles.length - 1].close,
      hasOpenPosition: true,
      config,
    };

    const result = tick(state, snap);

    expect(result.intents.find(i => i.kind === 'ENTER_LONG')).toBeUndefined();
  });

  it('emits CLOSE_POSITION when trailing stop is hit', () => {
    const config = baseConfig({ adxThreshold: 0, trailingAtrMult: 1.0 });
    // Build candles: ATR is ~1, position entered at 100, peak at 110, current drops to 108
    const candles: Kline[] = [];
    // Stable history to compute ATR ≈ 1
    for (let i = 0; i < 60; i++) {
      candles.push(kline(100, 100.5, 99.5, 100));
    }
    candles.push(kline(108, 108, 108, 108));

    const state = initialState(config);
    state.position = 'LONG';
    state.entryPrice = 100;
    state.entryOrderId = 'order-1';
    state.highestPrice = 110;
    state.lowestPrice = null;
    state.trailingActivated = true;

    const snap: Snapshot = {
      symbol: 'BTC-USDT',
      candles,
      currentPrice: 108,
      hasOpenPosition: true,
      config,
    };

    const result = tick(state, snap);

    expect(result.intents.find(i => i.kind === 'CLOSE_POSITION')).toBeDefined();
  });

  it('emits ACTIVATE_TRAILING when activation threshold reached', () => {
    const config = baseConfig({ adxThreshold: 0, activationAtrMult: 1.0, trailingAtrMult: 1.0 });
    const candles: Kline[] = [];
    for (let i = 0; i < 60; i++) {
      candles.push(kline(100, 100.5, 99.5, 100));
    }
    candles.push(kline(102, 102, 102, 102));

    const state = initialState(config);
    state.position = 'LONG';
    state.entryPrice = 100;
    state.entryOrderId = 'order-1';
    state.trailingActivated = false;

    const snap: Snapshot = {
      symbol: 'BTC-USDT',
      candles,
      currentPrice: 102,
      hasOpenPosition: true,
      config,
    };

    const result = tick(state, snap);

    expect(result.intents.find(i => i.kind === 'ACTIVATE_TRAILING')).toBeDefined();
    expect(result.newState.trailingActivated).toBe(true);
  });

  it('returns no intents and unchanged state when not enough candles for indicators', () => {
    const config = baseConfig();
    const candles = [kline(100, 101, 99, 100)];
    const snap: Snapshot = {
      symbol: 'BTC-USDT',
      candles,
      currentPrice: 100,
      hasOpenPosition: false,
      config,
    };

    const result = tick(initialState(config), snap);

    expect(result.intents).toEqual([]);
  });
});
