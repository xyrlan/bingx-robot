// src/lib/backtest/metrics.ts
import type { Trade } from '@/lib/backtest/types';

export function pnlPct(trades: Trade[], initialCapital: number): number {
  if (trades.length === 0 || initialCapital <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < trades.length; i++) sum += trades[i].pnlUsdt;
  return (sum / initialCapital) * 100;
}

export function maxDrawdownPct(equityCurve: number[], initialCapital: number): number {
  if (equityCurve.length === 0 || initialCapital <= 0) return 0;
  let peak = equityCurve[0];
  let maxDd = 0;
  for (let i = 1; i < equityCurve.length; i++) {
    const v = equityCurve[i];
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDd) maxDd = dd;
  }
  return (maxDd / initialCapital) * 100;
}

export function sharpeApprox(trades: Trade[]): number {
  if (trades.length < 2) return 0;
  let mean = 0;
  for (let i = 0; i < trades.length; i++) mean += trades[i].pnlPct;
  mean /= trades.length;

  let variance = 0;
  for (let i = 0; i < trades.length; i++) {
    const d = trades[i].pnlPct - mean;
    variance += d * d;
  }
  variance /= trades.length;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return mean / std;
}

export function winRatePct(trades: Trade[]): number {
  if (trades.length === 0) return 0;
  let wins = 0;
  for (let i = 0; i < trades.length; i++) {
    if (trades[i].pnlUsdt > 0) wins++;
  }
  return (wins / trades.length) * 100;
}
