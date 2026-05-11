// src/lib/backtest/__tests__/metrics.test.ts
import { describe, it, expect } from 'vitest';
import {
  pnlPct,
  maxDrawdownPct,
  sharpeApprox,
  winRatePct,
} from '@/lib/backtest/metrics';
import type { Trade } from '@/lib/backtest/types';

const trade = (over: Partial<Trade>): Trade => ({
  entryPrice: 100,
  exitPrice: 110,
  entryTime: 0,
  exitTime: 1,
  side: 'LONG',
  pnlPct: 10,
  pnlUsdt: 10,
  notionalUsdt: 100,
  ...over,
});

describe('pnlPct', () => {
  it('returns 0 for empty trades', () => {
    expect(pnlPct([], 100)).toBe(0);
  });

  it('sums pnlUsdt and divides by initial capital', () => {
    const trades = [trade({ pnlUsdt: 5 }), trade({ pnlUsdt: -2 })];
    expect(pnlPct(trades, 100)).toBeCloseTo(3, 9);
  });
});

describe('maxDrawdownPct', () => {
  it('returns 0 for monotonically increasing curve', () => {
    expect(maxDrawdownPct([0, 1, 2, 3], 100)).toBe(0);
  });

  it('measures peak-to-trough loss as percent of initial capital', () => {
    expect(maxDrawdownPct([0, 5, 10, 7, 4, 8], 100)).toBeCloseTo(6, 9);
  });

  it('handles empty curve', () => {
    expect(maxDrawdownPct([], 100)).toBe(0);
  });
});

describe('sharpeApprox', () => {
  it('returns 0 when fewer than 2 trades', () => {
    expect(sharpeApprox([])).toBe(0);
    expect(sharpeApprox([trade({ pnlPct: 5 })])).toBe(0);
  });

  it('returns 0 when stddev of returns is 0', () => {
    const ts = [trade({ pnlPct: 1 }), trade({ pnlPct: 1 }), trade({ pnlPct: 1 })];
    expect(sharpeApprox(ts)).toBe(0);
  });

  it('returns positive when mean return > 0 and there is variance', () => {
    const ts = [trade({ pnlPct: 2 }), trade({ pnlPct: -1 }), trade({ pnlPct: 4 })];
    expect(sharpeApprox(ts)).toBeGreaterThan(0);
  });
});

describe('winRatePct', () => {
  it('returns 0 for empty trades', () => {
    expect(winRatePct([])).toBe(0);
  });

  it('counts trades with pnlUsdt > 0 as wins', () => {
    const ts = [
      trade({ pnlUsdt: 10 }),
      trade({ pnlUsdt: -5 }),
      trade({ pnlUsdt: 0 }),
      trade({ pnlUsdt: 7 }),
    ];
    expect(winRatePct(ts)).toBeCloseTo(50, 9);
  });
});
