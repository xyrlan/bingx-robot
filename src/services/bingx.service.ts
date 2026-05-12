import { eq, and, desc, isNull, sql, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { bingxApiKeys, tradingBots, gridLevels, botTrades } from '@/db/schema';
import { encryptSecret, decryptSecret } from '@/lib/bingx/encryption';
import { createBingxClient, type BingxClient } from '@/lib/bingx/client';
import type { InferSelectModel } from 'drizzle-orm';
import { maybeEmitFillEvent } from '@/lib/ai-pm/emit-events';
import { inngest } from '@/inngest/client';
import type { FillPayload } from '@/lib/ai-pm/events';

export type TradingBot = InferSelectModel<typeof tradingBots>;
export type GridLevel = InferSelectModel<typeof gridLevels>;

export async function saveBingxKeys(
  userId: string,
  apiKey: string,
  secretKey: string,
  label: string = 'Main',
  apiKeyId?: string
): Promise<string> {
  const trimmedApiKey = apiKey.trim();
  const trimmedSecretKey = secretKey.trim();
  const secretKeyEncrypted = encryptSecret(trimmedSecretKey);

  if (apiKeyId) {
    await db
      .update(bingxApiKeys)
      .set({
        apiKey: trimmedApiKey,
        secretKeyEncrypted,
        label,
        updatedAt: new Date(),
      })
      .where(and(eq(bingxApiKeys.id, apiKeyId), eq(bingxApiKeys.userId, userId)));
    return apiKeyId;
  }

  const [row] = await db
    .insert(bingxApiKeys)
    .values({
      userId,
      apiKey: trimmedApiKey,
      secretKeyEncrypted,
      label,
    })
    .returning({ id: bingxApiKeys.id });
  return row.id;
}

export async function getBingxKeys(userId: string): Promise<{ apiKey: string; secretKey: string } | null> {
  const row = await db.query.bingxApiKeys.findFirst({
    where: eq(bingxApiKeys.userId, userId),
  });
  if (!row) return null;
  try {
    const secretKey = decryptSecret(row.secretKeyEncrypted);
    return { apiKey: row.apiKey, secretKey };
  } catch {
    return null;
  }
}

export async function getBingxClient(userId: string): Promise<BingxClient | null> {
  const keys = await getBingxKeys(userId);
  if (!keys) return null;
  return createBingxClient(keys.apiKey, keys.secretKey);
}

export async function getBingxKeysByApiKeyId(apiKeyId: string): Promise<{ apiKey: string; secretKey: string } | null> {
  const row = await db.query.bingxApiKeys.findFirst({
    where: eq(bingxApiKeys.id, apiKeyId),
  });
  if (!row) return null;
  try {
    const secretKey = decryptSecret(row.secretKeyEncrypted);
    return { apiKey: row.apiKey, secretKey };
  } catch {
    return null;
  }
}

export async function getBingxClientByApiKeyId(apiKeyId: string): Promise<BingxClient | null> {
  const keys = await getBingxKeysByApiKeyId(apiKeyId);
  if (!keys) return null;
  return createBingxClient(keys.apiKey, keys.secretKey);
}

export async function getUserApiKeys(userId: string): Promise<Array<{ id: string; label: string; createdAt: Date }>> {
  return db.query.bingxApiKeys.findMany({
    where: eq(bingxApiKeys.userId, userId),
    columns: { id: true, label: true, createdAt: true },
    orderBy: [desc(bingxApiKeys.createdAt)],
  });
}

export async function deleteBingxKey(apiKeyId: string, userId: string): Promise<void> {
  await db.delete(bingxApiKeys).where(
    and(eq(bingxApiKeys.id, apiKeyId), eq(bingxApiKeys.userId, userId))
  );
}

export async function deleteBingxKeys(userId: string): Promise<void> {
  await db.delete(bingxApiKeys).where(eq(bingxApiKeys.userId, userId));
}

export async function hasBingxKeys(userId: string): Promise<boolean> {
  const row = await db.query.bingxApiKeys.findFirst({
    where: eq(bingxApiKeys.userId, userId),
    columns: { id: true },
  });
  return !!row;
}

// ========== Trading Bots ==========

export type CreateBotParams = {
  symbol: string;
  priceMin: string;
  priceMax: string;
  positionSizeUsdt: string;
  takeProfitPercentage: string;
  gridCount: number;
  leverage?: number;
  marginType?: string;
  apiKeyId?: string;
  botType?: 'GRID_LONG' | 'GRID_SHORT' | 'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER';
  config?: Record<string, unknown>;
};

export async function createBot(userId: string, params: CreateBotParams): Promise<TradingBot> {
  const [bot] = await db
    .insert(tradingBots)
    .values({
      userId,
      symbol: params.symbol,
      botType: params.botType ?? 'GRID_LONG',
      config: params.config,
      priceMin: params.priceMin,
      priceMax: params.priceMax,
      positionSizeUsdt: params.positionSizeUsdt,
      takeProfitPercentage: params.takeProfitPercentage,
      gridCount: params.gridCount,
      leverage: params.leverage ?? 1,
      marginType: params.marginType ?? 'SEPARATE_ISOLATED',
      apiKeyId: params.apiKeyId,
    })
    .returning();
  if (!bot) throw new Error('Failed to create bot');
  return bot;
}

export async function getBotById(botId: string, userId: string): Promise<TradingBot | null> {
  const bot = await db.query.tradingBots.findFirst({
    where: and(eq(tradingBots.id, botId), eq(tradingBots.userId, userId)),
  });
  return bot ?? null;
}

export async function getRunningBots(): Promise<TradingBot[]> {
  return db.query.tradingBots.findMany({
    where: eq(tradingBots.status, 'RUNNING'),
  });
}

export async function getRunningAiBots(botType?: TradingBot['botType']): Promise<TradingBot[]> {
  const rows = await db
    .select({ bot: tradingBots })
    .from(tradingBots)
    .innerJoin(bingxApiKeys, eq(tradingBots.apiKeyId, bingxApiKeys.id))
    .where(
      and(
        eq(tradingBots.status, 'RUNNING'),
        eq(bingxApiKeys.managedByAi, true),
        botType ? eq(tradingBots.botType, botType) : undefined,
      ),
    );
  return rows.map(r => r.bot);
}

export async function getRunningBotsByIds(botIds: string[]): Promise<TradingBot[]> {
  if (botIds.length === 0) return [];
  return db.query.tradingBots.findMany({
    where: and(
      inArray(tradingBots.id, botIds),
      eq(tradingBots.status, 'RUNNING'),
    ),
  });
}

export async function setBotStatus(
  botId: string,
  userId: string,
  status: 'STOPPED' | 'RUNNING'
): Promise<void> {
  await db
    .update(tradingBots)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(tradingBots.id, botId), eq(tradingBots.userId, userId)));
}

