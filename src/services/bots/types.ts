export type BotType = 'GRID_LONG' | 'GRID_SHORT' | 'DCA' | 'TRAILING_STOP' | 'DCA_SPOT';

export type GridConfig = object; // Uses existing tradingBots columns (priceMin, priceMax, gridCount, etc.)

export type DCAConfig = {
  intervalMinutes: number;
  totalOrders: number;
  orderSizeUsdt: number;
  ordersPlaced: number;
  side: 'BUY' | 'SELL';
  lastOrderAt?: number;
};

export type TrailingStopConfig = {
  activationPricePct: number;
  trailingPct: number;
  positionSizeUsdt: number;
  highestPrice: number;
  isActivated: boolean;
  entryOrderId: string | null;
};

export type BotConfig = GridConfig | DCAConfig | TrailingStopConfig;

export const BOT_TYPE_LABELS: Record<BotType, string> = {
  GRID_LONG: 'Grid Long',
  GRID_SHORT: 'Grid Short',
  DCA: 'DCA',
  TRAILING_STOP: 'Trailing Stop',
  DCA_SPOT: 'DCA Spot',
};
