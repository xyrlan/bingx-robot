import type { BingxClient } from '@/lib/bingx/client';
import {
  toPrecision,
  toQuantityPrecision,
  toSafeIdString,
  cancelBatchOrders,
} from '@/services/bingx.service';
import type { Kline } from '@/services/bingx.service';
import type { SMAConfig, SMASymbolState } from './types';

// ==========================================
// Pure calculation functions
// ==========================================

export function calculateSMA(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((sum, v) => sum + v, 0) / period;
}

export function calculateATR(klines: Kline[], period: number): number | null {
  if (klines.length < period + 1) return null;

  const trueRanges: number[] = [];
  for (let i = 1; i < klines.length; i++) {
    const high = klines[i].high;
    const low = klines[i].low;
    const prevClose = klines[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trueRanges.push(tr);
  }

  if (trueRanges.length < period) return null;

  // Initial ATR = simple average of first `period` TRs
  let atr = trueRanges.slice(0, period).reduce((s, v) => s + v, 0) / period;

  // Smoothed ATR (Wilder's method) for remaining values
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }

  return atr;
}

export function calculateADX(klines: Kline[], period: number): number | null {
  if (klines.length < period * 2 + 1) return null;

  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const trueRanges: number[] = [];

  for (let i = 1; i < klines.length; i++) {
    const high = klines[i].high;
    const low = klines[i].low;
    const prevHigh = klines[i - 1].high;
    const prevLow = klines[i - 1].low;
    const prevClose = klines[i - 1].close;

    const upMove = high - prevHigh;
    const downMove = prevLow - low;

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);

    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trueRanges.push(tr);
  }

  if (trueRanges.length < period) return null;

  // Wilder's smoothing for ATR, +DM, -DM
  let smoothATR = trueRanges.slice(0, period).reduce((s, v) => s + v, 0);
  let smoothPlusDM = plusDM.slice(0, period).reduce((s, v) => s + v, 0);
  let smoothMinusDM = minusDM.slice(0, period).reduce((s, v) => s + v, 0);

  const dxValues: number[] = [];

  // First DI values
  const plusDI = (smoothPlusDM / smoothATR) * 100;
  const minusDI = (smoothMinusDM / smoothATR) * 100;
  const diSum = plusDI + minusDI;
  if (diSum > 0) dxValues.push((Math.abs(plusDI - minusDI) / diSum) * 100);

  // Subsequent smoothed values
  for (let i = period; i < trueRanges.length; i++) {
    smoothATR = smoothATR - smoothATR / period + trueRanges[i];
    smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i];
    smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i];

    if (smoothATR === 0) continue;

    const pDI = (smoothPlusDM / smoothATR) * 100;
    const mDI = (smoothMinusDM / smoothATR) * 100;
    const sum = pDI + mDI;
    if (sum > 0) dxValues.push((Math.abs(pDI - mDI) / sum) * 100);
  }

  if (dxValues.length < period) return null;

  // ADX = smoothed average of DX
  let adx = dxValues.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i]) / period;
  }

  return adx;
}

export type SignalResult = {
  crossover: 'LONG' | 'SHORT' | null;
  trendConfirms: boolean;
  signal: 'LONG' | 'SHORT' | null;
};

