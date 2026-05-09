import { describe, it, expect } from 'vitest';
import { initialState, tick, type Snapshot, type Intent } from '@/services/bots/dca/core';
import type { DCAConfig } from '@/services/bots/types';

const baseConfig = (overrides: Partial<DCAConfig> = {}): DCAConfig => ({
  intervalMinutes: 60,
  totalOrders: 5,
  orderSizeUsdt: 100,
  ordersPlaced: 0,
  side: 'BUY',
  ...overrides,
});

const ms = (h: number) => h * 60 * 60 * 1000;

describe('DCA core', () => {
  it('initialState carries forward ordersPlaced and lastOrderAt from config', () => {
    const config = baseConfig({ ordersPlaced: 2, lastOrderAt: 12345 });
    const state = initialState(config);
    expect(state.ordersPlaced).toBe(2);
    expect(state.lastOrderAt).toBe(12345);
  });

  it('emits PLACE_ENTRY when interval has elapsed and not all orders placed', () => {
    const config = baseConfig({ ordersPlaced: 1, lastOrderAt: 0 });
    const snap: Snapshot = { now: ms(2), currentPrice: 50000, botCreatedAt: 0, config };

    const result = tick(initialState(config), snap);

    expect(result.intents).toHaveLength(1);
    const intent = result.intents[0] as Extract<Intent, { kind: 'PLACE_ENTRY' }>;
    expect(intent.kind).toBe('PLACE_ENTRY');
    expect(intent.side).toBe('BUY');
    expect(intent.usdtAmount).toBe(100);
    expect(intent.referencePrice).toBe(50000);
    expect(result.newState.ordersPlaced).toBe(2);
    expect(result.newState.lastOrderAt).toBe(ms(2));
  });

  it('does NOT emit when interval has not elapsed', () => {
    const config = baseConfig({ ordersPlaced: 1, lastOrderAt: ms(1) });
    const snap: Snapshot = { now: ms(1) + 60_000, currentPrice: 50000, botCreatedAt: 0, config };

    const result = tick(initialState(config), snap);

    expect(result.intents).toEqual([]);
    expect(result.newState.ordersPlaced).toBe(1);
  });

  it('emits BOT_DONE when ordersPlaced reaches totalOrders after a fill', () => {
    const config = baseConfig({ ordersPlaced: 4, lastOrderAt: 0 });
    const snap: Snapshot = { now: ms(2), currentPrice: 50000, botCreatedAt: 0, config };

    const result = tick(initialState(config), snap);

    const kinds = result.intents.map(i => i.kind);
    expect(kinds).toContain('PLACE_ENTRY');
    expect(kinds).toContain('BOT_DONE');
    expect(result.newState.ordersPlaced).toBe(5);
  });

  it('does NOT emit when ordersPlaced already at totalOrders', () => {
    const config = baseConfig({ ordersPlaced: 5, lastOrderAt: 0 });
    const snap: Snapshot = { now: ms(2), currentPrice: 50000, botCreatedAt: 0, config };

    const result = tick(initialState(config), snap);

    expect(result.intents).toEqual([]);
  });

  it('SELL side produces SELL intent', () => {
    const config = baseConfig({ side: 'SELL' });
    const snap: Snapshot = { now: ms(2), currentPrice: 50000, botCreatedAt: 0, config };

    const result = tick(initialState(config), snap);

    const intent = result.intents[0] as Extract<Intent, { kind: 'PLACE_ENTRY' }>;
    expect(intent.side).toBe('SELL');
  });
});
