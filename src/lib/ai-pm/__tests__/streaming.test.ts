import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { db, sql } from '@/db';
import { users, aiChatMessages, chatMessageChunks } from '@/db/schema';
import { eq } from 'drizzle-orm';
import {
  notifyStream,
  persistChunk,
  loadChunksFromSeq,
  deleteChunks,
  streamChannel,
  type StreamEvent,
} from '@/lib/ai-pm/streaming';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000100';

async function ensureUser() {
  await db.insert(users).values({ id: TEST_USER_ID, email: 'streaming@example.com' }).onConflictDoNothing();
}

async function cleanup() {
  await db.delete(aiChatMessages).where(eq(aiChatMessages.userId, TEST_USER_ID));
}

async function insertPlaceholder(): Promise<string> {
  const [row] = await db.insert(aiChatMessages).values({
    userId: TEST_USER_ID, role: 'assistant', content: '', toolCalls: [], decisionId: null,
  }).returning();
  return row.id;
}

describe('streaming', () => {
  beforeAll(async () => { await ensureUser(); await cleanup(); });
  afterEach(async () => { await cleanup(); });

  it('streamChannel returns prefixed channel name', () => {
    expect(streamChannel('abc-123')).toBe('chat:abc-123');
  });

  it('persistChunk + loadChunksFromSeq round-trip ordered by seq', async () => {
    const id = await insertPlaceholder();
    await persistChunk(db, id, 1, 'hello ');
    await persistChunk(db, id, 2, 'world');
    await persistChunk(db, id, 3, '!');
    const got = await loadChunksFromSeq(db, id, 0);
    expect(got.map(c => c.text).join('')).toBe('hello world!');
    expect(got.map(c => c.seq)).toEqual([1, 2, 3]);
  });

  it('loadChunksFromSeq with fromSeq returns only newer rows', async () => {
    const id = await insertPlaceholder();
    await persistChunk(db, id, 1, 'a');
    await persistChunk(db, id, 2, 'b');
    await persistChunk(db, id, 3, 'c');
    const got = await loadChunksFromSeq(db, id, 1);
    expect(got.map(c => c.text)).toEqual(['b', 'c']);
  });

  it('persistChunk is idempotent on (messageId, seq)', async () => {
    const id = await insertPlaceholder();
    await persistChunk(db, id, 1, 'first');
    await persistChunk(db, id, 1, 'duplicate');
    const got = await loadChunksFromSeq(db, id, 0);
    expect(got).toHaveLength(1);
    expect(got[0].text).toBe('first');
  });

  it('deleteChunks wipes all chunks for a message', async () => {
    const id = await insertPlaceholder();
    await persistChunk(db, id, 1, 'a');
    await persistChunk(db, id, 2, 'b');
    await deleteChunks(db, id);
    expect(await loadChunksFromSeq(db, id, 0)).toEqual([]);
  });

  it('notifyStream + sql.listen round-trip delivers the event', async () => {
    const id = await insertPlaceholder();
    const received: StreamEvent[] = [];
    const sub = await sql.listen(streamChannel(id), (payload) => {
      try { received.push(JSON.parse(payload)); } catch {}
    });
    try {
      await notifyStream(sql, id, { type: 'text_chunk', seq: 1, text: 'hi' });
      // Give postgres a moment to deliver
      await new Promise((r) => setTimeout(r, 200));
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ type: 'text_chunk', seq: 1, text: 'hi' });
    } finally {
      await sub.unlisten();
    }
  });
});