export function detectSignal(params: {
  closes: number[];
  fastPeriod: number;
  mediumPeriod: number;
  trendPeriod: number;
}): SignalResult {
  const { closes, fastPeriod, mediumPeriod, trendPeriod } = params;
  const noSignal: SignalResult = { crossover: null, trendConfirms: false, signal: null };

  // Need at least trendPeriod + 1 candles (current + one previous for crossover)
  if (closes.length < trendPeriod + 1) return noSignal;

  const currentCloses = closes;
  const prevCloses = closes.slice(0, -1);

  const smaFast = calculateSMA(currentCloses, fastPeriod);
  const smaMedium = calculateSMA(currentCloses, mediumPeriod);
  const smaTrend = calculateSMA(currentCloses, trendPeriod);

  const prevSmaFast = calculateSMA(prevCloses, fastPeriod);
  const prevSmaMedium = calculateSMA(prevCloses, mediumPeriod);

  if (
    smaFast == null ||
    smaMedium == null ||
    smaTrend == null ||
    prevSmaFast == null ||
    prevSmaMedium == null
  )
    return noSignal;

  const currentClose = closes[closes.length - 1];

  // Detect crossover direction (independent of trend)
  const crossedAbove = prevSmaFast <= prevSmaMedium && smaFast > smaMedium;
  const crossedBelow = prevSmaFast >= prevSmaMedium && smaFast < smaMedium;

  if (crossedAbove) {
    const trendConfirms = currentClose > smaTrend;
    return {
      crossover: 'LONG',
      trendConfirms,
      signal: trendConfirms ? 'LONG' : null,
    };
  }

  if (crossedBelow) {
    const trendConfirms = currentClose < smaTrend;
    return {
      crossover: 'SHORT',
      trendConfirms,
      signal: trendConfirms ? 'SHORT' : null,
    };
  }

  return noSignal;
}

export function checkSMATrailingStop(
  state: SMASymbolState,
  currentPrice: number,
  config: Pick<SMAConfig, 'activationAtrMult' | 'trailingAtrMult' | 'initialStopAtrMult'>,
  atr: number
): {
  action: 'HOLD' | 'ACTIVATE' | 'CLOSE';
  updatedHighest: number;
  updatedLowest: number;
  newStopPrice: number | null;
} {
  // Guard against missing or zero ATR — skip trailing logic to avoid erratic stops
  if (atr <= 0) {
    return {
      action: 'HOLD',
      updatedHighest: state.highestPrice ?? currentPrice,
      updatedLowest: state.lowestPrice ?? currentPrice,
      newStopPrice: null,
    };
  }

  const entryPrice = state.entryPrice ?? currentPrice;
  const isLong = state.position === 'LONG';

  const highest = Math.max(state.highestPrice ?? entryPrice, isLong ? currentPrice : 0);
  const lowest = Math.min(
    state.lowestPrice ?? entryPrice,
    !isLong ? currentPrice : Infinity
  );

  // Check initial stop loss (ATR-based)
  if (!state.trailingActivated) {
    const stopDistance = config.initialStopAtrMult * atr;
    const initialStop = isLong
      ? entryPrice - stopDistance
      : entryPrice + stopDistance;

    const hitInitialStop = isLong
      ? currentPrice <= initialStop
      : currentPrice >= initialStop;

    if (hitInitialStop) {
      return {
        action: 'CLOSE',
        updatedHighest: highest,
        updatedLowest: lowest,
        newStopPrice: null,
      };
    }

    // Check activation threshold (ATR-based)
    const activationDistance = config.activationAtrMult * atr;
    const activationPrice = isLong
      ? entryPrice + activationDistance
      : entryPrice - activationDistance;

    const activated = isLong
      ? currentPrice >= activationPrice
      : currentPrice <= activationPrice;

    if (activated) {
      const trailDistance = config.trailingAtrMult * atr;
      const trailStop = isLong
        ? highest - trailDistance
        : lowest + trailDistance;

      return {
        action: 'ACTIVATE',
        updatedHighest: highest,
        updatedLowest: lowest,
        newStopPrice: trailStop,
      };
    }

    // Not activated yet — keep initial stop
    return {
      action: 'HOLD',
      updatedHighest: highest,
      updatedLowest: lowest,
      newStopPrice: initialStop,
    };
  }

  // Trailing is active — check if stop hit (ATR-based)
  const trailDistance = config.trailingAtrMult * atr;
  const trailStop = isLong
    ? highest - trailDistance
    : lowest + trailDistance;

  const hitTrail = isLong
    ? currentPrice <= trailStop
    : currentPrice >= trailStop;

  if (hitTrail) {
    return {
      action: 'CLOSE',
      updatedHighest: highest,
      updatedLowest: lowest,
      newStopPrice: null,
    };
  }

  return {
    action: 'HOLD',
    updatedHighest: highest,
    updatedLowest: lowest,
    newStopPrice: trailStop,
  };
}

