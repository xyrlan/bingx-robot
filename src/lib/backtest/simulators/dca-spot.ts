import { tick, initialState } from '@/services/bots/dca-spot/core';
import type { DCAConfig } from '@/services/bots/types';
import type { Kline } from '@/services/bingx.service';
import type { SimulatorResult, Trade } from '@/lib/backtest/types';

export function simulateDcaSpot(candles: Kline[], params: DCAConfig): SimulatorResult {
  if (candles.length === 0 || params.totalOrders <= 0) {
    return { trades: [], equityCurve: [] };
  }

  let state = initialState({ ...params, ordersPlaced: 0, lastOrderAt: undefined });
  const botCreatedAt = candles[0].time;

  let totalNotional = 0;
  let weightedPriceSum = 0;
  let firstEntryTime: number | null = null;
  const equityCurve: number[] = new Array(candles.length).fill(0);

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const { newState, intents } = tick(state, {
      now: c.time,
      currentPrice: c.close,
      botCreatedAt,
      config: { ...params, ordersPlaced: state.ordersPlaced, lastOrderAt: state.lastOrderAt ?? undefined },
    });
    state = newState;

    for (let j = 0; j < intents.length; j++) {
      const it = intents[j];
      if (it.kind === 'PLACE_SPOT_BUY') {
        weightedPriceSum += it.referencePrice * it.usdtAmount;
        totalNotional += it.usdtAmount;
        if (firstEntryTime === null) firstEntryTime = c.time;
      }
    }

    if (totalNotional > 0) {
      const avg = weightedPriceSum / totalNotional;
      const unrealizedPct = (c.close - avg) / avg * 100;
      equityCurve[i] = (unrealizedPct / 100) * totalNotional;
    } else {
      equityCurve[i] = i > 0 ? equityCurve[i - 1] : 0;
    }
  }

  if (totalNotional === 0 || firstEntryTime === null) {
    return { trades: [], equityCurve };
  }

  const last = candles[candles.length - 1];
  const avgEntry = weightedPriceSum / totalNotional;
  const pnlPctValue = (last.close - avgEntry) / avgEntry * 100;
  const pnlUsdt = (pnlPctValue / 100) * totalNotional;

  const trade: Trade = {
    entryPrice: avgEntry,
    exitPrice: last.close,
    entryTime: firstEntryTime,
    exitTime: last.time,
    side: 'LONG',
    pnlPct: pnlPctValue,
    pnlUsdt,
    notionalUsdt: totalNotional,
  };

  equityCurve[equityCurve.length - 1] = pnlUsdt;

  return { trades: [trade], equityCurve };
}
