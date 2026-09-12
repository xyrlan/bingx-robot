import { describe, it, expect } from 'vitest';
import { botStartTickEvent, TYPE_TO_EVENT } from '@/inngest/bot-events';
import type { BotType } from '@/services/bots/types';

/**
 * `trading/bot.start` used to be emitted by the start route with no
 * subscriber anywhere in the app, so pressing Start placed nothing — the bot
 * just sat in RUNNING until the next master-tick cron (up to 5 minutes).
 * The handler turns that event into the same per-type tick event the cron
 * dispatches, so the existing watcher runs immediately.
 */
describe('botStartTickEvent', () => {
  it('routes a grid bot to the GRID tick event', () => {
    const ev = botStartTickEvent('GRID_LONG', 'bot-1');
    expect(ev).toEqual({
      name: 'bot.tick.GRID',
      data: { botIds: ['bot-1'], tickNumber: expect.any(Number) },
    });
  });

  it('routes GRID_SHORT to the same GRID event as GRID_LONG', () => {
    expect(botStartTickEvent('GRID_SHORT', 'b')?.name).toBe('bot.tick.GRID');
  });

  it('routes a DCA bot to the DCA tick event, not GRID', () => {
    expect(botStartTickEvent('DCA', 'b')?.name).toBe('bot.tick.DCA');
  });

  it('returns null for bot types with no registered watcher', () => {
    // These types are disabled in ENABLED_BOT_TYPES; dispatching a tick for
    // them would produce an event nobody consumes — the very bug being fixed.
    expect(botStartTickEvent('TRAILING_STOP', 'b')).toBeNull();
    expect(botStartTickEvent('DCA_SPOT', 'b')).toBeNull();
    expect(botStartTickEvent('SMA_CROSSOVER', 'b')).toBeNull();
  });

  it('returns null for an unknown bot type', () => {
    expect(botStartTickEvent('NONSENSE' as BotType, 'b')).toBeNull();
  });

  it('carries a wall-clock minute tickNumber, matching master-tick', () => {
    const before = Math.floor(Date.now() / 60_000);
    const ev = botStartTickEvent('GRID_LONG', 'b');
    expect(ev!.data.tickNumber).toBeGreaterThanOrEqual(before);
  });

  it('maps every bot type to a tick event name', () => {
    const types: BotType[] = [
      'GRID_LONG', 'GRID_SHORT', 'DCA', 'DCA_SPOT', 'TRAILING_STOP', 'SMA_CROSSOVER',
    ];
    for (const t of types) expect(TYPE_TO_EVENT[t]).toBeTruthy();
  });
});
