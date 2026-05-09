import { describe, it, expect } from 'vitest';
import { shouldDispatch } from '@/inngest/cadence';

describe('shouldDispatch', () => {
  it('GRID dispatches every 5 minutes', () => {
    expect(shouldDispatch('GRID_LONG', 0)).toBe(true);
    expect(shouldDispatch('GRID_LONG', 1)).toBe(false);
    expect(shouldDispatch('GRID_LONG', 4)).toBe(false);
    expect(shouldDispatch('GRID_LONG', 5)).toBe(true);
    expect(shouldDispatch('GRID_LONG', 10)).toBe(true);
  });

  it('GRID_SHORT shares the GRID cadence', () => {
    expect(shouldDispatch('GRID_SHORT', 0)).toBe(true);
    expect(shouldDispatch('GRID_SHORT', 5)).toBe(true);
    expect(shouldDispatch('GRID_SHORT', 3)).toBe(false);
  });

  it('DCA dispatches every 5 minutes', () => {
    expect(shouldDispatch('DCA', 0)).toBe(true);
    expect(shouldDispatch('DCA', 5)).toBe(true);
    expect(shouldDispatch('DCA', 4)).toBe(false);
  });

  it('DCA_SPOT shares the DCA cadence', () => {
    expect(shouldDispatch('DCA_SPOT', 5)).toBe(true);
    expect(shouldDispatch('DCA_SPOT', 4)).toBe(false);
  });

  it('TRAILING_STOP dispatches every 3 minutes', () => {
    expect(shouldDispatch('TRAILING_STOP', 0)).toBe(true);
    expect(shouldDispatch('TRAILING_STOP', 3)).toBe(true);
    expect(shouldDispatch('TRAILING_STOP', 6)).toBe(true);
    expect(shouldDispatch('TRAILING_STOP', 1)).toBe(false);
    expect(shouldDispatch('TRAILING_STOP', 5)).toBe(false);
  });

  it('SMA_CROSSOVER dispatches every 60 minutes', () => {
    expect(shouldDispatch('SMA_CROSSOVER', 0)).toBe(true);
    expect(shouldDispatch('SMA_CROSSOVER', 60)).toBe(true);
    expect(shouldDispatch('SMA_CROSSOVER', 120)).toBe(true);
    expect(shouldDispatch('SMA_CROSSOVER', 1)).toBe(false);
    expect(shouldDispatch('SMA_CROSSOVER', 59)).toBe(false);
  });

  it('returns false for unknown bot types', () => {
    // @ts-expect-error testing runtime guard
    expect(shouldDispatch('UNKNOWN', 0)).toBe(false);
  });
});
