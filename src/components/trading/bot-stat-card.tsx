'use client';

import { useTranslations } from 'next-intl';
import type { BotStats, StatWindowKey } from '@/lib/bot-stats-types';
import { formatPnl, formatPercent } from '@/lib/format-pnl';
import { PnlSparkline } from './bots-stats/pnl-sparkline';

const SPARKLINE_DAYS: Record<StatWindowKey, number> = {
  '7d': 7,
  '30d': 30,
  '60d': 60,
  '90d': 90,
  '180d': 90, // series is capped at 90 days server-side
  all: 90,
};

type BotStatsSectionProps = {
  stats: BotStats | undefined;
  statsLoading: boolean;
  period: StatWindowKey;
  /** Allocated capital = positionSizeUsdt × gridCount (for ROI). */
  allocatedUsdt: number;
};

/** Windowed money stats + sparkline rendered inside each bot card. */
export function BotStatsSection({ stats, statsLoading, period, allocatedUsdt }: BotStatsSectionProps) {
  const t = useTranslations('Bots.stats');
  const tSource = useTranslations('Bots.source');

  if (statsLoading && !stats) {
    return (
      <div className="mt-2 space-y-2 animate-pulse">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-12 rounded-lg bg-default-100" />
          ))}
        </div>
        <div className="h-9 rounded bg-default-100" />
      </div>
    );
  }
  if (!stats) return null;

  const w = stats.windows[period];
  const winRate = w.trades > 0 ? w.wins / w.trades : null;
  const avgPerCycle = w.trades > 0 ? w.pnl / w.trades : null;
  const roi = allocatedUsdt > 0 ? w.pnl / allocatedUsdt : null;
  const sparkDays = SPARKLINE_DAYS[period];
  const truncated = period === '180d' || period === 'all';

  const tiles: Array<{ label: string; value: string; tone?: 'pnl' }> = [
    { label: t('realized'), value: formatPnl(w.pnl), tone: 'pnl' },
    { label: t('winRate'), value: winRate == null ? '—' : formatPercent(winRate, 0) },
    { label: t('trades'), value: String(w.trades) },
    { label: t('avgPerCycle'), value: avgPerCycle == null ? '—' : formatPnl(avgPerCycle) },
    { label: t('roi'), value: roi == null ? '—' : formatPercent(roi) },
  ];

  return (
    <div className="mt-2 space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {tiles.map((tile) => (
          <div key={tile.label} className="bg-default-50 rounded-lg px-2.5 py-1.5">
            <p className="text-[11px] text-default-500">{tile.label}</p>
            <p
              className={`text-sm font-semibold font-numeric truncate ${
                tile.tone === 'pnl' ? (w.pnl >= 0 ? 'text-success' : 'text-danger') : 'text-foreground'
              }`}
            >
              {tile.value}
            </p>
          </div>
        ))}
      </div>
      <div>
        <PnlSparkline data={stats.daily} days={sparkDays} />
        <div className="flex items-center justify-between mt-0.5">
          <span className="text-[10px] text-default-400">
            {truncated ? t('last90Days') : null}
          </span>
          <span className="text-[10px] text-default-400 uppercase tracking-wide">
            {tSource(stats.source)}
          </span>
        </div>
      </div>
    </div>
  );
}
