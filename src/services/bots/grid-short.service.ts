import type { BingxClient } from '@/lib/bingx/client';
import { toPrecision, toQuantityPrecision, toSafeIdString } from '@/services/bingx.service';

export type PlaceGridShortEntryParams = {
  client: BingxClient;
  symbol: string;
  priceLevel: number;
  quantity: number;
  takeProfitPct: number;
  pricePrecision: number;
  quantityPrecision: number;
  currentPrice: number | null;
};

/** Build the order payload for a SHORT grid entry — no API call. */
export function buildGridShortEntryPayload(params: Omit<PlaceGridShortEntryParams, 'client'>): Record<string, unknown> {
  const { symbol, priceLevel, quantity, takeProfitPct, pricePrecision, quantityPrecision, currentPrice } = params;

  const priceStr = toPrecision(priceLevel, pricePrecision);
  const quantityStr = toQuantityPrecision(quantity, quantityPrecision);
  const useTriggerLimit = currentPrice != null && priceLevel < currentPrice;
  const orderType = useTriggerLimit ? 'TRIGGER_LIMIT' : 'LIMIT';

  const orderPayload: Record<string, unknown> = {
    symbol,
    side: 'SELL',
    type: orderType,
    quantity: parseFloat(quantityStr),
    price: parseFloat(priceStr),
    positionSide: 'SHORT',
    timeInForce: 'GTC',
    workingType: 'MARK_PRICE',
  };

  if (useTriggerLimit) {
    orderPayload.stopPrice = parseFloat(priceStr);
  }

  const tpStopPrice = priceLevel * (1 - takeProfitPct);
  const tpStopPriceStr = toPrecision(tpStopPrice, pricePrecision);
  const tpPrice = parseFloat(tpStopPriceStr);
  if (tpPrice > 0) {
    orderPayload.takeProfit = JSON.stringify({
      type: 'TAKE_PROFIT_MARKET',
      stopPrice: tpPrice,
      price: tpPrice,
      workingType: 'MARK_PRICE',
    });
  }

  return orderPayload;
}

export async function placeGridShortEntryOrder(params: PlaceGridShortEntryParams): Promise<string | null> {
  const { client, ...rest } = params;
  const orderPayload = buildGridShortEntryPayload(rest);

  try {
    const result = (await client.post('/openApi/swap/v2/trade/order', orderPayload, true)) as {
      orderId?: string | number;
      order?: { orderId?: string | number };
    };
    const raw = result?.orderId ?? result?.order?.orderId;
    return raw != null ? (toSafeIdString(raw) ?? null) : null;
  } catch (err) {
    throw err;
  }
}

export async function placeShortTakeProfitOrder(
  client: BingxClient,
  symbol: string,
  quantity: number,
  stopPrice: number,
  pricePrecision: number,
  positionId?: string | number,
): Promise<string | null> {
  try {
    const stopPriceStr = toPrecision(stopPrice, pricePrecision);
    const positionIdStr = toSafeIdString(positionId);
    const orderPayload: Record<string, unknown> = {
      symbol,
      side: 'BUY',
      type: 'TAKE_PROFIT_MARKET',
      positionSide: 'SHORT',
      stopPrice: parseFloat(stopPriceStr),
      workingType: 'MARK_PRICE',
    };
    if (positionIdStr != null) {
      orderPayload.positionId = positionIdStr;
      orderPayload.closePosition = 'true';
    } else {
      orderPayload.quantity = parseFloat(toPrecision(quantity, 8));
    }
    const result = (await client.post('/openApi/swap/v2/trade/order', orderPayload, true)) as {
      orderId?: string | number;
      order?: { orderId?: string | number };
    };
    const rawOrderId = result?.orderId ?? result?.order?.orderId;
    return rawOrderId != null ? toSafeIdString(rawOrderId) ?? null : null;
  } catch (err) {
    console.error('[BingX] placeShortTakeProfitOrder failed:', err);
    return null;
  }
}