// ========== Grid Levels ==========

export function calcGridPriceLevels(
  priceMin: number,
  priceMax: number,
  gridCount: number
): number[] {
  if (gridCount < 2) return [priceMin];
  const step = (priceMax - priceMin) / (gridCount - 1);
  const levels: number[] = [];
  for (let i = 0; i < gridCount; i++) {
    levels.push(priceMin + i * step);
  }
  return levels;
}

export async function createGridLevels(
  botId: string,
  priceMin: string,
  priceMax: string,
  gridCount: number,
  options?: { onConflictDoNothing?: boolean; positionSide?: string }
): Promise<GridLevel[]> {
  const min = parseFloat(priceMin);
  const max = parseFloat(priceMax);
  const levels = calcGridPriceLevels(min, max, gridCount);
  const inserts = levels.map((priceLevel) => ({
    botId,
    priceLevel: String(priceLevel),
    positionSide: options?.positionSide ?? 'LONG',
  }));
  if (options?.onConflictDoNothing) {
    return await db
      .insert(gridLevels)
      .values(inserts)
      .onConflictDoNothing({ target: [gridLevels.botId, gridLevels.priceLevel] })
      .returning();
  }
  return await db.insert(gridLevels).values(inserts).returning();
}

export async function getGridLevelsByBotId(botId: string): Promise<GridLevel[]> {
  return db.query.gridLevels.findMany({
    where: eq(gridLevels.botId, botId),
  });
}

export async function updateGridLevelOrderId(
  botId: string,
  priceLevel: string,
  orderId: string | null
): Promise<void> {
  await db
    .update(gridLevels)
    .set({ orderId, updatedAt: new Date() })
    .where(and(eq(gridLevels.botId, botId), eq(gridLevels.priceLevel, priceLevel)));
}

export async function updateGridLevelTpOrderId(
  botId: string,
  priceLevel: string,
  tpOrderId: string | null
): Promise<void> {
  await db
    .update(gridLevels)
    .set({ tpOrderId, updatedAt: new Date() })
    .where(and(eq(gridLevels.botId, botId), eq(gridLevels.priceLevel, priceLevel)));
}

// ========== BingX API Helpers ==========

export type ContractInfo = {
  pricePrecision: number;
  quantityPrecision: number;
  tradeMinQuantity: number;
  tradeMinUSDT: number;
};

/** In-memory cache for contracts list (reduces Fast Origin Transfer - avoids fetching full list every call) */
const CONTRACT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
let contractCache: { contracts: unknown[]; fetchedAt: number } | null = null;

export async function getContractInfo(
  client: BingxClient,
  symbol: string
): Promise<ContractInfo | null> {
  try {
    const now = Date.now();
    if (!contractCache || now - contractCache.fetchedAt > CONTRACT_CACHE_TTL_MS) {
      const data = (await client.get('/openApi/swap/v2/quote/contracts')) as unknown;
      let contracts: unknown[] = [];
      if (Array.isArray(data)) {
        contracts = data;
      } else if (data && typeof data === 'object') {
        const o = data as Record<string, unknown>;
        contracts = (Array.isArray(o.contracts) ? o.contracts : Array.isArray(o.data) ? o.data : []) as unknown[];
      }
      contractCache = { contracts, fetchedAt: now };
    }
    const sym = symbol.toUpperCase().replace(/\s/g, '');
    const contract = contractCache.contracts.find((c) => {
      const s = String((c as { symbol?: string })?.symbol ?? '').toUpperCase().replace(/\s/g, '');
      return s === sym || s.includes(sym) || sym.includes(s);
    }) as {
      symbol?: string;
      pricePrecision?: number;
      quantityPrecision?: number;
      tradeMinQuantity?: number | string;
      tradeMinUSDT?: number | string;
    } | undefined;
    if (!contract) return null;
    return {
      pricePrecision: contract.pricePrecision ?? 4,
      quantityPrecision: contract.quantityPrecision ?? 4,
      tradeMinQuantity: Number(contract.tradeMinQuantity ?? 0),
      tradeMinUSDT: Number(contract.tradeMinUSDT ?? 0),
    };
  } catch {
    return null;
  }
}

export async function ensureMarginTypeAndLeverage(
  client: BingxClient,
  symbol: string,
  marginType: string,
  leverage: number
): Promise<void> {
  try {
    const marginRes = (await client.get('/openApi/swap/v2/trade/marginType', { symbol })) as {
      marginType?: string;
    };
    const currentMargin = String(marginRes?.marginType ?? '').toUpperCase();
    const targetMargin = marginType.toUpperCase();
    if (currentMargin !== targetMargin) {
      await client.post('/openApi/swap/v2/trade/marginType', { symbol, marginType: targetMargin });
    }
    try {
      await client.post(
        '/openApi/swap/v2/trade/leverage',
        {
          symbol,
          side: 'LONG',
          leverage,
        },
        true
      );
    } catch (leverageErr) {
      const msg = leverageErr instanceof Error ? leverageErr.message : String(leverageErr);
      if (msg.includes('close open positions') || msg.includes('cancel pending orders')) {
        console.warn(`[BingX] Cannot set leverage for ${symbol}: ${msg}. Continuing with current leverage.`);
        return;
      }
      throw leverageErr;
    }
  } catch (err) {
    console.error('ensureMarginTypeAndLeverage failed:', err);
    throw err;
  }
}

