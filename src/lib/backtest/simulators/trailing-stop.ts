import { tick, initialState } from '@/services/bots/trailing-stop/core';
import type { TrailingStopConfig } from '@/services/bots/types';
import type { Kline } from '@/services/bingx.service';
import type { SimulatorResult, Trade } from '@/lib/backtest/types';

export function simulateTrailingStop(candles: Kline[], params: TrailingStopConfig): SimulatorResult {
  if (candles.length === 0) return { trades: [], equityCurve: [] };

  let state = initialState({
    ...params,
    entryOrderId: null,
    entryPrice: undefined,
    highestPrice: 0,
    isActivated: false,
  });

  const trades: Trade[] = [];
  const equityCurve: number[] = new Array(candles.length).fill(0);

  let realized = 0;
  let openEntryPrice: number | null = null;
  let openEntryTime: number | null = null;
  const notional = params.positionSizeUsdt;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const hasOpenPosition = openEntryPrice !== null;
    const { newState, intents } = tick(state, {
      currentPrice: c.close,
      hasOpenPosition,
      config: params,
    });

    if (openEntryPrice === null) {
      let opened = false;
      for (let j = 0; j < intents.length; j++) {
        if (intents[j].kind === 'PLACE_ENTRY') {
          openEntryPrice = c.close;
          openEntryTime = c.time;
          state = { ...newState, entryOrderId: 'sim', entryPrice: c.close };
          opened = true;
          break;
        }
      }
      if (!opened) state = newState;
    } else {
      state = newState;
      for (let j = 0; j < intents.length; j++) {
        if (intents[j].kind === 'CLOSE_POSITION' && openEntryPrice !== null && openEntryTime !== null) {
          const pnlPctValue = ((c.close - openEntryPrice) / openEntryPrice) * 100;
          const pnlUsdt = (pnlPctValue / 100) * notional;
          trades.push({
            entryPrice: openEntryPrice,
            exitPrice: c.close,
            entryTime: openEntryTime,
            exitTime: c.time,
            side: 'LONG',
            pnlPct: pnlPctValue,
            pnlUsdt,
            notionalUsdt: notional,
          });
          realized += pnlUsdt;
          openEntryPrice = null;
          openEntryTime = null;
          state = initialState({
            ...params,
            entryOrderId: null,
            entryPrice: undefined,
            highestPrice: 0,
            isActivated: false,
          });
        }
      }
    }

    if (openEntryPrice !== null) {
      const unrealizedUsdt = ((c.close - openEntryPrice) / openEntryPrice) * notional;
      equityCurve[i] = realized + unrealizedUsdt;
    } else {
      equityCurve[i] = realized;
    }
  }

  if (openEntryPrice !== null && openEntryTime !== null) {
    const last = candles[candles.length - 1];
    const pnlPctValue = ((last.close - openEntryPrice) / openEntryPrice) * 100;
    const pnlUsdt = (pnlPctValue / 100) * notional;
    trades.push({
      entryPrice: openEntryPrice,
      exitPrice: last.close,
      entryTime: openEntryTime,
      exitTime: last.time,
      side: 'LONG',
      pnlPct: pnlPctValue,
      pnlUsdt,
      notionalUsdt: notional,
    });
    realized += pnlUsdt;
    equityCurve[equityCurve.length - 1] = realized;
  }

  return { trades, equityCurve };
}
