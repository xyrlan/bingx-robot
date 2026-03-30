import {
  getBingxClient,
  getBingxClientByApiKeyId,
  toSafeIdString,
} from '@/services/bingx.service';
import type { BingxClient } from '@/lib/bingx/client';

/** Minimal bot shape needed by the helpers (works with both raw and Inngest-serialized bots). */
interface BotLike {
  symbol: string;
  userId: string;
  apiKeyId: string | null;
}

/**
 * Groups bots by (symbol, apiKeyId) to share API calls within each group.
 */
export function groupBotsBySymbolAndKey<T extends BotLike>(bots: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const bot of bots) {
    const key = `${String(bot.symbol).trim().toUpperCase()}:${bot.apiKeyId ?? bot.userId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(bot);
  }
  return groups;
}

/**
 * Gets a BingX client for a bot, preferring apiKeyId if available.
 */
export async function getClientForBot(bot: BotLike): Promise<BingxClient | null> {
  return bot.apiKeyId
    ? await getBingxClientByApiKeyId(bot.apiKeyId)
    : await getBingxClient(bot.userId);
}

/**
 * Extracts orderId from a BingX order placement response.
 */
export function parseOrderId(result: unknown): string | null {
  const r = result as {
    orderId?: string | number;
    order?: { orderId?: string | number };
  } | null;
  const raw = r?.orderId ?? r?.order?.orderId;
  return raw != null ? (toSafeIdString(raw) ?? null) : null;
}
