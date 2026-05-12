import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { db } from '@/db';
import { users, aiChatMessages, chatMessageChunks } from '@/db/schema';
import { eq } from 'drizzle-orm';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000110';
const OTHER_USER_ID = '00000000-0000-0000-0000-000000000111';
let currentUserId: string | null = TEST_USER_ID;

vi.mock('@/services/auth.service', () => ({
  requireAuth: vi.fn(() => {
    if (currentUserId === null) throw new Error('Authentication required.');
    return Promise.resolve({ id: currentUserId });
  }),
}));

import { GET } from '../route';

async function ensureUsers() {
  await db.insert(users).values({ id: TEST_USER_ID, email: 'stream-route@example.com' }).onConflictDoNothing();
  await db.insert(users).values({ id: OTHER_USER_ID, email: 'stream-other@example.com' }).onConflictDoNothing();
}

async function cleanup() {
  for (const u of [TEST_USER_ID, OTHER_USER_ID]) {
    await db.delete(aiChatMessages).where(eq(aiChatMessages.userId, u));
  }
}

async function placeholder(userId: string, content = ''): Promise<string> {
  const [row] = await db.insert(aiChatMessages).values({
    userId, role: 'assistant', content, toolCalls: [], decisionId: null,
  }).returning();
  return row.id;
}

describe('GET /api/ai-pm/chat/stream/[messageId]', () => {
  beforeAll(async () => { await ensureUsers(); await cleanup(); currentUserId = TEST_USER_ID; });
  afterEach(async () => { await cleanup(); currentUserId = TEST_USER_ID; });

  it('returns 401 when not authenticated', async () => {
    const id = await placeholder(TEST_USER_ID);
    currentUserId = null;
    const res = await GET(new Request(`http://localhost/api/ai-pm/chat/stream/${id}`), { params: { messageId: id } });
    expect(res.status).toBe(401);
  });

  it('returns 404 when message belongs to another user', async () => {
    const id = await placeholder(OTHER_USER_ID);
    const res = await GET(new Request(`http://localhost/api/ai-pm/chat/stream/${id}`), { params: { messageId: id } });
    expect(res.status).toBe(404);
  });

  it('returns 404 for unknown message id', async () => {
    const fakeId = '00000000-0000-0000-0000-0000000000aa';
    const res = await GET(new Request(`http://localhost/api/ai-pm/chat/stream/${fakeId}`), { params: { messageId: fakeId } });
    expect(res.status).toBe(404);
  });

  it('sends synthetic done + closes when content already final', async () => {
    const id = await placeholder(TEST_USER_ID, 'final reply');
    const res = await GET(new Request(`http://localhost/api/ai-pm/chat/stream/${id}`), { params: { messageId: id } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('"type":"done"');
  });

  it('replays chunks newer than Last-Event-ID for finalized rows', async () => {
    const id = await placeholder(TEST_USER_ID, 'abc');
    await db.insert(chatMessageChunks).values([
      { messageId: id, seq: 1, text: 'a' },
      { messageId: id, seq: 2, text: 'b' },
      { messageId: id, seq: 3, text: 'c' },
    ]);
    const res = await GET(
      new Request(`http://localhost/api/ai-pm/chat/stream/${id}`, { headers: { 'Last-Event-ID': '1' } }),
      { params: { messageId: id } },
    );
    const text = await res.text();
    expect(text).toContain('"text":"b"');
    expect(text).toContain('"text":"c"');
    expect(text).not.toContain('"text":"a"');
  });
});
