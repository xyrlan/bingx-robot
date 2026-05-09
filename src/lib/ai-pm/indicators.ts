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
