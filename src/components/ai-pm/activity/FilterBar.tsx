'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { RefreshCw } from 'lucide-react';
import { ALL_STATUSES, ALL_ACTION_TYPES } from '@/services/ai-pm-activity.service';

interface Props {
  loading: boolean;
  onRefresh: () => void;
}

export function FilterBar({ loading, onRefresh }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const t = useTranslations('AiPm.Activity');
  const tStatus = useTranslations('AiPm.Activity.status');
  const tAction = useTranslations('AiPm.Activity.action');

  const selectedStatuses = new Set((params.get('status') ?? '').split(',').filter(Boolean));
  const selectedAction = params.get('actionType') ?? '';
  const symbol = params.get('symbol') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params.toString());
    if (value === null || value === '') next.delete(key);
    else next.set(key, value);
    router.replace(`?${next.toString()}`);
  }

  function toggleStatus(s: string) {
    const next = new Set(selectedStatuses);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    setParam('status', next.size ? Array.from(next).join(',') : null);
  }

  function reset() {
    router.replace('?');
  }

  return (
    <div className="rounded-lg border border-default-200 bg-background p-3 space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        <span className="text-xs font-semibold text-muted">{t('filterStatus')}:</span>
        {ALL_STATUSES.map((s) => {
          const active = selectedStatuses.has(s);
          return (
            <button
              key={s}
              type="button"
              onClick={() => toggleStatus(s)}
              className={`text-[10px] px-2 py-1 rounded uppercase font-semibold ${
                active ? 'bg-accent text-background' : 'bg-default-100 text-muted hover:text-foreground'
              }`}
            >
              {tStatus(s)}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <label className="flex items-center gap-2 text-xs">
          <span className="text-muted">{t('filterAction')}:</span>
          <select
            value={selectedAction}
            onChange={(e) => setParam('actionType', e.target.value || null)}
            className="text-xs bg-default-100 rounded px-2 py-1"
          >
            <option value="">—</option>
            {ALL_ACTION_TYPES.map((a) => (
              <option key={a} value={a}>{tAction(a)}</option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs">
          <span className="text-muted">{t('filterSymbol')}:</span>
          <input
            type="text"
            defaultValue={symbol}
            placeholder="BTC-USDT"
            onBlur={(e) => setParam('symbol', e.target.value.trim() || null)}
            className="text-xs bg-default-100 rounded px-2 py-1 w-32 font-mono"
          />
        </label>

        <label className="flex items-center gap-2 text-xs">
          <span className="text-muted">{t('filterFrom')}:</span>
          <input
            type="date"
            defaultValue={from ? from.slice(0, 10) : ''}
            onChange={(e) => setParam('from', e.target.value ? `${e.target.value}T00:00:00Z` : null)}
            className="text-xs bg-default-100 rounded px-2 py-1"
          />
        </label>

        <label className="flex items-center gap-2 text-xs">
          <span className="text-muted">{t('filterTo')}:</span>
          <input
            type="date"
            defaultValue={to ? to.slice(0, 10) : ''}
            onChange={(e) => setParam('to', e.target.value ? `${e.target.value}T23:59:59Z` : null)}
            className="text-xs bg-default-100 rounded px-2 py-1"
          />
        </label>

        <button
          type="button"
          onClick={reset}
          className="ml-auto text-xs text-muted hover:text-foreground underline"
        >
          {t('reset')}
        </button>

        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="text-xs px-3 py-1 rounded-lg bg-accent text-background flex items-center gap-1 disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          {t('refresh')}
        </button>
      </div>
    </div>
  );
}
