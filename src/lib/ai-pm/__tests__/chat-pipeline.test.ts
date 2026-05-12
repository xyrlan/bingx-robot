import { describe, it, expect, vi } from 'vitest';
import { runChatPipeline } from '@/lib/ai-pm/chat-pipeline';
import type { ChatPayload } from '@/lib/ai-pm/events';

function fakeConfig() {
  return {
    id: 'cfg1',
    userId: 'user-1',
    bingxApiKeyId: 'key-1',
    paperMode: true,
    enabled: true,
    killSwitch: false,
    maxCapitalUsdt: '1000',
    maxConcurrentBots: 5,
    allowedSymbols: ['BTC-USDT'],
    allowedStrategies: ['DCA'] as Array<'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER'>,
    anthropicApiKey: 'sk-test',
  };
}

describe('runChatPipeline', () => {
  it('persists assistant reply with no decisionId when chat decision yields no action', async () => {
    const inserts: unknown[] = [];
    const chatDecisionFn = vi.fn().mockResolvedValue({
      kind: 'reply',
      assistantText: 'Markets look choppy. I will wait.',
      usage: { inputTokens: 50, outputTokens: 20, costUsd: 0.0003 },
    });
    const fakeDb = {
      insert: () => ({ values: (v: unknown) => ({ returning: async () => { inserts.push(v); return [{ id: 'msg-2' }]; } }) }),
    } as never;

    const payload: ChatPayload = {
      configId: 'cfg1',
      emittedAt: new Date().toISOString(),
      symbol: null,
      chatMessageId: 'msg-1',
      userMessage: 'how is the market?',
    };

    const result = await runChatPipeline({
      payload,
      aiEventId: 'ev-1',
      config: fakeConfig() as never,
      portfolioState: { totalEquityUsdt: 1000, openPositions: [], openBots: [] } as never,
      db: fakeDb,
      chatDecisionFn,
      isKillSwitchActive: async () => false,
      loadChatHistoryFn: async () => [],
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(result.decisionId).toBeNull();
    expect(result.assistantText).toBe('Markets look choppy. I will wait.');
    expect(inserts).toHaveLength(1);
  });

  it('returns reply text + null decisionId when kill switch active', async () => {
    const result = await runChatPipeline({
      payload: { configId: 'cfg1', emittedAt: '', symbol: null, chatMessageId: 'msg-1', userMessage: 'hi' },
      aiEventId: 'ev-1',
      config: fakeConfig() as never,
      portfolioState: { totalEquityUsdt: 0, openPositions: [], openBots: [] } as never,
      db: { insert: () => ({ values: () => ({ returning: async () => [{ id: 'm' }] }) }) } as never,
      chatDecisionFn: vi.fn(),
      isKillSwitchActive: async () => true,
      loadChatHistoryFn: async () => [],
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    expect(result.decisionId).toBeNull();
    expect(result.assistantText).toMatch(/disabled/i);
  });
});
