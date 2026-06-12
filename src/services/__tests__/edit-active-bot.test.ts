import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { db } from '@/db';
import { bingxApiKeys, gridLevels, tradingBots, users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { encryptSecret } from '@/lib/bingx/encryption';
import { entryCidBotPrefix } from '@/services/bots/grid-cid';

// Fake exchange: open-orders state + cancel recording, served through the
// (mocked) BingX client factory so the real getOpenOrders/cancelBatchOrders
// service code runs unmodified.
const fakeState = vi.hoisted(() => ({
  openOrders: [] as Array<Record<string, unknown>>,
  cancelCalls: [] as Array<Record<string, unknown>>,
  cancelMode: 'remove' as 'remove' | 'noop',
  onCancel: undefined as undefined | (() => Promise<void>),
}));

vi.mock('@/lib/bingx/client', () => ({
  createBingxClient: () => ({
    get: async (path: string) =>
      path.includes('openOrders') ? { orders: fakeState.openOrders } : {},
    post: async () => ({}),
    postForm: async () => ({}),
    delete: async (_path: string, params: Record<string, unknown>) => {
      fakeState.cancelCalls.push(params);
      if (fakeState.onCancel) await fakeState.onCancel();
      if (fakeState.cancelMode === 'remove') {
        const ids = String(params.orderIdList).replace(/[[\]\s]/g, '').split(',').filter(Boolean);
        fakeState.openOrders = fakeState.openOrders.filter((o) => !ids.includes(String(o.orderId)));
      }
      return {};
    },
  }),
}));

import { createBingxClient } from '@/lib/bingx/client';
import {
  createGridLevels,
  editActiveBot,
  stopBotAndCancelEntries,
} from '@/services/bingx.service';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000033';

function cancelledIds(): string[] {
  return fakeState.cancelCalls.flatMap((c) =>
    String(c.orderIdList ?? '').replace(/[[\]\s]/g, '').split(',').filter(Boolean)
  );
}

async function ensureUser() {
  await db.insert(users).values({
    id: TEST_USER_ID,
    email: 'edit-active-bot-test@example.com',
  }).onConflictDoNothing();
}

async function makeKey() {
  const [row] = await db.insert(bingxApiKeys).values({
    userId: TEST_USER_ID,
    label: 'k',
    apiKey: 'k',
    secretKeyEncrypted: encryptSecret('test-secret'),
    managedByAi: false,
  }).returning();
  return row;
}

async function makeBot(apiKeyId: string, overrides: Partial<typeof tradingBots.$inferInsert> = {}) {
  const [row] = await db.insert(tradingBots).values({
    userId: TEST_USER_ID,
    apiKeyId,
    symbol: 'BTC-USDT',
    botType: 'GRID_LONG',
    priceMin: '50000',
    priceMax: '60000',
    positionSizeUsdt: '10',
    takeProfitPercentage: '1',
    gridCount: 2,
    leverage: 1,
    status: 'RUNNING',
    ...overrides,
  }).returning();
  return row;
}

const EDIT_PARAMS = {
  priceMin: '50000',
  priceMax: '70000',
  gridCount: 3,
  positionSizeUsdt: '12',
  takeProfitPercentage: '1.5',
};

describe('grid edit/stop flows', () => {
  beforeAll(async () => { await ensureUser(); });

  afterEach(async () => {
    await db.delete(tradingBots).where(eq(tradingBots.userId, TEST_USER_ID));
    await db.delete(bingxApiKeys).where(eq(bingxApiKeys.userId, TEST_USER_ID));
    fakeState.openOrders = [];
    fakeState.cancelCalls = [];
    fakeState.cancelMode = 'remove';
    fakeState.onCancel = undefined;
  });

  describe('stopBotAndCancelEntries', () => {
    it('cancels DB-known and CID-prefixed entry orders, leaves TPs untouched', async () => {
      const key = await makeKey();
      const bot = await makeBot(key.id);
      const levels = await createGridLevels(bot.id, '50000', '60000', 2);
      await db.update(gridLevels).set({ orderId: '11' }).where(eq(gridLevels.id, levels[0].id));

      fakeState.openOrders = [
        { orderId: '11', type: 'LIMIT', side: 'BUY', positionSide: 'LONG', price: 50000 },
        // Orphan from a failed write-back: ours by CID, unknown to the DB
        { orderId: '22', type: 'LIMIT', side: 'BUY', positionSide: 'LONG', price: 55000, clientOrderID: `${entryCidBotPrefix(bot.id)}aaaaaaaa123` },
        // "Let it Ride": TP must survive
        { orderId: '33', type: 'TAKE_PROFIT_MARKET', side: 'SELL', positionSide: 'LONG', stopPrice: 50500 },
      ];

      const client = createBingxClient('k', 's');
      await stopBotAndCancelEntries(client, bot.id, 'BTC-USDT');

      const ids = cancelledIds();
      expect(ids).toContain('11');
      expect(ids).toContain('22');
      expect(ids).not.toContain('33');

      const rows = await db.query.gridLevels.findMany({ where: eq(gridLevels.botId, bot.id) });
      expect(rows.every((r) => r.orderId === null && r.entryClientOrderId === null)).toBe(true);
    });
  });

  describe('editActiveBot', () => {
    it('cancels exchange-known CID orders missing from the DB', async () => {
      const key = await makeKey();
      const bot = await makeBot(key.id);
      await createGridLevels(bot.id, '50000', '60000', 2);

      fakeState.openOrders = [
        { orderId: '999', type: 'LIMIT', side: 'BUY', positionSide: 'LONG', price: 55000, clientOrderID: `${entryCidBotPrefix(bot.id)}bbbbbbbb456` },
      ];

      await editActiveBot(TEST_USER_ID, bot.id, EDIT_PARAMS);

      expect(cancelledIds()).toContain('999');
      const fresh = await db.query.tradingBots.findFirst({ where: eq(tradingBots.id, bot.id) });
      expect(fresh?.status).toBe('RUNNING');
      expect(fresh?.priceMax).toBe('70000.00000000');
    });

    it('reactivates a colliding legacy level preserving its TP, recreates the rest', async () => {
      const key = await makeKey();
      const bot = await makeBot(key.id);
      const levels = await createGridLevels(bot.id, '50000', '60000', 2); // 50000 + 60000
      await db.update(gridLevels).set({ tpOrderId: 'tp-X', orderId: 'stale' })
        .where(eq(gridLevels.id, levels.find((l) => Number(l.priceLevel) === 50000)!.id));

      await editActiveBot(TEST_USER_ID, bot.id, EDIT_PARAMS); // new grid: 50000, 60000, 70000

      const rows = await db.query.gridLevels.findMany({ where: eq(gridLevels.botId, bot.id) });
      expect(rows.map((r) => Number(r.priceLevel)).sort((a, b) => a - b)).toEqual([50000, 60000, 70000]);

      const reactivated = rows.find((r) => Number(r.priceLevel) === 50000);
      expect(reactivated?.isActive).toBe(true);
      expect(reactivated?.tpOrderId).toBe('tp-X'); // TP still live on the exchange
      expect(reactivated?.orderId).toBeNull();
      expect(reactivated?.entryClientOrderId).toBeNull();
    });

    it('keeps non-colliding legacy levels with TPs as inactive rows', async () => {
      const key = await makeKey();
      const bot = await makeBot(key.id, { priceMin: '55000', priceMax: '55000', gridCount: 1 });
      const [legacy] = await createGridLevels(bot.id, '55000', '55000', 1);
      await db.update(gridLevels).set({ tpOrderId: 'tp-Y' }).where(eq(gridLevels.id, legacy.id));

      await editActiveBot(TEST_USER_ID, bot.id, EDIT_PARAMS); // 50000/60000/70000 — no collision

      const rows = await db.query.gridLevels.findMany({ where: eq(gridLevels.botId, bot.id) });
      expect(rows).toHaveLength(4);
      const old = rows.find((r) => Number(r.priceLevel) === 55000);
      expect(old?.isActive).toBe(false);
      expect(old?.tpOrderId).toBe('tp-Y');
    });

    it('creates SHORT levels when editing a GRID_SHORT bot', async () => {
      const key = await makeKey();
      const bot = await makeBot(key.id, { botType: 'GRID_SHORT' });
      await createGridLevels(bot.id, '50000', '60000', 2, { positionSide: 'SHORT' });

      await editActiveBot(TEST_USER_ID, bot.id, EDIT_PARAMS);

      const rows = await db.query.gridLevels.findMany({ where: eq(gridLevels.botId, bot.id) });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.positionSide === 'SHORT')).toBe(true);
    });

    it('is STOPPED while cancelling and RUNNING after', async () => {
      const key = await makeKey();
      const bot = await makeBot(key.id);
      const levels = await createGridLevels(bot.id, '50000', '60000', 2);
      await db.update(gridLevels).set({ orderId: '11' }).where(eq(gridLevels.id, levels[0].id));
      fakeState.openOrders = [
        { orderId: '11', type: 'LIMIT', side: 'BUY', positionSide: 'LONG', price: 50000 },
      ];

      let statusDuringCancel: string | undefined;
      fakeState.onCancel = async () => {
        const row = await db.query.tradingBots.findFirst({ where: eq(tradingBots.id, bot.id) });
        statusDuringCancel = row?.status;
      };

      await editActiveBot(TEST_USER_ID, bot.id, EDIT_PARAMS);

      expect(statusDuringCancel).toBe('STOPPED');
      const fresh = await db.query.tradingBots.findFirst({ where: eq(tradingBots.id, bot.id) });
      expect(fresh?.status).toBe('RUNNING');
    });

    it('aborts and stays STOPPED when entry orders survive cancellation', async () => {
      const key = await makeKey();
      const bot = await makeBot(key.id);
      const levels = await createGridLevels(bot.id, '50000', '60000', 2);
      await db.update(gridLevels).set({ orderId: '11' }).where(eq(gridLevels.id, levels[0].id));
      fakeState.openOrders = [
        { orderId: '11', type: 'LIMIT', side: 'BUY', positionSide: 'LONG', price: 50000 },
      ];
      fakeState.cancelMode = 'noop'; // cancel "succeeds" but the order survives

      await expect(editActiveBot(TEST_USER_ID, bot.id, EDIT_PARAMS)).rejects.toThrow();

      const fresh = await db.query.tradingBots.findFirst({ where: eq(tradingBots.id, bot.id) });
      expect(fresh?.status).toBe('STOPPED');     // left stopped for a manual retry
      expect(fresh?.priceMax).toBe('60000.00000000'); // no DB surgery happened
      const rows = await db.query.gridLevels.findMany({ where: eq(gridLevels.botId, bot.id) });
      expect(rows).toHaveLength(2);
    });
  });
});
