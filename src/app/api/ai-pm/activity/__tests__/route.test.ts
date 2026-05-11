import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { db } from '@/db';
import { users, aiDecisions, aiSignals, paperBots } from '@/db/schema';
import { eq } from 'drizzle-orm';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000050';
const OTHER_USER_ID = '00000000-0000-0000-0000-000000000051';

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

async function ensureUsers() {
  await db.insert(users).values({ id: TEST_USER_ID, email: 'activity-route@example.com' }).onConflictDoNothing();
  await db.insert(users).values({ id: OTHER_USER_ID, email: 'activity-other@example.com' }).onConflictDoNothing();
}

async function cleanup() {
  for (const uid of [TEST_USER_ID, OTHER_USER_ID]) {
    await db.delete(aiSignals).where(eq(aiSignals.userId, uid));
    await db.delete(paperBots).where(eq(paperBots.userId, uid));
    await db.delete(aiDecisions).where(eq(aiDecisions.userId, uid));
  }
}

function req(url = 'http://localhost/api/ai-pm/activity'): Request {
  return new Request(url, { method: 'GET' });
}

describe('GET /api/ai-pm/activity', () => {
  beforeAll(async () => {
    await ensureUsers();
    await cleanup();
    currentUserId = TEST_USER_ID;
  });

  afterEach(async () => {
    await cleanup();
    currentUserId = TEST_USER_ID;
  });

  it('returns combined payload shape', async () => {
    await db.insert(aiDecisions).values({
      userId: TEST_USER_ID,
      triggeredBy: 'CRON_TICK',
      actionType: 'CREATE_BOT',
      status: 'EXECUTED',
      symbol: 'BTC-USDT',
      tokensInput: 100,
      tokensOutput: 50,
      costUsd: '0.005',
    });

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(Array.isArray(body.decisions)).toBe(true);
    expect(body.decisions).toHaveLength(1);
    expect(Array.isArray(body.signals)).toBe(true);
    expect(Array.isArray(body.paperBots)).toBe(true);
    expect(body.summary).toBeDefined();
    expect(typeof body.summary.decisionsToday).toBe('number');
    expect(body.summary.tokensInputToday).toBe(100);
    expect(body.lastTickAt).not.toBeNull();
  });

  it('returns 401 when unauthenticated', async () => {
    currentUserId = null;
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it('returns 400 on invalid cursor', async () => {
    const res = await GET(req('http://localhost/api/ai-pm/activity?cursor=not-base64-json'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/cursor/i);
  });

  it('returns 400 on invalid status value', async () => {
    const res = await GET(req('http://localhost/api/ai-pm/activity?status=BOGUS'));
    expect(res.status).toBe(400);
  });

  it('returns 400 on limit out of range', async () => {
    const res = await GET(req('http://localhost/api/ai-pm/activity?limit=999'));
    expect(res.status).toBe(400);
  });

  it('isolates rows by user id', async () => {
    await db.insert(aiDecisions).values({
      userId: OTHER_USER_ID,
      triggeredBy: 'CRON_TICK',
      actionType: 'NO_ACTION',
      status: 'EXECUTED',
      symbol: 'ETH-USDT',
    });

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decisions).toHaveLength(0);
  });

  it('passes status filter through to service', async () => {
    await db.insert(aiDecisions).values([
      { userId: TEST_USER_ID, triggeredBy: 'CRON_TICK', actionType: 'CREATE_BOT', status: 'EXECUTED' },
      { userId: TEST_USER_ID, triggeredBy: 'CRON_TICK', actionType: 'CREATE_BOT', status: 'REJECTED_GUARDRAIL' },
    ]);

    const res = await GET(req('http://localhost/api/ai-pm/activity?status=EXECUTED'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decisions.every((d: { status: string }) => d.status === 'EXECUTED')).toBe(true);
  });
});
