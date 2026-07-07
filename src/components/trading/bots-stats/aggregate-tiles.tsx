'use client';

import { useTranslations } from 'next-intl';
import type { BotStats, StatWindowKey } from '@/lib/bot-stats-types';
import { formatPnl, formatPercent } from '@/lib/format-pnl';

type AggregateTilesProps = {
  /** Stats for the bots being aggregated (running bots), keyed lookup already applied. */
  stats: Array<BotStats | undefined>;
  period: StatWindowKey;
  totalUnrealized: number;
  totalProjected: number;
};

/** Aggregate tiles across running bots: windowed realized P&L + live unrealized/projected. */
export function AggregateTiles({ stats, period, totalUnrealized, totalProjected }: AggregateTilesProps) {
  const t = useTranslations('Bots.stats');

  let pnl = 0;
  let trades = 0;
  let wins = 0;
  for (const s of stats) {
    if (!s) continue;
    const w = s.windows[period];
    pnl += w.pnl;
    trades += w.trades;
    wins += w.wins;
  }
  const winRate = trades > 0 ? wins / trades : null;
  const totalPnl = pnl + totalUnrealized;

  const tiles = [
    { label: t('realized'), value: formatPnl(pnl), signed: pnl },
    { label: t('unrealized'), value: formatPnl(totalUnrealized), signed: totalUnrealized },
    { label: t('totalPnl'), value: formatPnl(totalPnl), signed: totalPnl },
    { label: t('projected'), value: formatPnl(totalProjected), signed: totalProjected, title: t('projectedTitle') },
    { label: t('winRate'), value: winRate == null ? '—' : formatPercent(winRate, 0) },
    { label: t('trades'), value: String(trades) },
  ] as Array<{ label: string; value: string; signed?: number; title?: string }>;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
      {tiles.map((tile) => (
        <div key={tile.label} className="bg-default-100 rounded-lg p-3 text-center" title={tile.title}>
          <p className="text-xs text-default-500">{tile.label}</p>
          <p
            className={`text-xs sm:text-sm font-semibold font-numeric truncate ${
              tile.signed == null ? 'text-foreground' : tile.signed >= 0 ? 'text-success' : 'text-danger'
            }`}
          >
            {tile.value}
          </p>
        </div>
      ))}
    </div>
  );
}
