import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { db } from '@/db';
import { users, bingxApiKeys, aiPmConfigs } from '@/db/schema';
import { eq } from 'drizzle-orm';

// ────────────────────────────────────────────────────────────────────────────
// Mock auth so tests don't need a real Supabase session.
// Must be at the top level so Vitest hoisting works correctly.
// ────────────────────────────────────────────────────────────────────────────
const TEST_USER_ID = '00000000-0000-0000-0000-000000000030';
const OTHER_USER_ID = '00000000-0000-0000-0000-000000000031';

// Mutable ref swapped per-test to simulate different users or unauthenticated state
let currentUserId: string | null = TEST_USER_ID;

vi.mock('@/services/auth.service', () => ({
  requireAuth: vi.fn(() => {
    if (currentUserId === null) {
      throw new Error('Authentication required. User is not logged in.');
    }
    return Promise.resolve({ id: currentUserId });
  }),
}));

// ────────────────────────────────────────────────────────────────────────────
// Import route handlers (after mocks are registered)
// ────────────────────────────────────────────────────────────────────────────
import { GET, POST } from '../route';
import { PATCH, DELETE } from '../[id]/route';
import { POST as anthropicTestPOST } from '../../anthropic-test/route';
import * as aiPmService from '@/services/ai-pm-config.service';

// ────────────────────────────────────────────────────────────────────────────
// Test DB helpers
// ────────────────────────────────────────────────────────────────────────────
async function ensureUsers() {
  await db.insert(users).values({ id: TEST_USER_ID, email: 'route-test@example.com' }).onConflictDoNothing();
  await db.insert(users).values({ id: OTHER_USER_ID, email: 'route-other@example.com' }).onConflictDoNothing();
}

async function makeKey(userId = TEST_USER_ID, label = 'AI') {
  const [k] = await db.insert(bingxApiKeys).values({
    userId,
    label,
    apiKey: 'k',
    secretKeyEncrypted: 'k',
    managedByAi: true,
  }).returning();
  return k;
}

async function cleanup() {
  await db.delete(aiPmConfigs).where(eq(aiPmConfigs.userId, TEST_USER_ID));
  await db.delete(aiPmConfigs).where(eq(aiPmConfigs.userId, OTHER_USER_ID));
  await db.delete(bingxApiKeys).where(eq(bingxApiKeys.userId, TEST_USER_ID));
  await db.delete(bingxApiKeys).where(eq(bingxApiKeys.userId, OTHER_USER_ID));
}

