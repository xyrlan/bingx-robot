import { z } from 'zod';
import {
  sma,
  rsi,
  atr,
  bollinger,
  type Candle,
  type CloseCandle,
} from '@/lib/ai-pm/indicators';
import type { Kline } from '@/services/bingx.service';

export const REGIME_VALUES = ['range', 'trend_up', 'trend_down', 'volatile'] as const;
export type Regime = (typeof REGIME_VALUES)[number];

export const SignalResponseSchema = z.object({
  candidates: z.array(
    z.object({
      symbol: z.string().min(1),
      regime: z.enum(REGIME_VALUES),
      score: z.number().min(0).max(100),
      reason: z.string().min(1).max(500),
    }),
  ),
});

export type SignalResponse = z.infer<typeof SignalResponseSchema>;

export interface IndicatorSnapshot {
  symbol: string;
  lastClose: number;
  sma20: number | null;
  sma50: number | null;
  rsi14: number | null;
  atr14: number | null;
  bollingerWidth: number | null;
}

export function buildIndicatorSnapshot(symbol: string, candles: Kline[]): IndicatorSnapshot {
  const closeCandles: CloseCandle[] = candles.map((k) => ({ close: k.close }));
  const fullCandles: Candle[] = candles.map((k) => ({ high: k.high, low: k.low, close: k.close }));
  const lastClose = candles.length > 0 ? candles[candles.length - 1].close : 0;
  const bb = bollinger(closeCandles, 20, 2);
  const bollingerWidth =
    bb && bb.middle !== 0 ? (bb.upper - bb.lower) / bb.middle : null;

  return {
    symbol,
    lastClose,
    sma20: sma(closeCandles, 20),
    sma50: sma(closeCandles, 50),
    rsi14: rsi(closeCandles, 14),
    atr14: atr(fullCandles, 14),
    bollingerWidth,
  };
}

export function buildSystemPrompt(): string {
  return [
    'You are a quantitative analyst for a crypto futures portfolio.',
    'Given indicator snapshots for several symbols, return up to 5 candidates ranked by opportunity.',
    '',
    'Regime values:',
    '- "range": price oscillating, low directional bias (good for grid/DCA)',
    '- "trend_up": sustained upward move (good for trailing-stop long)',
    '- "trend_down": sustained downward move (avoid or short)',
    '- "volatile": high ATR, no clear direction (reduce risk)',
    '',
    'Score is 0-100: 100 = highest conviction trading opportunity, 0 = avoid.',
    'Reason: one sentence, plain English, no markdown.',
    '',
    'Return JSON only, no preamble. Schema:',
    '{"candidates":[{"symbol":"BTC-USDT","regime":"range","score":75,"reason":"..."}]}',
  ].join('\n');
}

export function buildUserPrompt(snapshots: IndicatorSnapshot[]): string {
  const rows = snapshots
    .map((s) => {
      const fmt = (n: number | null) => (n === null ? 'n/a' : n.toFixed(4));
      return [
        `symbol=${s.symbol}`,
        `last=${s.lastClose.toFixed(4)}`,
        `sma20=${fmt(s.sma20)}`,
        `sma50=${fmt(s.sma50)}`,
        `rsi14=${fmt(s.rsi14)}`,
        `atr14=${fmt(s.atr14)}`,
        `bbWidth=${fmt(s.bollingerWidth)}`,
      ].join(' ');
    })
    .join('\n');

  return `Indicator snapshots (1h candles, latest 100):\n${rows}\n\nReturn top-5 candidates as JSON.`;
}
