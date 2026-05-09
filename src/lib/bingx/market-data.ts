import type { BingxClient } from '@/lib/bingx/client';
import { getKlines, type Kline } from '@/services/bingx.service';

const TTL_MS = 60_000;

type CacheEntry = { value: Kline[]; expiresAt: number };

const cache = new Map<string, CacheEntry>();

export async function fetchKlines(
  client: BingxClient,
  symbol: string,
  interval: string,
  limit: number,
): Promise<Kline[]> {
  const key = `${symbol}|${interval}|${limit}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  const value = await getKlines(client, symbol, interval, limit);
  if (value.length > 0) {
    cache.set(key, { value, expiresAt: now + TTL_MS });
  }
  return value;
}

export function _clearKlinesCache(): void {
  cache.clear();
}
