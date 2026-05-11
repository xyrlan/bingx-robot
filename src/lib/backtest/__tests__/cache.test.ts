// src/lib/backtest/__tests__/cache.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

import { db } from '@/db';
import { paramsHash, findCached, writeCache } from '@/lib/backtest/cache';

beforeEach(() => {
  vi.mocked(db.select).mockReset();
  vi.mocked(db.insert).mockReset();
});

describe('paramsHash', () => {
  it('is stable across key order', () => {
    const a = paramsHash({ a: 1, b: 2, c: { d: 3, e: 4 } });
    const b = paramsHash({ c: { e: 4, d: 3 }, b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it('changes when values change', () => {
    expect(paramsHash({ a: 1 })).not.toBe(paramsHash({ a: 2 }));
  });
});

describe('findCached', () => {
  it('returns null when no row exists', async () => {
    const where = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) });
    const from = vi.fn().mockReturnValue({ where });
    vi.mocked(db.select).mockReturnValue({ from } as never);

    const r = await findCached('BTC-USDT', 'DCA', 'hash', 30);
    expect(r).toBeNull();
  });

  it('returns the row when present', async () => {
    const row = { id: 'abc', symbol: 'BTC-USDT' };
    const where = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([row]) });
    const from = vi.fn().mockReturnValue({ where });
    vi.mocked(db.select).mockReturnValue({ from } as never);

    const r = await findCached('BTC-USDT', 'DCA', 'hash', 30);
    expect(r).toEqual(row);
  });
});

describe('writeCache', () => {
  it('inserts and returns the new row', async () => {
    const inserted = { id: 'new-id' };
    const returning = vi.fn().mockResolvedValue([inserted]);
    const values = vi.fn().mockReturnValue({ returning });
    vi.mocked(db.insert).mockReturnValue({ values } as never);

    const r = await writeCache({
      symbol: 'BTC-USDT',
      strategy: 'DCA',
      paramsHash: 'hash',
      params: { x: 1 },
      windowDays: 30,
      pnlPct: '1.0000',
      maxDrawdownPct: '0.5000',
      sharpeApprox: '1.0000',
      winRatePct: '50.00',
      totalTrades: 1,
      metricsJson: { trades: [] },
    });
    expect(r).toEqual(inserted);
    expect(values).toHaveBeenCalledOnce();
  });
});