export function toPrecision(value: number, decimals: number): string {
  const factor = 10 ** decimals;
  return (Math.floor(value * factor) / factor).toFixed(decimals);
}

/**
 * Rounds quantity UP to the nearest step so we always meet at least the desired USDT per order.
 * At higher price levels (e.g. TRIGGER_LIMIT), quantityBtc is smaller; round() would give 0.0001
 * ($7) instead of 0.0002 ($12). Using ceil ensures consistent sizing across all grid levels.
 */
export function toQuantityPrecision(value: number, decimals: number): string {
  const factor = 10 ** decimals;
  return (Math.ceil(value * factor) / factor).toFixed(decimals);
}

/**
 * Converts positionId/orderId to exact string without precision loss.
 * NEVER use parseInt() or Number() - exchange IDs can exceed JS safe integer range.
 */
export function toSafeIdString(value: string | number | bigint | null | undefined): string | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'bigint') return String(value);
  return String(value);
}

// ========== Grid Bot BingX Helpers ==========

export type OpenPosition = {
  symbol: string;
  positionSide: string;
  positionAmt: number;
  entryPrice: number;
  leverage?: number;
  /** Always string to avoid JS BigInt/precision loss with exchange IDs */
  positionId?: string;
};

export async function getCurrentPrice(
  client: BingxClient,
  symbol: string
): Promise<number | null> {
  try {
    const data = (await client.get('/openApi/swap/v2/quote/price', {
      symbol,
    })) as { price?: string } | Array<{ symbol?: string; price?: string }>;
    if (Array.isArray(data) && data.length > 0) {
      const first = data[0] as { price?: string };
      return first.price != null ? parseFloat(String(first.price)) : null;
    }
    if (data && typeof data === 'object' && 'price' in data) {
      return parseFloat(String((data as { price?: string }).price));
    }
    return null;
  } catch {
    return null;
  }
}

export type Kline = {
  open: number;
  high: number;
  low: number;
  close: number;
  time: number;
};

export async function getKlines(
  client: BingxClient,
  symbol: string,
  interval: string,
  limit: number
): Promise<Kline[]> {
  try {
    const data = await client.get('/openApi/swap/v3/quote/klines', {
      symbol,
      interval,
      limit: String(limit),
    });

    if (!Array.isArray(data)) return [];

    return data
      .map((item: Record<string, unknown>) => ({
        open: Number(item.open ?? 0),
        high: Number(item.high ?? 0),
        low: Number(item.low ?? 0),
        close: Number(item.close ?? 0),
        time: Number(item.time ?? 0),
      }))
      .sort((a: Kline, b: Kline) => a.time - b.time);
  } catch {
    return [];
  }
}

export async function getOpenPositions(
  client: BingxClient,
  symbol: string
): Promise<OpenPosition[]> {
  try {
    let data: unknown;
    try {
      data = await client.get('/openApi/swap/v2/user/positions', { symbol });
    } catch {
      data = await client.get('/openApi/swap/v2/user/positions', {});
    }
    let positions: Array<Record<string, unknown>> = [];
    if (Array.isArray(data)) {
      positions = data as Array<Record<string, unknown>>;
    } else if (data && typeof data === 'object') {
      const o = data as Record<string, unknown>;
      positions = (Array.isArray(o.positions) ? o.positions : []) as Array<Record<string, unknown>>;
    }
    const sym = symbol.toUpperCase().replace(/\s/g, '');
    return positions
      .filter((p) => {
        const s = String(p?.symbol ?? '').toUpperCase().replace(/\s/g, '');
        return s === sym || s.includes(sym);
      })
      .filter((p) => {
        const amt = Number(p?.positionAmt ?? p?.position ?? 0);
        return Math.abs(amt) > 0;
      })
      .map((p) => {
        const rawPositionId = (p?.positionId ?? p?.position_id) as string | number | bigint | null | undefined;
        const rawLeverage = Number(p?.leverage ?? 0);
        return {
          symbol: String(p?.symbol ?? ''),
          positionSide: String(p?.positionSide ?? 'LONG'),
          positionAmt: Math.abs(Number(p?.positionAmt ?? p?.position ?? 0)),
          entryPrice: Number(p?.entryPrice ?? p?.avgPrice ?? 0),
          leverage: rawLeverage > 0 ? rawLeverage : undefined,
          positionId: toSafeIdString(rawPositionId),
        };
      });
  } catch {
    return [];
  }
}

export type OpenOrderInfo = {
  orderId: string;
  symbol?: string;
  type?: string;
  side?: string;
  positionSide?: string;
  price?: number | string;
  stopPrice?: number | string;
  /** Always string to avoid JS BigInt/precision loss with exchange IDs */
  positionId?: string;
};

