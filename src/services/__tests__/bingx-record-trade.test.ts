import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sentEvents: Array<{ name: string; data: Record<string, unknown> }> = [];

// Mock inngest.send to capture emitted events
vi.mock('@/inngest/client', () => ({
  inngest: {
    send: async (event: { name: string; data: Record<string, unknown> }) => {
      sentEvents.push(event);
    },
  },
}));

// Mock the maybeEmitFillEvent module so we exercise the real one in recordTrade
// but mock the config lookup to return a known config
vi.mock('@/services/ai-pm-config.service', () => ({
  getAiPmConfigByBingxApiKeyId: vi.fn(),
}));

// Mock db so insert is a no-op + tradingBots lookup is controllable
const dbMock = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => [],
      }),
    }),
  }),
  insert: () => ({ values: async () => undefined }),
  query: {
    tradingBots: {
      findFirst: async () => ({ id: 'bot-1', apiKeyId: 'key-1' }),
    },
  },
};

vi.mock('@/db', () => ({
  db: dbMock,
}));

describe('recordTrade emits ai-pm/event.fill for AI-managed bots', () => {
  beforeEach(() => {
    sentEvents.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('emits fill event when bot apiKey is managed by AI', async () => {
    const { getAiPmConfigByBingxApiKeyId } = await import('@/services/ai-pm-config.service');
    (getAiPmConfigByBingxApiKeyId as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'cfg-1' });

    const { recordTrade } = await import('@/services/bingx.service');
    await recordTrade({
      botId: 'bot-1',
      symbol: 'BTC-USDT',
      side: 'LONG',
      type: 'ENTRY',
      price: 50000,
      quantity: 0.01,
      orderId: 'ord-1',
    });

    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0].name).toBe('ai-pm/event.fill');
    const data = sentEvents[0].data as { configId: string; symbol: string; orderType: string; botKind: string };
    expect(data.configId).toBe('cfg-1');
    expect(data.symbol).toBe('BTC-USDT');
    expect(data.orderType).toBe('ENTRY');
    expect(data.botKind).toBe('real');
  });

  it('does not emit when no AI PM config matches the apiKey', async () => {
    const { getAiPmConfigByBingxApiKeyId } = await import('@/services/ai-pm-config.service');
    (getAiPmConfigByBingxApiKeyId as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { recordTrade } = await import('@/services/bingx.service');
    await recordTrade({
      botId: 'bot-1',
      symbol: 'BTC-USDT',
      side: 'LONG',
      type: 'EXIT_TP',
      price: 50500,
      quantity: 0.01,
      orderId: 'ord-2',
    });

    expect(sentEvents).toHaveLength(0);
  });

  it('does not throw when emission fails (resilient)', async () => {
    const { getAiPmConfigByBingxApiKeyId } = await import('@/services/ai-pm-config.service');
    (getAiPmConfigByBingxApiKeyId as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db down'));

    const { recordTrade } = await import('@/services/bingx.service');
    await expect(recordTrade({
      botId: 'bot-1',
      symbol: 'BTC-USDT',
      side: 'LONG',
      type: 'ENTRY',
      price: 50000,
      quantity: 0.01,
    })).resolves.toBeUndefined();
    expect(sentEvents).toHaveLength(0);
  });
});
