import { eq, and, desc, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { bingxApiKeys, tradingBots, gridLevels } from '@/db/schema';
import { encryptSecret, decryptSecret } from '@/lib/bingx/encryption';
import { createBingxClient, type BingxClient } from '@/lib/bingx/client';
import type { InferSelectModel } from 'drizzle-orm';

export type TradingBot = InferSelectModel<typeof tradingBots>;
export type GridLevel = InferSelectModel<typeof gridLevels>;

export async function saveBingxKeys(userId: string, apiKey: string, secretKey: string): Promise<void> {
  const trimmedApiKey = apiKey.trim();
  const trimmedSecretKey = secretKey.trim();
  const secretKeyEncrypted = encryptSecret(trimmedSecretKey);
  await db
    .insert(bingxApiKeys)
    .values({
      userId,
      apiKey: trimmedApiKey,
      secretKeyEncrypted,
    })
    .onConflictDoUpdate({
      target: bingxApiKeys.userId,
      set: {
        apiKey: trimmedApiKey,
        secretKeyEncrypted,
        updatedAt: new Date(),
      },
    });
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
};

export async function createBot(userId: string, params: CreateBotParams): Promise<TradingBot> {
  const [bot] = await db
    .insert(tradingBots)
    .values({
      userId,
      symbol: params.symbol,
      priceMin: params.priceMin,
      priceMax: params.priceMax,
      positionSizeUsdt: params.positionSizeUsdt,
      takeProfitPercentage: params.takeProfitPercentage,
      gridCount: params.gridCount,
      leverage: params.leverage ?? 1,
      marginType: params.marginType ?? 'SEPARATE_ISOLATED',
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
  options?: { onConflictDoNothing?: boolean }
): Promise<GridLevel[]> {
  const min = parseFloat(priceMin);
  const max = parseFloat(priceMax);
  const levels = calcGridPriceLevels(min, max, gridCount);
  const inserts = levels.map((priceLevel) => ({
    botId,
    priceLevel: String(priceLevel),
    positionSide: 'LONG',
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
        return amt > 0;
      })
      .map((p) => {
        const rawPositionId = (p?.positionId ?? p?.position_id) as string | number | bigint | null | undefined;
        return {
          symbol: String(p?.symbol ?? ''),
          positionSide: String(p?.positionSide ?? 'LONG'),
          positionAmt: Number(p?.positionAmt ?? p?.position ?? 0),
          entryPrice: Number(p?.entryPrice ?? p?.avgPrice ?? 0),
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

export async function placeGridEntryOrder(params: PlaceGridEntryOrderParams): Promise<string | null> {
  const {
    client,
    symbol,
    priceLevel,
    quantity,
    takeProfitPct,
    pricePrecision,
    quantityPrecision,
    positionSide,
    currentPrice,
  } = params;

  const priceStr = toPrecision(priceLevel, pricePrecision);
  const quantityStr = toQuantityPrecision(quantity, quantityPrecision);
  // BUY LONG: priceLevel < currentPrice → LIMIT (below market, sits in book).
  //           priceLevel > currentPrice → TRIGGER_LIMIT (above market, avoids sweeping book).
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
  const client = await getBingxClient(userId);
  const bot = await getBotById(botId, userId);

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
    const params: Record<string, string | number | undefined> = {
      symbol: symbol.toUpperCase().replace(/\s/g, ''),
      limit: 100,
    };
    if (startTime != null) params.startTime = startTime;
    if (endTime != null) params.endTime = endTime;
    const data = (await client.get('/openApi/swap/v2/user/income', params)) as unknown;
    let items: Array<{ income?: string | number; symbol?: string }> = [];
    if (Array.isArray(data)) {
      items = data;
    } else if (data && typeof data === 'object') {
      const o = data as Record<string, unknown>;
      const arr = Array.isArray(o.data) ? o.data : Array.isArray(o.income) ? o.income : [];
      items = arr as typeof items;
    }
    let total = 0;
    const sym = symbol.toUpperCase().replace(/\s/g, '');
    for (const item of items) {
      const itemSym = String(item?.symbol ?? '').toUpperCase();
      if (itemSym && itemSym !== sym) continue;
      total += Number(item?.income ?? 0);
    }
    return total;
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

  const client = await getBingxClient(userId);
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
    const sym = symbol.toUpperCase().replace(/\s/g, '');

    const positionMatchesLevel = (entryPrice: number, priceLevel: number) => {
      const diff = Math.abs(entryPrice - priceLevel) / priceLevel;
      return diff <= POSITION_ENTRY_TOLERANCE_PCT;
    };

    for (const pos of openPositions) {
      const side = String(pos.positionSide ?? 'LONG').toUpperCase();
      if (side !== 'LONG' && side !== 'BOTH') continue;

      const level = levels.find((l) =>
        positionMatchesLevel(pos.entryPrice, Number(l.priceLevel))
      );
      const priceLevel = level ? Number(level.priceLevel) : pos.entryPrice;
      const tpPrice = priceLevel * (1 + takeProfitPct);
      const unrealized = (priceNow - pos.entryPrice) * pos.positionAmt;
      const estimated = (tpPrice - pos.entryPrice) * pos.positionAmt;

      positions.push({
        entryPrice: pos.entryPrice,
        positionAmt: pos.positionAmt,
        positionSide: pos.positionSide,
        unrealizedPnl: unrealized,
        estimatedProfit: estimated,
      });
      unrealizedPnl += unrealized;
    }

    realizedPnl = await getIncome(
      client,
      sym,
      bot.createdAt.getTime(),
      Date.now()
    );
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
 * Batch variant: fetches BingX data once per unique symbol to avoid rate limits.
 * Processes bots sequentially with delays between BingX calls.
 */
export async function getBotsDetailsBatched(
  userId: string,
  bots: TradingBot[]
): Promise<BotDetails[]> {
  const RATE_LIMIT_DELAY_MS = 400;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const client = await getBingxClient(userId);
  const symbolCache = new Map<
    string,
    {
      openOrders: OpenOrderInfo[];
      openPositions: OpenPosition[];
      currentPrice: number | null;
    }
  >();

  const uniqueSymbols = [...new Set(bots.map((b) => (String(b.symbol ?? '').trim().toUpperCase() || 'BTC-USDT')))];
  for (const symbol of uniqueSymbols) {
    if (!client) break;
    const [openOrders, openPositions, currentPrice] = await Promise.all([
      getOpenOrders(client, symbol),
      getOpenPositions(client, symbol),
      getCurrentPrice(client, symbol),
    ]);
    symbolCache.set(symbol, { openOrders, openPositions, currentPrice });
    if (uniqueSymbols.indexOf(symbol) < uniqueSymbols.length - 1) {
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  }

  const results: BotDetails[] = [];
  for (let i = 0; i < bots.length; i++) {
    const bot = bots[i];
    const symbol = String(bot.symbol ?? '').trim().toUpperCase() || 'BTC-USDT';
    const levels = await getGridLevelsByBotId(bot.id);
    const takeProfitPct = Number(bot.takeProfitPercentage) / 100;
    const runtime = formatRuntime(bot.createdAt);
    const cached = client ? symbolCache.get(symbol) : null;
    const openOrders = cached?.openOrders ?? [];
    const openPositions = cached?.openPositions ?? [];
    const currentPrice = cached?.currentPrice ?? 0;
    const openOrderIds = new Set(openOrders.map((o) => String(o.orderId)));

    const orders: BotOrderInfo[] = [];
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
    const positions: BotPositionInfo[] = [];
    let unrealizedPnl = 0;
    for (const pos of openPositions) {
      const side = String(pos.positionSide ?? 'LONG').toUpperCase();
      if (side !== 'LONG' && side !== 'BOTH') continue;
      const level = levels.find((l) => positionMatchesLevel(pos.entryPrice, Number(l.priceLevel)));
      const priceLevel = level ? Number(level.priceLevel) : pos.entryPrice;
      const tpPrice = priceLevel * (1 + takeProfitPct);
      const unrealized = (currentPrice - pos.entryPrice) * pos.positionAmt;
      const estimated = (tpPrice - pos.entryPrice) * pos.positionAmt;
      positions.push({
        entryPrice: pos.entryPrice,
        positionAmt: pos.positionAmt,
        positionSide: pos.positionSide,
        unrealizedPnl: unrealized,
        estimatedProfit: estimated,
      });
      unrealizedPnl += unrealized;
    }

    let realizedPnl = 0;
    if (client) {
      realizedPnl = await getIncome(
        client,
        symbol,
        bot.createdAt.getTime(),
        Date.now()
      );
      if (i < bots.length - 1) await sleep(RATE_LIMIT_DELAY_MS);
    }

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
