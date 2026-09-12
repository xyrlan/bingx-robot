import type { BotType } from '@/services/bots/types';
import type { BotTickEventName, BotTickEventPayload } from '@/inngest/events';

/**
 * Maps a bot type to the tick event its watcher subscribes to. GRID_LONG and
 * GRID_SHORT share one event; the watcher branches on the stored bot type.
 */
export const TYPE_TO_EVENT: Record<BotType, BotTickEventName> = {
  GRID_LONG: 'bot.tick.GRID',
  GRID_SHORT: 'bot.tick.GRID',
  DCA: 'bot.tick.DCA',
  DCA_SPOT: 'bot.tick.DCA_SPOT',
  TRAILING_STOP: 'bot.tick.TRAILING',
  SMA_CROSSOVER: 'bot.tick.SMA_CROSSOVER',
};

/**
 * Bot types whose watcher is actually registered in the Inngest serve()
 * array. Sending a tick for anything else produces an event with no
 * subscriber — silently doing nothing, which is the failure mode this
 * module exists to prevent. Keep in sync with the `functions` array in
 * src/app/api/inngest/route.ts and ENABLED_BOT_TYPES in master-tick.ts.
 */
const TYPES_WITH_WATCHER = new Set<BotType>(['GRID_LONG', 'GRID_SHORT', 'DCA']);

/**
 * Builds the tick event that makes a freshly started bot run immediately,
 * instead of idling in RUNNING until the next master-tick cron (up to
 * MASTER_TICK_INTERVAL_MINUTES away).
 *
 * Returns null when the bot type has no registered watcher, so the caller
 * can skip the send rather than emit an event nobody consumes.
 *
 * Firing the same event the cron fires means the immediate run and the next
 * scheduled run share one code path and one concurrency limit. The watcher
 * is idempotent per grid level via deterministic client order IDs, so an
 * immediate tick racing the cron adopts the in-flight orders instead of
 * duplicating them.
 */
export function botStartTickEvent(
  botType: BotType,
  botId: string
): { name: BotTickEventName; data: BotTickEventPayload } | null {
  if (!TYPES_WITH_WATCHER.has(botType)) return null;
  const name = TYPE_TO_EVENT[botType];
  if (!name) return null;
  return {
    name,
    data: { botIds: [botId], tickNumber: Math.floor(Date.now() / 60_000) },
  };
}
