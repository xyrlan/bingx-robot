import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { db } from '@/db';
import { bingxApiKeys, tradingBots, users } from '@/db/schema';
import { getRunningAiBots } from '@/services/bingx.service';
import { eq } from 'drizzle-orm';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';

async function ensureTestUser() {
  await db.insert(users).values({
    id: TEST_USER_ID,
    email: 'session0-test@example.com',
  }).onConflictDoNothing();
}

async function createKey(label: string, managedByAi: boolean) {
  const [row] = await db.insert(bingxApiKeys).values({
    userId: TEST_USER_ID,
    label,
    apiKey: 'test',
    secretKeyEncrypted: 'test',
    managedByAi,
  }).returning();
  return row;
}

async function createBot(apiKeyId: string, botType: 'DCA' | 'TRAILING_STOP', status: 'RUNNING' | 'STOPPED' = 'RUNNING') {
  const [row] = await db.insert(tradingBots).values({
    userId: TEST_USER_ID,
    apiKeyId,
    symbol: 'BTC-USDT',
    botType,
    priceMin: '50000',
    priceMax: '60000',
    positionSizeUsdt: '10',
    takeProfitPercentage: '1',
    gridCount: 1,
    leverage: 1,
    status,
  }).returning();
  return row;
}

describe('getRunningAiBots', () => {
  beforeAll(async () => {
    await ensureTestUser();
  });

  afterEach(async () => {
    await db.delete(tradingBots).where(eq(tradingBots.userId, TEST_USER_ID));
    await db.delete(bingxApiKeys).where(eq(bingxApiKeys.userId, TEST_USER_ID));
  });

  it('returns only bots whose API key has managed_by_ai = true', async () => {
    const aiKey = await createKey('AI', true);
    const manualKey = await createKey('Manual', false);
    const aiBot = await createBot(aiKey.id, 'DCA');
    await createBot(manualKey.id, 'DCA');

    const result = await getRunningAiBots();

    const ids = result.map(b => b.id);
    expect(ids).toContain(aiBot.id);
    expect(result.every(b => b.apiKeyId === aiKey.id)).toBe(true);
  });

  it('filters by botType when provided', async () => {
    const aiKey = await createKey('AI', true);
    const dcaBot = await createBot(aiKey.id, 'DCA');
    await createBot(aiKey.id, 'TRAILING_STOP');

    const result = await getRunningAiBots('DCA');

    expect(result.length).toBe(1);
    expect(result[0].id).toBe(dcaBot.id);
  });

  it('skips bots that are STOPPED', async () => {
    const aiKey = await createKey('AI', true);
    await createBot(aiKey.id, 'DCA', 'STOPPED');

    const result = await getRunningAiBots('DCA');

    expect(result).toEqual([]);
  });

  it('skips bots whose apiKeyId is null', async () => {
    await db.insert(tradingBots).values({
      userId: TEST_USER_ID,
      apiKeyId: null,
      symbol: 'BTC-USDT',
      botType: 'DCA',
      priceMin: '50000',
      priceMax: '60000',
      positionSizeUsdt: '10',
      takeProfitPercentage: '1',
      gridCount: 1,
      leverage: 1,
      status: 'RUNNING',
    });

    const result = await getRunningAiBots('DCA');

    expect(result).toEqual([]);
  });
});
