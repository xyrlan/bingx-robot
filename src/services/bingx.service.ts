import { eq, and, desc } from 'drizzle-orm';
import { db } from '@/db';
import { bingxApiKeys, tradingBots } from '@/db/schema';
import { encryptSecret, decryptSecret } from '@/lib/bingx/encryption';
import { createBingxClient, type BingxClient } from '@/lib/bingx/client';
import type { InferSelectModel } from 'drizzle-orm';

export type TradingBot = InferSelectModel<typeof tradingBots>;

export async function saveBingxKeys(userId: string, apiKey: string, secretKey: string): Promise<void> {
  const trimmedApiKey = apiKey.trim();
  const trimmedSecretKey = secretKey.trim();
  const secretKeyEncrypted = encryptSecret(trimmedSecretKey);
  await db
    .insert(bingxApiKeys)
    .values({
      userId,
      apiKey: trimmedApiKey,
      secretKeyEncrypted,
    })
    .onConflictDoUpdate({
      target: bingxApiKeys.userId,
      set: {
        apiKey: trimmedApiKey,
        secretKeyEncrypted,
        updatedAt: new Date(),
      },
    });
}

export async function getBingxKeys(userId: string): Promise<{ apiKey: string; secretKey: string } | null> {
  const row = await db.query.bingxApiKeys.findFirst({
    where: eq(bingxApiKeys.userId, userId),
  });
  if (!row) return null;
  try {
    const secretKey = decryptSecret(row.secretKeyEncrypted);
    return { apiKey: row.apiKey, secretKey };
  } catch {
    return null;
  }
}

export async function getBingxClient(userId: string): Promise<BingxClient | null> {
  const keys = await getBingxKeys(userId);
  if (!keys) return null;
  return createBingxClient(keys.apiKey, keys.secretKey);
}

export async function deleteBingxKeys(userId: string): Promise<void> {
  await db.delete(bingxApiKeys).where(eq(bingxApiKeys.userId, userId));
}

export async function hasBingxKeys(userId: string): Promise<boolean> {
  const row = await db.query.bingxApiKeys.findFirst({
    where: eq(bingxApiKeys.userId, userId),
    columns: { id: true },
  });
  return !!row;
}

// ========== Trading Bots ==========

export async function createBot(
  userId: string,
  params: { symbol: string; priceMin: string; priceMax: string }
): Promise<TradingBot> {
  const [bot] = await db
    .insert(tradingBots)
    .values({
      userId,
      symbol: params.symbol,
      priceMin: params.priceMin,
      priceMax: params.priceMax,
    })
    .returning();
  if (!bot) throw new Error('Failed to create bot');
  return bot;
}

export async function getBotById(botId: string, userId: string): Promise<TradingBot | null> {
  const bot = await db.query.tradingBots.findFirst({
    where: and(eq(tradingBots.id, botId), eq(tradingBots.userId, userId)),
  });
  return bot ?? null;
}

export async function getRunningBots(): Promise<TradingBot[]> {
  return db.query.tradingBots.findMany({
    where: eq(tradingBots.status, 'RUNNING'),
  });
}

export async function setBotStatus(
  botId: string,
  userId: string,
  status: 'STOPPED' | 'RUNNING'
): Promise<void> {
  await db
    .update(tradingBots)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(tradingBots.id, botId), eq(tradingBots.userId, userId)));
}

export async function updateBotCurrentOrder(botId: string, orderId: string | null): Promise<void> {
  await db
    .update(tradingBots)
    .set({ currentOrderId: orderId, updatedAt: new Date() })
    .where(eq(tradingBots.id, botId));
}

export async function getUserBots(userId: string): Promise<TradingBot[]> {
  return db.query.tradingBots.findMany({
    where: eq(tradingBots.userId, userId),
    orderBy: [desc(tradingBots.createdAt)],
  });
}
