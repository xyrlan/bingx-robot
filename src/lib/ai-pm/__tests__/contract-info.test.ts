import { describe, it, expect, vi } from 'vitest';
import { makeGetContractInfoFn } from '@/lib/ai-pm/contract-info';

describe('makeGetContractInfoFn', () => {
  it('maps real contract info to executor shape', async () => {
    const get = vi.fn().mockResolvedValue({
      pricePrecision: 2,
      quantityPrecision: 3,
      tradeMinQuantity: 0.001,
      tradeMinUSDT: 5,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = makeGetContractInfoFn({} as any, get);
    const out = await fn('BTC-USDT');
    expect(out).toEqual({ quantityPrecision: 3, minNotional: '5' });
    expect(get).toHaveBeenCalledWith({}, 'BTC-USDT');
  });

  it('falls back when contract not found', async () => {
    const get = vi.fn().mockResolvedValue(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = makeGetContractInfoFn({} as any, get);
    const out = await fn('UNKNOWN-USDT');
    expect(out).toEqual({ quantityPrecision: 4, minNotional: '1' });
  });

  it('uses fallback minNotional when tradeMinUSDT is 0', async () => {
    const get = vi.fn().mockResolvedValue({
      pricePrecision: 4,
      quantityPrecision: 6,
      tradeMinQuantity: 0,
      tradeMinUSDT: 0,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = makeGetContractInfoFn({} as any, get);
    const out = await fn('FOO-USDT');
    expect(out).toEqual({ quantityPrecision: 6, minNotional: '1' });
  });
});
