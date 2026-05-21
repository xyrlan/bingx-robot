import { z } from 'zod';
import {
  sma,
  rsi,
  atr,
  bollinger,
  ema,
  fairValueGaps,
  swings,
  type Candle,
  type CloseCandle,
  type FvgZone,
} from '@/lib/ai-pm/indicators';
import type { Kline } from '@/services/bingx.service';

const SWING_LOOKBACK = 5;
const FVG_MAX_PER_SIDE = 3;

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
  ema20: number | null;
  ema50: number | null;
  rsi14: number | null;
  atr14: number | null;
  bollingerWidth: number | null;
  fvgBullish: FvgZone[];
  fvgBearish: FvgZone[];
  swingHigh: number | null;
  swingLow: number | null;
  stopDistanceAtrLong: number | null;
  stopDistanceAtrShort: number | null;
}

export function buildIndicatorSnapshot(symbol: string, candles: Kline[]): IndicatorSnapshot {
  const closeCandles: CloseCandle[] = candles.map((k) => ({ close: k.close }));
  const fullCandles: Candle[] = candles.map((k) => ({ high: k.high, low: k.low, close: k.close }));
  const lastClose = candles.length > 0 ? candles[candles.length - 1].close : 0;
  const bb = bollinger(closeCandles, 20, 2);
  const bollingerWidth =
    bb && bb.middle !== 0 ? (bb.upper - bb.lower) / bb.middle : null;

  const atr14 = atr(fullCandles, 14);
  const { swingHigh, swingLow } = swings(fullCandles, SWING_LOOKBACK);
  const fvgs = fairValueGaps(fullCandles);

  const stopDistanceAtrLong =
    atr14 && atr14 > 0 && swingLow !== null ? (lastClose - swingLow) / atr14 : null;
  const stopDistanceAtrShort =
    atr14 && atr14 > 0 && swingHigh !== null ? (swingHigh - lastClose) / atr14 : null;

  return {
    symbol,
    lastClose,
    sma20: sma(closeCandles, 20),
    sma50: sma(closeCandles, 50),
    ema20: ema(closeCandles, 20),
    ema50: ema(closeCandles, 50),
    rsi14: rsi(closeCandles, 14),
    atr14,
    bollingerWidth,
    fvgBullish: fvgs.bullish.slice(-FVG_MAX_PER_SIDE),
    fvgBearish: fvgs.bearish.slice(-FVG_MAX_PER_SIDE),
    swingHigh,
    swingLow,
    stopDistanceAtrLong,
    stopDistanceAtrShort,
  };
}

function formatFvgs(zones: FvgZone[]): string {
  if (zones.length === 0) return '[]';
  return zones
    .map((z) => `[${z.low.toFixed(4)}-${z.high.toFixed(4)} age=${z.ageBars}]`)
    .join(',');
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
        `ema20=${fmt(s.ema20)}`,
        `ema50=${fmt(s.ema50)}`,
        `rsi14=${fmt(s.rsi14)}`,
        `atr14=${fmt(s.atr14)}`,
        `bbWidth=${fmt(s.bollingerWidth)}`,
        `swingHigh=${fmt(s.swingHigh)}`,
        `swingLow=${fmt(s.swingLow)}`,
        `stopAtrLong=${fmt(s.stopDistanceAtrLong)}`,
        `stopAtrShort=${fmt(s.stopDistanceAtrShort)}`,
        `fvgBull=${formatFvgs(s.fvgBullish)}`,
        `fvgBear=${formatFvgs(s.fvgBearish)}`,
      ].join(' ');
    })
    .join('\n');

  return `Indicator snapshots (1h candles, latest 100):\n${rows}\n\nReturn top-5 candidates as JSON.`;
}
