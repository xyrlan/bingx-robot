import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { db } from '@/db';
import { users, bingxApiKeys, aiPmConfigs } from '@/db/schema';
import { eq } from 'drizzle-orm';
import {
  createAiPmConfig,
  getAiPmConfig,
  setAnthropicApiKey,
  setBingxApiKeyForAi,
  setKillSwitch,
  setEnabled,
  testAnthropicApiKey,
} from '@/services/ai-pm-config.service';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000020';

async function ensureUser() {
  await db.insert(users).values({
    id: TEST_USER_ID,
    email: 'session2-test@example.com',
  }).onConflictDoNothing();
}

async function makeKey(label = 'AI', managedByAi = true) {
  const [k] = await db.insert(bingxApiKeys).values({
    userId: TEST_USER_ID,
    label,
    apiKey: 'k', secretKeyEncrypted: 'k',
    managedByAi,
  }).returning();
  return k;
}

async function cleanup() {
  await db.delete(aiPmConfigs).where(eq(aiPmConfigs.userId, TEST_USER_ID));
  await db.delete(bingxApiKeys).where(eq(bingxApiKeys.userId, TEST_USER_ID));
}

describe('aiPmConfig service', () => {
  beforeAll(async () => {
    await ensureUser();
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
  });

  it('createAiPmConfig encrypts the Anthropic key and stores config', async () => {
    const key = await makeKey();
    const cfg = await createAiPmConfig(TEST_USER_ID, {
      bingxApiKeyId: key.id,
      anthropicApiKeyPlaintext: 'sk-ant-test-12345',
      mode: 'BALANCED',
    });

    expect(cfg.userId).toBe(TEST_USER_ID);
    expect(cfg.bingxApiKeyId).toBe(key.id);
    expect(cfg.mode).toBe('BALANCED');
    expect(cfg.enabled).toBe(false);
    expect(cfg.killSwitch).toBe(false);
    // The stored field is encrypted, NOT the plaintext
    expect(cfg.anthropicApiKeyEncrypted).not.toBe('sk-ant-test-12345');
    expect(cfg.anthropicApiKeyEncrypted.length).toBeGreaterThan(0);
  });

  it('getAiPmConfig returns the config including the decrypted Anthropic key', async () => {
    const key = await makeKey();
    await createAiPmConfig(TEST_USER_ID, {
      bingxApiKeyId: key.id,
      anthropicApiKeyPlaintext: 'sk-ant-test-roundtrip',
      mode: 'BALANCED',
    });

    const got = await getAiPmConfig(TEST_USER_ID);
    expect(got).not.toBeNull();
    expect(got!.anthropicApiKey).toBe('sk-ant-test-roundtrip');
    expect(got!.userId).toBe(TEST_USER_ID);
  });

  it('getAiPmConfig returns null when no config exists', async () => {
    const got = await getAiPmConfig(TEST_USER_ID);
    expect(got).toBeNull();
  });

  it('setAnthropicApiKey replaces the encrypted key', async () => {
    const key = await makeKey();
    await createAiPmConfig(TEST_USER_ID, {
      bingxApiKeyId: key.id,
      anthropicApiKeyPlaintext: 'sk-ant-original',
      mode: 'BALANCED',
    });

    await setAnthropicApiKey(TEST_USER_ID, 'sk-ant-replaced');

    const got = await getAiPmConfig(TEST_USER_ID);
    expect(got!.anthropicApiKey).toBe('sk-ant-replaced');
  });

  it('setAnthropicApiKey throws when no config exists', async () => {
    await expect(setAnthropicApiKey(TEST_USER_ID, 'sk-ant-test')).rejects.toThrow(/No AI PM config/);
  });

  it('setBingxApiKeyForAi switches the AI subaccount key', async () => {
    const oldKey = await makeKey('old');
    const newKey = await makeKey('new');
    await createAiPmConfig(TEST_USER_ID, {
      bingxApiKeyId: oldKey.id,
      anthropicApiKeyPlaintext: 'sk-ant-test',
      mode: 'BALANCED',
    });

    await setBingxApiKeyForAi(TEST_USER_ID, newKey.id);

    const got = await getAiPmConfig(TEST_USER_ID);
    expect(got!.bingxApiKeyId).toBe(newKey.id);
  });

  it('setKillSwitch flips the killSwitch flag', async () => {
    const key = await makeKey();
    await createAiPmConfig(TEST_USER_ID, {
      bingxApiKeyId: key.id,
      anthropicApiKeyPlaintext: 'sk-ant',
      mode: 'BALANCED',
    });

    await setKillSwitch(TEST_USER_ID, true);
    expect((await getAiPmConfig(TEST_USER_ID))!.killSwitch).toBe(true);

    await setKillSwitch(TEST_USER_ID, false);
    expect((await getAiPmConfig(TEST_USER_ID))!.killSwitch).toBe(false);
  });

  it('setEnabled flips the enabled flag', async () => {
    const key = await makeKey();
    await createAiPmConfig(TEST_USER_ID, {
      bingxApiKeyId: key.id,
      anthropicApiKeyPlaintext: 'sk-ant',
      mode: 'BALANCED',
    });

    await setEnabled(TEST_USER_ID, true);
    expect((await getAiPmConfig(TEST_USER_ID))!.enabled).toBe(true);
  });

  describe('testAnthropicApiKey', () => {
    it('returns ok=true when the API call succeeds', async () => {
      const fakeFactory = () => ({
        messages: { create: vi.fn().mockResolvedValue({ id: 'msg_1', content: [{ type: 'text', text: 'ok' }] }) },
      });
      const r = await testAnthropicApiKey('sk-ant-fake-success', fakeFactory);
      expect(r.ok).toBe(true);
    });

    it('returns ok=false with error when the API call rejects', async () => {
      const fakeFactory = () => ({
        messages: { create: vi.fn().mockRejectedValue(new Error('401 unauthorized')) },
      });
      const r = await testAnthropicApiKey('sk-ant-fake-fail', fakeFactory);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/401/);
    });
  });
});
