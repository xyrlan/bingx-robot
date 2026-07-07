/** Client-safe types/constants for bot money stats (no DB imports). */

export const STAT_WINDOW_KEYS = ['7d', '30d', '60d', '90d', '180d', 'all'] as const;
export type StatWindowKey = (typeof STAT_WINDOW_KEYS)[number];

export type BotWindowStats = { pnl: number; trades: number; wins: number };
export type BotWindowedStats = Record<StatWindowKey, BotWindowStats>;
export type BotDailyPnlPoint = { date: string; pnl: number };

export type BotStats = {
  botId: string;
  windows: BotWindowedStats;
  daily: BotDailyPnlPoint[];
  source: 'estimated' | 'real';
};

export function emptyWindowedStats(): BotWindowedStats {
  const empty = () => ({ pnl: 0, trades: 0, wins: 0 });
  return {
    '7d': empty(),
    '30d': empty(),
    '60d': empty(),
    '90d': empty(),
    '180d': empty(),
    all: empty(),
  };
}
