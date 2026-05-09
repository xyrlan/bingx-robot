import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { db } from '@/db';
import { bingxApiKeys, tradingBots, users } from '@/db/schema';
import { getRunningBotsByIds } from '@/services/bingx.service';
import { eq } from 'drizzle-orm';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000002';

async function ensureUser() {
  await db.insert(users).values({
    id: TEST_USER_ID,
    email: 'session05-test@example.com',
  }).onConflictDoNothing();
}

async function makeKey() {
  const [row] = await db.insert(bingxApiKeys).values({
    userId: TEST_USER_ID,
    label: 'TestKey',
    apiKey: 't',
    secretKeyEncrypted: 't',
    managedByAi: false,
  }).returning();
  return row;
}

async function makeBot(apiKeyId: string, status: 'RUNNING' | 'STOPPED') {
  const [row] = await db.insert(tradingBots).values({
    userId: TEST_USER_ID,
    apiKeyId,
    symbol: 'BTC-USDT',
    botType: 'DCA',
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

describe('getRunningBotsByIds', () => {
  beforeAll(async () => { await ensureUser(); });

  afterEach(async () => {
    await db.delete(tradingBots).where(eq(tradingBots.userId, TEST_USER_ID));
    await db.delete(bingxApiKeys).where(eq(bingxApiKeys.userId, TEST_USER_ID));
  });

  it('returns running bots whose ids match', async () => {
    const key = await makeKey();
    const a = await makeBot(key.id, 'RUNNING');
    const b = await makeBot(key.id, 'RUNNING');
    const c = await makeBot(key.id, 'STOPPED');

    const result = await getRunningBotsByIds([a.id, b.id, c.id]);

    const ids = result.map(r => r.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });

  it('returns empty array on empty input', async () => {
    const result = await getRunningBotsByIds([]);
    expect(result).toEqual([]);
  });

  it('skips ids not present', async () => {
    const result = await getRunningBotsByIds(['00000000-0000-0000-0000-000000000999']);
    expect(result).toEqual([]);
  });
});
