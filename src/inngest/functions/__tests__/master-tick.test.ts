import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { db } from '@/db';
import { bingxApiKeys, tradingBots, users } from '@/db/schema';
import { eq } from 'drizzle-orm';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000003';

async function seedUser() {
  await db.insert(users).values({
    id: TEST_USER_ID,
    email: 'session05-master-test@example.com',
  }).onConflictDoNothing();
}

async function seedKey() {
  const [k] = await db.insert(bingxApiKeys).values({
    userId: TEST_USER_ID,
    label: 'k',
    apiKey: 'k',
    secretKeyEncrypted: 'k',
    managedByAi: false,
  }).returning();
  return k;
}

async function seedBot(apiKeyId: string, botType: 'DCA' | 'TRAILING_STOP' | 'GRID_LONG') {
  const [b] = await db.insert(tradingBots).values({
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
    status: 'RUNNING',
  }).returning();
  return b;
}

describe('masterTick dispatch logic', () => {
  beforeAll(async () => { await seedUser(); });
  afterEach(async () => {
    await db.delete(tradingBots).where(eq(tradingBots.userId, TEST_USER_ID));
    await db.delete(bingxApiKeys).where(eq(bingxApiKeys.userId, TEST_USER_ID));
  });

  it('dispatches DCA event when DCA bots are running and tickNumber is multiple of 5', async () => {
    const key = await seedKey();
    await seedBot(key.id, 'DCA');

    const sent: { name: string; data: unknown }[] = [];
    const fakeStep = {
      run: async <T>(_id: string, fn: () => Promise<T>) => fn(),
      sendEvent: async (_id: string, events: { name: string; data: unknown }[]) => {
        sent.push(...events);
      },
    };
    const fakeLogger = { info: () => {} };

    const now = 5 * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const { masterTick } = await import('@/inngest/functions/master-tick');
    type Handler = (ctx: { step: unknown; logger: unknown }) => Promise<unknown>;
    const handler = (masterTick as unknown as { fn: Handler }).fn;
    await handler({ step: fakeStep, logger: fakeLogger });

    expect(sent.find(e => e.name === 'bot.tick.DCA')).toBeDefined();
    vi.restoreAllMocks();
  });

  it('does not dispatch when no bots are running', async () => {
    const sent: { name: string; data: unknown }[] = [];
    const fakeStep = {
      run: async <T>(_id: string, fn: () => Promise<T>) => fn(),
      sendEvent: async (_id: string, events: { name: string; data: unknown }[]) => {
        sent.push(...events);
      },
    };
    const fakeLogger = { info: () => {} };

    const { masterTick } = await import('@/inngest/functions/master-tick');
    type Handler = (ctx: { step: unknown; logger: unknown }) => Promise<unknown>;
    const handler = (masterTick as unknown as { fn: Handler }).fn;
    await handler({ step: fakeStep, logger: fakeLogger });

    expect(sent.length).toBe(0);
  });

  it('does not dispatch DCA when tickNumber is NOT a multiple of 5', async () => {
    const key = await seedKey();
    await seedBot(key.id, 'DCA');

    const sent: { name: string; data: unknown }[] = [];
    const fakeStep = {
      run: async <T>(_id: string, fn: () => Promise<T>) => fn(),
      sendEvent: async (_id: string, events: { name: string; data: unknown }[]) => {
        sent.push(...events);
      },
    };
    const fakeLogger = { info: () => {} };

    const now = 4 * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const { masterTick } = await import('@/inngest/functions/master-tick');
    type Handler = (ctx: { step: unknown; logger: unknown }) => Promise<unknown>;
    const handler = (masterTick as unknown as { fn: Handler }).fn;
    await handler({ step: fakeStep, logger: fakeLogger });

    expect(sent.find(e => e.name === 'bot.tick.DCA')).toBeUndefined();
    vi.restoreAllMocks();
  });
});
