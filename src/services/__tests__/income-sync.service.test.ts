import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { db } from '@/db';
import { botIncomeRecords, bingxApiKeys, tradingBots, users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { buildEntryCid, makeNonce } from '@/services/bots/grid-cid';
import type { HistoricalOrderInfo } from '@/services/bingx.service';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000051';

const fakeClient = { get: vi.fn(async () => ({})), post: vi.fn(), delete: vi.fn(), postForm: vi.fn() };

vi.mock('@/services/bingx.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/bingx.service')>();
  return {
    ...actual,
    getBingxClientByApiKeyId: vi.fn(async () => fakeClient),
    getOrderHistory: vi.fn(async () => []),
  };
});

import { getOrderHistory } from '@/services/bingx.service';
import { syncIncomeForApiKey } from '@/services/income-sync.service';

const mocked = {
  getOrderHistory: vi.mocked(getOrderHistory),
};

const NOW = 1780000000000; // fixed "now" for deterministic windows
const HOUR = 3600_000;
const DAY = 24 * HOUR;

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

function order(overrides: Partial<HistoricalOrderInfo>): HistoricalOrderInfo {
  return {
    orderId: 'o-default',
    symbol: 'BTC-USDT',
    type: 'LIMIT',
    side: 'BUY',
    positionSide: 'LONG',
    status: 'FILLED',
    profit: 0,
    commission: 0,
    updateTime: NOW - HOUR,
    ...overrides,
  };
}

