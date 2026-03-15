import type { BingxClient } from '@/lib/bingx/client';
import { toQuantityPrecision, toSafeIdString } from '@/services/bingx.service';
import type { DCAConfig } from './types';

export async function placeDCAOrder(
  client: BingxClient,
  symbol: string,
  config: DCAConfig,
  currentPrice: number,
  quantityPrecision: number,
): Promise<string | null> {
  const quantity = config.orderSizeUsdt / currentPrice;
  const quantityStr = toQuantityPrecision(quantity, quantityPrecision);
  const side = config.side === 'SELL' ? 'SELL' : 'BUY';
  const positionSide = side === 'BUY' ? 'LONG' : 'SHORT';

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
    console.error('[DCA] Order placement failed:', err);
    return null;
  }
}

export function shouldPlaceDCAOrder(
  config: DCAConfig,
  botCreatedAt: Date,
): boolean {
  if (config.ordersPlaced >= config.totalOrders) return false;
  const elapsed = Date.now() - botCreatedAt.getTime();
  const expectedOrders = Math.floor(elapsed / (config.intervalMinutes * 60 * 1000)) + 1;
  return config.ordersPlaced < expectedOrders;
}