export async function getOpenOrders(client: BingxClient, symbol: string): Promise<OpenOrderInfo[]> {
  let data: { orders?: OpenOrderInfo[] } | OpenOrderInfo[];
  try {
    data = (await client.get('/openApi/swap/v2/trade/openOrders', { symbol })) as typeof data;
  } catch (ordersErr) {
    const isSignatureError =
      ordersErr instanceof Error && ordersErr.message.toLowerCase().includes('signature');
    if (isSignatureError) {
      const allOrders = (await client.get('/openApi/swap/v2/trade/openOrders', {})) as typeof data;
      const rawOrders = Array.isArray(allOrders) ? allOrders : allOrders?.orders ?? [];
      const sym = symbol.toUpperCase().replace(/\s/g, '');
      const filtered = rawOrders.filter(
        (o) =>
          !(o as { symbol?: string }).symbol ||
          String((o as { symbol?: string }).symbol || '').toUpperCase() === sym
      );
      data = Array.isArray(allOrders) ? filtered : { orders: filtered };
    } else {
      throw ordersErr;
    }
  }
  const rawOrders = Array.isArray(data) ? data : data?.orders ?? [];
  return rawOrders.map((o) => {
    const rawOrderId = (o as { orderId?: string | number }).orderId;
    const rawPositionId = (o as { positionId?: string | number; position_id?: string | number }).positionId ??
      (o as { position_id?: string | number }).position_id;
    return {
      ...o,
      orderId: toSafeIdString(rawOrderId) ?? (rawOrderId != null ? String(rawOrderId) : ''),
      positionId: toSafeIdString(rawPositionId),
    } as OpenOrderInfo;
  });
}

export function hasTakeProfitForPosition(
  openOrders: OpenOrderInfo[],
  symbol: string,
  positionSide: string,
  stopPrice: number,
  tolerancePct = 0.001,
  positionId?: string | number
): boolean {
  const sym = symbol.toUpperCase().replace(/\s/g, '');
  const posIdStr = toSafeIdString(positionId);
  return openOrders.some((o) => {
    if (String(o.type ?? '').toUpperCase() !== 'TAKE_PROFIT_MARKET') return false;
    const orderSym = String(o.symbol ?? '').toUpperCase().replace(/\s/g, '');
    if (orderSym && orderSym !== sym) return false;
    if (String(o.positionSide ?? '').toUpperCase() !== positionSide.toUpperCase()) return false;
    const orderPosIdStr = o.positionId ?? toSafeIdString((o as { position_id?: string | number }).position_id);
    if (posIdStr != null && orderPosIdStr != null && orderPosIdStr !== posIdStr) return false;
    const sp = Number(o.stopPrice ?? 0);
    const diff = Math.abs(sp - stopPrice) / (stopPrice || 1);
    return diff <= tolerancePct;
  });
}

/**
 * Places a grid entry order (LIMIT or TRIGGER_LIMIT) for BUY LONG.
 * For LONG: priceLevel < currentPrice → LIMIT (below market, sits in book).
 *           priceLevel > currentPrice → TRIGGER_LIMIT (above market, avoids sweeping book).
 * Embeds takeProfit as JSON string per BingX docs; TP is created when order fills.
 */
export type PlaceGridEntryOrderParams = {
  client: BingxClient;
  symbol: string;
  priceLevel: number;
  quantity: number;
  takeProfitPct: number;
  pricePrecision: number;
  quantityPrecision: number;
  positionSide: string;
  currentPrice: number | null;
};

