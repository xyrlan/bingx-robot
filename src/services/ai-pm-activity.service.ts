import { db } from '@/db';
import { aiSignals, aiDecisions, paperBots } from '@/db/schema';
import { and, desc, eq, gte, inArray, lt, lte, or, sql } from 'drizzle-orm';

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

export type AiDecisionStatus =
  | 'PROPOSED'
  | 'REJECTED_GUARDRAIL'
  | 'REJECTED_BACKTEST'
  | 'REJECTED_REVIEWER'
  | 'EXECUTED'
  | 'EXECUTION_FAILED';

export type AiActionType =
  | 'CREATE_BOT'
  | 'STOP_BOT'
  | 'ADJUST_PARAMS'
  | 'REALLOCATE_CAPITAL'
  | 'NO_ACTION';

export const ALL_STATUSES: AiDecisionStatus[] = [
  'PROPOSED',
  'REJECTED_GUARDRAIL',
  'REJECTED_BACKTEST',
  'REJECTED_REVIEWER',
  'EXECUTED',
  'EXECUTION_FAILED',
];

export const ALL_ACTION_TYPES: AiActionType[] = [
  'CREATE_BOT',
  'STOP_BOT',
  'ADJUST_PARAMS',
  'REALLOCATE_CAPITAL',
  'NO_ACTION',
];

export interface ListDecisionsParams {
  userId: string;
  status?: AiDecisionStatus[];
  actionType?: AiActionType[];
  symbol?: string;
  from?: Date;
  to?: Date;
  cursor?: { createdAt: Date; id: string };
  limit?: number;
}

export interface PaperBotInline {
  id: string;
  symbol: string;
  strategy: string;
  status: string;
  pnlUsdt: string;
  tradesCount: number;
}

export interface AiDecisionPublic {
  id: string;
  triggeredBy: string;
  triggerDetail: string | null;
  actionType: AiActionType;
  status: AiDecisionStatus;
  symbol: string | null;
  strategy: string | null;
  params: unknown;
  reasoning: string | null;
  signalSnapshot: unknown;
  rejectionReason: string | null;
  modelUsed: string | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  costUsd: string | null;
  resultBotId: string | null;
  paperBot: PaperBotInline | null;
  executedAt: string | null;
  createdAt: string;
}

export interface ListDecisionsResult {
  decisions: AiDecisionPublic[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export function encodeCursor(c: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: c.createdAt.toISOString(), id: c.id }),
  ).toString('base64');
}

export function decodeCursor(s: string): { createdAt: Date; id: string } {
  let parsed: { createdAt?: unknown; id?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
  } catch {
    throw new Error('Invalid cursor');
  }
  if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') {
    throw new Error('Invalid cursor');
  }
  const createdAt = new Date(parsed.createdAt);
  if (Number.isNaN(createdAt.getTime())) throw new Error('Invalid cursor');
  return { createdAt, id: parsed.id };
}

export async function listDecisions(
  params: ListDecisionsParams,
): Promise<ListDecisionsResult> {
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const conditions = [eq(aiDecisions.userId, params.userId)];
  if (params.status?.length) {
    conditions.push(inArray(aiDecisions.status, params.status));
  }
  if (params.actionType?.length) {
    conditions.push(inArray(aiDecisions.actionType, params.actionType));
  }
  if (params.symbol) {
    conditions.push(eq(aiDecisions.symbol, params.symbol.toUpperCase()));
  }
  if (params.from) conditions.push(gte(aiDecisions.createdAt, params.from));
  if (params.to) conditions.push(lte(aiDecisions.createdAt, params.to));
  if (params.cursor) {
    const cursorPred = or(
      lt(aiDecisions.createdAt, params.cursor.createdAt),
      and(
        eq(aiDecisions.createdAt, params.cursor.createdAt),
        lt(aiDecisions.id, params.cursor.id),
      ),
    );
    if (cursorPred) conditions.push(cursorPred);
  }

  // Fetch limit+1 to detect "has more"
  const rows = await db
    .select({
      d: aiDecisions,
      pb: paperBots,
    })
    .from(aiDecisions)
    .leftJoin(paperBots, eq(paperBots.decisionId, aiDecisions.id))
    .where(and(...conditions))
    .orderBy(desc(aiDecisions.createdAt), desc(aiDecisions.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const kept = hasMore ? rows.slice(0, limit) : rows;
  const last = kept[kept.length - 1];

  const decisions: AiDecisionPublic[] = kept.map(({ d, pb }) => ({
    id: d.id,
    triggeredBy: d.triggeredBy,
    triggerDetail: d.triggerDetail,
    actionType: d.actionType as AiActionType,
    status: d.status as AiDecisionStatus,
    symbol: d.symbol,
    strategy: d.strategy,
    params: d.params,
    reasoning: d.reasoning,
    signalSnapshot: d.signalSnapshot,
    rejectionReason: d.rejectionReason,
    modelUsed: d.modelUsed,
    tokensInput: d.tokensInput,
    tokensOutput: d.tokensOutput,
    costUsd: d.costUsd,
    resultBotId: d.resultBotId,
    paperBot: pb
      ? {
          id: pb.id,
          symbol: pb.symbol,
          strategy: pb.strategy,
          status: pb.status,
          pnlUsdt: pb.pnlUsdt ?? '0',
          tradesCount: Array.isArray(pb.trades) ? pb.trades.length : 0,
        }
      : null,
    executedAt: d.executedAt ? d.executedAt.toISOString() : null,
    createdAt: d.createdAt.toISOString(),
  }));

  const nextCursor =
    hasMore && last
      ? encodeCursor({ createdAt: last.d.createdAt, id: last.d.id })
      : null;
  return { decisions, nextCursor };
}
