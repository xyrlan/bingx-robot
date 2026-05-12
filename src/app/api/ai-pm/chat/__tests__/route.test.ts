import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { db } from '@/db';
import { users, aiChatMessages, aiPmConfigs, bingxApiKeys } from '@/db/schema';
import { eq } from 'drizzle-orm';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000120';
const CONFIG_ID = '00000000-0000-0000-0000-000000000121';
const API_KEY_ID = '00000000-0000-0000-0000-000000000122';

let currentUserId: string | null = TEST_USER_ID;

vi.mock('@/services/auth.service', () => ({
  getAuthenticatedUser: vi.fn(async () => currentUserId ? { id: currentUserId } : null),
}));

const sentEvents: Array<{ name: string; data: unknown }> = [];
vi.mock('@/inngest/client', () => ({
  inngest: { send: vi.fn(async (e: { name: string; data: unknown }) => { sentEvents.push(e); }) },
}));

import { POST } from '../route';

async function ensureUserAndConfig() {
  await db.insert(users).values({ id: TEST_USER_ID, email: 'chat-route-120@example.com' }).onConflictDoNothing();
  await db.insert(bingxApiKeys).values({ id: API_KEY_ID, userId: TEST_USER_ID, label: 'k', apiKey: 'a', secretKeyEncrypted: 'b' }).onConflictDoNothing();
  await db.insert(aiPmConfigs).values({
    id: CONFIG_ID, userId: TEST_USER_ID, bingxApiKeyId: API_KEY_ID,
    anthropicApiKeyEncrypted: 'enc', enabled: true,
  }).onConflictDoNothing();
}

async function cleanup() {
  await db.delete(aiChatMessages).where(eq(aiChatMessages.userId, TEST_USER_ID));
  await db.delete(aiPmConfigs).where(eq(aiPmConfigs.userId, TEST_USER_ID));
}

function req(body: unknown): Request {
  return new Request('http://localhost/api/ai-pm/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/ai-pm/chat', () => {
  beforeAll(async () => {
    await cleanup();
    await ensureUserAndConfig();
    currentUserId = TEST_USER_ID;
    sentEvents.length = 0;
  });
  afterEach(async () => {
    await cleanup();
    await ensureUserAndConfig();
    currentUserId = TEST_USER_ID;
    sentEvents.length = 0;
  });

  it('inserts user row + placeholder assistant row and returns both ids', async () => {
    const res = await POST(req({ configId: CONFIG_ID, message: 'hello' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.chatMessageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.placeholderId).toMatch(/^[0-9a-f-]{36}$/);

    const rows = await db.select().from(aiChatMessages).where(eq(aiChatMessages.userId, TEST_USER_ID));
    expect(rows).toHaveLength(2);
    const user = rows.find((r) => r.id === body.chatMessageId);
    const assistant = rows.find((r) => r.id === body.placeholderId);
    expect(user?.role).toBe('user');
    expect(user?.content).toBe('hello');
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.content).toBe('');
  });

  it('emits ai-pm/event.chat with chatMessageId + assistantPlaceholderId', async () => {
    const res = await POST(req({ configId: CONFIG_ID, message: 'go' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0].name).toBe('ai-pm/event.chat');
    expect((sentEvents[0].data as { chatMessageId: string }).chatMessageId).toBe(body.chatMessageId);
    expect((sentEvents[0].data as { assistantPlaceholderId: string }).assistantPlaceholderId).toBe(body.placeholderId);
  });

  it('returns 401 unauthenticated', async () => {
    currentUserId = null;
    const res = await POST(req({ configId: CONFIG_ID, message: 'x' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 invalid body', async () => {
    const res = await POST(req({ message: 'no configId' }));
    expect(res.status).toBe(400);
  });

  it('returns 404 unknown config', async () => {
    const res = await POST(req({ configId: '00000000-0000-0000-0000-0000000000ff', message: 'x' }));
    expect(res.status).toBe(404);
  });
});
