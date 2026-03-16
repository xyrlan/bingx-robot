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

/**
 * Get current spot price for a symbol.
 */
export async function getSpotCurrentPrice(
  client: BingxClient,
  symbol: string,
): Promise<number | null> {
  try {
    const data = (await client.get('/openApi/spot/v2/ticker/price', { symbol })) as
      | Array<{ trades?: Array<{ price?: string }> }>
      | undefined;
    const price = data?.[0]?.trades?.[0]?.price;
    return price ? parseFloat(price) : null;
  } catch (err) {
    console.error('[DCA-SPOT] Failed to get spot price:', err);
    return null;
  }
}

/**
 * Get spot account balance for an asset.
 */
export async function getSpotBalance(
  client: BingxClient,
  asset = 'USDT',
): Promise<{ free: number; locked: number } | null> {
  try {
    const data = (await client.get('/openApi/spot/v1/account/balance')) as {
      balances?: Array<{ asset: string; free: string; locked: string }>;
    };
    const bal = data?.balances?.find(
      (b) => b.asset.toUpperCase() === asset.toUpperCase(),
    );
    if (!bal) return null;
    return {
      free: parseFloat(bal.free),
      locked: parseFloat(bal.locked),
    };
  } catch (err) {
    console.error('[DCA-SPOT] Failed to get spot balance:', err);
    return null;
  }
}
