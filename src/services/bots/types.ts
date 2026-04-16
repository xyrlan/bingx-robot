export type BotType = 'GRID_LONG' | 'GRID_SHORT' | 'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER';

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

export type SMASymbolState = {
  position: 'LONG' | 'SHORT' | null;
  entryPrice: number | null;
  entryOrderId: string | null;
  stopOrderId: string | null;
  highestPrice: number | null;
  lowestPrice: number | null;
  trailingActivated: boolean;
  lastSignal: 'LONG' | 'SHORT' | null;
  lastSignalAt: number | null;
  lastAtr: number | null;
};

export type SMAConfig = {
  symbols: string[];
  timeframe: string;
  fastPeriod: number;
  mediumPeriod: number;
  trendPeriod: number;
  adxPeriod: number;
  adxThreshold: number;
  atrPeriod: number;
  activationAtrMult: number;
  trailingAtrMult: number;
  initialStopAtrMult: number;
  positionSizeUsdt: number;
  leverage: number;
  marginType: string;
  symbolStates: Record<string, SMASymbolState>;
};

export type BotConfig = GridConfig | DCAConfig | TrailingStopConfig | SMAConfig;

export const BOT_TYPE_LABELS: Record<BotType, string> = {
  GRID_LONG: 'Grid Long',
  GRID_SHORT: 'Grid Short',
  DCA: 'DCA',
  TRAILING_STOP: 'Trailing Stop',
  DCA_SPOT: 'DCA Spot',
  SMA_CROSSOVER: 'SMA Crossover',
};
