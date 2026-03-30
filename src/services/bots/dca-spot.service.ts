import type { BingxClient } from '@/lib/bingx/client';
import { toSafeIdString } from '@/services/bingx.service';
import type { DCAConfig } from './types';

/**
 * Place a spot market order using quoteOrderQty (spend X USDT).
 * Uses /openApi/spot/v1/trade/order with x-www-form-urlencoded.
 */
export async function placeSpotDCAOrder(
  client: BingxClient,
  symbol: string,
  config: DCAConfig,
): Promise<string | null> {
  const side = config.side === 'SELL' ? 'SELL' : 'BUY';

  const params: Record<string, string | number> = {
    symbol,
    side,
    type: 'MARKET',
    quoteOrderQty: config.orderSizeUsdt,
  };

  try {
    const result = (await client.postForm('/openApi/spot/v1/trade/order', params)) as {
      orderId?: string | number;
      order?: { orderId?: string | number };
    };
    const raw = result?.orderId ?? result?.order?.orderId;
    return raw != null ? (toSafeIdString(raw) ?? null) : null;
  } catch (err) {
    console.error('[DCA-SPOT] Order placement failed:', err);
    return null;
  }
}
