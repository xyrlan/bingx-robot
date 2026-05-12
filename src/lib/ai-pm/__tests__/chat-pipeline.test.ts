import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { db } from '@/db';
import { users, aiChatMessages, aiDecisions, bingxApiKeys } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { runChatPipeline } from '@/lib/ai-pm/chat-pipeline';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000090';
const CONFIG_ID = '00000000-0000-0000-0000-000000000091';
const API_KEY_ID = '00000000-0000-0000-0000-000000000092';

async function ensureUser() {
  await db.insert(users).values({ id: TEST_USER_ID, email: 'cp@example.com' }).onConflictDoNothing();
  await db.insert(bingxApiKeys).values({ id: API_KEY_ID, userId: TEST_USER_ID, label: 'k', apiKey: 'a', secretKeyEncrypted: 'b' }).onConflictDoNothing();
}

async function cleanup() {
  await db.delete(aiDecisions).where(eq(aiDecisions.userId, TEST_USER_ID));
  await db.delete(aiChatMessages).where(eq(aiChatMessages.userId, TEST_USER_ID));
}

const baseConfig = {
  id: CONFIG_ID,
  userId: TEST_USER_ID,
  bingxApiKeyId: API_KEY_ID,
  anthropicApiKey: 'sk-test',
  enabled: true,
  mode: 'BALANCED' as const,
  maxCapitalUsdt: '1000',
  maxDrawdownPct: '20',
  maxLeverage: 5,
  allowedSymbols: [],
  allowedStrategies: [],
  maxConcurrentBots: 5,
  monthlyLlmBudgetUsd: '100',
  killSwitch: false,
  paperMode: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('runChatPipeline', () => {
  beforeAll(async () => {
    await ensureUser();
    await cleanup();
  });
  afterEach(async () => {
    await cleanup();
  });

  it('writes canned message and skips loop when config.enabled is false', async () => {
    const runToolLoopFn = vi.fn();
    const got = await runChatPipeline({
      payload: { configId: CONFIG_ID, userMessage: 'hi', symbol: null, chatMessageId: 'src-dis', emittedAt: new Date().toISOString() },
      aiEventId: 'evt',
      config: { ...baseConfig, enabled: false },
      portfolioState: { runningBots: [], capitalUsedUsdt: 0, bingxApiKeyId: API_KEY_ID },
      db,
      loadChatHistoryFn: async () => [],
      isKillSwitchActive: async () => false,
      runToolLoopFn,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    expect(runToolLoopFn).not.toHaveBeenCalled();
    expect(got.assistantText).toMatch(/not enabled/i);
    const rows = await db.select().from(aiChatMessages).where(eq(aiChatMessages.userId, TEST_USER_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toMatch(/not enabled/i);
  });

  it('writes canned message and skips loop when kill switch is active', async () => {
    const runToolLoopFn = vi.fn();
    const got = await runChatPipeline({
      payload: { configId: CONFIG_ID, userMessage: 'hi', symbol: null, chatMessageId: 'src1', emittedAt: new Date().toISOString() },
      aiEventId: 'evt',
      config: baseConfig,
      portfolioState: { runningBots: [], capitalUsedUsdt: 0, bingxApiKeyId: API_KEY_ID },
      db,
      loadChatHistoryFn: async () => [],
      isKillSwitchActive: async () => true,
      runToolLoopFn,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    expect(runToolLoopFn).not.toHaveBeenCalled();
    expect(got.assistantText).toMatch(/kill switch/i);
    const rows = await db.select().from(aiChatMessages).where(eq(aiChatMessages.userId, TEST_USER_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toMatch(/kill switch/i);
  });

  it('pre-inserts assistant row, runs loop, and persists toolCalls + usage', async () => {
    // Seed a real decision row so the FK in ai_chat_messages.decision_id resolves.
    const [decision] = await db
      .insert(aiDecisions)
      .values({
        userId: TEST_USER_ID,
        triggeredBy: 'CHAT',
        actionType: 'NO_ACTION',
        status: 'EXECUTED',
        reasoning: 'risk',
      })
      .returning();
    const decisionId = decision.id;

    const runToolLoopFn = vi.fn().mockImplementation(async ({ ctx }) => {
      expect(ctx.chatMessageId).toBeTruthy();
      return {
        assistantText: 'all done',
        toolCallEntries: [
          { toolName: 'read_portfolio', args: {}, status: 'EXECUTED', decisionId: null, summary: 'snapshot' },
          { toolName: 'pause_kill_switch', args: { reason: 'risk' }, status: 'EXECUTED', decisionId, summary: 'kill on' },
        ],
        cumulativeUsage: { inputTokens: 10, outputTokens: 20, cachedInputTokens: 0, costUsd: 0.002, model: 'claude-sonnet-4-6' },
      };
    });

    const got = await runChatPipeline({
      payload: { configId: CONFIG_ID, userMessage: 'do it', symbol: null, chatMessageId: 'src2', emittedAt: new Date().toISOString() },
      aiEventId: 'evt',
      config: baseConfig,
      portfolioState: { runningBots: [], capitalUsedUsdt: 0, bingxApiKeyId: API_KEY_ID },
      db,
      loadChatHistoryFn: async () => [],
      isKillSwitchActive: async () => false,
      runToolLoopFn,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    expect(got.assistantText).toBe('all done');
    expect(got.decisionId).toBe(decisionId);

    const rows = await db.select().from(aiChatMessages).where(eq(aiChatMessages.userId, TEST_USER_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('all done');
    expect(rows[0].decisionId).toBe(decisionId);
    expect(rows[0].tokensInput).toBe(10);
    expect(rows[0].tokensOutput).toBe(20);
    expect(Array.isArray(rows[0].toolCalls)).toBe(true);
    expect((rows[0].toolCalls as unknown[]).length).toBe(2);
  });

  it('survives loop throwing — placeholder row updated with error text', async () => {
    const runToolLoopFn = vi.fn().mockRejectedValue(new Error('boom'));
    const got = await runChatPipeline({
      payload: { configId: CONFIG_ID, userMessage: 'x', symbol: null, chatMessageId: 'src3', emittedAt: new Date().toISOString() },
      aiEventId: 'evt',
      config: baseConfig,
      portfolioState: { runningBots: [], capitalUsedUsdt: 0, bingxApiKeyId: API_KEY_ID },
      db,
      loadChatHistoryFn: async () => [],
      isKillSwitchActive: async () => false,
      runToolLoopFn,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    expect(got.assistantText).toMatch(/internal error/i);
    const rows = await db.select().from(aiChatMessages).where(eq(aiChatMessages.userId, TEST_USER_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toMatch(/internal error/i);
  });

  it('forwards bingxClient into ToolExecContext when provided', async () => {
    const runToolLoopFn = vi.fn().mockImplementation(async ({ ctx }) => {
      expect(ctx.bingxClient).toBeTruthy();
      expect((ctx.bingxClient as { tag: string }).tag).toBe('fake-client');
      return {
        assistantText: 'ok',
        toolCallEntries: [],
        cumulativeUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, model: 'claude-sonnet-4-6' },
      };
    });

    await runChatPipeline({
      payload: { configId: CONFIG_ID, userMessage: 'x', symbol: null, chatMessageId: 'src-bx', emittedAt: new Date().toISOString() },
      aiEventId: 'evt',
      config: baseConfig,
      portfolioState: { runningBots: [], capitalUsedUsdt: 0, bingxApiKeyId: API_KEY_ID },
      db,
      loadChatHistoryFn: async () => [],
      isKillSwitchActive: async () => false,
      runToolLoopFn,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bingxClient: { tag: 'fake-client' } as any,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    expect(runToolLoopFn).toHaveBeenCalled();
  });
});
