import type { SMAConfig, SMASymbolState } from '@/services/bots/types';
import type { Kline } from '@/services/bingx.service';
import {
  calculateATR,
  calculateADX,
  detectSignal,
  checkSMATrailingStop,
  createEmptySymbolState,
} from '@/services/bots/sma-crossover.service';

export type State = SMASymbolState;

export interface Snapshot {
  symbol: string;
  candles: Kline[];
  currentPrice: number;
  hasOpenPosition: boolean;
  config: SMAConfig;
}

export type Intent =
  | { kind: 'ENTER_LONG'; usdtAmount: number; referencePrice: number }
  | { kind: 'ENTER_SHORT'; usdtAmount: number; referencePrice: number }
  | { kind: 'PLACE_INITIAL_STOP'; stopPrice: number; positionSide: 'LONG' | 'SHORT' }
  | { kind: 'ACTIVATE_TRAILING'; newStopPrice: number; positionSide: 'LONG' | 'SHORT' }
  | { kind: 'UPDATE_TRAILING_STOP'; newStopPrice: number; positionSide: 'LONG' | 'SHORT' }
  | { kind: 'CLOSE_POSITION'; positionSide: 'LONG' | 'SHORT' };

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function initialState(_config: SMAConfig): State {
  return createEmptySymbolState();
}

export function tick(state: State, snap: Snapshot): { newState: State; intents: Intent[] } {
  const { candles, currentPrice, hasOpenPosition, config } = snap;
  const intents: Intent[] = [];

  // Build close array for indicator calculations
  const closes = candles.map(c => c.close);

  // Indicators that we can compute given the candles available
  const atr = calculateATR(candles, config.atrPeriod);
  const adx = calculateADX(candles, config.adxPeriod);

  // CASE A: position open — manage trailing stop / exit
  if (state.position && hasOpenPosition) {
    if (atr == null) {
      return { newState: { ...state, lastAtr: state.lastAtr }, intents: [] };
    }
    const trail = checkSMATrailingStop(
      state,
      currentPrice,
      {
        activationAtrMult: config.activationAtrMult,
        trailingAtrMult: config.trailingAtrMult,
        initialStopAtrMult: config.initialStopAtrMult,
      },
      atr,
    );

    const newState: State = {
      ...state,
      highestPrice: trail.updatedHighest,
      lowestPrice: trail.updatedLowest,
      lastAtr: atr,
    };

    if (trail.action === 'CLOSE') {
      intents.push({ kind: 'CLOSE_POSITION', positionSide: state.position });
      return { newState, intents };
    }

    if (trail.action === 'ACTIVATE' && trail.newStopPrice != null) {
      newState.trailingActivated = true;
      intents.push({
        kind: 'ACTIVATE_TRAILING',
        newStopPrice: trail.newStopPrice,
        positionSide: state.position,
      });
      return { newState, intents };
    }

    // HOLD action — emit a stop-update intent only if the stop level changed materially
    if (trail.newStopPrice != null && state.trailingActivated) {
      intents.push({
        kind: 'UPDATE_TRAILING_STOP',
        newStopPrice: trail.newStopPrice,
        positionSide: state.position,
      });
    }

    return { newState, intents };
  }

  // CASE B: no position — look for an entry signal
  const signal = detectSignal({
    closes,
    fastPeriod: config.fastPeriod,
    mediumPeriod: config.mediumPeriod,
    trendPeriod: config.trendPeriod,
  });

  if (signal.signal == null) {
    return { newState: { ...state, lastAtr: atr ?? state.lastAtr }, intents: [] };
  }

  // ADX gate
  if (adx == null || adx < config.adxThreshold) {
    return { newState: { ...state, lastAtr: atr ?? state.lastAtr }, intents: [] };
  }

  const entryIntent: Intent =
    signal.signal === 'LONG'
      ? { kind: 'ENTER_LONG', usdtAmount: config.positionSizeUsdt, referencePrice: currentPrice }
      : { kind: 'ENTER_SHORT', usdtAmount: config.positionSizeUsdt, referencePrice: currentPrice };

  intents.push(entryIntent);

  // Initial stop based on ATR if available
  if (atr != null) {
    const stopPrice =
      signal.signal === 'LONG'
        ? currentPrice - config.initialStopAtrMult * atr
        : currentPrice + config.initialStopAtrMult * atr;
    intents.push({ kind: 'PLACE_INITIAL_STOP', stopPrice, positionSide: signal.signal });
  }

  const newState: State = {
    ...state,
    position: signal.signal,
    entryPrice: currentPrice,
    lastSignal: signal.signal,
    lastSignalAt: Date.now(),
    lastAtr: atr,
  };

  return { newState, intents };
}
