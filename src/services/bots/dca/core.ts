import type { DCAConfig } from '@/services/bots/types';

export interface Snapshot {
  now: number;
  currentPrice: number;
  botCreatedAt: number;
  config: DCAConfig;
}

export interface State {
  ordersPlaced: number;
  lastOrderAt: number | null;
}

export type Intent =
  | { kind: 'PLACE_ENTRY'; side: 'BUY' | 'SELL'; usdtAmount: number; referencePrice: number }
  | { kind: 'BOT_DONE' };

export function initialState(config: DCAConfig): State {
  return {
    ordersPlaced: config.ordersPlaced,
    lastOrderAt: config.lastOrderAt ?? null,
  };
}

export function tick(state: State, snap: Snapshot): { newState: State; intents: Intent[] } {
  const { now, currentPrice, botCreatedAt, config } = snap;

  if (state.ordersPlaced >= config.totalOrders) {
    return { newState: state, intents: [] };
  }

  const intervalMs = config.intervalMinutes * 60 * 1000;

  let due = false;
  if (state.lastOrderAt !== null) {
    due = now - state.lastOrderAt >= intervalMs;
  } else {
    const elapsed = now - botCreatedAt;
    const expected = Math.floor(elapsed / intervalMs) + 1;
    due = state.ordersPlaced < expected;
  }

  if (!due) return { newState: state, intents: [] };

  const intents: Intent[] = [
    {
      kind: 'PLACE_ENTRY',
      side: config.side,
      usdtAmount: config.orderSizeUsdt,
      referencePrice: currentPrice,
    },
  ];
  const newState: State = {
    ordersPlaced: state.ordersPlaced + 1,
    lastOrderAt: now,
  };
  if (newState.ordersPlaced >= config.totalOrders) {
    intents.push({ kind: 'BOT_DONE' });
  }
  return { newState, intents };
}
