import { db } from '@/db';
import { botIncomeRecords, tradingBots } from '@/db/schema';
import { and, eq, gt, isNotNull, sql } from 'drizzle-orm';
import {
  getBingxClientByApiKeyId,
  getOrderHistory,
  type HistoricalOrderInfo,
} from '@/services/bingx.service';
import { shortId } from '@/services/bots/grid-cid';

/**
 * Syncs real exchange income (per-order realized PnL + fees from FILLED
 * orders in /trade/allOrders) into bot_income_records.
 *
 * Attribution, in order:
 * 1. The order's own clientOrderID matches the grid CID scheme (ge/gt + bot8)
 *    — entries always carry it.
 * 2. The order shares a positionId with a CID-attributed order — this covers
 *    TP orders, which BingX creates itself (from the entry's embedded
 *    takeProfit) with an empty clientOrderID.
 * Anything else is stored with botId null. This stays exact even when several
 * bots trade the same symbol on one API key.
 */

/** allOrders rejects ranges over 7 days (error 109400); stay a minute under. */
const WINDOW_MS = 7 * 24 * 3600_000 - 60_000;
/** Re-read this much before the cursor to absorb clock skew / late updates. */
const OVERLAP_MS = 3600_000;
const DEFAULT_LOOKBACK_DAYS = 90;

const CID_RE = /^g[et]([0-9a-f]{8})/;

/** Resolve a clientOrderID to one of the key's bots, or null if foreign/absent. */
export function resolveBotByCid(
  clientOrderId: string | undefined | null,
  bots: Array<{ id: string }>
): string | null {
  if (!clientOrderId) return null;
  const match = CID_RE.exec(clientOrderId.toLowerCase());
  if (!match) return null;
  return bots.find((b) => shortId(b.id) === match[1])?.id ?? null;
}

export type SyncResult = { inserted: number; windows: number; orders: number };

export async function syncIncomeForApiKey(
  apiKeyId: string,
  opts: { now?: number; lookbackDays?: number } = {}
): Promise<SyncResult> {
  const now = opts.now ?? Date.now();
  const lookbackMs = (opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS) * 24 * 3600_000;

  const bots = await db
    .select({ id: tradingBots.id, symbol: tradingBots.symbol })
    .from(tradingBots)
    .where(eq(tradingBots.apiKeyId, apiKeyId));
  if (bots.length === 0) return { inserted: 0, windows: 0, orders: 0 };

  const client = await getBingxClientByApiKeyId(apiKeyId);
  if (!client) return { inserted: 0, windows: 0, orders: 0 };

  const botSymbols = [...new Set(bots.map((b) => normalizeSymbol(b.symbol)))];

  // EPOCH extraction sidesteps naive-timestamp/timezone parsing pitfalls.
  const [cursorRow] = await db
    .select({
      maxMs: sql<string | null>`EXTRACT(EPOCH FROM MAX(${botIncomeRecords.incomeTime})) * 1000`,
    })
    .from(botIncomeRecords)
    .where(eq(botIncomeRecords.apiKeyId, apiKeyId));
  const cursor = cursorRow?.maxMs != null ? Number(cursorRow.maxMs) - OVERLAP_MS : null;
  const since = Math.max(cursor ?? now - lookbackMs, now - lookbackMs);

  // positionId -> botId, accumulated across windows so a TP filled this window
  // inherits the bot of an entry filled in an earlier one.
  const botByPositionId = new Map<string, string>();

  // Context pass: when resuming from a cursor, one earlier window seeds the
  // position map for TPs whose entries filled before the cursor. Read-only.
  if (cursor != null && since > now - lookbackMs) {
    const contextFrom = Math.max(since - WINDOW_MS, now - lookbackMs);
    if (contextFrom < since) {
      await collectOrders(client, botSymbols, contextFrom, since, (order) => {
        rememberPosition(order, bots, botByPositionId);
      });
    }
  }

  let inserted = 0;
  let windows = 0;
  let orderCount = 0;

  for (let from = since; from < now; from += WINDOW_MS) {
    const to = Math.min(from + WINDOW_MS, now);
    windows++;

    const filled: HistoricalOrderInfo[] = [];
    await collectOrders(client, botSymbols, from, to, (order) => {
      if (order.status !== 'FILLED') return;
      rememberPosition(order, bots, botByPositionId);
      filled.push(order);
    });
    if (filled.length === 0) continue;
    orderCount += filled.length;

    // Oldest first so an entry registers its positionId before its TP resolves.
    filled.sort((a, b) => (a.updateTime ?? 0) - (b.updateTime ?? 0));

    const rows: (typeof botIncomeRecords.$inferInsert)[] = [];
    for (const order of filled) {
      const fillTime = order.updateTime ?? order.time ?? 0;
      if (!order.orderId || fillTime <= 0) continue;

      const botId =
        resolveBotByCid(order.clientOrderId, bots) ??
        (order.positionId != null ? botByPositionId.get(order.positionId) ?? null : null);

      const base = {
        apiKeyId,
        botId,
        symbol: normalizeSymbol(order.symbol ?? ''),
        tradeId: order.orderId, // one income row pair per order
        orderId: order.orderId,
        clientOrderId: order.clientOrderId || null,
        incomeTime: new Date(fillTime),
      };
      const profit = order.profit ?? 0;
      const commission = order.commission ?? 0;
      if (profit !== 0) {
        rows.push({ ...base, incomeType: 'REALIZED_PNL', amount: String(profit) });
      }
      if (commission !== 0) {
        rows.push({ ...base, incomeType: 'FEE', amount: String(commission) });
      }
    }

    if (rows.length > 0) {
      const result = await db
        .insert(botIncomeRecords)
        .values(rows)
        .onConflictDoNothing()
        .returning({ id: botIncomeRecords.id });
      inserted += result.length;
    }
  }

  return { inserted, windows, orders: orderCount };
}

/** Distinct apiKeyIds that own bots touched in the last `days` days. */
export async function listApiKeyIdsForIncomeSync(days = 180): Promise<string[]> {
  const rows = await db
    .selectDistinct({ apiKeyId: tradingBots.apiKeyId })
    .from(tradingBots)
    .where(
      and(
        isNotNull(tradingBots.apiKeyId),
        gt(tradingBots.updatedAt, sql`now() - make_interval(days => ${days})`)
      )
    );
  return rows.map((r) => r.apiKeyId).filter((id): id is string => id != null);
}

async function collectOrders(
  client: NonNullable<Awaited<ReturnType<typeof getBingxClientByApiKeyId>>>,
  symbols: string[],
  from: number,
  to: number,
  onOrder: (order: HistoricalOrderInfo) => void
): Promise<void> {
  for (const symbol of symbols) {
    try {
      await rateLimitPause();
      const history = await getOrderHistory(client, symbol, from, to);
      for (const order of history) onOrder(order);
    } catch (err) {
      console.warn(`[IncomeSync] order history failed for ${symbol}:`, err);
    }
  }
}

function rememberPosition(
  order: HistoricalOrderInfo,
  bots: Array<{ id: string }>,
  botByPositionId: Map<string, string>
): void {
  if (order.positionId == null) return;
  const botId = resolveBotByCid(order.clientOrderId, bots);
  if (botId != null) botByPositionId.set(order.positionId, botId);
}

function normalizeSymbol(symbol: string): string {
  return symbol.toUpperCase().replace(/\s/g, '');
}

/** BingX rate limit spacing (skipped under vitest to keep tests fast). */
async function rateLimitPause(): Promise<void> {
  if (process.env.VITEST) return;
  await new Promise((r) => setTimeout(r, 400));
}
