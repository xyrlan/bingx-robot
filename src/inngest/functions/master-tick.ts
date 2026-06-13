import { inngest } from '@/inngest/client';
import { db } from '@/db';
import { tradingBots } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { shouldDispatch } from '@/inngest/cadence';
import type { BotType } from '@/services/bots/types';
import type { BotTickEventName, BotTickEventPayload } from '@/inngest/events';

const TYPE_TO_EVENT: Record<BotType, BotTickEventName> = {
  GRID_LONG: 'bot.tick.GRID',
  GRID_SHORT: 'bot.tick.GRID',
  DCA: 'bot.tick.DCA',
  DCA_SPOT: 'bot.tick.DCA_SPOT',
  TRAILING_STOP: 'bot.tick.TRAILING',
  SMA_CROSSOVER: 'bot.tick.SMA_CROSSOVER',
};

// Only these bot types run. AI PM and the extra strategies (TRAILING_STOP,
// DCA_SPOT, SMA_CROSSOVER) are disabled — any RUNNING rows of those types are
// ignored here. Re-enable by adding the type back to this set.
const ENABLED_BOT_TYPES = new Set<BotType>(['GRID_LONG', 'GRID_SHORT', 'DCA']);

interface BotRow {
  id: string;
  botType: BotType;
}

export const masterTick = inngest.createFunction(
  {
    id: 'master-tick',
    name: 'Master Tick (orchestrator)',
    retries: 3,
    concurrency: { limit: 1 },
  },
  { cron: '*/1 * * * *' },
  async ({ step, logger }) => {
    const now = Date.now();
    const tickNumber = Math.floor(now / 60_000);

    const bots = await step.run('load-running-bots', async (): Promise<BotRow[]> => {
      const rows = await db
        .select({
          id: tradingBots.id,
          botType: tradingBots.botType,
        })
        .from(tradingBots)
        .where(eq(tradingBots.status, 'RUNNING'));
      return rows;
    });

    if (bots.length === 0) {
      return { tickNumber, dispatched: {} as Record<string, number> };
    }

    // Group by event name (multiple bot types can map to same event, e.g. GRID_LONG + GRID_SHORT)
    const byEvent = new Map<BotTickEventName, string[]>();
    for (const bot of bots) {
      const eventName = TYPE_TO_EVENT[bot.botType];
      if (!eventName) continue;

      // Skip disabled bot types regardless of managed_by_ai state.
      if (!ENABLED_BOT_TYPES.has(bot.botType)) continue;

      // Cadence is keyed off the source bot type, not the target event.
      // GRID_LONG and GRID_SHORT share cadence (5 min). Either one in the group is sufficient.
      if (!shouldDispatch(bot.botType, tickNumber)) continue;
      const list = byEvent.get(eventName) ?? [];
      list.push(bot.id);
      byEvent.set(eventName, list);
    }

    const events = Array.from(byEvent.entries()).map(([name, botIds]) => ({
      name,
      data: { botIds, tickNumber } satisfies BotTickEventPayload,
    }));

    if (events.length === 0) {
      return { tickNumber, dispatched: {} };
    }

    await step.sendEvent('dispatch-tick-events', events);

    const dispatched: Record<string, number> = {};
    for (const ev of events) dispatched[ev.name] = ev.data.botIds.length;
    logger.info({ tickNumber, dispatched }, 'master-tick dispatched');
    return { tickNumber, dispatched };
  },
);
