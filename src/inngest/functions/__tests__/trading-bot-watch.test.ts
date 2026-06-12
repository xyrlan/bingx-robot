import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { db } from '@/db';
import { botTrades, gridLevels, tradingBots, users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { buildEntryCid, entryCidBotPrefix, makeNonce } from '@/services/bots/grid-cid';
import type { OpenOrderInfo } from '@/services/bingx.service';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000032';

// Exchange-facing functions are mocked; everything DB-backed stays real.
const fakeClient = { get: vi.fn(async () => ({})), post: vi.fn(), delete: vi.fn(), postForm: vi.fn() };

vi.mock('@/services/bingx.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/bingx.service')>();
  return {
    ...actual,
    getBingxClient: vi.fn(async () => fakeClient),
    getBingxClientByApiKeyId: vi.fn(async () => fakeClient),
    getContractInfo: vi.fn(),
    getCurrentPrice: vi.fn(),
    getOpenPositions: vi.fn(),
    getOpenOrders: vi.fn(),
    placeBatchOrders: vi.fn(),
    cancelBatchOrders: vi.fn(),
    updateGridLevelById: vi.fn(actual.updateGridLevelById),
  };
});

import {
  getContractInfo,
  getCurrentPrice,
  getOpenPositions,
  getOpenOrders,
  placeBatchOrders,
  cancelBatchOrders,
  updateGridLevelById,
} from '@/services/bingx.service';

const mocked = {
  getContractInfo: vi.mocked(getContractInfo),
  getCurrentPrice: vi.mocked(getCurrentPrice),
  getOpenPositions: vi.mocked(getOpenPositions),
  getOpenOrders: vi.mocked(getOpenOrders),
  placeBatchOrders: vi.mocked(placeBatchOrders),
  cancelBatchOrders: vi.mocked(cancelBatchOrders),
  updateGridLevelById: vi.mocked(updateGridLevelById),
};

async function ensureUser() {
  await db.insert(users).values({
    id: TEST_USER_ID,
    email: 'trading-bot-watch-test@example.com',
  }).onConflictDoNothing();
}

async function makeBot(overrides: Partial<typeof tradingBots.$inferInsert> = {}) {
  const [row] = await db.insert(tradingBots).values({
    userId: TEST_USER_ID,
    symbol: 'BTC-USDT',
    botType: 'GRID_LONG',
    priceMin: '64999.123456',
    priceMax: '65999.123456',
    positionSizeUsdt: '10',
    takeProfitPercentage: '1',
    gridCount: 2,
    leverage: 1,
    status: 'RUNNING',
    ...overrides,
  }).returning();
  return row;
}

/** Emulates Inngest step memoization: completed steps return cached results on retry. */
function makeMemoStep(onStepDone?: (id: string) => Promise<void>) {
  const memo = new Map<string, unknown>();
  return {
    memo,
    step: {
      run: async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
        if (memo.has(id)) return memo.get(id) as T;
        const v = await fn();
        memo.set(id, v);
        if (onStepDone) await onStepDone(id);
        return v;
      },
    },
  };
}

const fakeLogger = { info: () => {}, warn: () => {}, error: () => {} };

type Handler = (ctx: { step: unknown; logger: unknown; event: { data: unknown } }) => Promise<unknown>;

async function runWatch(botId: string, step: unknown) {
  const { tradingBotWatch } = await import('@/inngest/functions/trading-bot-watch');
  const handler = (tradingBotWatch as unknown as { fn: Handler }).fn;
  return handler({ step, logger: fakeLogger, event: { data: { botIds: [botId] } } });
}

function defaultMocks() {
  mocked.getContractInfo.mockResolvedValue({
    pricePrecision: 1,
    quantityPrecision: 4,
    tradeMinQuantity: 0.0001,
    tradeMinUSDT: 2,
  });
  mocked.getCurrentPrice.mockResolvedValue(65500);
  mocked.getOpenPositions.mockResolvedValue([]);
  mocked.getOpenOrders.mockResolvedValue([]);
  mocked.cancelBatchOrders.mockResolvedValue(undefined);
  mocked.placeBatchOrders.mockImplementation(async (_client, orders) =>
    orders.map((o, i) => ({
      orderId: String(9000 + i),
      clientOrderId: typeof o.clientOrderID === 'string' ? o.clientOrderID : undefined,
    }))
  );
}

