'use client';

import { STAT_WINDOW_KEYS, type StatWindowKey } from '@/lib/bot-stats-types';
import { useTranslations } from 'next-intl';

type PeriodSelectorProps = {
  value: StatWindowKey;
  onChange: (value: StatWindowKey) => void;
};

export function PeriodSelector({ value, onChange }: PeriodSelectorProps) {
  const t = useTranslations('Bots.periods');

  return (
    <div className="inline-flex items-center rounded-lg bg-default-100 p-0.5 gap-0.5" role="tablist">
      {STAT_WINDOW_KEYS.map((key) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={value === key}
          onClick={() => onChange(key)}
          className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors touch-target ${
            value === key
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted hover:text-foreground'
          }`}
        >
          {t(key)}
        </button>
      ))}
    </div>
  );
}
