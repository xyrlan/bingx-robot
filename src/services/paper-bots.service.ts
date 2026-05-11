import { and, eq } from 'drizzle-orm';
import { paperBots } from '@/db/schema';
import type { db as Db } from '@/db';

export interface CreatePaperBotInput {
  userId: string;
  decisionId: string | null;
  symbol: string;
  strategy: 'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER';
  capitalUsdt: number;
  params: Record<string, unknown>;
}

export interface PaperBotRow {
  id: string;
  userId: string;
  decisionId: string | null;
  symbol: string;
  strategy: string;
  capitalUsdt: string;
  status: 'STOPPED' | 'RUNNING';
  pnlUsdt: string;
  startedAt: Date | null;
  stoppedAt: Date | null;
}

export async function createPaperBot(db: typeof Db, input: CreatePaperBotInput): Promise<PaperBotRow> {
  const [row] = await db
    .insert(paperBots)
    .values({
      userId: input.userId,
      decisionId: input.decisionId,
      symbol: input.symbol,
      strategy: input.strategy,
      params: input.params,
      capitalUsdt: String(input.capitalUsdt),
      status: 'RUNNING',
      startedAt: new Date(),
    })
    .returning();
  return row as PaperBotRow;
}

export async function stopPaperBot(
  db: typeof Db,
  userId: string,
  paperBotId: string,
): Promise<PaperBotRow | null> {
  const updated = await db
    .update(paperBots)
    .set({ status: 'STOPPED', stoppedAt: new Date() })
    .where(and(eq(paperBots.id, paperBotId), eq(paperBots.userId, userId)))
    .returning();
  return (updated[0] as PaperBotRow) ?? null;
}

export async function getPaperBotById(
  db: typeof Db,
  userId: string,
  paperBotId: string,
): Promise<PaperBotRow | null> {
  const row = await db.query.paperBots.findFirst({
    where: and(eq(paperBots.id, paperBotId), eq(paperBots.userId, userId)),
  });
  return (row as PaperBotRow | undefined) ?? null;
}