describe('tradingBotWatch idempotent placement', () => {
  beforeAll(async () => { await ensureUser(); });

  afterEach(async () => {
    await db.delete(tradingBots).where(eq(tradingBots.userId, TEST_USER_ID));
    vi.clearAllMocks();
    const { updateGridLevelById: realUpdate } = await vi.importActual<typeof import('@/services/bingx.service')>('@/services/bingx.service');
    mocked.updateGridLevelById.mockImplementation(realUpdate);
  });

  it('step retry adopts already-placed orders instead of re-placing (duplicate-order repro)', async () => {
    defaultMocks();
    const bot = await makeBot();

    // First attempt: orders hit the exchange, then the orderId write-back blows up.
    mocked.updateGridLevelById.mockRejectedValueOnce(new Error('db connection lost'));

    const { step, memo } = makeMemoStep();
    await expect(runWatch(bot.id, step)).rejects.toThrow('db connection lost');
    expect(mocked.placeBatchOrders).toHaveBeenCalledTimes(1);

    // The orders from the failed attempt are now live on the exchange, echoing our CIDs.
    const placedPayloads = mocked.placeBatchOrders.mock.calls[0][1];
    const liveOrders: OpenOrderInfo[] = placedPayloads.map((p, i) => ({
      orderId: String(9000 + i),
      type: String(p.type),
      side: 'BUY',
      positionSide: 'LONG',
      price: p.price as number,
      stopPrice: p.stopPrice as number | undefined,
      clientOrderId: String(p.clientOrderID),
    }));
    mocked.getOpenOrders.mockResolvedValue(liveOrders);

    // Retry with memoized prior steps (Inngest semantics).
    await runWatch(bot.id, step);

    // Old code re-placed the whole batch here -> stacked duplicates.
    expect(mocked.placeBatchOrders).toHaveBeenCalledTimes(1);

    // The retry adopted the live orders into the levels instead.
    const levels = await db.query.gridLevels.findMany({ where: eq(gridLevels.botId, bot.id) });
    expect(levels.map((l) => l.orderId).sort()).toEqual(['9000', '9001']);
  });

  it('recognizes its own CID-less order at the tick-rounded price (no duplicate)', async () => {
    defaultMocks();
    const bot = await makeBot();
    // Order placed at toPrecision(64999.123456, 1) = 64999.1 — the old absolute
    // 0.0001 tolerance never matched it against the unrounded level.
    mocked.getOpenOrders.mockResolvedValue([
      { orderId: '500', type: 'LIMIT', side: 'BUY', positionSide: 'LONG', price: 64999.1 },
    ]);

    const { step } = makeMemoStep();
    await runWatch(bot.id, step);

    // Only the upper level (no order yet) gets placed.
    expect(mocked.placeBatchOrders).toHaveBeenCalledTimes(1);
    const payloads = mocked.placeBatchOrders.mock.calls[0][1];
    expect(payloads).toHaveLength(1);
    expect(payloads[0].type).toBe('TRIGGER_LIMIT');

    const levels = await db.query.gridLevels.findMany({ where: eq(gridLevels.botId, bot.id) });
    const lower = levels.find((l) => Number(l.priceLevel) < 65500);
    expect(lower?.orderId).toBe('500'); // adopted
  });

  it('cancels post-edit ghost orders whose CID points at a dead level', async () => {
    defaultMocks();
    const bot = await makeBot();
    const ghostCid = buildEntryCid(bot.id, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeffff0000', makeNonce(1700000000000));
    mocked.getOpenOrders.mockResolvedValue([
      { orderId: '777', type: 'LIMIT', side: 'BUY', positionSide: 'LONG', price: 50000.0, clientOrderId: ghostCid },
    ]);

    const { step } = makeMemoStep();
    await runWatch(bot.id, step);

    expect(mocked.cancelBatchOrders).toHaveBeenCalledWith(expect.anything(), 'BTC-USDT', ['777']);
  });

  it('drains a duplicate stack at one level, keeping the tracked order', async () => {
    defaultMocks();
    const bot = await makeBot();
    const { createGridLevels } = await vi.importActual<typeof import('@/services/bingx.service')>('@/services/bingx.service');
    const levels = await createGridLevels(bot.id, bot.priceMin, bot.priceMax, bot.gridCount);
    const lower = levels.find((l) => Number(l.priceLevel) < 65500)!;
    await db.update(gridLevels).set({ orderId: '111' }).where(eq(gridLevels.id, lower.id));

    mocked.getOpenOrders.mockResolvedValue([
      { orderId: '111', type: 'LIMIT', side: 'BUY', positionSide: 'LONG', price: 64999.1 },
      { orderId: '222', type: 'LIMIT', side: 'BUY', positionSide: 'LONG', price: 64999.1 },
      { orderId: '333', type: 'LIMIT', side: 'BUY', positionSide: 'LONG', price: 64999.1 },
    ]);

    const { step } = makeMemoStep();
    await runWatch(bot.id, step);

    expect(mocked.cancelBatchOrders).toHaveBeenCalledWith(expect.anything(), 'BTC-USDT', ['222', '333']);
    // The lower level keeps its tracked order; only the upper level is placed.
    const payloads = mocked.placeBatchOrders.mock.calls.flatMap((c) => c[1]);
    expect(payloads).toHaveLength(1);
    expect(payloads[0].type).toBe('TRIGGER_LIMIT');
  });

  it('cancels the just-placed order when the level vanished mid-tick (edit race)', async () => {
    defaultMocks();
    const bot = await makeBot();

    // A concurrent edit deletes the levels while orders are in flight.
    mocked.placeBatchOrders.mockImplementation(async (_client, orders) => {
      await db.delete(gridLevels).where(eq(gridLevels.botId, bot.id));
      return orders.map((o, i) => ({
        orderId: String(9000 + i),
        clientOrderId: typeof o.clientOrderID === 'string' ? o.clientOrderID : undefined,
      }));
    });

    const { step } = makeMemoStep();
    await runWatch(bot.id, step);

    const cancelled = mocked.cancelBatchOrders.mock.calls.flatMap((c) => c[2]);
    expect(cancelled.sort()).toEqual(['9000', '9001']);
  });

  it('records each completed cycle exactly once across repeated ticks', async () => {
    defaultMocks();
    // positionSizeUsdt below minUsdt so the level is never re-placed and the
    // completed-cycle branch re-runs on every tick.
    const bot = await makeBot({ positionSizeUsdt: '1' });
    const { createGridLevels } = await vi.importActual<typeof import('@/services/bingx.service')>('@/services/bingx.service');
    const levels = await createGridLevels(bot.id, bot.priceMin, bot.priceMax, bot.gridCount);
    const lower = levels.find((l) => Number(l.priceLevel) < 65500)!;
    await db.update(gridLevels).set({ orderId: 'e1', tpOrderId: 't1' }).where(eq(gridLevels.id, lower.id));
    mocked.getCurrentPrice.mockResolvedValue(66600); // past TP -> EXIT_TP

    await runWatch(bot.id, makeMemoStep().step);
    await runWatch(bot.id, makeMemoStep().step); // next cron tick

    const trades = await db.query.botTrades.findMany({ where: eq(botTrades.botId, bot.id) });
    expect(trades).toHaveLength(2);
    expect(trades.map((t) => t.type).sort()).toEqual(['ENTRY', 'EXIT_TP']);
  });

  it('GRID_SHORT entries carry the bot CID prefix and SELL/SHORT semantics', async () => {
    defaultMocks();
    const bot = await makeBot({ botType: 'GRID_SHORT' });

    const { step } = makeMemoStep();
    await runWatch(bot.id, step);

    const payloads = mocked.placeBatchOrders.mock.calls.flatMap((c) => c[1]);
    expect(payloads.length).toBeGreaterThan(0);
    for (const p of payloads) {
      expect(p.side).toBe('SELL');
      expect(p.positionSide).toBe('SHORT');
      expect(String(p.clientOrderID).startsWith(entryCidBotPrefix(bot.id))).toBe(true);
    }
  });

  it('places nothing when the bot is stopped between analysis and placement', async () => {
    defaultMocks();
    const bot = await makeBot();

    const { step } = makeMemoStep(async (id) => {
      if (id.startsWith('analyze-')) {
        await db.update(tradingBots).set({ status: 'STOPPED' }).where(eq(tradingBots.id, bot.id));
      }
    });
    await runWatch(bot.id, step);

    expect(mocked.placeBatchOrders).not.toHaveBeenCalled();
  });
});
