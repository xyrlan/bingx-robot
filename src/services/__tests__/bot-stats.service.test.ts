import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { db } from '@/db';
import { botTrades, tradingBots, users } from '@/db/schema';
import { getBotWindowedStats, getBotDailyPnl, getBotsStats } from '@/services/bot-stats.service';
import { eq } from 'drizzle-orm';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000041';

async function ensureUser() {
  await db.insert(users).values({
    id: TEST_USER_ID,
    email: 'bot-stats-test@example.com',
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

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

async function seedTrade(
  botId: string,
  opts: { type?: string; pnl?: string; createdAt?: Date } = {},
) {
  await db.insert(botTrades).values({
    botId,
    symbol: 'BTC-USDT',
    side: 'LONG',
    type: opts.type ?? 'EXIT_TP',
    price: '55000',
    quantity: '0.001',
    realizedPnl: opts.pnl ?? '1',
    createdAt: opts.createdAt ?? new Date(),
  });
}

describe('bot-stats.service', () => {
  beforeAll(async () => { await ensureUser(); });

  afterEach(async () => {
    await db.delete(tradingBots).where(eq(tradingBots.userId, TEST_USER_ID));
  });

  describe('getBotWindowedStats', () => {
    it('excludes ENTRY rows even when they carry a pnl value', async () => {
      const bot = await makeBot();
      await seedTrade(bot.id, { type: 'ENTRY', pnl: '5' });
      await seedTrade(bot.id, { type: 'EXIT_TP', pnl: '2' });

      const stats = await getBotWindowedStats([bot.id]);

      expect(stats[bot.id].all).toEqual({ pnl: 2, trades: 1, wins: 1 });
    });

    it('places trades into the correct time windows', async () => {
      const bot = await makeBot();
      await seedTrade(bot.id, { pnl: '1', createdAt: daysAgo(1) });
      await seedTrade(bot.id, { pnl: '2', createdAt: daysAgo(8) });
      await seedTrade(bot.id, { pnl: '4', createdAt: daysAgo(45) });
      await seedTrade(bot.id, { pnl: '8', createdAt: daysAgo(100) });
      await seedTrade(bot.id, { pnl: '16', createdAt: daysAgo(200) });

      const stats = await getBotWindowedStats([bot.id]);
      const w = stats[bot.id];

      expect(w['7d']).toEqual({ pnl: 1, trades: 1, wins: 1 });
      expect(w['30d']).toEqual({ pnl: 3, trades: 2, wins: 2 });
      expect(w['60d']).toEqual({ pnl: 7, trades: 3, wins: 3 });
      expect(w['90d']).toEqual({ pnl: 7, trades: 3, wins: 3 });
      expect(w['180d']).toEqual({ pnl: 15, trades: 4, wins: 4 });
      expect(w.all).toEqual({ pnl: 31, trades: 5, wins: 5 });
    });

    it('counts wins as pnl > 0 only (zero pnl is a trade, not a win)', async () => {
      const bot = await makeBot();
      await seedTrade(bot.id, { pnl: '2' });
      await seedTrade(bot.id, { pnl: '0' });
      await seedTrade(bot.id, { pnl: '-1' });

      const stats = await getBotWindowedStats([bot.id]);

      expect(stats[bot.id].all).toEqual({ pnl: 1, trades: 3, wins: 1 });
    });

    it('counts all four EXIT_* subtypes', async () => {
      const bot = await makeBot();
      for (const type of ['EXIT_TP', 'EXIT_TRAILING', 'EXIT_SIGNAL', 'EXIT_MANUAL']) {
        await seedTrade(bot.id, { type, pnl: '1' });
      }

      const stats = await getBotWindowedStats([bot.id]);

      expect(stats[bot.id].all).toEqual({ pnl: 4, trades: 4, wins: 4 });
    });

    it('isolates stats between bots', async () => {
      const botA = await makeBot();
      const botB = await makeBot();
      await seedTrade(botA.id, { pnl: '10' });
      await seedTrade(botB.id, { pnl: '-3' });

      const stats = await getBotWindowedStats([botA.id, botB.id]);

      expect(stats[botA.id].all).toEqual({ pnl: 10, trades: 1, wins: 1 });
      expect(stats[botB.id].all).toEqual({ pnl: -3, trades: 1, wins: 0 });
    });
  });

  describe('getBotDailyPnl', () => {
    it('sums trades on the same day into one point, sparse and ascending', async () => {
      const bot = await makeBot();
      await seedTrade(bot.id, { pnl: '1', createdAt: daysAgo(2) });
      await seedTrade(bot.id, { pnl: '2', createdAt: daysAgo(2) });
      await seedTrade(bot.id, { pnl: '5', createdAt: daysAgo(10) });

      const daily = await getBotDailyPnl([bot.id]);
      const series = daily[bot.id];

      expect(series).toHaveLength(2);
      expect(series[0].pnl).toBe(5);
      expect(series[1].pnl).toBe(3);
      expect(new Date(series[0].date).getTime()).toBeLessThan(new Date(series[1].date).getTime());
    });

    it('excludes trades older than the window and ENTRY rows', async () => {
      const bot = await makeBot();
      await seedTrade(bot.id, { pnl: '9', createdAt: daysAgo(91) });
      await seedTrade(bot.id, { type: 'ENTRY', pnl: '9', createdAt: daysAgo(1) });

      const daily = await getBotDailyPnl([bot.id], 90);

      expect(daily[bot.id] ?? []).toHaveLength(0);
    });
  });

  describe('getBotsStats', () => {
    it('returns empty object for empty botIds without querying', async () => {
      const stats = await getBotsStats([]);
      expect(stats).toEqual({});
    });

    it('zero-fills bots that have no trades', async () => {
      const bot = await makeBot();

      const stats = await getBotsStats([bot.id]);

      expect(stats[bot.id]).toBeDefined();
      expect(stats[bot.id].source).toBe('estimated');
      expect(stats[bot.id].daily).toEqual([]);
      for (const key of ['7d', '30d', '60d', '90d', '180d', 'all'] as const) {
        expect(stats[bot.id].windows[key]).toEqual({ pnl: 0, trades: 0, wins: 0 });
      }
    });

    it('composes windows and daily series per bot', async () => {
      const bot = await makeBot();
      await seedTrade(bot.id, { pnl: '2.5', createdAt: daysAgo(3) });

      const stats = await getBotsStats([bot.id]);

      expect(stats[bot.id].windows['7d']).toEqual({ pnl: 2.5, trades: 1, wins: 1 });
      expect(stats[bot.id].daily).toHaveLength(1);
      expect(stats[bot.id].daily[0].pnl).toBe(2.5);
    });
  });
});
