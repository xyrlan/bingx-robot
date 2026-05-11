// src/lib/backtest/types.ts
import type { BotType } from '@/services/bots/types';
import type { Kline } from '@/services/bingx.service';

export type Trade = {
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  side: 'LONG' | 'SHORT';
  pnlPct: number;
  pnlUsdt: number;
  notionalUsdt: number;
};

export type SimulatorResult = {
  trades: Trade[];
  equityCurve: number[];
};

export type Simulator<TParams> = (candles: Kline[], params: TParams) => SimulatorResult;

export type BacktestResult = {
  cached: boolean;
  pnlPct: number;
  maxDrawdownPct: number;
  sharpeApprox: number;
  winRatePct: number;
  totalTrades: number;
  paramsHash: string;
  runId: string;
};

export type BacktestableStrategy = Extract<BotType, 'DCA' | 'DCA_SPOT' | 'TRAILING_STOP' | 'SMA_CROSSOVER'>;
