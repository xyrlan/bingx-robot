import { describe, it, expect } from 'vitest';
import { AI_PM_SYMBOLS } from '@/lib/ai-pm/symbols';

describe('AI_PM_SYMBOLS', () => {
  it('is a non-empty curated list', () => {
    expect(AI_PM_SYMBOLS.length).toBeGreaterThan(20);
  });

  it('every entry has a XXX-USDT code and a friendly name distinct from the code', () => {
    for (const s of AI_PM_SYMBOLS) {
      expect(s.code).toMatch(/^[A-Z0-9]+-USDT$/);
      expect(s.name.trim().length).toBeGreaterThan(0);
      expect(s.name).not.toBe(s.code);
    }
  });

  it('has unique codes', () => {
    const codes = AI_PM_SYMBOLS.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('includes the majors', () => {
    const codes = new Set(AI_PM_SYMBOLS.map((s) => s.code));
    expect(codes.has('BTC-USDT')).toBe(true);
    expect(codes.has('ETH-USDT')).toBe(true);
    expect(codes.has('SOL-USDT')).toBe(true);
    expect(codes.has('SUI-USDT')).toBe(true);
  });
});
