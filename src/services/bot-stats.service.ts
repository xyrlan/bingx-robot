import { db } from '@/db';
import { botIncomeRecords, botTrades } from '@/db/schema';
import { and, gte, inArray, sql } from 'drizzle-orm';
import {
  STAT_WINDOW_KEYS,
  emptyWindowedStats,
  type BotDailyPnlPoint,
  type BotStats,
  type BotWindowedStats,
  type StatWindowKey,
} from '@/lib/bot-stats-types';

export type { BotDailyPnlPoint, BotStats, BotWindowedStats, StatWindowKey } from '@/lib/bot-stats-types';

/**
 * Windowed P&L statistics computed from bot_trades EXIT rows.
 *
 * Note: values are estimates recorded by the watchers (grid price × qty),
 * not exchange income — no fees, funding, or slippage. `source: 'estimated'`
 * flags this to the UI; a future income sync will provide `source: 'real'`.
 */

export const EXIT_TRADE_TYPES = ['EXIT_TP', 'EXIT_TRAILING', 'EXIT_SIGNAL', 'EXIT_MANUAL'] as const;

const WINDOW_DAYS: Record<Exclude<StatWindowKey, 'all'>, number> = {
  '7d': 7,
  '30d': 30,
  '60d': 60,
  '90d': 90,
  '180d': 180,
};

/**
 * One row per bot with SUM/COUNT FILTER aggregates for every window.
 * Bots with no EXIT trades are absent from the result — callers that need
 * zero-filled entries should use getBotsStats.
 */
export async function getBotWindowedStats(
  botIds: string[]
): Promise<Record<string, BotWindowedStats>> {
  if (botIds.length === 0) return {};

  const windowSelects: Record<string, ReturnType<typeof sql<string>>> = {};
  for (const [key, days] of Object.entries(WINDOW_DAYS)) {
    const cutoff = sql`now() - make_interval(days => ${days})`;
    windowSelects[`pnl_${key}`] = sql<string>`COALESCE(SUM(${botTrades.realizedPnl}) FILTER (WHERE ${botTrades.createdAt} >= ${cutoff}), 0)`;
    windowSelects[`trades_${key}`] = sql<string>`COUNT(*) FILTER (WHERE ${botTrades.createdAt} >= ${cutoff})`;
    windowSelects[`wins_${key}`] = sql<string>`COUNT(*) FILTER (WHERE ${botTrades.realizedPnl} > 0 AND ${botTrades.createdAt} >= ${cutoff})`;
  }

  const rows = await db
    .select({
      botId: botTrades.botId,
      pnl_all: sql<string>`COALESCE(SUM(${botTrades.realizedPnl}), 0)`,
      trades_all: sql<string>`COUNT(*)`,
      wins_all: sql<string>`COUNT(*) FILTER (WHERE ${botTrades.realizedPnl} > 0)`,
      ...windowSelects,
    })
    .from(botTrades)
    .where(and(inArray(botTrades.botId, botIds), inArray(botTrades.type, [...EXIT_TRADE_TYPES])))
    .groupBy(botTrades.botId);

  const result: Record<string, BotWindowedStats> = {};
  for (const row of rows) {
    const windows = emptyWindowedStats();
    for (const key of STAT_WINDOW_KEYS) {
      const raw = row as unknown as Record<string, string>;
      windows[key] = {
        pnl: Number(raw[`pnl_${key}`] ?? 0),
        trades: Number(raw[`trades_${key}`] ?? 0),
        wins: Number(raw[`wins_${key}`] ?? 0),
      };
    }
    result[row.botId] = windows;
  }
  return result;
}

/**
 * Sparse per-day realized P&L series (EXIT rows only), ascending by day,
 * limited to the last `days` days. Days without trades are omitted.
 */
export async function getBotDailyPnl(
  botIds: string[],
  days = 90
): Promise<Record<string, BotDailyPnlPoint[]>> {
  if (botIds.length === 0) return {};

  const day = sql<string>`date_trunc('day', ${botTrades.createdAt})`;
  const rows = await db
    .select({
      botId: botTrades.botId,
      day,
      pnl: sql<string>`SUM(${botTrades.realizedPnl})`,
    })
    .from(botTrades)
    .where(
      and(
        inArray(botTrades.botId, botIds),
        inArray(botTrades.type, [...EXIT_TRADE_TYPES]),
        gte(botTrades.createdAt, sql`now() - make_interval(days => ${days})`)
      )
    )
    .groupBy(botTrades.botId, day)
    .orderBy(day);

  const result: Record<string, BotDailyPnlPoint[]> = {};
  for (const row of rows) {
    (result[row.botId] ??= []).push({
      date: new Date(row.day).toISOString().slice(0, 10),
      pnl: Number(row.pnl),
    });
  }
  return result;
}

