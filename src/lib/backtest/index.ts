// src/lib/backtest/index.ts
import type { BingxClient } from '@/lib/bingx/client';
import { fetchKlines } from '@/lib/bingx/market-data';
import { simulateDca } from '@/lib/backtest/simulators/dca';
import { simulateDcaSpot } from '@/lib/backtest/simulators/dca-spot';
import { simulateTrailingStop } from '@/lib/backtest/simulators/trailing-stop';
import { simulateSmaCrossover } from '@/lib/backtest/simulators/sma-crossover';
import { findCached, paramsHash, writeCache } from '@/lib/backtest/cache';
import { pnlPct, maxDrawdownPct, sharpeApprox, winRatePct } from '@/lib/backtest/metrics';
import type {
  BacktestableStrategy,
  BacktestResult,
  SimulatorResult,
} from '@/lib/backtest/types';
import type {
  DCAConfig,
  TrailingStopConfig,
  SMAConfig,
} from '@/services/bots/types';
import type { Kline } from '@/services/bingx.service';

export type BacktestParams = DCAConfig | TrailingStopConfig | SMAConfig;

export type RunBacktestArgs = {
  client: BingxClient;
  symbol: string;
  strategy: BacktestableStrategy;
  params: BacktestParams;
  windowDays?: number;
  initialCapitalUsdt?: number;
  interval?: string;
};

function deriveInitialCapital(strategy: BacktestableStrategy, params: BacktestParams): number {
  if (strategy === 'DCA' || strategy === 'DCA_SPOT') {
    const p = params as DCAConfig;
    return Math.max(1, p.orderSizeUsdt * Math.max(1, p.totalOrders));
  }
  if (strategy === 'TRAILING_STOP') {
    const p = params as TrailingStopConfig;
    return Math.max(1, p.positionSizeUsdt);
  }
  if (strategy === 'SMA_CROSSOVER') {
    const p = params as SMAConfig;
    return Math.max(1, p.positionSizeUsdt);
  }
  return 1000;
}

function dispatch(strategy: BacktestableStrategy, candles: Kline[], params: BacktestParams): SimulatorResult {
  switch (strategy) {
    case 'DCA':
      return simulateDca(candles, params as DCAConfig);
    case 'DCA_SPOT':
      return simulateDcaSpot(candles, params as DCAConfig);
    case 'TRAILING_STOP':
      return simulateTrailingStop(candles, params as TrailingStopConfig);
    case 'SMA_CROSSOVER':
      return simulateSmaCrossover(candles, params as SMAConfig);
    default: {
      const _exhaustive: never = strategy;
      throw new Error(`Unsupported strategy: ${String(_exhaustive)}`);
    }
  }
}

export async function runBacktest(args: RunBacktestArgs): Promise<BacktestResult> {
  const {
    client,
    symbol,
    strategy,
    params,
    windowDays = 30,
    initialCapitalUsdt,
    interval = '1h',
  } = args;

  if (
    strategy !== 'DCA' &&
    strategy !== 'DCA_SPOT' &&
    strategy !== 'TRAILING_STOP' &&
    strategy !== 'SMA_CROSSOVER'
  ) {
    throw new Error(`Unsupported strategy: ${String(strategy)}`);
  }

  const hash = paramsHash(params);
  const cached = await findCached(symbol, strategy, hash, windowDays);
  if (cached) {
    return {
      cached: true,
      pnlPct: cached.pnlPct === null ? 0 : Number(cached.pnlPct),
      maxDrawdownPct: cached.maxDrawdownPct === null ? 0 : Number(cached.maxDrawdownPct),
      sharpeApprox: cached.sharpeApprox === null ? 0 : Number(cached.sharpeApprox),
      winRatePct: cached.winRatePct === null ? 0 : Number(cached.winRatePct),
      totalTrades: cached.totalTrades ?? 0,
      paramsHash: hash,
      runId: cached.id,
    };
  }

  const limit = windowDays * 24;
  const candles = await fetchKlines(client, symbol, interval, limit);
  if (candles.length === 0) {
    throw new Error(`No klines returned for ${symbol} ${interval} (window ${windowDays}d)`);
  }

  const sim = dispatch(strategy, candles, params);
  const capital = initialCapitalUsdt ?? deriveInitialCapital(strategy, params);

  const pnl = pnlPct(sim.trades, capital);
  const dd = maxDrawdownPct(sim.equityCurve, capital);
  const sharpe = sharpeApprox(sim.trades);
  const wr = winRatePct(sim.trades);

  const inserted = await writeCache({
    symbol,
    strategy,
    paramsHash: hash,
    params: params as unknown as Record<string, unknown>,
    windowDays,
    pnlPct: pnl.toFixed(4),
    maxDrawdownPct: dd.toFixed(4),
    sharpeApprox: sharpe.toFixed(4),
    winRatePct: wr.toFixed(2),
    totalTrades: sim.trades.length,
    metricsJson: { trades: sim.trades, equityCurve: sim.equityCurve, initialCapitalUsdt: capital },
  });

  return {
    cached: false,
    pnlPct: pnl,
    maxDrawdownPct: dd,
    sharpeApprox: sharpe,
    winRatePct: wr,
    totalTrades: sim.trades.length,
    paramsHash: hash,
    runId: inserted.id,
  };
}
