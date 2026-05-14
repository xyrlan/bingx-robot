import { describe, it, expect, vi } from 'vitest';
import { getAllOpenPositions, getOpenPositions } from '@/services/bingx.service';

function clientReturning(data: unknown) {
  return { get: vi.fn().mockResolvedValue(data) } as never;
}

describe('bingx positions — unrealized pnl', () => {
  it('getAllOpenPositions returns open positions with unrealizedPnl populated', async () => {
    const client = clientReturning([
      {
        symbol: 'BTC-USDT',
        positionSide: 'LONG',
        positionAmt: '0.5',
        entryPrice: '60000',
        unrealizedProfit: '120.5',
        leverage: '10',
        positionId: '99',
      },
      {
        symbol: 'ETH-USDT',
        positionSide: 'SHORT',
        positionAmt: '0',
        entryPrice: '3000',
        unrealizedProfit: '0',
      },
    ]);

    const positions = await getAllOpenPositions(client);

    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ symbol: 'BTC-USDT', unrealizedPnl: 120.5 });
  });

  it('getOpenPositions includes unrealizedPnl', async () => {
    const client = clientReturning([
      {
        symbol: 'BTC-USDT',
        positionSide: 'LONG',
        positionAmt: '1',
        entryPrice: '50000',
        unrealizedProfit: '-75.25',
      },
    ]);

    const positions = await getOpenPositions(client, 'BTC-USDT');

    expect(positions[0].unrealizedPnl).toBeCloseTo(-75.25);
  });
});
