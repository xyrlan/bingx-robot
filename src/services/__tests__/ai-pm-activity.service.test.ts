import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { db } from '@/db';
import { users, aiSignals, aiDecisions, paperBots, bingxApiKeys } from '@/db/schema';
import { eq } from 'drizzle-orm';
import {
  listLatestSignals,
  listActivePaperBots,
  getTodaySpendSummary,
  getLastTickAt,
} from '@/services/ai-pm-activity.service';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000040';

async function ensureUser() {
  await db.insert(users).values({
    id: TEST_USER_ID,
    email: 'activity-test@example.com',
  }).onConflictDoNothing();
}

async function cleanup() {
  await db.delete(aiSignals).where(eq(aiSignals.userId, TEST_USER_ID));
  await db.delete(paperBots).where(eq(paperBots.userId, TEST_USER_ID));
  await db.delete(aiDecisions).where(eq(aiDecisions.userId, TEST_USER_ID));
  await db.delete(bingxApiKeys).where(eq(bingxApiKeys.userId, TEST_USER_ID));
}

describe('ai-pm-activity service', () => {
  beforeAll(async () => {
    await ensureUser();
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
  });

  it('listLatestSignals returns most recent 10 ordered DESC', async () => {
    const now = Date.now();
    const rows = Array.from({ length: 12 }, (_, i) => ({
      userId: TEST_USER_ID,
      symbol: `SYM${i}-USDT`,
      regime: 'TRENDING',
      score: 70 + i,
      reason: `r${i}`,
      createdAt: new Date(now - (12 - i) * 1000),
    }));
    await db.insert(aiSignals).values(rows);

    const got = await listLatestSignals(TEST_USER_ID);

    expect(got).toHaveLength(10);
    // Newest first
    expect(got[0].symbol).toBe('SYM11-USDT');
    expect(got[9].symbol).toBe('SYM2-USDT');
  });

  it('listActivePaperBots returns only RUNNING bots ordered DESC by createdAt', async () => {
    const [running] = await db.insert(paperBots).values({
      userId: TEST_USER_ID,
      symbol: 'BTC-USDT',
      strategy: 'GRID_LONG',
      params: {},
      capitalUsdt: '100',
      status: 'RUNNING',
      pnlUsdt: '12.5',
      trades: [{ t: 1 }, { t: 2 }, { t: 3 }],
      startedAt: new Date(),
    }).returning();

    await db.insert(paperBots).values({
      userId: TEST_USER_ID,
      symbol: 'ETH-USDT',
      strategy: 'GRID_LONG',
      params: {},
      capitalUsdt: '100',
      status: 'STOPPED',
      pnlUsdt: '0',
      trades: [],
    });

    const got = await listActivePaperBots(TEST_USER_ID);

    expect(got).toHaveLength(1);
    expect(got[0].id).toBe(running.id);
    expect(got[0].tradesCount).toBe(3);
    expect(got[0].status).toBe('RUNNING');
  });

  it('getTodaySpendSummary returns zeros when no decisions today', async () => {
    const got = await getTodaySpendSummary(TEST_USER_ID);
    expect(got.decisionsToday).toBe(0);
    expect(got.tokensInputToday).toBe(0);
    expect(got.tokensOutputToday).toBe(0);
    expect(got.costUsdToday).toBe('0.000000');
  });

  it('getTodaySpendSummary sums only rows from today', async () => {
    const today = new Date();
    const todayMidnight = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const yesterday = new Date(todayMidnight.getTime() - 1000);

    await db.insert(aiDecisions).values([
      {
        userId: TEST_USER_ID,
        triggeredBy: 'CRON_TICK',
        actionType: 'CREATE_BOT',
        status: 'EXECUTED',
        tokensInput: 100,
        tokensOutput: 50,
        costUsd: '0.005',
        createdAt: new Date(),
      },
      {
        userId: TEST_USER_ID,
        triggeredBy: 'CRON_TICK',
        actionType: 'NO_ACTION',
        status: 'EXECUTED',
        tokensInput: 200,
        tokensOutput: 100,
        costUsd: '0.010',
        createdAt: new Date(),
      },
      {
        userId: TEST_USER_ID,
        triggeredBy: 'CRON_TICK',
        actionType: 'NO_ACTION',
        status: 'EXECUTED',
        tokensInput: 999,
        tokensOutput: 999,
        costUsd: '99.99',
        createdAt: yesterday,
      },
    ]);

    const got = await getTodaySpendSummary(TEST_USER_ID);

    expect(got.decisionsToday).toBe(2);
    expect(got.tokensInputToday).toBe(300);
    expect(got.tokensOutputToday).toBe(150);
    expect(got.costUsdToday).toBe('0.015000');
  });

  it('getLastTickAt returns the newest createdAt or null', async () => {
    expect(await getLastTickAt(TEST_USER_ID)).toBeNull();

    const ts = new Date('2026-05-11T10:00:00Z');
    await db.insert(aiDecisions).values({
      userId: TEST_USER_ID,
      triggeredBy: 'CRON_TICK',
      actionType: 'NO_ACTION',
      status: 'EXECUTED',
      createdAt: ts,
    });

    const got = await getLastTickAt(TEST_USER_ID);
    expect(got).toBe(ts.toISOString());
  });
});
