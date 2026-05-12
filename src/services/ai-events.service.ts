import { and, eq, gt, sql } from 'drizzle-orm';
import { aiEvents, aiPmConfigs } from '@/db/schema';
import { db as defaultDb } from '@/db';
import type { AiTriggerEnum } from '@/lib/ai-pm/events';

type Db = typeof defaultDb;

type EventStatus = 'PENDING' | 'THROTTLED' | 'PROCESSING' | 'PROCESSED' | 'FAILED';

export interface InsertAiEventParams {
  db?: Db;
  configId: string;
  eventType: AiTriggerEnum;
  symbol: string | null;
  payload: unknown;
  emittedAt: Date;
}

export interface MarkEventParams {
  db?: Db;
  aiEventId: string;
  status: EventStatus;
  decisionId?: string | null;
}

export interface CheckThrottleParams {
  db?: Db;
  configId: string;
  eventType: AiTriggerEnum;
  symbol: string | null;
  currentEventId: string;
  windowSeconds: number;
}

export async function insertAiEvent(params: InsertAiEventParams): Promise<string> {
  const database = params.db ?? defaultDb;

  const cfg = await database.query.aiPmConfigs.findFirst({
    where: eq(aiPmConfigs.id, params.configId),
  });
  if (!cfg) throw new Error(`AI PM config not found: ${params.configId}`);

  const [row] = await database
    .insert(aiEvents)
    .values({
      configId: params.configId,
      userId: cfg.userId,
      eventType: params.eventType,
      symbol: params.symbol,
      payload: params.payload,
      status: 'PENDING',
      emittedAt: params.emittedAt,
    })
    .returning();

  return row.id;
}

export async function markEvent(params: MarkEventParams): Promise<void> {
  const database = params.db ?? defaultDb;
  await database
    .update(aiEvents)
    .set({
      status: params.status,
      decisionId: params.decisionId ?? null,
      processedAt:
        params.status === 'PROCESSED' || params.status === 'FAILED'
          ? new Date()
          : null,
    })
    .where(eq(aiEvents.id, params.aiEventId))
    .returning();
}

export async function checkThrottle(params: CheckThrottleParams): Promise<boolean> {
  const database = params.db ?? defaultDb;
  const cutoff = new Date(Date.now() - params.windowSeconds * 1000);

  const rows = await database.query.aiEvents.findMany({
    where: and(
      eq(aiEvents.configId, params.configId),
      eq(aiEvents.eventType, params.eventType),
      sql`${aiEvents.symbol} IS NOT DISTINCT FROM ${params.symbol}`,
      gt(aiEvents.createdAt, cutoff),
    ),
  });

  return rows.some(
    (r) =>
      r.id !== params.currentEventId &&
      (r.status === 'PROCESSING' || r.status === 'PROCESSED'),
  );
}
