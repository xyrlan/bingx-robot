import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { db } from '@/db';
import { users, aiChatMessages } from '@/db/schema';
import { eq } from 'drizzle-orm';
import {
  listChatMessages,
  encodeChatCursor,
  decodeChatCursor,
} from '@/services/ai-pm-chat-history.service';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000060';
const OTHER_USER_ID = '00000000-0000-0000-0000-000000000061';

async function ensureUsers() {
  await db.insert(users).values({ id: TEST_USER_ID, email: 'chat-svc@example.com' }).onConflictDoNothing();
  await db.insert(users).values({ id: OTHER_USER_ID, email: 'chat-svc-other@example.com' }).onConflictDoNothing();
}

async function cleanup() {
  await db.delete(aiChatMessages).where(eq(aiChatMessages.userId, TEST_USER_ID));
  await db.delete(aiChatMessages).where(eq(aiChatMessages.userId, OTHER_USER_ID));
}

async function seed(userId: string, count: number, startMs: number) {
  const rows = Array.from({ length: count }, (_, i) => ({
    userId,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `msg-${i}`,
    createdAt: new Date(startMs + i * 1000),
  }));
  await db.insert(aiChatMessages).values(rows);
}

describe('ai-pm-chat-history service', () => {
  beforeAll(async () => {
    await ensureUsers();
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
  });

  it('listChatMessages returns newest-first up to limit', async () => {
    await seed(TEST_USER_ID, 5, Date.now() - 60_000);
    const got = await listChatMessages(TEST_USER_ID, { limit: 3 });
    expect(got.messages).toHaveLength(3);
    expect(got.messages[0].content).toBe('msg-4');
    expect(got.messages[2].content).toBe('msg-2');
    expect(got.nextCursor).not.toBeNull();
  });

  it('listChatMessages returns null cursor when fewer than limit', async () => {
    await seed(TEST_USER_ID, 2, Date.now() - 60_000);
    const got = await listChatMessages(TEST_USER_ID, { limit: 30 });
    expect(got.messages).toHaveLength(2);
    expect(got.nextCursor).toBeNull();
  });

  it('listChatMessages paginates older with cursor', async () => {
    await seed(TEST_USER_ID, 6, Date.now() - 60_000);
    const first = await listChatMessages(TEST_USER_ID, { limit: 3 });
    expect(first.messages.map(m => m.content)).toEqual(['msg-5', 'msg-4', 'msg-3']);
    const cursor = decodeChatCursor(first.nextCursor!);
    const second = await listChatMessages(TEST_USER_ID, { limit: 3, cursor });
    expect(second.messages.map(m => m.content)).toEqual(['msg-2', 'msg-1', 'msg-0']);
    expect(second.nextCursor).toBeNull();
  });

  it('listChatMessages with since returns only newer rows and null cursor', async () => {
    const start = Date.now() - 60_000;
    await seed(TEST_USER_ID, 4, start);
    const cutoff = new Date(start + 1500); // includes msg-2, msg-3
    const got = await listChatMessages(TEST_USER_ID, { limit: 30, since: cutoff });
    expect(got.messages.map(m => m.content).sort()).toEqual(['msg-2', 'msg-3']);
    expect(got.nextCursor).toBeNull();
  });

  it('listChatMessages scopes by userId', async () => {
    await db.insert(aiChatMessages).values([
      { userId: TEST_USER_ID, role: 'user', content: 'me-A', createdAt: new Date(Date.now() - 3000) },
      { userId: TEST_USER_ID, role: 'assistant', content: 'me-B', createdAt: new Date(Date.now() - 2000) },
      { userId: OTHER_USER_ID, role: 'user', content: 'other-A', createdAt: new Date(Date.now() - 3000) },
      { userId: OTHER_USER_ID, role: 'assistant', content: 'other-B', createdAt: new Date(Date.now() - 2000) },
    ]);
    const got = await listChatMessages(TEST_USER_ID, { limit: 30 });
    expect(got.messages).toHaveLength(2);
    const contents = got.messages.map(m => m.content);
    expect(contents.every(c => c.startsWith('me-'))).toBe(true);
    expect(contents.some(c => c.startsWith('other-'))).toBe(false);
  });

  it('encodeChatCursor / decodeChatCursor round-trip', () => {
    const c = { createdAt: new Date('2026-05-12T00:00:00Z'), id: '00000000-0000-0000-0000-0000000000aa' };
    const enc = encodeChatCursor(c);
    const dec = decodeChatCursor(enc);
    expect(dec.id).toBe(c.id);
    expect(dec.createdAt.toISOString()).toBe(c.createdAt.toISOString());
  });

  it('decodeChatCursor throws on bad input', () => {
    expect(() => decodeChatCursor('not-base64-json')).toThrow(/Invalid cursor/);
  });
});
