import { describe, it, expect, vi } from 'vitest';
import { tickPaperBots, computeDrawdownPct } from '@/services/paper-bot-sim.service';

const baseBot = {
  id: 'pb-1',
  userId: 'u1',
  decisionId: null,
  symbol: 'BTC-USDT',
  strategy: 'DCA' as const,
  capitalUsdt: '1000',
  status: 'RUNNING' as const,
  pnlUsdt: '0',
  startedAt: new Date(),
  stoppedAt: null,
  trades: [],
  params: { leverage: 1, reasoning: '' },
  createdAt: new Date(),
};

describe('paper-bot-sim', () => {
  it('computeDrawdownPct returns negative percentage from pnl/capital', () => {
    expect(computeDrawdownPct({ pnlUsdt: '-150', capitalUsdt: '1000' })).toBeCloseTo(-15);
    expect(computeDrawdownPct({ pnlUsdt: '0', capitalUsdt: '1000' })).toBeCloseTo(0);
    expect(computeDrawdownPct({ pnlUsdt: '50', capitalUsdt: '1000' })).toBeCloseTo(5);
  });

  it('tickPaperBots updates pnlUsdt using last candle close vs starting price', async () => {
    const fetchKlinesFn = vi.fn().mockResolvedValue([
      { open: 100, high: 110, low: 90, close: 95, openTime: 1, closeTime: 2, volume: 0 },
    ]);
    const fakeDb = {
      query: { paperBots: { findMany: async () => [{ ...baseBot, pnlUsdt: '0', params: { ...baseBot.params, lastSimPrice: 100 } }] } },
      update: () => ({ set: (patch: { pnlUsdt: string }) => ({ where: () => ({ returning: async () => [{ ...baseBot, pnlUsdt: patch.pnlUsdt }] }) }) }),
    } as never;
    const sendEventFn = vi.fn();

    const ticked = await tickPaperBots({
      db: fakeDb,
      configId: 'cfg1',
      userId: 'u1',
      allowedSymbols: ['BTC-USDT'],
      maxDrawdownPct: 50,
      fetchKlinesFn,
      sendEventFn,
      bingxClient: {} as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(ticked.advanced).toBe(1);
    // pnl decreases because close (95) < lastSimPrice (100); capital 1000 → pnl ≈ -50
    expect(ticked.bots[0].newPnlUsdt).toBeCloseTo(-50, 0);
  });

  it('tickPaperBots emits drawdown event when threshold breached', async () => {
    const fetchKlinesFn = vi.fn().mockResolvedValue([
      { open: 100, high: 110, low: 50, close: 60, openTime: 1, closeTime: 2, volume: 0 },
    ]);
    const captured: unknown[] = [];
    const sendEventFn = vi.fn(async (ev: unknown) => { captured.push(ev); });
    const fakeDb = {
      query: { paperBots: { findMany: async () => [{ ...baseBot, params: { ...baseBot.params, lastSimPrice: 100 } }] } },
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [baseBot] }) }) }),
    } as never;

    await tickPaperBots({
      db: fakeDb,
      configId: 'cfg1',
      userId: 'u1',
      allowedSymbols: ['BTC-USDT'],
      maxDrawdownPct: 10,
      fetchKlinesFn,
      sendEventFn,
      bingxClient: {} as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const drawdownEvent = captured.find((e) => (e as { name: string }).name === 'ai-pm/event.drawdown');
    expect(drawdownEvent).toBeDefined();
  });
});
