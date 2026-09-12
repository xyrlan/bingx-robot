import { describe, it, expect } from 'vitest';
import { checkMinOrderSize } from '@/services/bots/min-order-size';

/**
 * The watcher skips any grid level whose notional falls under the symbol's
 * exchange minimum, and it does so with a bare `continue` — no log, no status
 * change, nothing in the UI. A bot configured below the minimum therefore sits
 * in RUNNING forever placing nothing. Neither config form nor the start route
 * validated against the minimum, so such a bot could be created freely.
 */
describe('checkMinOrderSize', () => {
  const contract = { tradeMinUSDT: 5, tradeMinQuantity: 0.0001 };

  it('accepts a position size at or above the notional minimum', () => {
    expect(checkMinOrderSize({ positionSizeUsdt: 10, priceLevel: 60000, contract }).ok).toBe(true);
    // Exactly at the notional minimum, at a price low enough that the derived
    // quantity clears the separate quantity floor.
    expect(checkMinOrderSize({ positionSizeUsdt: 5, priceLevel: 100, contract }).ok).toBe(true);
  });

  it('rejects a notional-passing size whose quantity still breaches the floor', () => {
    // 5 USDT clears tradeMinUSDT but buys only 0.0000833 BTC at 60k, under
    // the 0.0001 quantity floor — both gates must be checked, not just one.
    const got = checkMinOrderSize({ positionSizeUsdt: 5, priceLevel: 60000, contract });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe('MIN_QUANTITY');
  });

  it('rejects a position size below the notional minimum', () => {
    const got = checkMinOrderSize({ positionSizeUsdt: 2, priceLevel: 60000, contract });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe('MIN_NOTIONAL');
    expect(got.message).toContain('5');
    expect(got.message).toContain('2');
  });

  it('rejects when the derived quantity falls under the minimum quantity', () => {
    // 5 USDT at 1,000,000/unit = 0.000005 units, below the 0.0001 minimum.
    const got = checkMinOrderSize({
      positionSizeUsdt: 5,
      priceLevel: 1_000_000,
      contract: { tradeMinUSDT: 5, tradeMinQuantity: 0.0001 },
    });
    expect(got.ok).toBe(false);
    expect(got.reason).toBe('MIN_QUANTITY');
  });

  it('checks the worst-case level: the highest price of the grid', () => {
    // Quantity shrinks as price rises, so priceMax is where a grid first
    // breaches the quantity floor. Callers pass priceMax for creation checks.
    const contractQty = { tradeMinUSDT: 0, tradeMinQuantity: 0.001 };
    expect(checkMinOrderSize({ positionSizeUsdt: 10, priceLevel: 5_000, contract: contractQty }).ok).toBe(true);
    expect(checkMinOrderSize({ positionSizeUsdt: 10, priceLevel: 50_000, contract: contractQty }).ok).toBe(false);
  });

  it('passes when the exchange reports no minimums (fails open, as today)', () => {
    // getContractInfo defaults both to 0 when the field is missing; a missing
    // minimum must never block a bot that the exchange would have accepted.
    const got = checkMinOrderSize({
      positionSizeUsdt: 1,
      priceLevel: 60000,
      contract: { tradeMinUSDT: 0, tradeMinQuantity: 0 },
    });
    expect(got.ok).toBe(true);
  });

  it('passes when contract info is unavailable', () => {
    expect(checkMinOrderSize({ positionSizeUsdt: 1, priceLevel: 60000, contract: null }).ok).toBe(true);
  });

  it('gives a message naming the symbol minimum, for the user-facing toast', () => {
    const got = checkMinOrderSize({
      positionSizeUsdt: 2,
      priceLevel: 60000,
      contract,
      symbol: 'BTC-USDT',
    });
    expect(got.message).toContain('BTC-USDT');
  });
});
