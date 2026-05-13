import type { BingxClient } from '@/lib/bingx/client';

export interface PlaceOrderParams {
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  type: 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET' | 'TRAILING_STOP_MARKET';
  quantity: string;
  price?: string;
  stopPrice?: string;
  timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'PostOnly';
  priceRate?: string;
  reduceOnly?: boolean;
  stopLoss?: { type: 'STOP_MARKET'; stopPrice: string };
  takeProfit?: { type: 'TAKE_PROFIT_MARKET'; stopPrice: string };
}

export interface PlaceOrderResult {
  orderId: string;
  status: string;
  avgPrice?: string;
}

export async function placeFuturesOrder(
  client: BingxClient,
  params: PlaceOrderParams,
): Promise<PlaceOrderResult> {
  const body: Record<string, unknown> = {
    symbol: params.symbol,
    side: params.side,
    positionSide: params.positionSide,
    type: params.type,
    quantity: params.quantity,
  };
  if (params.price !== undefined) body.price = params.price;
  if (params.stopPrice !== undefined) body.stopPrice = params.stopPrice;
  if (params.timeInForce !== undefined) body.timeInForce = params.timeInForce;
  if (params.priceRate !== undefined) body.priceRate = params.priceRate;
  if (params.reduceOnly !== undefined) body.reduceOnly = String(params.reduceOnly);
  if (params.stopLoss !== undefined) body.stopLoss = JSON.stringify(params.stopLoss);
  if (params.takeProfit !== undefined) body.takeProfit = JSON.stringify(params.takeProfit);

  const res = await client.post<{ order: { orderId: string; status: string; avgPrice?: string } }>(
    '/openApi/swap/v2/trade/order',
    body,
  );
  return {
    orderId: String(res.order.orderId),
    status: res.order.status,
    avgPrice: res.order.avgPrice,
  };
}

export async function cancelFuturesOrder(
  client: BingxClient,
  symbol: string,
  orderId: string,
): Promise<void> {
  await client.delete('/openApi/swap/v2/trade/order', { symbol, orderId });
}

export interface CancelAllResult { canceledCount: number; }

export async function cancelAllFuturesOrders(
  client: BingxClient,
  symbol?: string,
): Promise<CancelAllResult> {
  const params: Record<string, string> = {};
  if (symbol) params.symbol = symbol;
  const res = await client.delete<{ success?: Array<{ orderId: string }> }>(
    '/openApi/swap/v2/trade/allOpenOrders',
    params,
  );
  return { canceledCount: res.success?.length ?? 0 };
}

export interface CloseAllResult { closedCount: number; }

export async function closeAllPositions(
  client: BingxClient,
  symbol: string,
): Promise<CloseAllResult> {
  const res = await client.post<{ success?: unknown[] }>(
    '/openApi/swap/v2/trade/closeAllPositions',
    { symbol },
  );
  return { closedCount: res.success?.length ?? 0 };
}

export interface FuturesPosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  qty: string;
  entryPrice: string;
  markPrice: string;
  unrealizedPnlUsdt: string;
  leverage: number;
  liquidationPrice: string;
}

export async function listFuturesPositions(
  client: BingxClient,
  symbol?: string,
): Promise<FuturesPosition[]> {
  const params: Record<string, string> = {};
  if (symbol) params.symbol = symbol;
  const res = await client.get<Array<{
    symbol: string; positionSide: 'LONG' | 'SHORT'; positionAmt: string;
    avgPrice: string; markPrice: string; unrealizedProfit: string;
    leverage: string; liquidationPrice: string;
  }>>('/openApi/swap/v2/user/positions', params);
  return res.map((p) => ({
    symbol: p.symbol,
    side: p.positionSide,
    qty: p.positionAmt,
    entryPrice: p.avgPrice,
    markPrice: p.markPrice,
    unrealizedPnlUsdt: p.unrealizedProfit,
    leverage: Number(p.leverage),
    liquidationPrice: p.liquidationPrice,
  }));
}

export interface FuturesOpenOrder {
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: string;
  quantity: string;
  price: string;
  stopPrice: string;
  status: string;
  createdAt: string;
}

export async function listFuturesOpenOrders(
  client: BingxClient,
  symbol?: string,
): Promise<FuturesOpenOrder[]> {
  const params: Record<string, string> = {};
  if (symbol) params.symbol = symbol;
  const res = await client.get<{ orders: Array<{
    orderId: string; symbol: string; side: 'BUY' | 'SELL'; type: string;
    origQty: string; price: string; stopPrice: string; status: string; time: number;
  }>; }>('/openApi/swap/v2/trade/openOrders', params);
  return (res.orders ?? []).map((o) => ({
    orderId: String(o.orderId),
    symbol: o.symbol,
    side: o.side,
    type: o.type,
    quantity: o.origQty,
    price: o.price,
    stopPrice: o.stopPrice,
    status: o.status,
    createdAt: new Date(o.time).toISOString(),
  }));
}

export interface FuturesBalance {
  availableUsdt: string;
  equityUsdt: string;
  marginUsedUsdt: string;
  unrealizedPnlUsdt: string;
}

export async function getFuturesBalance(client: BingxClient): Promise<FuturesBalance> {
  const res = await client.get<Array<{
    asset: string; balance?: string; equity?: string; availableMargin?: string;
    unrealizedProfit?: string; usedMargin?: string;
  }>>('/openApi/swap/v3/user/balance', {});
  const usdt = res.find((r) => r.asset === 'USDT');
  return {
    availableUsdt: usdt?.availableMargin ?? '0',
    equityUsdt: usdt?.equity ?? '0',
    marginUsedUsdt: usdt?.usedMargin ?? '0',
    unrealizedPnlUsdt: usdt?.unrealizedProfit ?? '0',
  };
}