// ==========================================
// API-calling functions
// ==========================================

export async function placeEntryOrder(
  client: BingxClient,
  symbol: string,
  positionSide: 'LONG' | 'SHORT',
  positionSizeUsdt: number,
  currentPrice: number,
  quantityPrecision: number
): Promise<string | null> {
  const quantity = positionSizeUsdt / currentPrice;
  const quantityStr = toQuantityPrecision(quantity, quantityPrecision);
  const side = positionSide === 'LONG' ? 'BUY' : 'SELL';

  const orderPayload: Record<string, unknown> = {
    symbol,
    side,
    type: 'MARKET',
    quantity: parseFloat(quantityStr),
    positionSide,
  };

  try {
    const result = (await client.post('/openApi/swap/v2/trade/order', orderPayload, true)) as {
      orderId?: string | number;
      order?: { orderId?: string | number };
    };
    const raw = result?.orderId ?? result?.order?.orderId;
    return raw != null ? (toSafeIdString(raw) ?? null) : null;
  } catch (err) {
    console.error(`[SMA] Entry order failed for ${symbol}:`, err);
    return null;
  }
}

export async function placeStopOrder(
  client: BingxClient,
  symbol: string,
  positionSide: 'LONG' | 'SHORT',
  stopPrice: number,
  quantity: number,
  pricePrecision: number
): Promise<string | null> {
  const side = positionSide === 'LONG' ? 'SELL' : 'BUY';
  const stopType = 'STOP_MARKET';
  const stopPriceStr = toPrecision(stopPrice, pricePrecision);

  const orderPayload: Record<string, unknown> = {
    symbol,
    side,
    type: stopType,
    positionSide,
    stopPrice: parseFloat(stopPriceStr),
    quantity,
    workingType: 'MARK_PRICE',
  };

  try {
    const result = (await client.post('/openApi/swap/v2/trade/order', orderPayload, true)) as {
      orderId?: string | number;
      order?: { orderId?: string | number };
    };
    const raw = result?.orderId ?? result?.order?.orderId;
    return raw != null ? (toSafeIdString(raw) ?? null) : null;
  } catch (err) {
    console.error(`[SMA] Stop order failed for ${symbol}:`, err);
    return null;
  }
}

export async function closePositionMarket(
  client: BingxClient,
  symbol: string,
  positionSide: 'LONG' | 'SHORT',
  quantity: number,
  quantityPrecision: number
): Promise<string | null> {
  const quantityStr = toQuantityPrecision(quantity, quantityPrecision);
  const side = positionSide === 'LONG' ? 'SELL' : 'BUY';

  const orderPayload: Record<string, unknown> = {
    symbol,
    side,
    type: 'MARKET',
    quantity: parseFloat(quantityStr),
    positionSide,
  };

  try {
    const result = (await client.post('/openApi/swap/v2/trade/order', orderPayload, true)) as {
      orderId?: string | number;
      order?: { orderId?: string | number };
    };
    const raw = result?.orderId ?? result?.order?.orderId;
    return raw != null ? (toSafeIdString(raw) ?? null) : null;
  } catch (err) {
    console.error(`[SMA] Close position failed for ${symbol}:`, err);
    return null;
  }
}

export async function cancelStopOrder(
  client: BingxClient,
  symbol: string,
  orderId: string
): Promise<void> {
  try {
    await cancelBatchOrders(client, symbol, [orderId]);
  } catch (err) {
    console.error(`[SMA] Cancel stop order failed for ${symbol}:`, err);
  }
}

export function createEmptySymbolState(): SMASymbolState {
  return {
    position: null,
    entryPrice: null,
    entryOrderId: null,
    stopOrderId: null,
    highestPrice: null,
    lowestPrice: null,
    trailingActivated: false,
    lastSignal: null,
    lastSignalAt: null,
    lastAtr: null,
  };
}
