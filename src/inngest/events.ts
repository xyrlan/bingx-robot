/**
 * Inngest event names + payload types for AI portfolio orchestration.
 * Master tick (master-tick.ts) emits these events when corresponding
 * bots are due for a cadence cycle. Strategy handlers consume them.
 */

export type BotTickEventName =
  | 'bot.tick.GRID'
  | 'bot.tick.DCA'
  | 'bot.tick.DCA_SPOT'
  | 'bot.tick.TRAILING'
  | 'bot.tick.SMA_CROSSOVER';

export interface BotTickEventPayload {
  botIds: string[];
  tickNumber: number;
}
