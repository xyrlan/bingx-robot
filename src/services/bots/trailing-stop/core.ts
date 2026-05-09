import type { TrailingStopConfig } from '@/services/bots/types';

export interface Snapshot {
  currentPrice: number;
  hasOpenPosition: boolean;
  config: TrailingStopConfig;
}

export interface State {
  entryOrderId: string | null;
  entryPrice: number | null;
  highestPrice: number;
  isActivated: boolean;
}

export type Intent =
  | { kind: 'PLACE_ENTRY'; usdtAmount: number; referencePrice: number }
  | { kind: 'CLOSE_POSITION' };

export function initialState(config: TrailingStopConfig): State {
  return {
    entryOrderId: config.entryOrderId,
    entryPrice: config.entryPrice ?? null,
    highestPrice: config.highestPrice ?? 0,
    isActivated: config.isActivated,
  };
}

export function tick(state: State, snap: Snapshot): { newState: State; intents: Intent[] } {
  const { currentPrice, hasOpenPosition, config } = snap;

  if (!state.entryOrderId) {
    return {
      newState: state,
      intents: [
        {
          kind: 'PLACE_ENTRY',
          usdtAmount: config.positionSizeUsdt,
          referencePrice: currentPrice,
        },
      ],
    };
  }

  if (!hasOpenPosition) {
    return { newState: state, intents: [] };
  }

  const entryPrice = state.entryPrice ?? currentPrice;
  const newHighest = Math.max(state.highestPrice || entryPrice, currentPrice);

  if (!state.isActivated) {
    const activationPrice = entryPrice * (1 + config.activationPricePct / 100);
    if (currentPrice >= activationPrice) {
      return {
        newState: { ...state, isActivated: true, highestPrice: newHighest },
        intents: [],
      };
    }
    return { newState: { ...state, highestPrice: newHighest }, intents: [] };
  }

  const trailPrice = newHighest * (1 - config.trailingPct / 100);
  if (currentPrice <= trailPrice) {
    return {
      newState: { ...state, highestPrice: newHighest },
      intents: [{ kind: 'CLOSE_POSITION' }],
    };
  }

  return { newState: { ...state, highestPrice: newHighest }, intents: [] };
}
