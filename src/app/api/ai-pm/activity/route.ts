import { NextResponse } from 'next/server';
import { requireAuth } from '@/services/auth.service';
import {
  listDecisions,
  listLatestSignals,
  listActivePaperBots,
  getTodaySpendSummary,
  getLastTickAt,
  decodeCursor,
  ALL_STATUSES,
  ALL_ACTION_TYPES,
  type AiDecisionStatus,
  type AiActionType,
} from '@/services/ai-pm-activity.service';

function parseList<T extends string>(raw: string | null, allowed: readonly T[]): T[] | undefined {
  if (!raw) return undefined;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return undefined;
  const bad = parts.find((p) => !(allowed as readonly string[]).includes(p));
  if (bad) throw new Error(`Invalid value: ${bad}`);
  return parts as T[];
}

function parseDate(raw: string | null, field: string): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid ${field}`);
  return d;
}

function parseLimit(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 100) throw new Error('Invalid limit');
  return n;
}

export async function GET(req: Request) {
  try {
    const user = await requireAuth();
    const url = new URL(req.url);
    const params = url.searchParams;

    let status: AiDecisionStatus[] | undefined;
    let actionType: AiActionType[] | undefined;
    let from: Date | undefined;
    let to: Date | undefined;
    let cursor: { createdAt: Date; id: string } | undefined;
    let limit: number | undefined;

    try {
      status = parseList<AiDecisionStatus>(params.get('status'), ALL_STATUSES);
      actionType = parseList<AiActionType>(params.get('actionType'), ALL_ACTION_TYPES);
      from = parseDate(params.get('from'), 'from');
      to = parseDate(params.get('to'), 'to');
      limit = parseLimit(params.get('limit'));
      const cursorRaw = params.get('cursor');
      if (cursorRaw) cursor = decodeCursor(cursorRaw);
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : 'Bad request';
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    const symbol = params.get('symbol') ?? undefined;

    const [decisionsRes, signals, paperBots, summary, lastTickAt] = await Promise.all([
      listDecisions({ userId: user.id, status, actionType, symbol, from, to, cursor, limit }),
      listLatestSignals(user.id, 10),
      listActivePaperBots(user.id),
      getTodaySpendSummary(user.id),
      getLastTickAt(user.id),
    ]);

    return NextResponse.json({
      decisions: decisionsRes.decisions,
      nextCursor: decisionsRes.nextCursor,
      signals,
      paperBots,
      summary,
      lastTickAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed';
    if (message.includes('Authentication')) {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
