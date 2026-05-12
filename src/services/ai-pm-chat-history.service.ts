import { db } from '@/db';
import { aiChatMessages } from '@/db/schema';
import { and, desc, eq, gt, lt, or } from 'drizzle-orm';

export interface ChatMessagePublic {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  decisionId: string | null;
  toolCalls: unknown | null;
  createdAt: string;
}

export interface ListChatMessagesOpts {
  limit: number;
  cursor?: { createdAt: Date; id: string };
  since?: Date;
}

export interface ListChatMessagesResult {
  messages: ChatMessagePublic[];
  nextCursor: string | null;
}

const MAX_LIMIT = 50;

export function encodeChatCursor(c: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: c.createdAt.toISOString(), id: c.id }),
  ).toString('base64');
}

export function decodeChatCursor(s: string): { createdAt: Date; id: string } {
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

export async function listChatMessages(
  userId: string,
  opts: ListChatMessagesOpts,
): Promise<ListChatMessagesResult> {
  const limit = Math.min(Math.max(opts.limit, 1), MAX_LIMIT);

  if (opts.since) {
    const rows = await db
      .select()
      .from(aiChatMessages)
      .where(and(eq(aiChatMessages.userId, userId), gt(aiChatMessages.createdAt, opts.since)))
      .orderBy(desc(aiChatMessages.createdAt), desc(aiChatMessages.id))
      .limit(limit);
    return { messages: rows.map(toPublic), nextCursor: null };
  }

  const whereClause = opts.cursor
    ? and(
        eq(aiChatMessages.userId, userId),
        or(
          lt(aiChatMessages.createdAt, opts.cursor.createdAt),
          and(
            eq(aiChatMessages.createdAt, opts.cursor.createdAt),
            lt(aiChatMessages.id, opts.cursor.id),
          ),
        ),
      )
    : eq(aiChatMessages.userId, userId);

  // Fetch limit + 1 to detect if there are more rows beyond this page.
  const rows = await db
    .select()
    .from(aiChatMessages)
    .where(whereClause)
    .orderBy(desc(aiChatMessages.createdAt), desc(aiChatMessages.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const messages = pageRows.map(toPublic);
  const nextCursor = hasMore
    ? encodeChatCursor({
        createdAt: pageRows[pageRows.length - 1].createdAt,
        id: pageRows[pageRows.length - 1].id,
      })
    : null;

  return { messages, nextCursor };
}

function toPublic(row: typeof aiChatMessages.$inferSelect): ChatMessagePublic {
  const role: 'user' | 'assistant' = row.role === 'assistant' ? 'assistant' : 'user';
  return {
    id: row.id,
    role,
    content: row.content ?? '',
    decisionId: row.decisionId,
    toolCalls: row.toolCalls ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
