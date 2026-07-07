'use client';

import type { BotDailyPnlPoint } from '@/services/bot-stats.service';

type PnlSparklineProps = {
  /** Sparse daily series, ascending by date (YYYY-MM-DD). */
  data: BotDailyPnlPoint[];
  /** Number of trailing days to render (missing days show as empty slots). */
  days: number;
  className?: string;
};

const BAR_W = 4;
const GAP = 1;
const HEIGHT = 36;

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Dependency-free daily P&L bar sparkline. Positive days green, negative red;
 * baseline sits proportionally so both directions stay visible.
 */
export function PnlSparkline({ data, days, className }: PnlSparklineProps) {
  const byDay = new Map(data.map((p) => [p.date, p.pnl]));

  const today = new Date();
  const values: Array<{ date: string; pnl: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const key = dayKey(d);
    values.push({ date: key, pnl: byDay.get(key) ?? 0 });
  }

  const maxPos = Math.max(0, ...values.map((v) => v.pnl));
  const maxNeg = Math.max(0, ...values.map((v) => -v.pnl));
  const total = maxPos + maxNeg;
  if (total === 0) {
    return (
      <div className={`h-9 rounded bg-default-50 border border-dashed border-default-200 ${className ?? ''}`} />
    );
  }

  const baseline = (maxPos / total) * (HEIGHT - 2) + 1;
  const width = days * (BAR_W + GAP);

  return (
    <svg
      viewBox={`0 0 ${width} ${HEIGHT}`}
      preserveAspectRatio="none"
      className={`h-9 w-full ${className ?? ''}`}
      aria-hidden
    >
      <line x1="0" y1={baseline} x2={width} y2={baseline} className="stroke-default-200" strokeWidth="0.5" />
      {values.map((v, i) => {
        if (v.pnl === 0) return null;
        const scale = (HEIGHT - 2) / total;
        const h = Math.max(1, Math.abs(v.pnl) * scale);
        const y = v.pnl > 0 ? baseline - h : baseline;
        return (
          <rect
            key={v.date}
            x={i * (BAR_W + GAP)}
            y={y}
            width={BAR_W}
            height={h}
            rx="0.5"
            className={v.pnl > 0 ? 'fill-success' : 'fill-danger'}
          >
            <title>{`${v.date}: ${v.pnl > 0 ? '+' : ''}${v.pnl.toFixed(2)} USDT`}</title>
          </rect>
        );
      })}
    </svg>
  );
}