describe('income-sync.service', () => {
  beforeAll(async () => { await ensureUser(); });

  afterEach(async () => {
    await db.delete(bingxApiKeys).where(eq(bingxApiKeys.userId, TEST_USER_ID));
    await db.delete(tradingBots).where(eq(tradingBots.userId, TEST_USER_ID));
    vi.clearAllMocks();
  });

  it('attributes orders via CID, and CID-less TPs via shared positionId', async () => {
    const key = await makeApiKey();
    const botA = await makeBot(key.id);
    const botB = await makeBot(key.id); // same symbol — CID keeps attribution exact
    const nonce = makeNonce(NOW);

    mocked.getOrderHistory.mockResolvedValue([
      // botA entry: carries CID, zero profit, a fee, opens position p1
      order({
        orderId: 'e1',
        clientOrderId: buildEntryCid(botA.id, 'aaaaaaaa-0000-4000-8000-000000000000', nonce),
        commission: -0.01,
        positionId: 'p1',
        updateTime: NOW - 2 * HOUR,
      }),
      // exchange-created TP for p1: NO CID — must inherit botA via positionId
      order({
        orderId: 'tp1',
        type: 'TAKE_PROFIT_MARKET',
        side: 'SELL',
        clientOrderId: '',
        profit: 5.5,
        commission: -0.02,
        positionId: 'p1',
        updateTime: NOW - HOUR,
      }),
      // botB entry with CID
      order({
        orderId: 'e2',
        clientOrderId: buildEntryCid(botB.id, 'bbbbbbbb-0000-4000-8000-000000000000', nonce),
        commission: -0.015,
        positionId: 'p2',
        updateTime: NOW - HOUR,
      }),
      // manual order: no CID, unknown position — recorded unattributed
      order({ orderId: 'm1', profit: -1, positionId: 'p9', updateTime: NOW - HOUR }),
      // not filled — ignored entirely
      order({ orderId: 'n1', status: 'NEW', profit: 9, commission: -9 }),
    ]);

    await syncIncomeForApiKey(key.id, { now: NOW, lookbackDays: 1 });

    const rows = await db.query.botIncomeRecords.findMany({ where: eq(botIncomeRecords.apiKeyId, key.id) });
    const byOrder = (o: string) => rows.filter((r) => r.orderId === o);

    expect(byOrder('e1')).toHaveLength(1);
    expect(byOrder('e1')[0]).toMatchObject({ incomeType: 'FEE', botId: botA.id });

    expect(byOrder('tp1').map((r) => [r.incomeType, r.botId, Number(r.amount)]).sort()).toEqual([
      ['FEE', botA.id, -0.02],
      ['REALIZED_PNL', botA.id, 5.5],
    ]);

    expect(byOrder('e2')[0]).toMatchObject({ incomeType: 'FEE', botId: botB.id });

    expect(byOrder('m1')).toHaveLength(1);
    expect(byOrder('m1')[0]).toMatchObject({ incomeType: 'REALIZED_PNL', botId: null });

    expect(byOrder('n1')).toHaveLength(0);
  });

  it('is idempotent across repeated syncs', async () => {
    const key = await makeApiKey();
    await makeBot(key.id);
    mocked.getOrderHistory.mockResolvedValue([
      order({ orderId: 'o1', profit: 2, commission: -0.01 }),
    ]);

    await syncIncomeForApiKey(key.id, { now: NOW, lookbackDays: 1 });
    await syncIncomeForApiKey(key.id, { now: NOW, lookbackDays: 1 });

    const rows = await db.query.botIncomeRecords.findMany({ where: eq(botIncomeRecords.apiKeyId, key.id) });
    expect(rows).toHaveLength(2); // 1 pnl + 1 fee, not doubled
  });

  it('resumes from the stored cursor instead of the full lookback', async () => {
    const key = await makeApiKey();
    await makeBot(key.id);
    mocked.getOrderHistory.mockResolvedValue([
      order({ orderId: 'o1', profit: 1, updateTime: NOW - 2 * HOUR }),
    ]);
    await syncIncomeForApiKey(key.id, { now: NOW, lookbackDays: 30 });

    mocked.getOrderHistory.mockClear();
    mocked.getOrderHistory.mockResolvedValue([]);
    await syncIncomeForApiKey(key.id, { now: NOW, lookbackDays: 30 });

    // Every call (context lookback included) starts far after the 30d horizon.
    for (const call of mocked.getOrderHistory.mock.calls) {
      const startTime = call[2] as number;
      expect(startTime).toBeGreaterThan(NOW - 30 * DAY + HOUR);
      expect(startTime).toBeLessThanOrEqual(NOW - HOUR);
    }
  });

  it('only queries symbols the key bots trade', async () => {
    const key = await makeApiKey();
    await makeBot(key.id, 'BTC-USDT');
    mocked.getOrderHistory.mockResolvedValue([]);

    await syncIncomeForApiKey(key.id, { now: NOW, lookbackDays: 1 });

    expect(mocked.getOrderHistory.mock.calls.length).toBeGreaterThan(0);
    for (const call of mocked.getOrderHistory.mock.calls) {
      expect(call[1]).toBe('BTC-USDT');
    }
  });

  it('splits long lookbacks into windows under the 7-day API limit', async () => {
    const key = await makeApiKey();
    await makeBot(key.id);
    mocked.getOrderHistory.mockResolvedValue([]);

    await syncIncomeForApiKey(key.id, { now: NOW, lookbackDays: 30 });

    expect(mocked.getOrderHistory.mock.calls.length).toBeGreaterThanOrEqual(5);
    for (const call of mocked.getOrderHistory.mock.calls) {
      const startTime = call[2] as number;
      const endTime = call[3] as number;
      expect(endTime - startTime).toBeLessThanOrEqual(7 * DAY);
    }
  });

  it('carries positionId attribution across windows within one run', async () => {
    const key = await makeApiKey();
    const bot = await makeBot(key.id);
    const nonce = makeNonce(NOW);
    const entryTime = NOW - 10 * DAY;
    const tpTime = NOW - 2 * DAY;

    // Entry lands in an earlier window than its TP.
    mocked.getOrderHistory.mockImplementation(async (_c, _s, startTime, endTime) => {
      const inWindow = (t: number) => t >= (startTime as number) && t <= (endTime as number);
      const out: HistoricalOrderInfo[] = [];
      if (inWindow(entryTime)) {
        out.push(order({
          orderId: 'e1',
          clientOrderId: buildEntryCid(bot.id, 'aaaaaaaa-0000-4000-8000-000000000000', nonce),
          commission: -0.01,
          positionId: 'p1',
          updateTime: entryTime,
        }));
      }
      if (inWindow(tpTime)) {
        out.push(order({
          orderId: 'tp1', type: 'TAKE_PROFIT_MARKET', side: 'SELL', clientOrderId: '',
          profit: 3, commission: -0.02, positionId: 'p1', updateTime: tpTime,
        }));
      }
      return out;
    });

    await syncIncomeForApiKey(key.id, { now: NOW, lookbackDays: 30 });

    const rows = await db.query.botIncomeRecords.findMany({ where: eq(botIncomeRecords.apiKeyId, key.id) });
    const tpPnl = rows.find((r) => r.orderId === 'tp1' && r.incomeType === 'REALIZED_PNL');
    expect(tpPnl?.botId).toBe(bot.id);
  });
});
