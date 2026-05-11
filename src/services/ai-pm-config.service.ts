import { db } from '@/db';
import { aiPmConfigs } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import Anthropic from '@anthropic-ai/sdk';
import { encryptSecret, decryptSecret } from '@/lib/bingx/encryption';

type AiPmConfigRow = InferSelectModel<typeof aiPmConfigs>;

/**
 * Plaintext-shaped config. The Anthropic key is decrypted into `anthropicApiKey`.
 * Never log this object; never serialize it to the client.
 */
export interface AiPmConfigDecrypted extends Omit<AiPmConfigRow, 'anthropicApiKeyEncrypted'> {
  anthropicApiKey: string;
}

export interface CreateAiPmConfigInput {
  bingxApiKeyId: string;
  anthropicApiKeyPlaintext: string;
  mode?: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE' | 'CUSTOM';
}

function decrypt(row: AiPmConfigRow): AiPmConfigDecrypted {
  const { anthropicApiKeyEncrypted, ...rest } = row;
  return { ...rest, anthropicApiKey: decryptSecret(anthropicApiKeyEncrypted) };
}

export async function createAiPmConfig(
  userId: string,
  input: CreateAiPmConfigInput,
): Promise<AiPmConfigRow> {
  const encrypted = encryptSecret(input.anthropicApiKeyPlaintext);
  const [row] = await db
    .insert(aiPmConfigs)
    .values({
      userId,
      bingxApiKeyId: input.bingxApiKeyId,
      anthropicApiKeyEncrypted: encrypted,
      mode: input.mode ?? 'BALANCED',
    })
    .returning();
  return row;
}

export async function getAiPmConfigById(configId: string): Promise<AiPmConfigDecrypted | null> {
  const row = await db.query.aiPmConfigs.findFirst({
    where: eq(aiPmConfigs.id, configId),
  });
  return row ? decrypt(row) : null;
}

export async function getAiPmConfigByBingxApiKeyId(
  bingxApiKeyId: string,
): Promise<AiPmConfigDecrypted | null> {
  const row = await db.query.aiPmConfigs.findFirst({
    where: eq(aiPmConfigs.bingxApiKeyId, bingxApiKeyId),
  });
  return row ? decrypt(row) : null;
}

export async function listAiPmConfigsForUser(userId: string): Promise<AiPmConfigDecrypted[]> {
  const rows = await db.query.aiPmConfigs.findMany({
    where: eq(aiPmConfigs.userId, userId),
  });
  return rows.map(decrypt);
}

export async function listEnabledAiPmConfigs(): Promise<AiPmConfigDecrypted[]> {
  const rows = await db.query.aiPmConfigs.findMany({
    where: and(eq(aiPmConfigs.enabled, true), eq(aiPmConfigs.killSwitch, false)),
  });
  return rows.map(decrypt);
}

export async function setAnthropicApiKey(configId: string, plaintext: string): Promise<void> {
  const existing = await db.query.aiPmConfigs.findFirst({
    where: eq(aiPmConfigs.id, configId),
  });
  if (!existing) {
    throw new Error('No AI PM config found for id. Call createAiPmConfig first.');
  }
  const encrypted = encryptSecret(plaintext);
  await db
    .update(aiPmConfigs)
    .set({ anthropicApiKeyEncrypted: encrypted, updatedAt: new Date() })
    .where(eq(aiPmConfigs.id, configId));
}

export async function setKillSwitch(configId: string, value: boolean): Promise<void> {
  await db
    .update(aiPmConfigs)
    .set({ killSwitch: value, updatedAt: new Date() })
    .where(eq(aiPmConfigs.id, configId));
}

export async function setEnabled(configId: string, value: boolean): Promise<void> {
  await db
    .update(aiPmConfigs)
    .set({ enabled: value, updatedAt: new Date() })
    .where(eq(aiPmConfigs.id, configId));
}

interface AnthropicLike {
  messages: {
    create: (params: {
      model: string;
      max_tokens: number;
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    }) => Promise<unknown>;
  };
}

type AnthropicFactory = (apiKey: string) => AnthropicLike;

const defaultFactory: AnthropicFactory = (apiKey) => new Anthropic({ apiKey }) as unknown as AnthropicLike;

/**
 * Validates an Anthropic API key by calling messages.create with the cheapest
 * possible request (1 input token, max_tokens=1). Does NOT persist the key.
 *
 * @param plaintext - The Anthropic API key to test
 * @param factory - Optional factory for injecting a fake Anthropic client in tests
 */
export async function testAnthropicApiKey(
  plaintext: string,
  factory: AnthropicFactory = defaultFactory,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = factory(plaintext);
    await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ok' }],
    });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
