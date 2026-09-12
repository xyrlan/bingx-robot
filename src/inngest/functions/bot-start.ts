import { inngest } from '@/inngest/client';
import { getBotById } from '@/services/bingx.service';
import { botStartTickEvent } from '@/inngest/bot-events';

/**
 * Runs a bot immediately when the user starts it.
 *
 * The start route has always emitted `trading/bot.start`, but nothing
 * subscribed to it: pressing Start only flipped the DB row to RUNNING, and
 * the first order waited for the next master-tick cron — up to
 * MASTER_TICK_INTERVAL_MINUTES later, with nothing on the exchange and no
 * feedback in between. This handler closes that gap by dispatching the same
 * tick event the cron dispatches, so the immediate run and every scheduled
 * run share one code path.
 *
 * Racing the cron is safe: watchers hold `concurrency: { limit: 1 }`, and
 * grid placement is idempotent per level through deterministic client order
 * IDs, so a concurrent tick adopts in-flight orders rather than duplicating
 * them.
 */
export const botStart = inngest.createFunction(
  {
    id: 'bot-start',
    name: 'Bot Start (immediate first tick)',
    retries: 2,
    concurrency: { limit: 1 },
  },
  { event: 'trading/bot.start' },
  async ({ step, logger, event }) => {
    const { userId, botId } = event.data as { userId?: string; botId?: string };
    if (!userId || !botId) {
      logger.warn('[BotStart] missing userId or botId in event payload');
      return { dispatched: false as const, reason: 'BAD_PAYLOAD' };
    }

    const bot = await step.run('load-bot', () => getBotById(botId, userId));

    // The user may have stopped the bot between pressing Start and this run.
    if (!bot || bot.status !== 'RUNNING') {
      return { dispatched: false as const, reason: 'NOT_RUNNING' };
    }

    const tick = botStartTickEvent(bot.botType ?? 'GRID_LONG', botId);
    if (!tick) {
      logger.warn(`[BotStart] no registered watcher for bot type ${bot.botType}, bot ${botId}`);
      return { dispatched: false as const, reason: 'NO_WATCHER' };
    }

    await step.sendEvent('dispatch-first-tick', tick);
    logger.info(`[BotStart] dispatched ${tick.name} for bot ${botId}`);
    return { dispatched: true as const, event: tick.name };
  }
);
