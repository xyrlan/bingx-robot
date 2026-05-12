import { describe, it, expect, vi } from 'vitest';
import { handleAiPmEvent } from '@/inngest/functions/ai-pm-event-handler';
import type { FillPayload, ChatPayload } from '@/lib/ai-pm/events';

function basics() {
  return {
    insertAiEventFn: vi.fn().mockResolvedValue('ev-1'),
    markEventFn: vi.fn().mockResolvedValue(undefined),
    checkThrottleFn: vi.fn().mockResolvedValue(false),
    loadConfigFn: vi.fn().mockResolvedValue({
      id: 'cfg1', userId: 'u1', bingxApiKeyId: 'k1', paperMode: true,
      enabled: true, killSwitch: false,
      maxCapitalUsdt: '1000', maxConcurrentBots: 5,
      allowedSymbols: ['BTC-USDT'], allowedStrategies: ['DCA'],
      anthropicApiKey: 'sk',
    }),
    loadBingxClientFn: vi.fn().mockResolvedValue({}),
    loadPortfolioFn: vi.fn().mockResolvedValue({ totalEquityUsdt: 1000, openPositions: [], openBots: [] }),
    runScopedFn: vi.fn().mockResolvedValue({
      status: 'COMPLETED', proposedCount: 1, executedCount: 1, failedCount: 0, rejectedCount: 0, executedDecisionId: 'dec-1',
    }),
    runChatFn: vi.fn().mockResolvedValue({ decisionId: null, assistantText: 'hi' }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

const fillPayload: FillPayload = {
  configId: 'cfg1', emittedAt: new Date().toISOString(),
  symbol: 'BTC-USDT', botId: 'b1', botKind: 'paper',
  side: 'LONG', fillPrice: '50000', quantity: '0.01', orderType: 'ENTRY',
};

const chatPayload: ChatPayload = {
  configId: 'cfg1', emittedAt: new Date().toISOString(),
  symbol: null, chatMessageId: 'msg-1', userMessage: 'how is BTC?',
};

describe('handleAiPmEvent', () => {
  it('inserts event, runs scoped pipeline, marks PROCESSED', async () => {
    const b = basics();
    const result = await handleAiPmEvent({
      eventName: 'ai-pm/event.fill',
      data: fillPayload,
      db: {} as never,
      ...b,
    });
    expect(b.insertAiEventFn).toHaveBeenCalled();
    expect(b.runScopedFn).toHaveBeenCalled();
    expect(b.markEventFn).toHaveBeenCalledWith(expect.objectContaining({ aiEventId: 'ev-1', status: 'PROCESSED', decisionId: 'dec-1' }));
    expect(result.status).toBe('PROCESSED');
  });

  it('marks THROTTLED and skips pipeline when checkThrottle returns true', async () => {
    const b = basics();
    b.checkThrottleFn.mockResolvedValueOnce(true);
    const result = await handleAiPmEvent({
      eventName: 'ai-pm/event.fill',
      data: fillPayload,
      db: {} as never,
      ...b,
    });
    expect(b.runScopedFn).not.toHaveBeenCalled();
    expect(b.markEventFn).toHaveBeenCalledWith(expect.objectContaining({ aiEventId: 'ev-1', status: 'THROTTLED' }));
    expect(result.status).toBe('THROTTLED');
  });

  it('routes chat events through runChatPipeline (no signal/decision call)', async () => {
    const b = basics();
    const result = await handleAiPmEvent({
      eventName: 'ai-pm/event.chat',
      data: chatPayload,
      db: {} as never,
      ...b,
    });
    expect(b.runChatFn).toHaveBeenCalled();
    expect(b.runScopedFn).not.toHaveBeenCalled();
    expect(result.status).toBe('PROCESSED');
  });

  it('marks FAILED and rethrows when scoped pipeline throws', async () => {
    const b = basics();
    b.runScopedFn.mockRejectedValueOnce(new Error('boom'));
    await expect(
      handleAiPmEvent({ eventName: 'ai-pm/event.fill', data: fillPayload, db: {} as never, ...b })
    ).rejects.toThrow('boom');
    expect(b.markEventFn).toHaveBeenCalledWith(expect.objectContaining({ aiEventId: 'ev-1', status: 'FAILED' }));
  });

  it('returns SKIPPED_CONFIG_DISABLED when config not enabled and event is non-chat', async () => {
    const b = basics();
    b.loadConfigFn.mockResolvedValueOnce({ ...await b.loadConfigFn(), enabled: false });
    const result = await handleAiPmEvent({
      eventName: 'ai-pm/event.fill',
      data: fillPayload,
      db: {} as never,
      ...b,
    });
    expect(b.runScopedFn).not.toHaveBeenCalled();
    expect(result.status).toBe('SKIPPED_CONFIG_DISABLED');
  });
});
