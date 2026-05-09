import type { BotType } from '@/services/bots/types';

const CADENCE_MINUTES: Record<BotType, number> = {
  GRID_LONG: 5,
  GRID_SHORT: 5,
  DCA: 5,
  DCA_SPOT: 5,
  TRAILING_STOP: 3,
  SMA_CROSSOVER: 60,
};

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
