import type { BingxClient } from '@/lib/bingx/client';
import { toPrecision, toQuantityPrecision, toSafeIdString } from '@/services/bingx.service';
import type { TrailingStopConfig } from './types';

export async function placeEntryMarketOrder(
  client: BingxClient,
  symbol: string,
  positionSizeUsdt: number,
  currentPrice: number,
  quantityPrecision: number,
): Promise<string | null> {
  const quantity = positionSizeUsdt / currentPrice;
  const quantityStr = toQuantityPrecision(quantity, quantityPrecision);

  const orderPayload: Record<string, unknown> = {
    symbol,
    side: 'BUY',
    type: 'MARKET',
    quantity: parseFloat(quantityStr),
    positionSide: 'LONG',
  };

  try {
    const result = (await client.post('/openApi/swap/v2/trade/order', orderPayload, true)) as {
      orderId?: string | number;
      order?: { orderId?: string | number };
    };
    const raw = result?.orderId ?? result?.order?.orderId;
    return raw != null ? (toSafeIdString(raw) ?? null) : null;
  } catch (err) {
    console.error('[TrailingStop] Entry order failed:', err);
    return null;
  }
}

export async function closePosition(
  client: BingxClient,
  symbol: string,
  quantity: number,
  quantityPrecision: number,
): Promise<string | null> {
  const quantityStr = toPrecision(quantity, quantityPrecision);

  const orderPayload: Record<string, unknown> = {
    symbol,
    side: 'SELL',
    type: 'MARKET',
    quantity: parseFloat(quantityStr),
    positionSide: 'LONG',
  };

  try {
    const result = (await client.post('/openApi/swap/v2/trade/order', orderPayload, true)) as {
      orderId?: string | number;
      order?: { orderId?: string | number };
    };
    const raw = result?.orderId ?? result?.order?.orderId;
    return raw != null ? (toSafeIdString(raw) ?? null) : null;
  } catch (err) {
    console.error('[TrailingStop] Close position failed:', err);
    return null;
  }
}

export function checkTrailingStop(
  config: TrailingStopConfig,
  currentPrice: number,
  entryPrice: number,
): { action: 'HOLD' | 'ACTIVATE' | 'CLOSE'; updatedHighest: number } {
  const highest = Math.max(config.highestPrice || entryPrice, currentPrice);

  if (!config.isActivated) {
    const activationPrice = entryPrice * (1 + config.activationPricePct / 100);
    if (currentPrice >= activationPrice) {
      return { action: 'ACTIVATE', updatedHighest: highest };
    }
    return { action: 'HOLD', updatedHighest: highest };
  }

  const trailPrice = highest * (1 - config.trailingPct / 100);
  if (currentPrice <= trailPrice) {
    return { action: 'CLOSE', updatedHighest: highest };
  }

  return { action: 'HOLD', updatedHighest: highest };
}
