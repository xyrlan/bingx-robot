export type Candle = { high: number; low: number; close: number };
export type CloseCandle = { close: number };
export type Bollinger = { upper: number; middle: number; lower: number };
export type CrossoverState = 'CROSS_UP' | 'CROSS_DOWN' | 'NONE';

export function sma(candles: readonly CloseCandle[], period: number): number | null {
  if (period <= 0 || candles.length < period) return null;
  let sum = 0;
  const start = candles.length - period;
  for (let i = start; i < candles.length; i++) {
    sum += candles[i].close;
  }
  return sum / period;
}

export function rsi(candles: readonly CloseCandle[], period = 14): number | null {
  if (period <= 0 || candles.length < period + 1) return null;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff > 0) avgGain += diff;
    else avgLoss += -diff;
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function atr(candles: readonly Candle[], period = 14): number | null {
  if (period <= 0 || candles.length < period + 1) return null;

  let atrVal = 0;
  for (let i = 1; i <= period; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose),
    );
    atrVal += tr;
  }
  atrVal /= period;

  for (let i = period + 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose),
    );
    atrVal = (atrVal * (period - 1) + tr) / period;
  }

  return atrVal;
}

export function bollinger(
  candles: readonly CloseCandle[],
  period = 20,
  stdDev = 2,
): Bollinger | null {
  if (period <= 0 || candles.length < period) return null;

  const start = candles.length - period;
  let sum = 0;
  for (let i = start; i < candles.length; i++) {
    sum += candles[i].close;
  }
  const mean = sum / period;

  let varSum = 0;
  for (let i = start; i < candles.length; i++) {
    const d = candles[i].close - mean;
    varSum += d * d;
  }
  const sd = Math.sqrt(varSum / period);

  return {
    upper: mean + stdDev * sd,
    middle: mean,
    lower: mean - stdDev * sd,
  };
}

export function ema(candles: readonly CloseCandle[], period: number): number | null {
  if (period <= 0 || candles.length < period) return null;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += candles[i].close;
  let val = sum / period;
  const alpha = 2 / (period + 1);
  for (let i = period; i < candles.length; i++) {
    val = val + alpha * (candles[i].close - val);
  }
  return val;
}

export interface FvgZone {
  low: number;
  high: number;
  ageBars: number;
}

export interface FairValueGapsResult {
  bullish: FvgZone[];
  bearish: FvgZone[];
}

export function fairValueGaps(candles: readonly Candle[]): FairValueGapsResult {
  const n = candles.length;
  if (n < 3) return { bullish: [], bearish: [] };

  const latest = n - 1;
  const bullish: FvgZone[] = [];
  const bearish: FvgZone[] = [];

  for (let i = 2; i < n; i++) {
    const prev2 = candles[i - 2];
    const cur = candles[i];

    if (prev2.high < cur.low) {
      const zoneLow = prev2.high;
      const zoneHigh = cur.low;
      let filled = false;
      for (let j = i + 1; j < n; j++) {
        if (candles[j].low <= zoneHigh) {
          filled = true;
          break;
        }
      }
      if (!filled) {
        bullish.push({ low: zoneLow, high: zoneHigh, ageBars: latest - i });
      }
    }

    if (prev2.low > cur.high) {
      const zoneLow = cur.high;
      const zoneHigh = prev2.low;
      let filled = false;
      for (let j = i + 1; j < n; j++) {
        if (candles[j].high >= zoneLow) {
          filled = true;
          break;
        }
      }
      if (!filled) {
        bearish.push({ low: zoneLow, high: zoneHigh, ageBars: latest - i });
      }
    }
  }

  return { bullish, bearish };
}

export interface SwingsResult {
  swingHigh: number | null;
  swingLow: number | null;
}

export function swings(candles: readonly Candle[], lookback: number): SwingsResult {
  const n = candles.length;
  if (lookback <= 0 || n < 2 * lookback + 1) return { swingHigh: null, swingLow: null };

  let swingHigh: number | null = null;
  let swingLow: number | null = null;

  for (let i = n - 1 - lookback; i >= lookback; i--) {
    const cur = candles[i];
    if (swingHigh === null) {
      let isHigh = true;
      for (let j = 1; j <= lookback; j++) {
        if (candles[i - j].high >= cur.high || candles[i + j].high >= cur.high) {
          isHigh = false;
          break;
        }
      }
      if (isHigh) swingHigh = cur.high;
    }
    if (swingLow === null) {
      let isLow = true;
      for (let j = 1; j <= lookback; j++) {
        if (candles[i - j].low <= cur.low || candles[i + j].low <= cur.low) {
          isLow = false;
          break;
        }
      }
      if (isLow) swingLow = cur.low;
    }
    if (swingHigh !== null && swingLow !== null) break;
  }

  return { swingHigh, swingLow };
}

export function crossoverState(
  shortSeries: readonly number[],
  longSeries: readonly number[],
): CrossoverState {
  if (shortSeries.length < 2 || longSeries.length < 2) return 'NONE';
  const sN = shortSeries[shortSeries.length - 1];
  const sP = shortSeries[shortSeries.length - 2];
  const lN = longSeries[longSeries.length - 1];
  const lP = longSeries[longSeries.length - 2];
  if (sP <= lP && sN > lN) return 'CROSS_UP';
  if (sP >= lP && sN < lN) return 'CROSS_DOWN';
  return 'NONE';
}
