import type { BotType } from '@/services/bots/types';

export const CADENCE_MINUTES: Record<BotType, number> = {
  GRID_LONG: 5,
  GRID_SHORT: 5,
  DCA: 5,
  DCA_SPOT: 5,
  TRAILING_STOP: 3,
  SMA_CROSSOVER: 60,
};

/**
 * How often the master-tick cron wakes up, in minutes.
 *
 * This MUST divide every enabled bot type's cadence in CADENCE_MINUTES.
 * shouldDispatch() gates on `tickNumber % cadence`, where tickNumber is a
 * wall-clock minute counter — so the cron only ever observes minutes that
 * are multiples of this interval. If the interval does not divide a cadence,
 * the two grids fall out of phase and the bot silently runs slower than
 * configured: a 2-minute cron only sees even minutes, so the odd multiples
 * of 5 (5, 15, 25...) are never dispatched and GRID degrades from 5min to
 * 10min. Waking exactly on the cadence keeps phase alignment and costs the
 * fewest Inngest invocations (a 1-minute cron discarded 4 of every 5 runs).
 */
export const MASTER_TICK_INTERVAL_MINUTES = 5;

/** Cron expression for master-tick, derived from the interval above. */
export const MASTER_TICK_CRON = `*/${MASTER_TICK_INTERVAL_MINUTES} * * * *`;

/**
 * Returns true when the given bot type is due to be dispatched at the
 * given tick number. `tickNumber` is a monotonically-increasing minute
 * counter (typically Math.floor(Date.now() / 60_000)).
 */
export function shouldDispatch(botType: BotType, tickNumber: number): boolean {
  const interval = CADENCE_MINUTES[botType];
  if (!interval) return false;
  return tickNumber % interval === 0;
}
