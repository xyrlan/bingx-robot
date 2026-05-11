'use client';

import { useTranslations } from 'next-intl';

function computePulse(lastTickAt: string): { color: string; label: string } {
  const diffMin = Math.floor((Date.now() - new Date(lastTickAt).getTime()) / 60_000);
  const color = diffMin < 30 ? 'bg-emerald-500' : diffMin < 60 ? 'bg-amber-500' : 'bg-rose-500';
  const label = diffMin < 1 ? 'now' : diffMin < 60 ? `${diffMin}m ago` : `${Math.floor(diffMin / 60)}h ago`;
  return { color, label };
}

export function CronPulseRail({ lastTickAt }: { lastTickAt: string | null }) {
  const t = useTranslations('AiPm.Activity.rails');

  if (!lastTickAt) {
    return (
      <div className="rounded-lg border border-default-200 bg-background p-4">
        <h3 className="text-sm font-semibold mb-2">{t('cronTitle')}</h3>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-rose-500" />
          <span className="text-xs">{t('cronNever')}</span>
        </div>
      </div>
    );
  }

  const { color, label } = computePulse(lastTickAt);

  return (
    <div className="rounded-lg border border-default-200 bg-background p-4">
      <h3 className="text-sm font-semibold mb-2">{t('cronTitle')}</h3>
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${color}`} />
        <span className="text-xs">{label}</span>
      </div>
    </div>
  );
}
