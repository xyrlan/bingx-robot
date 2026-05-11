import { tick, initialState } from '@/services/bots/sma-crossover/core';
import type { SMAConfig } from '@/services/bots/types';
import type { Kline } from '@/services/bingx.service';
import type { SimulatorResult, Trade } from '@/lib/backtest/types';

export function simulateSmaCrossover(candles: Kline[], params: SMAConfig): SimulatorResult {
  if (candles.length === 0) return { trades: [], equityCurve: [] };

  let state = initialState(params);
  const trades: Trade[] = [];
  const equityCurve: number[] = new Array(candles.length).fill(0);

  let realized = 0;
  let openSide: 'LONG' | 'SHORT' | null = null;
  let openEntryPrice: number | null = null;
  let openEntryTime: number | null = null;
  const notional = params.positionSizeUsdt;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const window = candles.slice(0, i + 1);
    const { newState, intents } = tick(state, {
      symbol: 'BACKTEST',
      candles: window,
      currentPrice: c.close,
      hasOpenPosition: openSide !== null,
      config: params,
    });
    state = newState;

    for (let j = 0; j < intents.length; j++) {
      const it = intents[j];
      if ((it.kind === 'ENTER_LONG' || it.kind === 'ENTER_SHORT') && openSide === null) {
        openSide = it.kind === 'ENTER_LONG' ? 'LONG' : 'SHORT';
        openEntryPrice = c.close;
        openEntryTime = c.time;
      } else if (
        it.kind === 'CLOSE_POSITION' &&
        openSide !== null &&
        openEntryPrice !== null &&
        openEntryTime !== null
      ) {
        const sign = openSide === 'LONG' ? 1 : -1;
        const pnlPctValue = sign * ((c.close - openEntryPrice) / openEntryPrice) * 100;
        const pnlUsdt = (pnlPctValue / 100) * notional;
        trades.push({
          entryPrice: openEntryPrice,
          exitPrice: c.close,
          entryTime: openEntryTime,
          exitTime: c.time,
          side: openSide,
          pnlPct: pnlPctValue,
          pnlUsdt,
          notionalUsdt: notional,
        });
        realized += pnlUsdt;
        openSide = null;
        openEntryPrice = null;
        openEntryTime = null;
        state = initialState(params);
      }
    }

    if (openSide !== null && openEntryPrice !== null) {
      const sign = openSide === 'LONG' ? 1 : -1;
      const unrealizedUsdt = sign * ((c.close - openEntryPrice) / openEntryPrice) * notional;
      equityCurve[i] = realized + unrealizedUsdt;
    } else {
      equityCurve[i] = realized;
    }
  }

  // Force-close any open position at the last candle
  if (openSide !== null && openEntryPrice !== null && openEntryTime !== null) {
    const last = candles[candles.length - 1];
    const sign = openSide === 'LONG' ? 1 : -1;
    const pnlPctValue = sign * ((last.close - openEntryPrice) / openEntryPrice) * 100;
    const pnlUsdt = (pnlPctValue / 100) * notional;
    trades.push({
      entryPrice: openEntryPrice,
      exitPrice: last.close,
      entryTime: openEntryTime,
      exitTime: last.time,
      side: openSide,
      pnlPct: pnlPctValue,
      pnlUsdt,
      notionalUsdt: notional,
    });
    realized += pnlUsdt;
    equityCurve[equityCurve.length - 1] = realized;
  }

  return { trades, equityCurve };
}
