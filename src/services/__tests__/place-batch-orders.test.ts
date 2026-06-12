import { describe, it, expect, vi } from 'vitest';
import { placeBatchOrders, buildGridEntryPayload } from '@/services/bingx.service';
import { buildGridShortEntryPayload } from '@/services/bots/grid-short.service';
import type { BingxClient } from '@/lib/bingx/client';

function mockClient(post: ReturnType<typeof vi.fn>): BingxClient {
  return {
    get: vi.fn(),
    post,
    delete: vi.fn(),
    postForm: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('buildGridEntryPayload clientOrderId', () => {
  const base = {
    symbol: 'BTC-USDT',
    priceLevel: 65000.123456,
    quantity: 0.001,
    takeProfitPct: 0.01,
    pricePrecision: 1,
    quantityPrecision: 4,
    positionSide: 'LONG',
    currentPrice: 66000,
  };

  it('sets clientOrderID when provided', () => {
    const payload = buildGridEntryPayload({ ...base, clientOrderId: 'ge3fa85f64a1b2c3d4abc' });
    expect(payload.clientOrderID).toBe('ge3fa85f64a1b2c3d4abc');
  });

  it('omits clientOrderID when not provided', () => {
    const payload = buildGridEntryPayload(base);
    expect(payload).not.toHaveProperty('clientOrderID');
  });
});

describe('buildGridShortEntryPayload clientOrderId', () => {
  it('sets clientOrderID when provided', () => {
    const payload = buildGridShortEntryPayload({
      symbol: 'BTC-USDT',
      priceLevel: 65000.123456,
      quantity: 0.001,
      takeProfitPct: 0.01,
      pricePrecision: 1,
      quantityPrecision: 4,
      currentPrice: 64000,
      clientOrderId: 'ge3fa85f64a1b2c3d4abc',
    });
    expect(payload.clientOrderID).toBe('ge3fa85f64a1b2c3d4abc');
  });
});

describe('placeBatchOrders', () => {
  it('sends clientOrderID through the batchOrders JSON', async () => {
    const post = vi.fn().mockResolvedValue({
      orders: [{ orderId: '111', clientOrderID: 'cidA' }],
    });
    const client = mockClient(post);

    await placeBatchOrders(client, [{ symbol: 'BTC-USDT', clientOrderID: 'cidA' }]);

    const body = post.mock.calls[0][1] as { batchOrders: string };
    expect(body.batchOrders).toContain('"clientOrderID":"cidA"');
  });

  it('matches results to requests by echoed clientOrderID on partial failure', async () => {
    // Old code pushed all successes then all errors: a failure for request B
    // attributed C's orderId to B and B's error to C, so orderIds got written
    // to the wrong grid levels.
    const post = vi.fn().mockResolvedValue({
      orders: [
        { orderId: '111', clientOrderID: 'cidA' },
        { orderId: '333', clientOrderID: 'cidC' },
      ],
      errors: [{ msg: 'min quantity not met', code: 80001 }],
    });
    const client = mockClient(post);

    const results = await placeBatchOrders(client, [
      { symbol: 'BTC-USDT', clientOrderID: 'cidA' },
      { symbol: 'BTC-USDT', clientOrderID: 'cidB' },
      { symbol: 'BTC-USDT', clientOrderID: 'cidC' },
    ]);

    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ orderId: '111', clientOrderId: 'cidA' });
    expect(results[1].orderId).toBeNull();
    expect(results[1].clientOrderId).toBe('cidB');
    expect(results[1].error).toContain('min quantity');
    expect(results[2]).toMatchObject({ orderId: '333', clientOrderId: 'cidC' });
  });

  it('falls back to index matching when requests carry no clientOrderID', async () => {
    const post = vi.fn().mockResolvedValue({
      orders: [{ orderId: '111' }, { orderId: '222' }],
    });
    const client = mockClient(post);

    const results = await placeBatchOrders(client, [
      { symbol: 'BTC-USDT' },
      { symbol: 'BTC-USDT' },
    ]);

    expect(results.map((r) => r.orderId)).toEqual(['111', '222']);
  });

  it('marks the whole chunk failed when the request throws', async () => {
    const post = vi.fn().mockRejectedValue(new Error('network down'));
    const client = mockClient(post);

    const results = await placeBatchOrders(client, [
      { symbol: 'BTC-USDT', clientOrderID: 'cidA' },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].orderId).toBeNull();
    expect(results[0].clientOrderId).toBe('cidA');
    expect(results[0].error).toContain('network down');
  });
});
