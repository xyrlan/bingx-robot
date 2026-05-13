import { db } from '@/db';
import { aiChatMessages } from '@/db/schema';
import { and, desc, eq, gt, lt, or } from 'drizzle-orm';
import type { UIMessage } from 'ai';
import { randomUUID } from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Subset of ToolExecResult that we round-trip through the toolCalls JSONB column.
 * Kept loose to tolerate legacy rows written by the pre-S19 chat pipeline.
 */
interface PersistedToolCall {
  toolCallId?: string;
  toolName: string;
  args: unknown;
  status?: string;
  decisionId?: string | null;
  summary?: string;
  output?: unknown;
}

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

/**
 * Direct-by-id lookup with userId ownership check. Used by the chat client's
 * polling fallback to fetch the assistant placeholder regardless of when it
 * was created (the `since` filter would otherwise exclude it).
 */
export async function getChatMessageById(
  userId: string,
  messageId: string,
): Promise<ChatMessagePublic | null> {
  const row = await db.query.aiChatMessages.findFirst({
    where: and(eq(aiChatMessages.id, messageId), eq(aiChatMessages.userId, userId)),
  });
  return row ? toPublic(row) : null;
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

// ---------------------------------------------------------------------------
// AI SDK v6 UIMessage round-tripping
// ---------------------------------------------------------------------------

function uuidOrRandom(maybeId: string | undefined): string {
  return maybeId && UUID_RE.test(maybeId) ? maybeId : randomUUID();
}

function uiMessageToText(msg: UIMessage): string {
  return msg.parts
    .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function uiMessageToToolCalls(msg: UIMessage): PersistedToolCall[] {
  const calls: PersistedToolCall[] = [];
  for (const part of msg.parts) {
    if (typeof part.type === 'string' && part.type.startsWith('tool-')) {
      const toolName = part.type.slice('tool-'.length);
      // The part shape varies by state; pull the union-safe fields.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = part as any;
      const status =
        p.state === 'output-error'
          ? 'EXECUTION_FAILED'
          : (p.output as { status?: string } | undefined)?.status ?? 'EXECUTED';
      const summary =
        (p.output as { summary?: string } | undefined)?.summary ??
        p.errorText ??
        '';
      const decisionId =
        (p.output as { decisionId?: string | null } | undefined)?.decisionId ?? null;
      calls.push({
        toolCallId: typeof p.toolCallId === 'string' ? p.toolCallId : undefined,
        toolName,
        args: p.input ?? p.args ?? null,
        status,
        decisionId,
        summary,
        output: p.output,
      });
    }
  }
  return calls;
}

/**
 * Persist a single user UIMessage. Idempotent on the message id when the id is
 * a valid UUID (re-sending the same message in a follow-up turn is a no-op).
 */
export async function persistUserMessage(userId: string, msg: UIMessage): Promise<void> {
  const id = uuidOrRandom(msg.id);
  const content = uiMessageToText(msg);
  await db
    .insert(aiChatMessages)
    .values({ id, userId, role: 'user', content })
    .onConflictDoNothing({ target: aiChatMessages.id });
}

/**
 * Find the latest assistant UIMessage in `finalMessages` and persist it. Called
 * from `result.toUIMessageStreamResponse({ onFinish })`. Idempotent on UUID id.
 */
export async function persistAssistantTurn(
  userId: string,
  finalMessages: UIMessage[],
): Promise<void> {
  const assistant = [...finalMessages].reverse().find((m) => m.role === 'assistant');
  if (!assistant) return;
  const id = uuidOrRandom(assistant.id);
  const content = uiMessageToText(assistant);
  const toolCalls = uiMessageToToolCalls(assistant);
  const firstDecisionId = toolCalls.find((c) => c.decisionId)?.decisionId ?? null;
  await db
    .insert(aiChatMessages)
    .values({
      id,
      userId,
      role: 'assistant',
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      decisionId: firstDecisionId,
    })
    .onConflictDoNothing({ target: aiChatMessages.id });
}

/**
 * Load chat history shaped as AI SDK v6 UIMessage[] for `useChat` initialMessages.
 * Returns oldest-first (ASC display order). Tool calls become typed `tool-{name}`
 * parts in `output-available` state.
 */
export async function loadChatHistoryAsUIMessages(
  userId: string,
  limit: number = 30,
): Promise<UIMessage[]> {
  const rows = await db
    .select()
    .from(aiChatMessages)
    .where(eq(aiChatMessages.userId, userId))
    .orderBy(desc(aiChatMessages.createdAt), desc(aiChatMessages.id))
    .limit(Math.min(Math.max(limit, 1), MAX_LIMIT));

  const asc = rows.slice().reverse();
  return asc.map((row): UIMessage => {
    const role: 'user' | 'assistant' = row.role === 'assistant' ? 'assistant' : 'user';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parts: any[] = [];
    if (row.content && row.content.length > 0) {
      parts.push({ type: 'text', text: row.content });
    }
    const calls = Array.isArray(row.toolCalls) ? (row.toolCalls as PersistedToolCall[]) : [];
    for (const c of calls) {
      parts.push({
        type: `tool-${c.toolName}`,
        toolCallId: c.toolCallId ?? randomUUID(),
        state: 'output-available',
        input: c.args,
        output: c.output ?? {
          status: c.status ?? 'EXECUTED',
          decisionId: c.decisionId ?? null,
          summary: c.summary ?? '',
        },
      });
    }
    return { id: row.id, role, parts } as UIMessage;
  });
}
