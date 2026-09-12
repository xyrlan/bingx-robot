import { describe, it, expect } from 'vitest';
import { shouldDispatch, CADENCE_MINUTES, MASTER_TICK_INTERVAL_MINUTES, MASTER_TICK_CRON } from '@/inngest/cadence';
import type { BotType } from '@/services/bots/types';

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

/**
 * The master cron only wakes on minutes divisible by its own interval, but
 * shouldDispatch() gates on `tickNumber % CADENCE_MINUTES`. Those two grids
 * must line up: if the cron interval does not divide a bot type's cadence,
 * the wake-ups and the due-minutes fall out of phase and the bot silently
 * runs slower than configured (a two-minute cron only ever sees even minutes, so
 * the odd multiples of 5 - 5, 15, 25 - are never dispatched and GRID drops
 * from 5 min to 10 min).
 */
describe('master cron interval vs bot cadences', () => {
  const ENABLED: BotType[] = ['GRID_LONG', 'GRID_SHORT', 'DCA'];

  function dispatchesPerHour(botType: BotType, cronInterval: number): number {
    let count = 0;
    for (let minute = 0; minute < 60; minute++) {
      if (minute % cronInterval !== 0) continue; // cron asleep this minute
      if (shouldDispatch(botType, minute)) count++;
    }
    return count;
  }

  it('cron interval divides every enabled bot cadence', () => {
    for (const botType of ENABLED) {
      expect(
        CADENCE_MINUTES[botType] % MASTER_TICK_INTERVAL_MINUTES,
        `cron interval ${MASTER_TICK_INTERVAL_MINUTES}min does not divide ${botType} cadence of ${CADENCE_MINUTES[botType]}min`
      ).toBe(0);
    }
  });

  it('every enabled bot type dispatches at its configured cadence', () => {
    for (const botType of ENABLED) {
      const expected = 60 / CADENCE_MINUTES[botType];
      expect(
        dispatchesPerHour(botType, MASTER_TICK_INTERVAL_MINUTES),
        `${botType} should dispatch ${expected}x/hour`
      ).toBe(expected);
    }
  });

  it('the declared cron string matches the interval constant', () => {
    expect(MASTER_TICK_CRON).toBe(`*/${MASTER_TICK_INTERVAL_MINUTES} * * * *`);
  });

  it('detects the out-of-phase bug a */2 cron would introduce', () => {
    // Regression guard: GRID at 5min under a two-minute cron only sees 0,10,20,...
    expect(dispatchesPerHour('GRID_LONG', 2)).toBe(6); // 10min, not 5min
    expect(dispatchesPerHour('GRID_LONG', 5)).toBe(12); // correct 5min
  });
});
