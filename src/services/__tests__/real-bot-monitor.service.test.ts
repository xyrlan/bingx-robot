import { describe, it, expect, vi } from 'vitest';
import { tickRealBots } from '@/services/real-bot-monitor.service';
import type { OpenPosition } from '@/services/bingx.service';

const baseBot = {
  id: 'rb-1',
  userId: 'u1',
  apiKeyId: 'k1',
  symbol: 'BTC-USDT',
  botType: 'DCA' as const,
  positionSizeUsdt: '1000',
  leverage: 5,
  status: 'RUNNING' as const,
};

function fakeDb(rows: unknown[]) {
  return { select: () => ({ from: () => ({ where: async () => rows }) }) } as never;
}

interface CapturedEvent {
  name: string;
  data: Record<string, unknown>;
}

describe('real-bot-monitor', () => {
  it('emits drawdown event when real bot unrealized pnl breaches threshold', async () => {
    const captured: CapturedEvent[] = [];
    const positions: OpenPosition[] = [
      { symbol: 'BTC-USDT', positionSide: 'LONG', positionAmt: 0.5, entryPrice: 60000, unrealizedPnl: -150 },
    ];

    const result = await tickRealBots({
      db: fakeDb([baseBot]),
      configId: 'cfg1',
      userId: 'u1',
      bingxApiKeyId: 'k1',
      allowedSymbols: ['BTC-USDT'],
      maxDrawdownPct: 10,
      bingxClient: {} as never,
      fetchPositionsFn: async () => positions,
      sendEventFn: async (e) => { captured.push(e as unknown as CapturedEvent); },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const ev = captured.find((e) => e.name === 'ai-pm/event.drawdown');
    expect(ev).toBeDefined();
    expect(ev?.data.botKind).toBe('real');
    expect(ev?.data.botId).toBe('rb-1');
    expect(ev?.data.drawdownPct).toBeCloseTo(-15);
    expect(result.advanced).toBe(1);
  });

  it('does not emit when drawdown is within threshold', async () => {
    const captured: CapturedEvent[] = [];

    await tickRealBots({
      db: fakeDb([baseBot]),
      configId: 'cfg1',
      userId: 'u1',
      bingxApiKeyId: 'k1',
      allowedSymbols: ['BTC-USDT'],
      maxDrawdownPct: 20,
      bingxClient: {} as never,
      fetchPositionsFn: async () => [
        { symbol: 'BTC-USDT', positionSide: 'LONG', positionAmt: 0.5, entryPrice: 60000, unrealizedPnl: -150 },
      ],
      sendEventFn: async (e) => { captured.push(e as unknown as CapturedEvent); },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(captured.find((e) => e.name === 'ai-pm/event.drawdown')).toBeUndefined();
  });

  it('sums unrealized pnl across multiple positions for the same symbol', async () => {
    const captured: CapturedEvent[] = [];

    await tickRealBots({
      db: fakeDb([baseBot]),
      configId: 'cfg1',
      userId: 'u1',
      bingxApiKeyId: 'k1',
      allowedSymbols: ['BTC-USDT'],
      maxDrawdownPct: 10,
      bingxClient: {} as never,
      fetchPositionsFn: async () => [
        { symbol: 'BTC-USDT', positionSide: 'LONG', positionAmt: 0.3, entryPrice: 60000, unrealizedPnl: -80 },
        { symbol: 'BTC-USDT', positionSide: 'SHORT', positionAmt: 0.2, entryPrice: 61000, unrealizedPnl: -60 },
      ],
      sendEventFn: async (e) => { captured.push(e as unknown as CapturedEvent); },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const ev = captured.find((e) => e.name === 'ai-pm/event.drawdown');
    expect(ev).toBeDefined();
    expect(ev?.data.drawdownPct).toBeCloseTo(-14);
  });

  it('skips bots whose symbol is not in allowedSymbols', async () => {
    const captured: CapturedEvent[] = [];

    const result = await tickRealBots({
      db: fakeDb([{ ...baseBot, symbol: 'DOGE-USDT' }]),
      configId: 'cfg1',
      userId: 'u1',
      bingxApiKeyId: 'k1',
      allowedSymbols: ['BTC-USDT'],
      maxDrawdownPct: 5,
      bingxClient: {} as never,
      fetchPositionsFn: async () => [
        { symbol: 'DOGE-USDT', positionSide: 'LONG', positionAmt: 100, entryPrice: 0.1, unrealizedPnl: -500 },
      ],
      sendEventFn: async (e) => { captured.push(e as unknown as CapturedEvent); },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(captured).toHaveLength(0);
    expect(result.advanced).toBe(0);
  });

  it('skips non-grid filter — ignores GRID bots', async () => {
    const captured: CapturedEvent[] = [];

    const result = await tickRealBots({
      db: fakeDb([{ ...baseBot, botType: 'GRID_LONG' }]),
      configId: 'cfg1',
      userId: 'u1',
      bingxApiKeyId: 'k1',
      allowedSymbols: ['BTC-USDT'],
      maxDrawdownPct: 5,
      bingxClient: {} as never,
      fetchPositionsFn: async () => [
        { symbol: 'BTC-USDT', positionSide: 'LONG', positionAmt: 0.5, entryPrice: 60000, unrealizedPnl: -500 },
      ],
      sendEventFn: async (e) => { captured.push(e as unknown as CapturedEvent); },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(captured).toHaveLength(0);
    expect(result.advanced).toBe(0);
  });
});
