import { and, asc, eq, gt } from 'drizzle-orm';
import { chatMessageChunks } from '@/db/schema';
import type { db as Db, sql as SqlClient } from '@/db';
import type { ToolCallEntry } from '@/lib/ai-pm/chat-loop';
import type { LlmUsage } from '@/lib/ai-pm/llm';

export type StreamEvent =
  | { type: 'started'; placeholderId: string }
  | { type: 'tool_start'; toolName: string; args: unknown }
  | { type: 'tool_done'; entry: ToolCallEntry }
  | { type: 'text_chunk'; seq: number; text: string }
  | { type: 'done'; decisionId: string | null; usage: LlmUsage }
  | { type: 'error'; kind: string; message: string };

export function streamChannel(messageId: string): string {
  return `chat:${messageId}`;
}

export async function notifyStream(
  sqlClient: typeof SqlClient,
  messageId: string,
  event: StreamEvent,
): Promise<void> {
  await sqlClient.notify(streamChannel(messageId), JSON.stringify(event));
}

export async function persistChunk(
  database: typeof Db,
  messageId: string,
  seq: number,
  text: string,
): Promise<void> {
  await database
    .insert(chatMessageChunks)
    .values({ messageId, seq, text })
    .onConflictDoNothing();
}

export async function loadChunksFromSeq(
  database: typeof Db,
  messageId: string,
  fromSeq: number,
): Promise<Array<{ seq: number; text: string }>> {
  const rows = await database
    .select({ seq: chatMessageChunks.seq, text: chatMessageChunks.text })
    .from(chatMessageChunks)
    .where(and(eq(chatMessageChunks.messageId, messageId), gt(chatMessageChunks.seq, fromSeq)))
    .orderBy(asc(chatMessageChunks.seq));
  return rows;
}

export async function deleteChunks(
  database: typeof Db,
  messageId: string,
): Promise<void> {
  await database.delete(chatMessageChunks).where(eq(chatMessageChunks.messageId, messageId));
}
