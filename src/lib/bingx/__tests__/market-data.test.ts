import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BingxClient } from '@/lib/bingx/client';

vi.mock('@/services/bingx.service', () => ({
  getKlines: vi.fn(),
}));

import { getKlines } from '@/services/bingx.service';
import { fetchKlines, _clearKlinesCache } from '@/lib/bingx/market-data';

const stubClient = {} as unknown as BingxClient;
const sample = [{ open: 1, high: 1, low: 1, close: 1, time: 1 }];

beforeEach(() => {
  _clearKlinesCache();
  vi.mocked(getKlines).mockReset();
  vi.mocked(getKlines).mockResolvedValue(sample);
});

describe('fetchKlines', () => {
  it('forwards args to getKlines on cache miss', async () => {
    const result = await fetchKlines(stubClient, 'BTC-USDT', '1h', 720);
    expect(result).toEqual(sample);
    expect(getKlines).toHaveBeenCalledTimes(1);
    expect(getKlines).toHaveBeenCalledWith(stubClient, 'BTC-USDT', '1h', 720);
  });

  it('returns cached value within TTL without calling getKlines again', async () => {
    await fetchKlines(stubClient, 'BTC-USDT', '1h', 720);
    await fetchKlines(stubClient, 'BTC-USDT', '1h', 720);
    expect(getKlines).toHaveBeenCalledTimes(1);
  });

  it('refetches after TTL expiry', async () => {
    vi.useFakeTimers();
    try {
      await fetchKlines(stubClient, 'BTC-USDT', '1h', 720);
      vi.advanceTimersByTime(60_001);
      await fetchKlines(stubClient, 'BTC-USDT', '1h', 720);
      expect(getKlines).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caches per (symbol, interval, limit) tuple', async () => {
    await fetchKlines(stubClient, 'BTC-USDT', '1h', 720);
    await fetchKlines(stubClient, 'ETH-USDT', '1h', 720);
    await fetchKlines(stubClient, 'BTC-USDT', '4h', 720);
    await fetchKlines(stubClient, 'BTC-USDT', '1h', 100);
    expect(getKlines).toHaveBeenCalledTimes(4);
  });

  it('does not cache empty results (retries on next call)', async () => {
    vi.mocked(getKlines).mockResolvedValueOnce([]);
    await fetchKlines(stubClient, 'BTC-USDT', '1h', 720);
    await fetchKlines(stubClient, 'BTC-USDT', '1h', 720);
    expect(getKlines).toHaveBeenCalledTimes(2);
  });
});
