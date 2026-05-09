import { describe, it, expect } from 'vitest';
import { initialState, tick, type Snapshot, type Intent } from '@/services/bots/trailing-stop/core';
import type { TrailingStopConfig } from '@/services/bots/types';

const baseConfig = (overrides: Partial<TrailingStopConfig> = {}): TrailingStopConfig => ({
  activationPricePct: 1,
  trailingPct: 0.5,
  positionSizeUsdt: 100,
  highestPrice: 0,
  isActivated: false,
  entryOrderId: null,
  ...overrides,
});

describe('TRAILING_STOP core', () => {
  it('emits PLACE_ENTRY when no entry yet', () => {
    const config = baseConfig({ entryOrderId: null });
    const snap: Snapshot = { currentPrice: 50000, hasOpenPosition: false, config };

    const result = tick(initialState(config), snap);

    const intent = result.intents.find(i => i.kind === 'PLACE_ENTRY') as Extract<Intent, { kind: 'PLACE_ENTRY' }>;
    expect(intent).toBeDefined();
    expect(intent.usdtAmount).toBe(100);
    expect(intent.referencePrice).toBe(50000);
  });

  it('does not place entry if entryOrderId already set', () => {
    const config = baseConfig({ entryOrderId: 'order-1', entryPrice: 50000 });
    const snap: Snapshot = { currentPrice: 50000, hasOpenPosition: true, config };

    const result = tick(initialState(config), snap);

    expect(result.intents.find(i => i.kind === 'PLACE_ENTRY')).toBeUndefined();
  });

  it('activates when price crosses activation threshold', () => {
    const config = baseConfig({
      entryOrderId: 'order-1',
      entryPrice: 50000,
      isActivated: false,
      activationPricePct: 1,
    });
    const snap: Snapshot = { currentPrice: 50500, hasOpenPosition: true, config };

    const result = tick(initialState(config), snap);

    expect(result.newState.isActivated).toBe(true);
    expect(result.newState.highestPrice).toBeGreaterThanOrEqual(50500);
  });

  it('updates highestPrice while active', () => {
    const config = baseConfig({
      entryOrderId: 'order-1',
      entryPrice: 50000,
      highestPrice: 50500,
      isActivated: true,
    });
    const snap: Snapshot = { currentPrice: 50800, hasOpenPosition: true, config };

    const result = tick(initialState(config), snap);

    expect(result.newState.highestPrice).toBe(50800);
    expect(result.intents.find(i => i.kind === 'CLOSE_POSITION')).toBeUndefined();
  });

  it('emits CLOSE_POSITION when price drops below trailing threshold', () => {
    const config = baseConfig({
      entryOrderId: 'order-1',
      entryPrice: 50000,
      highestPrice: 51000,
      isActivated: true,
      trailingPct: 0.5,
    });
    const trailPrice = 51000 * (1 - 0.5 / 100);  // 50745
    const snap: Snapshot = { currentPrice: trailPrice - 1, hasOpenPosition: true, config };

    const result = tick(initialState(config), snap);

    expect(result.intents.find(i => i.kind === 'CLOSE_POSITION')).toBeDefined();
  });
});
