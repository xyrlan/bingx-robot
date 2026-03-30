import { describe, it, expect } from 'vitest';
import { shouldPlaceDCAOrder } from '../dca.service';
import { checkTrailingStop } from '../trailing-stop.service';
import type { DCAConfig } from '../types';
import type { TrailingStopConfig } from '../types';

describe('shouldPlaceDCAOrder', () => {
  const baseConfig: DCAConfig = {
    intervalMinutes: 5,
    totalOrders: 10,
    orderSizeUsdt: 100,
    ordersPlaced: 0,
    side: 'BUY',
  };

  it('should return true for first order (no orders placed yet)', () => {
    const botCreatedAt = new Date(Date.now() - 1000); // 1 second ago
    expect(shouldPlaceDCAOrder(baseConfig, botCreatedAt)).toBe(true);
  });

  it('should return false when all orders are placed', () => {
    const config = { ...baseConfig, ordersPlaced: 10 };
    const botCreatedAt = new Date(Date.now() - 60 * 60 * 1000);
    expect(shouldPlaceDCAOrder(config, botCreatedAt)).toBe(false);
  });

  it('should return false if interval has not elapsed since last order', () => {
    const config = { ...baseConfig, ordersPlaced: 1, lastOrderAt: Date.now() - 1000 }; // 1 second ago
    const botCreatedAt = new Date(Date.now() - 10 * 60 * 1000);
    expect(shouldPlaceDCAOrder(config, botCreatedAt)).toBe(false);
  });

  it('should return true if interval has elapsed since last order', () => {
    const config = { ...baseConfig, ordersPlaced: 1, lastOrderAt: Date.now() - 6 * 60 * 1000 }; // 6 min ago
    const botCreatedAt = new Date(Date.now() - 20 * 60 * 1000);
    expect(shouldPlaceDCAOrder(config, botCreatedAt)).toBe(true);
  });

  it('should use botCreatedAt fallback when lastOrderAt is not set', () => {
    const config = { ...baseConfig, ordersPlaced: 1 }; // no lastOrderAt
    const botCreatedAt = new Date(Date.now() - 6 * 60 * 1000); // 6 min ago
    // Expected orders = floor(6min / 5min) + 1 = 2, ordersPlaced = 1, so should be true
    expect(shouldPlaceDCAOrder(config, botCreatedAt)).toBe(true);
  });

  it('should return false with fallback when not enough time passed', () => {
    const config = { ...baseConfig, ordersPlaced: 1 }; // no lastOrderAt
    const botCreatedAt = new Date(Date.now() - 4 * 60 * 1000); // 4 min ago
    // Expected orders = floor(4min / 5min) + 1 = 1, ordersPlaced = 1, so should be false
    expect(shouldPlaceDCAOrder(config, botCreatedAt)).toBe(false);
  });
});

describe('checkTrailingStop', () => {
  const baseConfig: TrailingStopConfig = {
    activationPricePct: 5,
    trailingPct: 3,
    positionSizeUsdt: 100,
    highestPrice: 0,
    isActivated: false,
    entryOrderId: 'test-order-123',
  };

  it('should HOLD when price has not reached activation threshold', () => {
    const config = { ...baseConfig, highestPrice: 100 };
    const result = checkTrailingStop(config, 103, 100); // 3% gain, need 5%
    expect(result.action).toBe('HOLD');
    expect(result.updatedHighest).toBe(103);
  });

  it('should ACTIVATE when price reaches activation threshold', () => {
    const config = { ...baseConfig, highestPrice: 100 };
    const result = checkTrailingStop(config, 106, 100); // 6% gain, threshold 5%
    expect(result.action).toBe('ACTIVATE');
    expect(result.updatedHighest).toBe(106);
  });

  it('should HOLD when activated but price has not dropped enough', () => {
    const config = { ...baseConfig, isActivated: true, highestPrice: 110 };
    const result = checkTrailingStop(config, 108, 100); // dropped ~1.8% from 110, need 3%
    expect(result.action).toBe('HOLD');
    expect(result.updatedHighest).toBe(110);
  });

  it('should CLOSE when activated and price drops below trail threshold', () => {
    const config = { ...baseConfig, isActivated: true, highestPrice: 110 };
    // Trail price = 110 * (1 - 3/100) = 106.7
    const result = checkTrailingStop(config, 106, 100); // below 106.7
    expect(result.action).toBe('CLOSE');
    expect(result.updatedHighest).toBe(110);
  });

  it('should update highest price when current price is new high', () => {
    const config = { ...baseConfig, isActivated: true, highestPrice: 110 };
    const result = checkTrailingStop(config, 115, 100);
    expect(result.action).toBe('HOLD');
    expect(result.updatedHighest).toBe(115);
  });

  it('should ACTIVATE at exact activation price', () => {
    const config = { ...baseConfig, highestPrice: 100 };
    const result = checkTrailingStop(config, 105, 100); // exactly 5%
    expect(result.action).toBe('ACTIVATE');
  });

  it('should CLOSE at exact trail price', () => {
    const config = { ...baseConfig, isActivated: true, highestPrice: 100 };
    // Trail price = 100 * (1 - 3/100) = 97
    const result = checkTrailingStop(config, 97, 100);
    expect(result.action).toBe('CLOSE');
  });

  it('should use entryPrice as fallback when highestPrice is 0', () => {
    const config = { ...baseConfig, highestPrice: 0 };
    const result = checkTrailingStop(config, 106, 100);
    // highest = max(0 || 100 (entryPrice fallback), 106) = 106
    expect(result.action).toBe('ACTIVATE');
    expect(result.updatedHighest).toBe(106);
  });
});
