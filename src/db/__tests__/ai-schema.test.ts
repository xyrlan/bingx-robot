import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/db';
import {
  users, bingxApiKeys, aiPmConfigs, aiDecisions, paperBots,
  aiSignals, backtestRuns, aiChatMessages,
} from '@/db/schema';
import { eq } from 'drizzle-orm';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000010';

async function ensureTestUser() {
  await db.insert(users).values({
    id: TEST_USER_ID,
    email: 'session1-test@example.com',
  }).onConflictDoNothing();
}

async function cleanup() {
  await db.delete(aiChatMessages).where(eq(aiChatMessages.userId, TEST_USER_ID));
  await db.delete(paperBots).where(eq(paperBots.userId, TEST_USER_ID));
  await db.delete(aiDecisions).where(eq(aiDecisions.userId, TEST_USER_ID));
  await db.delete(aiSignals).where(eq(aiSignals.userId, TEST_USER_ID));
  await db.delete(aiPmConfigs).where(eq(aiPmConfigs.userId, TEST_USER_ID));
  await db.delete(bingxApiKeys).where(eq(bingxApiKeys.userId, TEST_USER_ID));
}

describe('AI Portfolio Manager schema', () => {
  beforeAll(async () => {
    await ensureTestUser();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  it('inserts an aiPmConfigs row and reads it back', async () => {
    const [key] = await db.insert(bingxApiKeys).values({
      userId: TEST_USER_ID,
      label: 'AI subaccount',
      apiKey: 'k', secretKeyEncrypted: 'k',
      managedByAi: true,
    }).returning();

    const [cfg] = await db.insert(aiPmConfigs).values({
      userId: TEST_USER_ID,
      bingxApiKeyId: key.id,
      anthropicApiKeyEncrypted: 'enc',
      mode: 'BALANCED',
      maxCapitalUsdt: '500',
      maxDrawdownPct: '5.00',
      maxLeverage: 5,
      allowedSymbols: ['BTC-USDT', 'ETH-USDT'],
      allowedStrategies: ['DCA', 'TRAILING_STOP'],
    }).returning();

    expect(cfg.userId).toBe(TEST_USER_ID);
    expect(cfg.mode).toBe('BALANCED');
    expect(cfg.allowedSymbols).toEqual(['BTC-USDT', 'ETH-USDT']);
    expect(cfg.enabled).toBe(false);
    expect(cfg.killSwitch).toBe(false);
    expect(cfg.paperMode).toBe(false);
  });

  it('inserts an aiDecisions row with all enum values', async () => {
    const [d] = await db.insert(aiDecisions).values({
      userId: TEST_USER_ID,
      triggeredBy: 'CRON_TICK',
      actionType: 'NO_ACTION',
      status: 'PROPOSED',
    }).returning();

    expect(d.triggeredBy).toBe('CRON_TICK');
    expect(d.actionType).toBe('NO_ACTION');
    expect(d.status).toBe('PROPOSED');
  });

  it('inserts an aiSignals row', async () => {
    const [s] = await db.insert(aiSignals).values({
      userId: TEST_USER_ID,
      symbol: 'BTC-USDT',
      regime: 'range',
      score: 75,
      reason: 'RSI 48, ATR low',
      indicatorsSnapshot: { rsi: 48, atr: 120.5 },
    }).returning();

    expect(s.symbol).toBe('BTC-USDT');
    expect(s.score).toBe(75);
  });

  it('inserts a backtestRuns row and enforces dedup uniqueness', async () => {
    const [b] = await db.insert(backtestRuns).values({
      symbol: 'BTC-USDT',
      strategy: 'DCA',
      paramsHash: 'hash-test-1',
      params: { totalOrders: 5 },
      windowDays: 30,
      pnlPct: '2.30',
      maxDrawdownPct: '1.10',
    }).returning();

    expect(b.strategy).toBe('DCA');

    // Inserting the same (symbol, strategy, paramsHash, windowDays) must fail
    await expect(
      db.insert(backtestRuns).values({
        symbol: 'BTC-USDT',
        strategy: 'DCA',
        paramsHash: 'hash-test-1',
        params: { totalOrders: 5 },
        windowDays: 30,
      })
    ).rejects.toThrow();

    await db.delete(backtestRuns).where(eq(backtestRuns.id, b.id));
  });

  it('inserts a paperBots row tied to a decision', async () => {
    const [d] = await db.insert(aiDecisions).values({
      userId: TEST_USER_ID,
      triggeredBy: 'CRON_TICK',
      actionType: 'CREATE_BOT',
      status: 'EXECUTED',
      strategy: 'DCA',
      symbol: 'BTC-USDT',
    }).returning();

    const [pb] = await db.insert(paperBots).values({
      userId: TEST_USER_ID,
      decisionId: d.id,
      symbol: 'BTC-USDT',
      strategy: 'DCA',
      params: { totalOrders: 5 },
      capitalUsdt: '100',
    }).returning();

    expect(pb.decisionId).toBe(d.id);
    expect(pb.status).toBe('STOPPED');
  });

  it('inserts an aiChatMessages row tied to a decision', async () => {
    const [d] = await db.insert(aiDecisions).values({
      userId: TEST_USER_ID,
      triggeredBy: 'CHAT',
      actionType: 'NO_ACTION',
      status: 'PROPOSED',
    }).returning();

    const [m] = await db.insert(aiChatMessages).values({
      userId: TEST_USER_ID,
      decisionId: d.id,
      role: 'assistant',
      content: 'Let me explain why I did that.',
    }).returning();

    expect(m.decisionId).toBe(d.id);
    expect(m.role).toBe('assistant');
  });
});