function makeRequest(method: string, body?: unknown): Request {
  if (body === undefined) return new Request('http://localhost', { method });
  return new Request('http://localhost', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

// ────────────────────────────────────────────────────────────────────────────
// Suite
// ────────────────────────────────────────────────────────────────────────────
describe('GET /api/ai-pm/config', () => {
  beforeAll(async () => {
    await ensureUsers();
    await cleanup();
  });

  afterEach(async () => {
    currentUserId = TEST_USER_ID;
    await cleanup();
  });

  it('returns empty list initially', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json() as { configs: unknown[] };
    expect(body.configs).toEqual([]);
  });

  it('returns 401 when not authenticated', async () => {
    currentUserId = null;
    const res = await GET();
    expect(res.status).toBe(401);
  });
});

describe('POST /api/ai-pm/config', () => {
  beforeAll(async () => {
    await ensureUsers();
    await cleanup();
  });

  afterEach(async () => {
    currentUserId = TEST_USER_ID;
    await cleanup();
  });

  it('returns 400 when bingxApiKeyId is missing', async () => {
    const res = await POST(makeRequest('POST', { anthropicApiKey: 'sk-ant-test' }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/bingxApiKeyId/);
  });

  it('returns 400 when anthropicApiKey is missing', async () => {
    const res = await POST(makeRequest('POST', { bingxApiKeyId: '00000000-0000-0000-0000-000000000099' }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/anthropicApiKey/);
  });

  it('returns 404 when bingxApiKeyId belongs to another user', async () => {
    const otherKey = await makeKey(OTHER_USER_ID, 'other');
    const res = await POST(makeRequest('POST', {
      bingxApiKeyId: otherKey.id,
      anthropicApiKey: 'sk-ant-test',
    }));
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/Subaccount not found/);
  });

  it('creates a config (happy path) and strips key fields', async () => {
    const key = await makeKey();
    const res = await POST(makeRequest('POST', {
      bingxApiKeyId: key.id,
      anthropicApiKey: 'sk-ant-test-create',
      mode: 'CONSERVATIVE',
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { config: Record<string, unknown> };
    expect(body.config).toBeDefined();
    expect(body.config.bingxApiKeyId).toBe(key.id);
    expect(body.config.mode).toBe('CONSERVATIVE');
    expect(body.config.anthropicApiKey).toBeUndefined();
    expect(body.config.anthropicApiKeyEncrypted).toBeUndefined();
  });

  it('returns 409 on duplicate bingxApiKeyId', async () => {
    const key = await makeKey();
    await POST(makeRequest('POST', { bingxApiKeyId: key.id, anthropicApiKey: 'sk-ant-first' }));
    const res = await POST(makeRequest('POST', { bingxApiKeyId: key.id, anthropicApiKey: 'sk-ant-second' }));
    expect(res.status).toBe(409);
  });
});

describe('GET /api/ai-pm/config — after POST', () => {
  beforeAll(async () => {
    await ensureUsers();
    await cleanup();
  });

  afterEach(async () => {
    currentUserId = TEST_USER_ID;
    await cleanup();
  });

  it('returns the created config after POST', async () => {
    const key = await makeKey();
    await POST(makeRequest('POST', { bingxApiKeyId: key.id, anthropicApiKey: 'sk-ant-list' }));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json() as { configs: Array<Record<string, unknown>> };
    expect(body.configs).toHaveLength(1);
    expect(body.configs[0].bingxApiKeyId).toBe(key.id);
    // Should not contain key fields
    expect(body.configs[0].anthropicApiKey).toBeUndefined();
    expect(body.configs[0].anthropicApiKeyEncrypted).toBeUndefined();
  });
});

describe('PATCH /api/ai-pm/config/[id]', () => {
  beforeAll(async () => {
    await ensureUsers();
    await cleanup();
  });

  afterEach(async () => {
    currentUserId = TEST_USER_ID;
    await cleanup();
  });

  it('persists changes (toggle enabled, set mode)', async () => {
    const key = await makeKey();
    const createRes = await POST(makeRequest('POST', { bingxApiKeyId: key.id, anthropicApiKey: 'sk-ant-patch' }));
    const createBody = await createRes.json() as { config: { id: string; enabled: boolean; mode: string } };
    const configId = createBody.config.id;
    expect(createBody.config.enabled).toBe(false);

    const patchRes = await PATCH(
      makeRequest('PATCH', { enabled: true, mode: 'AGGRESSIVE' }),
      makeParams(configId),
    );
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json() as { config: Record<string, unknown> };
    expect(patchBody.config.enabled).toBe(true);
    expect(patchBody.config.mode).toBe('AGGRESSIVE');
    expect(patchBody.config.anthropicApiKey).toBeUndefined();
    expect(patchBody.config.anthropicApiKeyEncrypted).toBeUndefined();
  });

  it('returns 404 when config belongs to another user', async () => {
    // Create config as OTHER user
    const otherKey = await makeKey(OTHER_USER_ID, 'other-for-patch');
    currentUserId = OTHER_USER_ID;
    const createRes = await POST(makeRequest('POST', { bingxApiKeyId: otherKey.id, anthropicApiKey: 'sk-ant-other' }));
    const createBody = await createRes.json() as { config: { id: string } };
    const configId = createBody.config.id;

    // Patch as TEST user
    currentUserId = TEST_USER_ID;
    const patchRes = await PATCH(makeRequest('PATCH', { enabled: true }), makeParams(configId));
    expect(patchRes.status).toBe(404);
  });
});

describe('DELETE /api/ai-pm/config/[id]', () => {
  beforeAll(async () => {
    await ensureUsers();
    await cleanup();
  });

  afterEach(async () => {
    currentUserId = TEST_USER_ID;
    await cleanup();
  });

  it('deletes the config successfully', async () => {
    const key = await makeKey();
    const createRes = await POST(makeRequest('POST', { bingxApiKeyId: key.id, anthropicApiKey: 'sk-ant-del' }));
    const createBody = await createRes.json() as { config: { id: string } };
    const configId = createBody.config.id;

    const delRes = await DELETE(makeRequest('DELETE'), makeParams(configId));
    expect(delRes.status).toBe(200);
    const delBody = await delRes.json() as { ok: boolean };
    expect(delBody.ok).toBe(true);

    // Verify row is gone
    const getRes = await GET();
    const getBody = await getRes.json() as { configs: unknown[] };
    expect(getBody.configs).toHaveLength(0);
  });

  it('returns 404 when config belongs to another user', async () => {
    const otherKey = await makeKey(OTHER_USER_ID, 'other-for-del');
    currentUserId = OTHER_USER_ID;
    const createRes = await POST(makeRequest('POST', { bingxApiKeyId: otherKey.id, anthropicApiKey: 'sk-ant-other-del' }));
    const createBody = await createRes.json() as { config: { id: string } };
    const configId = createBody.config.id;

    // Delete as TEST user
    currentUserId = TEST_USER_ID;
    const delRes = await DELETE(makeRequest('DELETE'), makeParams(configId));
    expect(delRes.status).toBe(404);
  });
});

describe('POST /api/ai-pm/anthropic-test', () => {
  beforeAll(async () => {
    await ensureUsers();
  });

  afterEach(() => {
    currentUserId = TEST_USER_ID;
    vi.restoreAllMocks();
  });

  it('returns 400 when anthropicApiKey is missing', async () => {
    const res = await anthropicTestPOST(makeRequest('POST', {}));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/anthropicApiKey/);
  });

  it('returns ok=true when testAnthropicApiKey succeeds (spy stub)', async () => {
    vi.spyOn(aiPmService, 'testAnthropicApiKey').mockResolvedValueOnce({ ok: true });

    const res = await anthropicTestPOST(makeRequest('POST', { anthropicApiKey: 'sk-ant-stubbed' }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
