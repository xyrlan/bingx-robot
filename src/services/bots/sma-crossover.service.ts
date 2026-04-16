import type { BingxClient } from '@/lib/bingx/client';
import {
  toPrecision,
  toQuantityPrecision,
  toSafeIdString,
  cancelBatchOrders,
} from '@/services/bingx.service';
import type { SMAConfig, SMASymbolState } from './types';

// ==========================================
// Pure calculation functions
// ==========================================

export function calculateSMA(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((sum, v) => sum + v, 0) / period;
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
  config: Pick<SMAConfig, 'activationPct' | 'trailingPct' | 'initialStopPct'>
): {
  action: 'HOLD' | 'ACTIVATE' | 'CLOSE';
  updatedHighest: number;
  updatedLowest: number;
  newStopPrice: number | null;
} {
  const entryPrice = state.entryPrice ?? currentPrice;
  const isLong = state.position === 'LONG';

  const highest = Math.max(state.highestPrice ?? entryPrice, isLong ? currentPrice : 0);
  const lowest = Math.min(
    state.lowestPrice ?? entryPrice,
    !isLong ? currentPrice : Infinity
  );

  // Check initial stop loss
  if (!state.trailingActivated) {
    const initialStop = isLong
      ? entryPrice * (1 - config.initialStopPct / 100)
      : entryPrice * (1 + config.initialStopPct / 100);

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

    // Check activation threshold
    const activationPrice = isLong
      ? entryPrice * (1 + config.activationPct / 100)
      : entryPrice * (1 - config.activationPct / 100);

    const activated = isLong
      ? currentPrice >= activationPrice
      : currentPrice <= activationPrice;

    if (activated) {
      const trailStop = isLong
        ? highest * (1 - config.trailingPct / 100)
        : lowest * (1 + config.trailingPct / 100);

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

  // Trailing is active — check if stop hit
  const trailStop = isLong
    ? highest * (1 - config.trailingPct / 100)
    : lowest * (1 + config.trailingPct / 100);

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
  };
}
