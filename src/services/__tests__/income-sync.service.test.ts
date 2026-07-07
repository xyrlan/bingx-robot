import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { db } from '@/db';
import { botIncomeRecords, bingxApiKeys, tradingBots, users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { buildEntryCid, buildTpCid, makeNonce } from '@/services/bots/grid-cid';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000051';

const fakeClient = { get: vi.fn(async () => ({})), post: vi.fn(), delete: vi.fn(), postForm: vi.fn() };

vi.mock('@/services/bingx.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/bingx.service')>();
  return {
    ...actual,
    getBingxClientByApiKeyId: vi.fn(async () => fakeClient),
    getOrderHistory: vi.fn(async () => []),
    getFillHistory: vi.fn(async () => []),
  };
});

import { getOrderHistory, getFillHistory } from '@/services/bingx.service';
import { syncIncomeForApiKey } from '@/services/income-sync.service';

const mocked = {
  getOrderHistory: vi.mocked(getOrderHistory),
  getFillHistory: vi.mocked(getFillHistory),
};

const NOW = 1780000000000; // fixed "now" for deterministic windows
const HOUR = 3600_000;

async function ensureUser() {
  await db.insert(users).values({
    id: TEST_USER_ID,
    email: 'income-sync-test@example.com',
  }).onConflictDoNothing();
}

async function makeApiKey() {
  const [row] = await db.insert(bingxApiKeys).values({
    userId: TEST_USER_ID,
    label: 'test',
    apiKey: 'k',
    secretKeyEncrypted: 's',
  }).returning();
  return row;
}

async function makeBot(apiKeyId: string, symbol = 'BTC-USDT') {
  const [row] = await db.insert(tradingBots).values({
    userId: TEST_USER_ID,
    apiKeyId,
    symbol,
    botType: 'GRID_LONG',
    priceMin: '50000',
    priceMax: '60000',
    positionSizeUsdt: '10',
    takeProfitPercentage: '1',
    gridCount: 5,
    leverage: 1,
    status: 'RUNNING',
  }).returning();
  return row;
}

