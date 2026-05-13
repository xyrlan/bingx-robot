import { describe, it, expect } from 'vitest';
import { mapNameToEnum, AI_PM_EVENT_NAMES } from '@/lib/ai-pm/events';
import type {
  FillPayload,
  ErrorPayload,
  DrawdownPayload,
  FundingFlipPayload,
} from '@/lib/ai-pm/events';

describe('events', () => {
  it('AI_PM_EVENT_NAMES contains the autonomous event names', () => {
    expect(AI_PM_EVENT_NAMES).toEqual([
      'ai-pm/event.fill',
      'ai-pm/event.error',
      'ai-pm/event.drawdown',
      'ai-pm/event.funding-flip',
    ]);
  });

  it('mapNameToEnum maps each event name to its DB enum', () => {
    expect(mapNameToEnum('ai-pm/event.fill')).toBe('EVENT_FILL');
    expect(mapNameToEnum('ai-pm/event.error')).toBe('EVENT_ERROR');
    expect(mapNameToEnum('ai-pm/event.drawdown')).toBe('EVENT_DRAWDOWN');
    expect(mapNameToEnum('ai-pm/event.funding-flip')).toBe('EVENT_FUNDING_FLIP');
  });

  it('FillPayload type accepts a real-bot fill', () => {
    const p: FillPayload = {
      configId: 'cfg',
      emittedAt: new Date().toISOString(),
      symbol: 'BTC-USDT',
      botId: 'bot',
      botKind: 'real',
      side: 'LONG',
      fillPrice: '50000',
      quantity: '0.01',
      orderType: 'ENTRY',
    };
    expect(p.botKind).toBe('real');
  });

  it('ErrorPayload accepts an unknown errorKind only via UNKNOWN literal', () => {
    const p: ErrorPayload = {
      configId: 'cfg',
      emittedAt: new Date().toISOString(),
      symbol: 'BTC-USDT',
      botId: 'bot',
      botKind: 'real',
      errorKind: 'UNKNOWN',
      message: 'boom',
    };
    expect(p.errorKind).toBe('UNKNOWN');
  });

  it('DrawdownPayload + FundingFlipPayload compile', () => {
    const d: DrawdownPayload = {
      configId: 'cfg',
      emittedAt: '',
      symbol: 'BTC-USDT',
      botId: 'bot',
      botKind: 'paper',
      drawdownPct: -12.5,
      thresholdPct: 10,
      currentPnlUsdt: '-125',
      capitalUsdt: '1000',
    };
    const f: FundingFlipPayload = {
      configId: 'cfg',
      emittedAt: '',
      symbol: 'BTC-USDT',
      previousRate: 0.0012,
      currentRate: -0.0008,
    };
    expect(d.drawdownPct).toBeLessThan(0);
    expect(f.previousRate * f.currentRate).toBeLessThan(0);
  });
});
