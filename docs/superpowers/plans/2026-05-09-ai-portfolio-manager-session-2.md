# AI Portfolio Manager — Session 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an AI Portfolio Manager configuration service that encrypts/decrypts the user's BYOK Anthropic API key, manages the `aiPmConfigs` lifecycle (create / read / update), and exposes a connection-test function. No UI yet — service layer only.

**Architecture:** Reuse the existing `encryptSecret`/`decryptSecret` (already generic — they accept any string). The service module wraps `aiPmConfigs` CRUD with explicit narrow methods. The Anthropic key never appears in plaintext on disk; the test function calls `client.messages.create` with a 1-token sample to verify the key works.

**Tech Stack:** TypeScript · Drizzle ORM · `@anthropic-ai/sdk` · Vitest · Bun

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/services/ai-pm-config.service.ts` | Create | Public CRUD on `aiPmConfigs` + Anthropic connection test |
| `src/services/__tests__/ai-pm-config.service.test.ts` | Create | Vitest coverage: round-trip encryption, CRUD, mocked Anthropic test |

---

## Task 1: Service module + tests (TDD)

**Files:**
- Create: `src/services/ai-pm-config.service.ts`
- Create: `src/services/__tests__/ai-pm-config.service.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/services/__tests__/ai-pm-config.service.test.ts`:

```ts
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
      // Mock the Anthropic SDK constructor + messages.create
      vi.doMock('@anthropic-ai/sdk', () => {
        return {
          default: class FakeAnthropic {
            messages = {
              create: vi.fn().mockResolvedValue({ id: 'msg_1', content: [{ type: 'text', text: 'ok' }] }),
            };
          },
        };
      });
      // Re-import so the mock applies
      const mod = await import('@/services/ai-pm-config.service');
      const r = await mod.testAnthropicApiKey('sk-ant-fake-success');
      expect(r.ok).toBe(true);
      vi.doUnmock('@anthropic-ai/sdk');
      vi.resetModules();
    });

    it('returns ok=false with error when the API call rejects', async () => {
      vi.doMock('@anthropic-ai/sdk', () => {
        return {
          default: class FakeAnthropic {
            messages = {
              create: vi.fn().mockRejectedValue(new Error('401 unauthorized')),
            };
          },
        };
      });
      const mod = await import('@/services/ai-pm-config.service');
      const r = await mod.testAnthropicApiKey('sk-ant-fake-fail');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/401/);
      vi.doUnmock('@anthropic-ai/sdk');
      vi.resetModules();
    });
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `bun run test src/services/__tests__/ai-pm-config.service.test.ts`

Expected: failure — module `@/services/ai-pm-config.service` does not exist.

- [ ] **Step 3: Implement the service**

Create `src/services/ai-pm-config.service.ts`:

```ts
import { db } from '@/db';
import { aiPmConfigs } from '@/db/schema';
import { eq } from 'drizzle-orm';
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

export async function getAiPmConfig(userId: string): Promise<AiPmConfigDecrypted | null> {
  const row = await db.query.aiPmConfigs.findFirst({
    where: eq(aiPmConfigs.userId, userId),
  });
  if (!row) return null;
  const { anthropicApiKeyEncrypted, ...rest } = row;
  return {
    ...rest,
    anthropicApiKey: decryptSecret(anthropicApiKeyEncrypted),
  };
}

export async function setAnthropicApiKey(userId: string, plaintext: string): Promise<void> {
  const existing = await db.query.aiPmConfigs.findFirst({
    where: eq(aiPmConfigs.userId, userId),
  });
  if (!existing) {
    throw new Error('No AI PM config found for user. Call createAiPmConfig first.');
  }
  const encrypted = encryptSecret(plaintext);
  await db
    .update(aiPmConfigs)
    .set({ anthropicApiKeyEncrypted: encrypted, updatedAt: new Date() })
    .where(eq(aiPmConfigs.userId, userId));
}

export async function setBingxApiKeyForAi(userId: string, bingxApiKeyId: string): Promise<void> {
  await db
    .update(aiPmConfigs)
    .set({ bingxApiKeyId, updatedAt: new Date() })
    .where(eq(aiPmConfigs.userId, userId));
}

export async function setKillSwitch(userId: string, value: boolean): Promise<void> {
  await db
    .update(aiPmConfigs)
    .set({ killSwitch: value, updatedAt: new Date() })
    .where(eq(aiPmConfigs.userId, userId));
}

export async function setEnabled(userId: string, value: boolean): Promise<void> {
  await db
    .update(aiPmConfigs)
    .set({ enabled: value, updatedAt: new Date() })
    .where(eq(aiPmConfigs.userId, userId));
}

/**
 * Validates an Anthropic API key by calling messages.create with the cheapest
 * possible request (1 input token, max_tokens=1). Does NOT persist the key.
 */
export async function testAnthropicApiKey(plaintext: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = new Anthropic({ apiKey: plaintext });
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test src/services/__tests__/ai-pm-config.service.test.ts`

Expected: 10 tests pass.

If the Anthropic mock tests fail because of how vitest handles ESM dynamic imports with `vi.doMock`, the implementer may pivot: split the SDK construction into a small factory function inside the service (e.g. `function buildAnthropicClient(apiKey) { return new Anthropic({ apiKey }); }`) and either export it for direct mocking or accept it as a default parameter. Either approach is acceptable; document the choice in the task report.

- [ ] **Step 5: Run full suite**

Run: `bun run test`

Expected: all previously-green tests still pass + new tests pass. Total: 51 + 10 = 61.

- [ ] **Step 6: Lint**

Run: `bunx eslint src/services/ai-pm-config.service.ts src/services/__tests__/ai-pm-config.service.test.ts`

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/services/ai-pm-config.service.ts src/services/__tests__/ai-pm-config.service.test.ts
git commit -m "feat(ai-pm): add config service with BYOK Anthropic key encryption"
```

---

## Self-Review

- **Spec coverage:** Session 2 spec entry asks for `createAiPmConfig`, `getAiPmConfig` (or equivalent), `setAnthropicApiKey`, and `testAnthropicApiKey`. All present plus extra setters (`setBingxApiKeyForAi`, `setKillSwitch`, `setEnabled`) that map to natural UI actions in Session 12.
- **Placeholder scan:** All code blocks complete; no TODOs.
- **Type consistency:** `AiPmConfigDecrypted` reuses `InferSelectModel` and replaces only the encrypted field with the plaintext field. `CreateAiPmConfigInput.mode` matches the enum union.
- **Security:** Plaintext key never persisted; encryption happens before insert/update; decryption only happens in `getAiPmConfig` which the caller is responsible for handling carefully.

## Done Criteria for Session 2

1. `createAiPmConfig` writes encrypted ciphertext (never plaintext) to `aiPmConfigs.anthropicApiKeyEncrypted`.
2. `getAiPmConfig` returns decrypted plaintext via `anthropicApiKey` field.
3. `setAnthropicApiKey` updates the stored ciphertext.
4. `testAnthropicApiKey` returns `{ ok: true }` on a valid SDK response and `{ ok: false, error }` on rejection.
5. All 10 tests pass; no regressions.
6. Lint clean.