describe('income-sync.service', () => {
  beforeAll(async () => { await ensureUser(); });

  afterEach(async () => {
    await db.delete(bingxApiKeys).where(eq(bingxApiKeys.userId, TEST_USER_ID));
    await db.delete(tradingBots).where(eq(tradingBots.userId, TEST_USER_ID));
    vi.clearAllMocks();
  });

  it('attributes fills to bots via entry/TP CID even with two bots on the same symbol', async () => {
    const key = await makeApiKey();
    const botA = await makeBot(key.id);
    const botB = await makeBot(key.id); // same symbol — income endpoint could never split these
    const nonce = makeNonce(NOW);

    mocked.getOrderHistory.mockResolvedValue([
      { orderId: 'o1', clientOrderId: buildTpCid(botA.id, 'aaaaaaaa-0000-4000-8000-000000000000', nonce) },
      { orderId: 'o2', clientOrderId: buildEntryCid(botB.id, 'bbbbbbbb-0000-4000-8000-000000000000', nonce) },
    ]);
    mocked.getFillHistory.mockResolvedValue([
      { tradeId: 't1', orderId: 'o1', symbol: 'BTC-USDT', realizedPnl: 5.5, fee: -0.02, time: NOW - HOUR },
      { tradeId: 't2', orderId: 'o2', symbol: 'BTC-USDT', realizedPnl: 0, fee: -0.01, time: NOW - HOUR },
      { tradeId: 't3', orderId: 'o3', symbol: 'BTC-USDT', realizedPnl: -1, fee: 0, time: NOW - HOUR },
    ]);

    await syncIncomeForApiKey(key.id, { now: NOW, lookbackDays: 1 });

    const rows = await db.query.botIncomeRecords.findMany({ where: eq(botIncomeRecords.apiKeyId, key.id) });
    const byTrade = (t: string) => rows.filter((r) => r.tradeId === t);

    // TP fill of botA: pnl + fee rows, both attributed
    expect(byTrade('t1').map((r) => [r.incomeType, r.botId, Number(r.amount)]).sort()).toEqual([
      ['FEE', botA.id, -0.02],
      ['REALIZED_PNL', botA.id, 5.5],
    ]);
    // Entry fill of botB: zero pnl skipped, fee attributed
    expect(byTrade('t2')).toHaveLength(1);
    expect(byTrade('t2')[0]).toMatchObject({ incomeType: 'FEE', botId: botB.id });
    // Manual fill: recorded but unattributed
    expect(byTrade('t3')).toHaveLength(1);
    expect(byTrade('t3')[0]).toMatchObject({ incomeType: 'REALIZED_PNL', botId: null });
  });

  it('is idempotent across repeated syncs', async () => {
    const key = await makeApiKey();
    await makeBot(key.id);
    mocked.getFillHistory.mockResolvedValue([
      { tradeId: 't1', orderId: 'o1', symbol: 'BTC-USDT', realizedPnl: 2, fee: -0.01, time: NOW - HOUR },
    ]);

    await syncIncomeForApiKey(key.id, { now: NOW, lookbackDays: 1 });
    await syncIncomeForApiKey(key.id, { now: NOW, lookbackDays: 1 });

    const rows = await db.query.botIncomeRecords.findMany({ where: eq(botIncomeRecords.apiKeyId, key.id) });
    expect(rows).toHaveLength(2); // 1 pnl + 1 fee, not doubled
  });

  it('resumes from the stored cursor instead of the full lookback', async () => {
    const key = await makeApiKey();
    await makeBot(key.id);
    mocked.getFillHistory.mockResolvedValue([
      { tradeId: 't1', orderId: 'o1', symbol: 'BTC-USDT', realizedPnl: 1, fee: 0, time: NOW - 2 * HOUR },
    ]);
    await syncIncomeForApiKey(key.id, { now: NOW, lookbackDays: 30 });

    mocked.getFillHistory.mockClear();
    mocked.getFillHistory.mockResolvedValue([]);
    await syncIncomeForApiKey(key.id, { now: NOW, lookbackDays: 30 });

    const firstCallStart = mocked.getFillHistory.mock.calls[0][1] as number;
    // Cursor = last income time minus a safety overlap — far after the 30d lookback.
    expect(firstCallStart).toBeGreaterThan(NOW - 30 * 24 * HOUR + HOUR);
    expect(firstCallStart).toBeLessThanOrEqual(NOW - HOUR);
  });

  it('ignores fills for symbols none of the key bots trade', async () => {
    const key = await makeApiKey();
    await makeBot(key.id, 'BTC-USDT');
    mocked.getFillHistory.mockResolvedValue([
      { tradeId: 't1', orderId: 'o1', symbol: 'DOGE-USDT', realizedPnl: 9, fee: -1, time: NOW - HOUR },
    ]);

    await syncIncomeForApiKey(key.id, { now: NOW, lookbackDays: 1 });

    const rows = await db.query.botIncomeRecords.findMany({ where: eq(botIncomeRecords.apiKeyId, key.id) });
    expect(rows).toHaveLength(0);
  });

  it('splits long lookbacks into windows under the 7-day API limit', async () => {
    const key = await makeApiKey();
    await makeBot(key.id);
    mocked.getFillHistory.mockResolvedValue([]);

    await syncIncomeForApiKey(key.id, { now: NOW, lookbackDays: 30 });

    expect(mocked.getFillHistory.mock.calls.length).toBeGreaterThanOrEqual(5);
    for (const call of mocked.getFillHistory.mock.calls) {
      const [, startTs, endTs] = call as unknown as [unknown, number, number];
      expect(endTs - startTs).toBeLessThanOrEqual(7 * 24 * HOUR);
    }
  });
});