/**
 * Real income aggregates from bot_income_records (synced exchange fills).
 * pnl is fee-inclusive (SUM of all income types); trades/wins count only
 * REALIZED_PNL rows.
 */
export async function getBotRealWindowedStats(
  botIds: string[]
): Promise<Record<string, BotWindowedStats>> {
  if (botIds.length === 0) return {};

  const isPnl = sql`${botIncomeRecords.incomeType} = 'REALIZED_PNL'`;
  const windowSelects: Record<string, ReturnType<typeof sql<string>>> = {};
  for (const [key, days] of Object.entries(WINDOW_DAYS)) {
    const cutoff = sql`now() - make_interval(days => ${days})`;
    windowSelects[`pnl_${key}`] = sql<string>`COALESCE(SUM(${botIncomeRecords.amount}) FILTER (WHERE ${botIncomeRecords.incomeTime} >= ${cutoff}), 0)`;
    windowSelects[`trades_${key}`] = sql<string>`COUNT(*) FILTER (WHERE ${isPnl} AND ${botIncomeRecords.incomeTime} >= ${cutoff})`;
    windowSelects[`wins_${key}`] = sql<string>`COUNT(*) FILTER (WHERE ${isPnl} AND ${botIncomeRecords.amount} > 0 AND ${botIncomeRecords.incomeTime} >= ${cutoff})`;
  }

  const rows = await db
    .select({
      botId: sql<string>`${botIncomeRecords.botId}`,
      pnl_all: sql<string>`COALESCE(SUM(${botIncomeRecords.amount}), 0)`,
      trades_all: sql<string>`COUNT(*) FILTER (WHERE ${isPnl})`,
      wins_all: sql<string>`COUNT(*) FILTER (WHERE ${isPnl} AND ${botIncomeRecords.amount} > 0)`,
      ...windowSelects,
    })
    .from(botIncomeRecords)
    .where(inArray(botIncomeRecords.botId, botIds))
    .groupBy(botIncomeRecords.botId);

  const result: Record<string, BotWindowedStats> = {};
  for (const row of rows) {
    const windows = emptyWindowedStats();
    for (const key of STAT_WINDOW_KEYS) {
      const raw = row as unknown as Record<string, string>;
      windows[key] = {
        pnl: Number(raw[`pnl_${key}`] ?? 0),
        trades: Number(raw[`trades_${key}`] ?? 0),
        wins: Number(raw[`wins_${key}`] ?? 0),
      };
    }
    result[row.botId] = windows;
  }
  return result;
}

/** Sparse per-day fee-inclusive real P&L series over the last `days` days. */
export async function getBotRealDailyPnl(
  botIds: string[],
  days = 90
): Promise<Record<string, BotDailyPnlPoint[]>> {
  if (botIds.length === 0) return {};

  const day = sql<string>`date_trunc('day', ${botIncomeRecords.incomeTime})`;
  const rows = await db
    .select({
      botId: sql<string>`${botIncomeRecords.botId}`,
      day,
      pnl: sql<string>`SUM(${botIncomeRecords.amount})`,
    })
    .from(botIncomeRecords)
    .where(
      and(
        inArray(botIncomeRecords.botId, botIds),
        gte(botIncomeRecords.incomeTime, sql`now() - make_interval(days => ${days})`)
      )
    )
    .groupBy(sql`${botIncomeRecords.botId}`, day)
    .orderBy(day);

  const result: Record<string, BotDailyPnlPoint[]> = {};
  for (const row of rows) {
    (result[row.botId] ??= []).push({
      date: new Date(row.day).toISOString().slice(0, 10),
      pnl: Number(row.pnl),
    });
  }
  return result;
}

/**
 * Composed stats for the bots page, zero-filled per requested bot.
 * Bots with synced exchange income use it (source 'real', fee-inclusive);
 * the rest fall back to watcher estimates from bot_trades.
 */
export async function getBotsStats(botIds: string[]): Promise<Record<string, BotStats>> {
  if (botIds.length === 0) return {};

  const [windowed, daily, realWindowed, realDaily] = await Promise.all([
    getBotWindowedStats(botIds),
    getBotDailyPnl(botIds),
    getBotRealWindowedStats(botIds),
    getBotRealDailyPnl(botIds),
  ]);

  const result: Record<string, BotStats> = {};
  for (const botId of botIds) {
    const real = realWindowed[botId];
    result[botId] = real
      ? { botId, windows: real, daily: realDaily[botId] ?? [], source: 'real' }
      : {
          botId,
          windows: windowed[botId] ?? emptyWindowedStats(),
          daily: daily[botId] ?? [],
          source: 'estimated',
        };
  }
  return result;
}
