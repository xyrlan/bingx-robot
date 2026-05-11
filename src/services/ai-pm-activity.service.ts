import { db } from '@/db';
import { aiSignals, aiDecisions, paperBots } from '@/db/schema';
import { and, desc, eq, gte, sql } from 'drizzle-orm';

export interface AiSignalPublic {
  id: string;
  symbol: string;
  regime: string;
  score: number;
  reason: string | null;
  createdAt: string;
}

export async function listLatestSignals(userId: string, limit = 10): Promise<AiSignalPublic[]> {
  const rows = await db
    .select({
      id: aiSignals.id,
      symbol: aiSignals.symbol,
      regime: aiSignals.regime,
      score: aiSignals.score,
      reason: aiSignals.reason,
      createdAt: aiSignals.createdAt,
    })
    .from(aiSignals)
    .where(eq(aiSignals.userId, userId))
    .orderBy(desc(aiSignals.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    symbol: r.symbol,
    regime: r.regime,
    score: r.score,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
  }));
}

export interface PaperBotPublic {
  id: string;
  symbol: string;
  strategy: string;
  status: string;
  pnlUsdt: string;
  capitalUsdt: string;
  tradesCount: number;
  startedAt: string | null;
  createdAt: string;
}

export async function listActivePaperBots(userId: string): Promise<PaperBotPublic[]> {
  const rows = await db
    .select()
    .from(paperBots)
    .where(and(eq(paperBots.userId, userId), eq(paperBots.status, 'RUNNING')))
    .orderBy(desc(paperBots.createdAt));

  return rows.map((r) => ({
    id: r.id,
    symbol: r.symbol,
    strategy: r.strategy,
    status: r.status,
    pnlUsdt: r.pnlUsdt ?? '0',
    capitalUsdt: r.capitalUsdt,
    tradesCount: Array.isArray(r.trades) ? r.trades.length : 0,
    startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export interface SpendSummary {
  decisionsToday: number;
  tokensInputToday: number;
  tokensOutputToday: number;
  costUsdToday: string;
}

function todayMidnightUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function getTodaySpendSummary(userId: string): Promise<SpendSummary> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      tokensIn: sql<number>`coalesce(sum(${aiDecisions.tokensInput}), 0)::int`,
      tokensOut: sql<number>`coalesce(sum(${aiDecisions.tokensOutput}), 0)::int`,
      costSum: sql<string>`coalesce(sum(${aiDecisions.costUsd})::text, '0.000000')`,
    })
    .from(aiDecisions)
    .where(and(eq(aiDecisions.userId, userId), gte(aiDecisions.createdAt, todayMidnightUtc())));

  return {
    decisionsToday: row.count,
    tokensInputToday: row.tokensIn,
    tokensOutputToday: row.tokensOut,
    costUsdToday: row.costSum,
  };
}

export async function getLastTickAt(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ createdAt: aiDecisions.createdAt })
    .from(aiDecisions)
    .where(eq(aiDecisions.userId, userId))
    .orderBy(desc(aiDecisions.createdAt))
    .limit(1);

  if (!row) return null;
  return row.createdAt.toISOString();
}
