import { db } from '@/db';
import { botIncomeRecords, tradingBots } from '@/db/schema';
import { and, eq, gt, isNotNull, sql } from 'drizzle-orm';
import {
  getBingxClientByApiKeyId,
  getFillHistory,
  getOrderHistory,
} from '@/services/bingx.service';
import { shortId } from '@/services/bots/grid-cid';

/**
 * Syncs real exchange income (per-fill realized PnL + fees) into
 * bot_income_records and attributes each fill to a bot via the grid
 * clientOrderID scheme (ge/gt + bot8). Unlike the /user/income endpoint,
 * fills join to orders and orders echo our CIDs — attribution stays exact
 * even when several bots trade the same symbol on the same API key.
 */

/** allOrders/allFillOrders reject ranges over 7 days; stay a minute under. */
const WINDOW_MS = 7 * 24 * 3600_000 - 60_000;
/** Re-read this much before the cursor to absorb clock skew / late fills. */
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

export type SyncResult = { inserted: number; windows: number; fills: number };

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
  if (bots.length === 0) return { inserted: 0, windows: 0, fills: 0 };

  const client = await getBingxClientByApiKeyId(apiKeyId);
  if (!client) return { inserted: 0, windows: 0, fills: 0 };

  const botSymbols = new Set(bots.map((b) => normalizeSymbol(b.symbol)));

  // EPOCH extraction sidesteps naive-timestamp/timezone parsing pitfalls.
  const [cursorRow] = await db
    .select({
      maxMs: sql<string | null>`EXTRACT(EPOCH FROM MAX(${botIncomeRecords.incomeTime})) * 1000`,
    })
    .from(botIncomeRecords)
    .where(eq(botIncomeRecords.apiKeyId, apiKeyId));
  const cursor = cursorRow?.maxMs != null ? Number(cursorRow.maxMs) - OVERLAP_MS : null;
  const since = Math.max(cursor ?? now - lookbackMs, now - lookbackMs);

  let inserted = 0;
  let windows = 0;
  let fillCount = 0;

  for (let from = since; from < now; from += WINDOW_MS) {
    const to = Math.min(from + WINDOW_MS, now);
    if (windows > 0) await rateLimitPause();
    windows++;

    const fills = (await getFillHistory(client, from, to)).filter(
      (f) => f.symbol != null && botSymbols.has(normalizeSymbol(f.symbol))
    );
    if (fills.length === 0) continue;
    fillCount += fills.length;

    // Map orderId -> clientOrderId for this window, per symbol we trade.
    const cidByOrderId = new Map<string, string>();
    for (const symbol of botSymbols) {
      try {
        await rateLimitPause();
        const history = await getOrderHistory(client, symbol, from, to);
        for (const order of history) {
          if (order.clientOrderId) cidByOrderId.set(order.orderId, order.clientOrderId);
        }
      } catch (err) {
        // Order history is only needed for attribution — keep the fills
        // (unattributed) rather than losing the window.
        console.warn(`[IncomeSync] order history failed for ${symbol}:`, err);
      }
    }

    const rows: (typeof botIncomeRecords.$inferInsert)[] = [];
    for (const fill of fills) {
      if (!fill.tradeId || fill.time <= 0) continue;
      const clientOrderId = cidByOrderId.get(fill.orderId) ?? null;
      const base = {
        apiKeyId,
        botId: resolveBotByCid(clientOrderId, bots),
        symbol: normalizeSymbol(fill.symbol ?? ''),
        tradeId: fill.tradeId,
        orderId: fill.orderId || null,
        clientOrderId,
        incomeTime: new Date(fill.time),
      };
      if (fill.realizedPnl !== 0) {
        rows.push({ ...base, incomeType: 'REALIZED_PNL', amount: String(fill.realizedPnl) });
      }
      if (fill.fee !== 0) {
        rows.push({ ...base, incomeType: 'FEE', amount: String(fill.fee) });
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

  return { inserted, windows, fills: fillCount };
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

function normalizeSymbol(symbol: string): string {
  return symbol.toUpperCase().replace(/\s/g, '');
}

/** BingX rate limit spacing (skipped under vitest to keep tests fast). */
async function rateLimitPause(): Promise<void> {
  if (process.env.VITEST) return;
  await new Promise((r) => setTimeout(r, 400));
}
