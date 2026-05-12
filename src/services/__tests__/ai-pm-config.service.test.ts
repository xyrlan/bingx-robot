import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { db } from '@/db';
import { users, bingxApiKeys, aiPmConfigs } from '@/db/schema';
import { eq } from 'drizzle-orm';
import {
  createAiPmConfig,
  getAiPmConfigById,
  getAiPmConfigByBingxApiKeyId,
  listAiPmConfigsForUser,
  listEnabledAiPmConfigs,
  setAnthropicApiKey,
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
    expect(cfg.anthropicApiKeyEncrypted).not.toBe('sk-ant-test-12345');
    expect(cfg.anthropicApiKeyEncrypted.length).toBeGreaterThan(0);
  });

  it('getAiPmConfigById returns the config including the decrypted Anthropic key', async () => {
    const key = await makeKey();
    const cfg = await createAiPmConfig(TEST_USER_ID, {
      bingxApiKeyId: key.id,
      anthropicApiKeyPlaintext: 'sk-ant-test-roundtrip',
      mode: 'BALANCED',
    });

    const got = await getAiPmConfigById(cfg.id);
    expect(got).not.toBeNull();
    expect(got!.anthropicApiKey).toBe('sk-ant-test-roundtrip');
    expect(got!.userId).toBe(TEST_USER_ID);
  });

  it('getAiPmConfigById returns null when no config exists', async () => {
    const got = await getAiPmConfigById('00000000-0000-0000-0000-0000000000ff');
    expect(got).toBeNull();
  });

  it('getAiPmConfigByBingxApiKeyId returns the config scoped to subaccount', async () => {
    const key = await makeKey();
    await createAiPmConfig(TEST_USER_ID, {
      bingxApiKeyId: key.id,
      anthropicApiKeyPlaintext: 'sk-ant-scoped',
      mode: 'BALANCED',
    });

    const got = await getAiPmConfigByBingxApiKeyId(key.id);
    expect(got).not.toBeNull();
    expect(got!.bingxApiKeyId).toBe(key.id);
    expect(got!.anthropicApiKey).toBe('sk-ant-scoped');
  });

  it('listAiPmConfigsForUser returns all configs for a user (multi-subaccount support)', async () => {
    const keyA = await makeKey('subA');
    const keyB = await makeKey('subB');
    await createAiPmConfig(TEST_USER_ID, {
      bingxApiKeyId: keyA.id, anthropicApiKeyPlaintext: 'sk-ant-A', mode: 'BALANCED',
    });
    await createAiPmConfig(TEST_USER_ID, {
      bingxApiKeyId: keyB.id, anthropicApiKeyPlaintext: 'sk-ant-B', mode: 'CONSERVATIVE',
    });

    const list = await listAiPmConfigsForUser(TEST_USER_ID);
    expect(list).toHaveLength(2);
    const apiKeyIds = list.map((c) => c.bingxApiKeyId).sort();
    expect(apiKeyIds).toEqual([keyA.id, keyB.id].sort());
  });

  it('setAnthropicApiKey replaces the encrypted key', async () => {
    const key = await makeKey();
    const cfg = await createAiPmConfig(TEST_USER_ID, {
      bingxApiKeyId: key.id,
      anthropicApiKeyPlaintext: 'sk-ant-original',
      mode: 'BALANCED',
    });

    await setAnthropicApiKey(cfg.id, 'sk-ant-replaced');

    const got = await getAiPmConfigById(cfg.id);
    expect(got!.anthropicApiKey).toBe('sk-ant-replaced');
  });

  it('setAnthropicApiKey throws when no config exists', async () => {
    await expect(
      setAnthropicApiKey('00000000-0000-0000-0000-0000000000ff', 'sk-ant-test'),
    ).rejects.toThrow(/No AI PM config/);
  });

  it('setKillSwitch flips the killSwitch flag', async () => {
    const key = await makeKey();
    const cfg = await createAiPmConfig(TEST_USER_ID, {
      bingxApiKeyId: key.id,
      anthropicApiKeyPlaintext: 'sk-ant',
      mode: 'BALANCED',
    });

    await setKillSwitch(cfg.id, true);
    expect((await getAiPmConfigById(cfg.id))!.killSwitch).toBe(true);

    await setKillSwitch(cfg.id, false);
    expect((await getAiPmConfigById(cfg.id))!.killSwitch).toBe(false);
  });

  it('setEnabled flips the enabled flag', async () => {
    const key = await makeKey();
    const cfg = await createAiPmConfig(TEST_USER_ID, {
      bingxApiKeyId: key.id,
      anthropicApiKeyPlaintext: 'sk-ant',
      mode: 'BALANCED',
    });

    await setEnabled(cfg.id, true);
    expect((await getAiPmConfigById(cfg.id))!.enabled).toBe(true);
  });

  describe('decrypt resilience', () => {
    it('listEnabledAiPmConfigs skips rows with a corrupted ciphertext and returns the rest', async () => {
      const key1 = await makeKey('A');
      const key2 = await makeKey('B');
      await createAiPmConfig(TEST_USER_ID, { bingxApiKeyId: key1.id, anthropicApiKeyPlaintext: 'sk-ant-good' });
      // Inject a deliberately corrupt row that bypasses encryptSecret.
      await db.insert(aiPmConfigs).values({
        userId: TEST_USER_ID,
        bingxApiKeyId: key2.id,
        anthropicApiKeyEncrypted: 'corrupt-payload-no-colons',
        enabled: true,
      });
      // First config defaults to enabled=false; flip it on so both are eligible.
      await db.update(aiPmConfigs).set({ enabled: true }).where(eq(aiPmConfigs.bingxApiKeyId, key1.id));

      // The shared DB may contain enabled configs from other test users; just
      // check our two known configs: the good one is returned, the corrupt
      // one is filtered out.
      const configs = await listEnabledAiPmConfigs();
      const mine = configs.filter((c) => c.userId === TEST_USER_ID);
      expect(mine.map((c) => c.bingxApiKeyId)).toEqual([key1.id]);
    });

    it('listAiPmConfigsForUser also skips corrupted rows', async () => {
      const key1 = await makeKey('C');
      const key2 = await makeKey('D');
      await createAiPmConfig(TEST_USER_ID, { bingxApiKeyId: key1.id, anthropicApiKeyPlaintext: 'sk-ant-good' });
      await db.insert(aiPmConfigs).values({
        userId: TEST_USER_ID,
        bingxApiKeyId: key2.id,
        anthropicApiKeyEncrypted: 'still:bad:not-a-real-cipher',
      });

      const configs = await listAiPmConfigsForUser(TEST_USER_ID);
      expect(configs).toHaveLength(1);
      expect(configs[0].bingxApiKeyId).toBe(key1.id);
    });
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
