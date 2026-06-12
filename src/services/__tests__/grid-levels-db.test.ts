import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { db } from '@/db';
import { gridLevels, tradingBots, users } from '@/db/schema';
import { createGridLevels, updateGridLevelById } from '@/services/bingx.service';
import { eq } from 'drizzle-orm';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000031';

async function ensureUser() {
  await db.insert(users).values({
    id: TEST_USER_ID,
    email: 'grid-levels-db-test@example.com',
  }).onConflictDoNothing();
}

async function makeBot() {
  const [row] = await db.insert(tradingBots).values({
    userId: TEST_USER_ID,
    symbol: 'BTC-USDT',
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

describe('grid level CID persistence', () => {
  beforeAll(async () => { await ensureUser(); });

  afterEach(async () => {
    await db.delete(tradingBots).where(eq(tradingBots.userId, TEST_USER_ID));
  });

  describe('updateGridLevelById', () => {
    it('updates fields by level id and returns affected row count', async () => {
      const bot = await makeBot();
      const [level] = await createGridLevels(bot.id, '50000', '60000', 2);

      const affected = await updateGridLevelById(level.id, {
        orderId: '12345',
        entryClientOrderId: 'ge00000000aaaaaaaabb',
        tpOrderId: null,
      });

      expect(affected).toBe(1);
      const row = await db.query.gridLevels.findFirst({ where: eq(gridLevels.id, level.id) });
      expect(row?.orderId).toBe('12345');
      expect(row?.entryClientOrderId).toBe('ge00000000aaaaaaaabb');
    });

    it('returns 0 when the level no longer exists (edit race)', async () => {
      const bot = await makeBot();
      const [level] = await createGridLevels(bot.id, '50000', '60000', 2);
      await db.delete(gridLevels).where(eq(gridLevels.id, level.id));

      const affected = await updateGridLevelById(level.id, { orderId: '99999' });

      expect(affected).toBe(0);
    });
  });

  describe('createGridLevels onConflictReactivate', () => {
    it('reactivates a colliding legacy level preserving tpOrderId', async () => {
      const bot = await makeBot();
      // Legacy level at a price the new grid will also produce, holding a live TP
      const [legacy] = await createGridLevels(bot.id, '50000', '60000', 2); // 50000 + 60000
      await db.update(gridLevels)
        .set({ isActive: false, tpOrderId: 'tp-legacy', orderId: 'stale-entry', entryClientOrderId: 'ge-stale' })
        .where(eq(gridLevels.id, legacy.id));

      await createGridLevels(bot.id, '50000', '70000', 3, {
        onConflictReactivate: true,
        positionSide: 'LONG',
      }); // 50000 collides with legacy, 60000 collides with the other row, 70000 is new

      const rows = await db.query.gridLevels.findMany({ where: eq(gridLevels.botId, bot.id) });
      expect(rows).toHaveLength(3);

      const reactivated = rows.find((r) => Number(r.priceLevel) === 50000);
      expect(reactivated?.isActive).toBe(true);
      expect(reactivated?.tpOrderId).toBe('tp-legacy');   // preserved — TP still live on exchange
      expect(reactivated?.orderId).toBeNull();             // stale entry tracking cleared
      expect(reactivated?.entryClientOrderId).toBeNull();
    });

    it('applies positionSide to both inserted and reactivated rows', async () => {
      const bot = await makeBot();
      await createGridLevels(bot.id, '50000', '60000', 2);
      await db.update(gridLevels).set({ isActive: false }).where(eq(gridLevels.botId, bot.id));

      await createGridLevels(bot.id, '50000', '70000', 3, {
        onConflictReactivate: true,
        positionSide: 'SHORT',
      });

      const rows = await db.query.gridLevels.findMany({ where: eq(gridLevels.botId, bot.id) });
      expect(rows.every((r) => r.positionSide === 'SHORT')).toBe(true);
    });
  });
});