/** Build the order payload for a LONG grid entry — no API call. */
export function buildGridEntryPayload(params: Omit<PlaceGridEntryOrderParams, 'client'>): Record<string, unknown> {
  const { symbol, priceLevel, quantity, takeProfitPct, pricePrecision, quantityPrecision, positionSide, currentPrice } = params;

  const priceStr = toPrecision(priceLevel, pricePrecision);
  const quantityStr = toQuantityPrecision(quantity, quantityPrecision);
  const useTriggerLimit = currentPrice != null && priceLevel > currentPrice;
  const orderType = useTriggerLimit ? 'TRIGGER_LIMIT' : 'LIMIT';

  const orderPayload: Record<string, unknown> = {
    symbol,
    side: 'BUY',
    type: orderType,
    quantity: parseFloat(quantityStr),
    price: parseFloat(priceStr),
    positionSide: positionSide.toUpperCase(),
    timeInForce: 'GTC',
    workingType: 'MARK_PRICE',
  };

  if (useTriggerLimit) {
    orderPayload.stopPrice = parseFloat(priceStr);
  }

  const tpStopPrice = priceLevel * (1 + takeProfitPct);
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

export async function placeGridEntryOrder(params: PlaceGridEntryOrderParams): Promise<string | null> {
  const { client, ...rest } = params;
  const orderPayload = buildGridEntryPayload(rest);

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

export async function placeTakeProfitOrder(
  client: BingxClient,
  symbol: string,
  positionSide: string,
  quantity: number,
  stopPrice: number,
  pricePrecision: number,
  positionId?: string | number
): Promise<string | null> {
  try {
    const stopPriceStr = toPrecision(stopPrice, pricePrecision);
    const positionIdStr = toSafeIdString(positionId);
    const orderPayload: Record<string, unknown> = {
      symbol,
      side: 'SELL',
      type: 'TAKE_PROFIT_MARKET',
      positionSide: positionSide.toUpperCase(),
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
    console.error('[BingX] placeTakeProfitOrder failed:', err);
    return null;
  }
}

/**
 * Cancel multiple orders via BingX batchOrders API (up to 10 per request).
 * Splits into chunks if orderIds.length > 10.
 */
export async function cancelBatchOrders(
  client: BingxClient,
  symbol: string,
  orderIds: string[]
): Promise<void> {
  const BATCH_SIZE = 10;
  const ids = orderIds.filter((id) => id && id.trim());
  if (ids.length === 0) return;

  let formattedSymbol = symbol.toUpperCase().trim();
  if (!formattedSymbol.includes('-')) {
    formattedSymbol = formattedSymbol.replace(/(USDT|USDC|USDT-VST)$/, '-$1');
  }

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const chunk = ids.slice(i, i + BATCH_SIZE);
    
    const orderIdList = `[${chunk.join(', ')}]`;

    console.log(`Tentando cancelar no par: ${formattedSymbol}`);
    console.log(`Lista de IDs formatada: ${orderIdList}`);

    await client.delete(
      '/openApi/swap/v2/trade/batchOrders',
      {
        symbol: formattedSymbol,
        orderIdList: orderIdList,
      },
      { omitRecvWindow: true }
    );

  }
}

/**
 * Place multiple orders via BingX batchOrders API (up to 5 per request).
 * Splits into chunks if orders.length > 5.
 * Unlike cancelBatchOrders (DELETE, batch size 10, omitRecvWindow),
 * this uses POST with useQueryParams=true and batch size 5.
 */
export async function placeBatchOrders(
  client: BingxClient,
  orders: Record<string, unknown>[]
): Promise<Array<{ orderId: string | null; error?: string }>> {
  const BATCH_SIZE = 5;
  if (orders.length === 0) return [];

  const results: Array<{ orderId: string | null; error?: string }> = [];

  for (let i = 0; i < orders.length; i += BATCH_SIZE) {
    if (i > 0) await new Promise((r) => setTimeout(r, 400)); // Rate limit between chunks
    const chunk = orders.slice(i, i + BATCH_SIZE);
    const batchOrdersParam = JSON.stringify(chunk);

    try {
      const response = (await client.post(
        '/openApi/swap/v2/trade/batchOrders',
        { batchOrders: batchOrdersParam },
        true
      )) as {
        orders?: Array<{ orderId?: string | number; order?: { orderId?: string | number } }>;
        errors?: Array<{ msg?: string; code?: number }>;
      };

      const successOrders = response?.orders ?? [];
      const errorOrders = response?.errors ?? [];

      for (const order of successOrders) {
        const raw = order?.orderId ?? order?.order?.orderId;
        results.push({ orderId: raw != null ? toSafeIdString(raw) ?? null : null });
      }

      for (const err of errorOrders) {
        results.push({ orderId: null, error: err?.msg ?? `Error code ${err?.code}` });
      }
    } catch (err) {
      // Entire chunk failed — mark all as failed
      for (let j = 0; j < chunk.length; j++) {
        results.push({ orderId: null, error: String(err) });
      }
    }
  }

  return results;
}

/**
 * Clear only orderId (entry orders) for all grid levels of a bot.
 * Does NOT clear tpOrderId — Take Profits stay active on BingX ("Let it Ride").
 */
export async function clearGridLevelEntryOrders(botId: string): Promise<void> {
  await db
    .update(gridLevels)
    .set({ orderId: null, updatedAt: new Date() })
    .where(eq(gridLevels.botId, botId));
}

/**
 * Stop bot with surgical cancellation: cancel only entry orders (Buy Limits),
 * leave positions and Take Profit orders active on BingX ("Let it Ride").
 */
export async function stopBotAndCancelEntries(
  client: BingxClient,
  botId: string,
  symbol: string
): Promise<void> {
  const levels = await getGridLevelsByBotId(botId);
  const entryOrderIds = levels
    .map((l) => l.orderId)
    .filter((id): id is string => id != null && id.trim() !== '');

  if (entryOrderIds.length > 0) {
    try {
      await cancelBatchOrders(client, symbol, entryOrderIds);
    } catch (err) {
      console.warn('[BingX] Some entry orders may already be filled/cancelled:', err);
    }
  }

  await clearGridLevelEntryOrders(botId);
}

export type EditBotParams = {
  priceMin: string;
  priceMax: string;
  gridCount: number;
  positionSizeUsdt: string;
  takeProfitPercentage: string;
};

export async function editActiveBot(
  userId: string,
  botId: string,
  params: EditBotParams
): Promise<void> {
  const bot = await getBotById(botId, userId);
  const client = bot?.apiKeyId
    ? await getBingxClientByApiKeyId(bot.apiKeyId)
    : await getBingxClient(userId);

  if (!client || !bot) {
    throw new Error('Bot or API Client not found');
  }

  if (bot.status !== 'RUNNING') {
    throw new Error('Bot must be RUNNING to edit');
  }

  const symbol = String(bot.symbol ?? '').trim().toUpperCase() || bot.symbol;

  // 1. Cancel all entry orders on BingX and clear orderId in DB
  await stopBotAndCancelEntries(client, botId, symbol);

  // 2. Delete empty levels (no position/TP running)
  await db
    .delete(gridLevels)
    .where(and(eq(gridLevels.botId, botId), isNull(gridLevels.tpOrderId)));

  // 3. Mark remaining levels (with open positions) as legacy (isActive = false)
  await db
    .update(gridLevels)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(gridLevels.botId, botId));

  // 4. Update bot config with new params
  await db
    .update(tradingBots)
    .set({
      priceMin: params.priceMin,
      priceMax: params.priceMax,
      gridCount: params.gridCount,
      positionSizeUsdt: params.positionSizeUsdt,
      takeProfitPercentage: params.takeProfitPercentage,
      updatedAt: new Date(),
    })
    .where(and(eq(tradingBots.id, botId), eq(tradingBots.userId, userId)));

  // 5. Generate and insert new grid levels (skip conflicts with legacy levels)
  await createGridLevels(botId, params.priceMin, params.priceMax, params.gridCount, {
    onConflictDoNothing: true,
  });
}

export async function getUserBots(userId: string): Promise<TradingBot[]> {
  return db.query.tradingBots.findMany({
    where: eq(tradingBots.userId, userId),
    orderBy: [desc(tradingBots.createdAt)],
  });
}

export async function getUserBotsByApiKey(userId: string, apiKeyId: string): Promise<TradingBot[]> {
  return db.query.tradingBots.findMany({
    where: and(
      eq(tradingBots.userId, userId),
      eq(tradingBots.apiKeyId, apiKeyId)
    ),
    orderBy: [desc(tradingBots.createdAt)],
  });
}

// ========== Bot Details (for UI) ==========

const POSITION_ENTRY_TOLERANCE_PCT = 0.005;

function formatRuntime(createdAt: Date): string {
  const ms = Date.now() - createdAt.getTime();
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export type BotOrderInfo = {
  priceLevel: string;
  type: 'ENTRY' | 'TP';
  orderId: string | null;
  status: 'OPEN' | 'FILLED' | 'CANCELLED' | 'UNKNOWN';
  price?: number;
  stopPrice?: number;
  quantity?: number;
};

export type BotPositionInfo = {
  entryPrice: number;
  positionAmt: number;
  positionSide: string;
  unrealizedPnl: number;
  estimatedProfit: number;
  leverage?: number;
};

export type BotDetails = {
  bot: TradingBot;
  runtime: string;
  orders: BotOrderInfo[];
  positions: BotPositionInfo[];
  unrealizedPnl: number;
  realizedPnl: number;
};

export async function getIncome(
  client: BingxClient,
  symbol: string,
  startTime?: number,
  endTime?: number
): Promise<number> {
  try {
    const PAGE_SIZE = 100;
    const MAX_PAGES = 20;
    const sym = symbol.toUpperCase().replace(/\s/g, '');
    let total = 0;
    let currentStart = startTime;

    for (let page = 0; page < MAX_PAGES; page++) {
      const params: Record<string, string | number | undefined> = {
        symbol: sym,
        limit: PAGE_SIZE,
      };
      if (currentStart != null) params.startTime = currentStart;
      if (endTime != null) params.endTime = endTime;

      const data = (await client.get('/openApi/swap/v2/user/income', params)) as unknown;
      let items: Array<{ income?: string | number; symbol?: string; time?: number }> = [];
      if (Array.isArray(data)) {
        items = data;
      } else if (data && typeof data === 'object') {
        const o = data as Record<string, unknown>;
        const arr = Array.isArray(o.data) ? o.data : Array.isArray(o.income) ? o.income : [];
        items = arr as typeof items;
      }

      if (items.length === 0) break;

      for (const item of items) {
        const itemSym = String(item?.symbol ?? '').toUpperCase();
        if (itemSym && itemSym !== sym) continue;
        total += Number(item?.income ?? 0);
      }

      // If we got fewer items than the page size, we've reached the end
      if (items.length < PAGE_SIZE) break;

      // Move startTime past the last item's time to get next page
      const lastTime = Math.max(...items.map((i) => Number(i?.time ?? 0)));
      if (lastTime <= (currentStart ?? 0)) break; // safety: avoid infinite loop
      currentStart = lastTime + 1;
    }

    return total;
  } catch {
    return 0;
  }
}

// ========== P&L Trade Recording ==========

export type TradeType = 'ENTRY' | 'EXIT_TP' | 'EXIT_TRAILING' | 'EXIT_SIGNAL' | 'EXIT_MANUAL';

function tradeTypeToOrderType(t: TradeType): FillPayload['orderType'] {
  if (t === 'ENTRY') return 'ENTRY';
  if (t === 'EXIT_TP') return 'TAKE_PROFIT';
  return 'STOP_LOSS';
}

export async function recordTrade(params: {
  botId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  type: TradeType;
  price: number;
  quantity: number;
  realizedPnl?: number;
  orderId?: string | null;
}): Promise<void> {
  try {
    // Duplicate check: skip if same (botId, orderId, type) already exists
    if (params.orderId) {
      const existing = await db
        .select({ id: botTrades.id })
        .from(botTrades)
        .where(
          and(
            eq(botTrades.botId, params.botId),
            eq(botTrades.orderId, params.orderId),
            eq(botTrades.type, params.type)
          )
        )
        .limit(1);
      if (existing.length > 0) return;
    }

    await db.insert(botTrades).values({
      botId: params.botId,
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      price: String(params.price),
      quantity: String(params.quantity),
      realizedPnl: String(params.realizedPnl ?? 0),
      orderId: params.orderId ?? null,
    });

    try {
      const bot = await db.query.tradingBots.findFirst({
        where: eq(tradingBots.id, params.botId),
      });
      if (bot?.apiKeyId) {
        await maybeEmitFillEvent({
          sendEventFn: (event) => inngest.send(event),
          apiKeyId: bot.apiKeyId,
          botId: params.botId,
          botKind: 'real',
          symbol: params.symbol,
          side: params.side,
          fillPrice: String(params.price),
          quantity: String(params.quantity),
          orderType: tradeTypeToOrderType(params.type),
        });
      }
    } catch (emitErr) {
      // Emission must never break recordTrade. Swallow.
      // eslint-disable-next-line no-console
      console.warn('[recordTrade] AI PM fill emission failed:', emitErr);
    }
  } catch (err) {
    console.error('[recordTrade] Failed:', err);
  }
}

export async function getBotRealizedPnl(botId: string): Promise<number> {
  try {
    const result = await db
      .select({ total: sql<string>`COALESCE(SUM(${botTrades.realizedPnl}), 0)` })
      .from(botTrades)
      .where(eq(botTrades.botId, botId));
    return Number(result[0]?.total ?? 0);
  } catch {
    return 0;
  }
}

export async function getBotDetails(
  userId: string,
  botId: string
): Promise<BotDetails | null> {
  const bot = await getBotById(botId, userId);
  if (!bot) return null;

  const symbol = String(bot.symbol ?? '').trim().toUpperCase() || 'BTC-USDT';
  const levels = await getGridLevelsByBotId(botId);
  const takeProfitPct = Number(bot.takeProfitPercentage) / 100;

  const runtime = formatRuntime(bot.createdAt);

  const client = bot.apiKeyId
    ? await getBingxClientByApiKeyId(bot.apiKeyId)
    : await getBingxClient(userId);
  const orders: BotOrderInfo[] = [];
  const positions: BotPositionInfo[] = [];
  let unrealizedPnl = 0;
  let realizedPnl = 0;
  const openOrderIds = new Set<string>();

  if (client) {
    const [openOrders, openPositions, currentPrice] = await Promise.all([
      getOpenOrders(client, symbol),
      getOpenPositions(client, symbol),
      getCurrentPrice(client, symbol),
    ]);

    for (const o of openOrders) {
      openOrderIds.add(String(o.orderId));
    }

    for (const level of levels) {
      const priceLevel = Number(level.priceLevel);
      const tpStopPrice = priceLevel * (1 + takeProfitPct);

      if (level.orderId) {
        const openOrder = openOrders.find((o) => String(o.orderId) === level.orderId);
        orders.push({
          priceLevel: String(priceLevel),
          type: 'ENTRY',
          orderId: level.orderId,
          status: openOrderIds.has(level.orderId) ? 'OPEN' : 'FILLED',
          price: openOrder ? Number(openOrder.price ?? 0) : priceLevel,
          quantity: openOrder ? Number((openOrder as { origQty?: string }).origQty ?? 0) : undefined,
          stopPrice: tpStopPrice,
        });
      }
      if (level.tpOrderId) {
        const openOrder = openOrders.find((o) => String(o.orderId) === level.tpOrderId);
        orders.push({
          priceLevel: String(priceLevel),
          type: 'TP',
          orderId: level.tpOrderId,
          status: openOrderIds.has(level.tpOrderId) ? 'OPEN' : 'FILLED',
          stopPrice: openOrder ? Number(openOrder.stopPrice ?? 0) : tpStopPrice,
        });
      }
    }

    const priceNow = currentPrice ?? 0;

    const positionMatchesLevel = (entryPrice: number, priceLevel: number) => {
      const diff = Math.abs(entryPrice - priceLevel) / priceLevel;
      return diff <= POSITION_ENTRY_TOLERANCE_PCT;
    };

    const expectedSide = bot.botType === 'GRID_SHORT' ? 'SHORT' : 'LONG';
    for (const pos of openPositions) {
      const side = String(pos.positionSide ?? 'LONG').toUpperCase();
      if (side !== expectedSide && side !== 'BOTH') continue;

      const level = levels.find((l) =>
        positionMatchesLevel(pos.entryPrice, Number(l.priceLevel))
      );
      const priceLevel = level ? Number(level.priceLevel) : pos.entryPrice;
      const tpPrice = side === 'SHORT'
        ? priceLevel * (1 - takeProfitPct)
        : priceLevel * (1 + takeProfitPct);
      const unrealized = side === 'SHORT'
        ? (pos.entryPrice - priceNow) * pos.positionAmt
        : (priceNow - pos.entryPrice) * pos.positionAmt;
      const estimated = side === 'SHORT'
        ? (pos.entryPrice - tpPrice) * pos.positionAmt
        : (tpPrice - pos.entryPrice) * pos.positionAmt;

      positions.push({
        entryPrice: pos.entryPrice,
        positionAmt: pos.positionAmt,
        positionSide: pos.positionSide,
        unrealizedPnl: unrealized,
        estimatedProfit: estimated,
        leverage: pos.leverage,
      });
      unrealizedPnl += unrealized;
    }

    realizedPnl = await getBotRealizedPnl(bot.id);
  }

  return {
    bot,
    runtime,
    orders,
    positions,
    unrealizedPnl,
    realizedPnl,
  };
}

/**
 * Returns all symbols a bot operates on. For SMA_CROSSOVER bots,
 * this includes all symbols from config.symbols.
 */
export function getBotSymbols(bot: TradingBot): string[] {
  const primary = String(bot.symbol ?? '').trim().toUpperCase() || 'BTC-USDT';

  if (bot.botType === 'SMA_CROSSOVER' && bot.config && typeof bot.config === 'object') {
    const cfg = bot.config as Record<string, unknown>;
    if (Array.isArray(cfg.symbols) && cfg.symbols.length > 0) {
      return (cfg.symbols as string[]).map((s) => s.trim().toUpperCase());
    }
  }

  return [primary];
}

/**
 * Whether a bot type uses grid levels for order/position tracking.
 */
function isGridBot(botType: string | null): boolean {
  return botType === 'GRID_LONG' || botType === 'GRID_SHORT';
}

/**
 * Batch variant: fetches BingX data once per unique (apiKey, symbol) pair.
 * Handles all bot types: grid, DCA, trailing stop, SMA crossover, DCA spot.
 * Groups bots by apiKeyId to use the correct credentials for each.
 */
export async function getBotsDetailsBatched(
  userId: string,
  bots: TradingBot[]
): Promise<BotDetails[]> {
  if (bots.length === 0) return [];

  const RATE_LIMIT_DELAY_MS = 400;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Resolve API clients per apiKeyId (or userId as fallback)
  const clientCache = new Map<string, BingxClient | null>();
  async function getClientForBotLocal(bot: TradingBot): Promise<BingxClient | null> {
    const key = bot.apiKeyId ?? `user:${userId}`;
    if (!clientCache.has(key)) {
      const c = bot.apiKeyId
        ? await getBingxClientByApiKeyId(bot.apiKeyId)
        : await getBingxClient(userId);
      clientCache.set(key, c);
    }
    return clientCache.get(key) ?? null;
  }

  // Build symbol cache keyed by "apiKeyOrUserId:symbol"
  const symbolCache = new Map<
    string,
    {
      openOrders: OpenOrderInfo[];
      openPositions: OpenPosition[];
      currentPrice: number | null;
    }
  >();

  // Collect all (clientKey, symbol) pairs we need
  const symbolsToFetch = new Map<string, Set<string>>();
  for (const bot of bots) {
    const clientKey = bot.apiKeyId ?? `user:${userId}`;
    if (!symbolsToFetch.has(clientKey)) symbolsToFetch.set(clientKey, new Set());
    for (const sym of getBotSymbols(bot)) {
      symbolsToFetch.get(clientKey)!.add(sym);
    }
  }

  // Fetch market data per (clientKey, symbol) pair
  for (const [clientKey, symbols] of symbolsToFetch) {
    const sampleBot = bots.find((b) => (b.apiKeyId ?? `user:${userId}`) === clientKey);
    if (!sampleBot) continue;
    const client = await getClientForBotLocal(sampleBot);
    if (!client) continue;

    let first = true;
    for (const symbol of symbols) {
      if (!first) await sleep(RATE_LIMIT_DELAY_MS);
      first = false;
      const [openOrders, openPositions, currentPrice] = await Promise.all([
        getOpenOrders(client, symbol),
        getOpenPositions(client, symbol),
        getCurrentPrice(client, symbol),
      ]);
      symbolCache.set(`${clientKey}:${symbol}`, { openOrders, openPositions, currentPrice });
    }
  }

  const results: BotDetails[] = [];
  for (let i = 0; i < bots.length; i++) {
    const bot = bots[i];
    const botSymbols = getBotSymbols(bot);
    const clientKey = bot.apiKeyId ?? `user:${userId}`;
    const client = await getClientForBotLocal(bot);
    const runtime = formatRuntime(bot.createdAt);
    const orders: BotOrderInfo[] = [];
    const positions: BotPositionInfo[] = [];
    let unrealizedPnl = 0;
    let realizedPnl = 0;

    // --- Grid bots: match positions to grid levels ---
    if (isGridBot(bot.botType)) {
      const symbol = botSymbols[0];
      const cacheKey = `${clientKey}:${symbol}`;
      const levels = await getGridLevelsByBotId(bot.id);
      const takeProfitPct = Number(bot.takeProfitPercentage) / 100;
      const cached = client ? symbolCache.get(cacheKey) : null;
      const openOrders = cached?.openOrders ?? [];
      const openPositions = cached?.openPositions ?? [];
      const currentPrice = cached?.currentPrice ?? 0;
      const openOrderIds = new Set(openOrders.map((o) => String(o.orderId)));
      const expectedSide = bot.botType === 'GRID_SHORT' ? 'SHORT' : 'LONG';

      for (const level of levels) {
        const priceLevel = Number(level.priceLevel);
        const tpStopPrice = expectedSide === 'SHORT'
          ? priceLevel * (1 - takeProfitPct)
          : priceLevel * (1 + takeProfitPct);
        if (level.orderId) {
          const openOrder = openOrders.find((o) => String(o.orderId) === level.orderId);
          orders.push({
            priceLevel: String(priceLevel),
            type: 'ENTRY',
            orderId: level.orderId,
            status: openOrderIds.has(level.orderId) ? 'OPEN' : 'FILLED',
            price: openOrder ? Number(openOrder.price ?? 0) : priceLevel,
            quantity: openOrder ? Number((openOrder as { origQty?: string }).origQty ?? 0) : undefined,
          });
        }
        if (level.tpOrderId) {
          const openOrder = openOrders.find((o) => String(o.orderId) === level.tpOrderId);
          orders.push({
            priceLevel: String(priceLevel),
            type: 'TP',
            orderId: level.tpOrderId,
            status: openOrderIds.has(level.tpOrderId) ? 'OPEN' : 'FILLED',
            stopPrice: openOrder ? Number(openOrder.stopPrice ?? 0) : tpStopPrice,
          });
        }
      }

      const positionMatchesLevel = (entryPrice: number, priceLevel: number) => {
        const diff = Math.abs(entryPrice - priceLevel) / priceLevel;
        return diff <= POSITION_ENTRY_TOLERANCE_PCT;
      };

      for (const pos of openPositions) {
        const side = String(pos.positionSide ?? 'LONG').toUpperCase();
        if (side !== expectedSide && side !== 'BOTH') continue;
        const level = levels.find((l) => positionMatchesLevel(pos.entryPrice, Number(l.priceLevel)));
        const priceLevel = level ? Number(level.priceLevel) : pos.entryPrice;
        const tpPrice = expectedSide === 'SHORT'
          ? priceLevel * (1 - takeProfitPct)
          : priceLevel * (1 + takeProfitPct);
        const priceDelta = side === 'SHORT'
          ? (pos.entryPrice - currentPrice) * pos.positionAmt
          : (currentPrice - pos.entryPrice) * pos.positionAmt;
        const estimated = side === 'SHORT'
          ? (pos.entryPrice - tpPrice) * pos.positionAmt
          : (tpPrice - pos.entryPrice) * pos.positionAmt;
        positions.push({
          entryPrice: pos.entryPrice,
          positionAmt: pos.positionAmt,
          positionSide: pos.positionSide,
          unrealizedPnl: priceDelta,
          estimatedProfit: estimated,
          leverage: pos.leverage,
        });
        unrealizedPnl += priceDelta;
      }

      realizedPnl = await getBotRealizedPnl(bot.id);
    } else {
      // --- Non-grid bots (DCA, Trailing Stop, SMA Crossover, DCA Spot): ---
      // Aggregate positions and income across all symbols
      for (const symbol of botSymbols) {
        const cacheKey = `${clientKey}:${symbol}`;
        const cached = client ? symbolCache.get(cacheKey) : null;
        const openPositions = cached?.openPositions ?? [];
        const currentPrice = cached?.currentPrice ?? 0;

        for (const pos of openPositions) {
          const side = String(pos.positionSide ?? 'LONG').toUpperCase();
          const priceDelta = side === 'SHORT'
            ? (pos.entryPrice - currentPrice) * pos.positionAmt
            : (currentPrice - pos.entryPrice) * pos.positionAmt;
          positions.push({
            entryPrice: pos.entryPrice,
            positionAmt: pos.positionAmt,
            positionSide: pos.positionSide,
            unrealizedPnl: priceDelta,
            estimatedProfit: 0,
            leverage: pos.leverage,
          });
          unrealizedPnl += priceDelta;
        }

      }
      realizedPnl = await getBotRealizedPnl(bot.id);
    }

    if (i < bots.length - 1) await sleep(RATE_LIMIT_DELAY_MS);

    results.push({
      bot,
      runtime,
      orders,
      positions,
      unrealizedPnl,
      realizedPnl,
    });
  }
  return results;
}
