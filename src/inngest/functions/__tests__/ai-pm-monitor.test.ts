import { describe, it, expect, vi } from 'vitest';
import { runMonitorForConfig } from '@/inngest/functions/ai-pm-monitor';

function baseCfg() {
  return {
    id: 'cfg1',
    userId: 'u1',
    bingxApiKeyId: 'k1',
    enabled: true,
    killSwitch: false,
    paperMode: true,
    maxDrawdownPct: '10',
    allowedSymbols: ['BTC-USDT'],
    anthropicApiKey: 'sk',
  };
}

describe('ai-pm-monitor', () => {
  it('emits funding-flip when sign of rate changes vs cache', async () => {
    const sent: unknown[] = [];
    const fakeDb = {
      query: {
        paperBots: { findMany: async () => [] },
        aiPmFundingCache: { findFirst: async () => ({ symbol: 'BTC-USDT', fundingRate: '0.0010' }) },
      },
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
      insert: () => ({ values: () => ({ onConflictDoUpdate: () => ({ returning: async () => [] }) }) }),
    } as never;

    await runMonitorForConfig({
      db: fakeDb,
      config: baseCfg(),
      loadBingxClientFn: async () => ({}) as never,
      fetchFundingRateFn: async () => -0.0008,
      tickPaperBotsFn: vi.fn().mockResolvedValue({ advanced: 0, bots: [] }),
      sendEventFn: async (e) => { sent.push(e); },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(sent.find((e) => (e as { name: string }).name === 'ai-pm/event.funding-flip')).toBeDefined();
  });

  it('does not emit funding-flip when sign unchanged', async () => {
    const sent: unknown[] = [];
    const fakeDb = {
      query: {
        paperBots: { findMany: async () => [] },
        aiPmFundingCache: { findFirst: async () => ({ symbol: 'BTC-USDT', fundingRate: '0.0010' }) },
      },
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
      insert: () => ({ values: () => ({ onConflictDoUpdate: () => ({ returning: async () => [] }) }) }),
    } as never;

    await runMonitorForConfig({
      db: fakeDb,
      config: baseCfg(),
      loadBingxClientFn: async () => ({}) as never,
      fetchFundingRateFn: async () => 0.0015,
      tickPaperBotsFn: vi.fn().mockResolvedValue({ advanced: 0, bots: [] }),
      sendEventFn: async (e) => { sent.push(e); },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(sent.find((e) => (e as { name: string }).name === 'ai-pm/event.funding-flip')).toBeUndefined();
  });

  it('calls tickPaperBots once with config thresholds', async () => {
    const tickFn = vi.fn().mockResolvedValue({ advanced: 0, bots: [] });
    const fakeDb = {
      query: {
        paperBots: { findMany: async () => [] },
        aiPmFundingCache: { findFirst: async () => null },
      },
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
      insert: () => ({ values: () => ({ onConflictDoUpdate: () => ({ returning: async () => [] }) }) }),
    } as never;

    await runMonitorForConfig({
      db: fakeDb,
      config: baseCfg(),
      loadBingxClientFn: async () => ({}) as never,
      fetchFundingRateFn: async () => 0,
      tickPaperBotsFn: tickFn,
      sendEventFn: async () => {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(tickFn).toHaveBeenCalledWith(expect.objectContaining({
      configId: 'cfg1',
      userId: 'u1',
      maxDrawdownPct: 10,
      allowedSymbols: ['BTC-USDT'],
    }));
  });
});
