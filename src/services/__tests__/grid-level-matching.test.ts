import { describe, it, expect } from 'vitest';
import { orderMatchesPriceLevel } from '@/services/bingx.service';

describe('orderMatchesPriceLevel', () => {
  // Root-cause repro: grid math produces levels like 65000.123456 but orders are
  // placed at toPrecision(level, pricePrecision) = 65000.1 (BTC tick 0.1). The old
  // predicate Math.abs(price - priceLevel) < 0.0001 never matched these.
  it('matches an order placed at the tick-rounded level price', () => {
    expect(orderMatchesPriceLevel({ price: 65000.1 }, 65000.123456, 1)).toBe(true);
  });

  it('does not match an order one full tick away', () => {
    expect(orderMatchesPriceLevel({ price: 65000.0 }, 65000.123456, 1)).toBe(false);
    expect(orderMatchesPriceLevel({ price: 65000.2 }, 65000.123456, 1)).toBe(false);
  });

  it('matches despite float representation noise', () => {
    expect(orderMatchesPriceLevel({ price: 65000.10000000001 }, 65000.123456, 1)).toBe(true);
  });

  it('matches TRIGGER_LIMIT orders via stopPrice', () => {
    expect(orderMatchesPriceLevel({ price: 65100.2, stopPrice: 65000.1 }, 65000.123456, 1)).toBe(true);
  });

  it('handles string price fields from the exchange', () => {
    expect(orderMatchesPriceLevel({ price: '65000.1' }, 65000.123456, 1)).toBe(true);
  });

  it('does not match when both price and stopPrice are absent', () => {
    expect(orderMatchesPriceLevel({}, 65000.123456, 1)).toBe(false);
  });

  it('works at higher precision (tick 0.0001)', () => {
    expect(orderMatchesPriceLevel({ price: 0.8123 }, 0.81237777, 4)).toBe(true);
    expect(orderMatchesPriceLevel({ price: 0.8124 }, 0.81237777, 4)).toBe(false);
  });
});
