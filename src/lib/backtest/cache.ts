// src/lib/backtest/cache.ts
import { createHash } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { backtestRuns } from '@/db/schema';
import type { BacktestableStrategy } from '@/lib/backtest/types';

export type BacktestRow = typeof backtestRuns.$inferSelect;
export type BacktestInsert = typeof backtestRuns.$inferInsert;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => [k, canonical((value as Record<string, unknown>)[k])] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

export function paramsHash(params: unknown): string {
  const json = JSON.stringify(canonical(params));
  return createHash('sha256').update(json).digest('hex').slice(0, 32);
}

export async function findCached(
  symbol: string,
  strategy: BacktestableStrategy,
  hash: string,
  windowDays: number,
): Promise<BacktestRow | null> {
  const rows = await db
    .select()
    .from(backtestRuns)
    .where(
      and(
        eq(backtestRuns.symbol, symbol),
        eq(backtestRuns.strategy, strategy),
        eq(backtestRuns.paramsHash, hash),
        eq(backtestRuns.windowDays, windowDays),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function writeCache(row: BacktestInsert): Promise<BacktestRow> {
  const [inserted] = await db
    .insert(backtestRuns)
    .values(row)
    .onConflictDoNothing({
      target: [backtestRuns.symbol, backtestRuns.strategy, backtestRuns.paramsHash, backtestRuns.windowDays],
    })
    .returning();

  if (inserted) return inserted;

  // Race: someone else inserted the same key first. Re-read it.
  const existing = await findCached(row.symbol, row.strategy as BacktestableStrategy, row.paramsHash, row.windowDays);
  if (!existing) {
    throw new Error(
      `writeCache conflict on ${row.symbol}|${row.strategy}|${row.paramsHash}|${row.windowDays} but no row found on re-read`,
    );
  }
  return existing;
}
