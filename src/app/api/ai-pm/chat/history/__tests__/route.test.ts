import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { db } from '@/db';
import { users, aiChatMessages } from '@/db/schema';
import { eq } from 'drizzle-orm';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000070';
let currentUserId: string | null = TEST_USER_ID;

vi.mock('@/services/auth.service', () => ({
  requireAuth: vi.fn(() => {
    if (currentUserId === null) {
      throw new Error('Authentication required. User is not logged in.');
    }
    return Promise.resolve({ id: currentUserId });
  }),
}));

import { GET } from '../route';

async function ensureUser() {
  await db.insert(users).values({ id: TEST_USER_ID, email: 'chat-route@example.com' }).onConflictDoNothing();
}

async function cleanup() {
  await db.delete(aiChatMessages).where(eq(aiChatMessages.userId, TEST_USER_ID));
}

function req(qs = ''): Request {
  return new Request(`http://localhost/api/ai-pm/chat/history${qs}`, { method: 'GET' });
}

describe('GET /api/ai-pm/chat/history', () => {
  beforeAll(async () => {
    await ensureUser();
    await cleanup();
    currentUserId = TEST_USER_ID;
  });

  afterEach(async () => {
    await cleanup();
    currentUserId = TEST_USER_ID;
  });

  it('returns 401 when not authenticated', async () => {
    currentUserId = null;
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it('returns messages newest-first', async () => {
    await db.insert(aiChatMessages).values([
      { userId: TEST_USER_ID, role: 'user', content: 'a', createdAt: new Date(Date.now() - 2000) },
      { userId: TEST_USER_ID, role: 'assistant', content: 'b', createdAt: new Date(Date.now() - 1000) },
    ]);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].content).toBe('b');
    expect(body.nextCursor).toBeNull();
  });

  it('returns 400 on invalid limit', async () => {
    const res = await GET(req('?limit=abc'));
    expect(res.status).toBe(400);
  });

  it('returns 400 on invalid cursor', async () => {
    const res = await GET(req('?cursor=garbage'));
    expect(res.status).toBe(400);
  });

  it('returns 400 on invalid since', async () => {
    const res = await GET(req('?since=not-a-date'));
    expect(res.status).toBe(400);
  });

  it('since wins over cursor if both passed', async () => {
    const old = new Date(Date.now() - 10_000);
    const recent = new Date(Date.now() - 1_000);
    await db.insert(aiChatMessages).values([
      { userId: TEST_USER_ID, role: 'user', content: 'old', createdAt: old },
      { userId: TEST_USER_ID, role: 'user', content: 'recent', createdAt: recent },
    ]);
    const cutoff = new Date(Date.now() - 5_000).toISOString();
    const res = await GET(req(`?since=${encodeURIComponent(cutoff)}&cursor=garbage`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content).toBe('recent');
    expect(body.nextCursor).toBeNull();
  });
});
