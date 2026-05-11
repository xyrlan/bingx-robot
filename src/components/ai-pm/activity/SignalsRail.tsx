'use client';

import { useTranslations } from 'next-intl';
import type { AiSignalPublic } from '@/services/ai-pm-activity.service';

function relativeAge(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diffMs / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export function SignalsRail({ signals }: { signals: AiSignalPublic[] }) {
  const t = useTranslations('AiPm.Activity.rails');

  return (
    <div className="rounded-lg border border-default-200 bg-background p-4">
      <h3 className="text-sm font-semibold mb-3">{t('signalsTitle')}</h3>
      {signals.length === 0 ? (
        <p className="text-xs text-muted">{t('signalsEmpty')}</p>
      ) : (
        <ul className="space-y-2">
          {signals.map((s) => (
            <li key={s.id} className="flex items-center justify-between text-xs">
              <span className="font-mono">{s.symbol}</span>
              <span className="px-1.5 py-0.5 rounded bg-default-100 text-[10px] uppercase">{s.regime}</span>
              <span className="font-mono">{s.score}</span>
              <span className="text-muted">{relativeAge(s.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
