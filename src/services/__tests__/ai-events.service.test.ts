import { describe, it, expect } from 'vitest';
import {
  insertAiEvent,
  markEvent,
  checkThrottle,
} from '@/services/ai-events.service';
import type { AiTriggerEnum } from '@/lib/ai-pm/events';

type FakeRow = {
  id: string;
  configId: string;
  userId: string;
  eventType: AiTriggerEnum;
  symbol: string | null;
  status: 'PENDING' | 'THROTTLED' | 'PROCESSING' | 'PROCESSED' | 'FAILED';
  createdAt: Date;
};

interface FakeDb {
  rows: FakeRow[];
  configs: Record<string, { userId: string }>;
}

function makeFakeDb(): FakeDb {
  return { rows: [], configs: {} };
}

function buildDbAdapter(fake: FakeDb) {
  let nextId = 1;
  return {
    insert: () => ({
      values: (v: Omit<FakeRow, 'id' | 'createdAt'> & { configId: string }) => ({
        returning: async () => {
          const row: FakeRow = {
            id: String(nextId++),
            createdAt: new Date(),
            configId: v.configId,
            userId: v.userId,
            eventType: v.eventType,
            symbol: v.symbol ?? null,
            status: v.status ?? 'PENDING',
          };
          fake.rows.push(row);
          return [row];
        },
      }),
    }),
    update: () => ({
      set: (patch: Partial<FakeRow>) => ({
        where: () => ({
          returning: async () => {
            fake.rows[fake.rows.length - 1] = {
              ...fake.rows[fake.rows.length - 1],
              ...patch,
            };
            return [fake.rows[fake.rows.length - 1]];
          },
        }),
      }),
    }),
    query: {
      aiPmConfigs: {
        findFirst: async ({ where }: { where: unknown }) => {
          const ids = Object.keys(fake.configs);
          return ids.length ? { userId: fake.configs[ids[0]].userId, id: ids[0] } : null;
        },
      },
      aiEvents: {
        findMany: async ({ where }: { where: unknown }) => fake.rows.slice(),
      },
    },
  } as unknown as Parameters<typeof insertAiEvent>[0]['db'];
}

describe('ai-events.service', () => {
  it('insertAiEvent inserts row with PENDING status and stamps userId from config', async () => {
    const fake = makeFakeDb();
    fake.configs['cfg1'] = { userId: 'user-1' };
    const dbAdapter = buildDbAdapter(fake);

    const id = await insertAiEvent({
      db: dbAdapter,
      configId: 'cfg1',
      eventType: 'EVENT_FILL',
      symbol: 'BTC-USDT',
      payload: { foo: 'bar' },
      emittedAt: new Date(),
    });

    expect(id).toBe('1');
    expect(fake.rows[0]).toMatchObject({
      configId: 'cfg1',
      userId: 'user-1',
      eventType: 'EVENT_FILL',
      symbol: 'BTC-USDT',
      status: 'PENDING',
    });
  });

  it('markEvent updates status + processedAt + decisionId', async () => {
    const fake = makeFakeDb();
    fake.rows.push({
      id: 'r1',
      configId: 'cfg1',
      userId: 'u1',
      eventType: 'EVENT_FILL',
      symbol: null,
      status: 'PENDING',
      createdAt: new Date(),
    });
    const dbAdapter = buildDbAdapter(fake);

    await markEvent({ db: dbAdapter, aiEventId: 'r1', status: 'PROCESSED', decisionId: 'd1' });

    expect(fake.rows[0].status).toBe('PROCESSED');
  });

  it('checkThrottle returns true when prior event exists in window', async () => {
    const fake = makeFakeDb();
    const now = new Date();
    fake.rows.push({
      id: 'old',
      configId: 'cfg1',
      userId: 'u1',
      eventType: 'EVENT_FILL',
      symbol: 'BTC-USDT',
      status: 'PROCESSED',
      createdAt: new Date(now.getTime() - 60_000),
    });
    fake.rows.push({
      id: 'me',
      configId: 'cfg1',
      userId: 'u1',
      eventType: 'EVENT_FILL',
      symbol: 'BTC-USDT',
      status: 'PENDING',
      createdAt: now,
    });
    const dbAdapter = buildDbAdapter(fake);

    const throttled = await checkThrottle({
      db: dbAdapter,
      configId: 'cfg1',
      eventType: 'EVENT_FILL',
      symbol: 'BTC-USDT',
      currentEventId: 'me',
      windowSeconds: 300,
    });

    expect(throttled).toBe(true);
  });

  it('checkThrottle returns false when only the current event exists', async () => {
    const fake = makeFakeDb();
    fake.rows.push({
      id: 'me',
      configId: 'cfg1',
      userId: 'u1',
      eventType: 'EVENT_FILL',
      symbol: 'BTC-USDT',
      status: 'PENDING',
      createdAt: new Date(),
    });
    const dbAdapter = buildDbAdapter(fake);

    const throttled = await checkThrottle({
      db: dbAdapter,
      configId: 'cfg1',
      eventType: 'EVENT_FILL',
      symbol: 'BTC-USDT',
      currentEventId: 'me',
      windowSeconds: 300,
    });

    expect(throttled).toBe(false);
  });

  it('checkThrottle groups NULL symbols together (IS NOT DISTINCT FROM)', async () => {
    const fake = makeFakeDb();
    fake.rows.push({
      id: 'old',
      configId: 'cfg1',
      userId: 'u1',
      eventType: 'CHAT',
      symbol: null,
      status: 'PROCESSED',
      createdAt: new Date(),
    });
    fake.rows.push({
      id: 'me',
      configId: 'cfg1',
      userId: 'u1',
      eventType: 'CHAT',
      symbol: null,
      status: 'PENDING',
      createdAt: new Date(),
    });
    const dbAdapter = buildDbAdapter(fake);

    const throttled = await checkThrottle({
      db: dbAdapter,
      configId: 'cfg1',
      eventType: 'CHAT',
      symbol: null,
      currentEventId: 'me',
      windowSeconds: 300,
    });

    expect(throttled).toBe(true);
  });
});
