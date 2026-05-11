'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type {
  AiDecisionPublic,
  AiSignalPublic,
  PaperBotPublic,
  SpendSummary,
} from '@/services/ai-pm-activity.service';
import { FilterBar } from './FilterBar';
import { DecisionsList } from './DecisionsList';
import { SignalsRail } from './SignalsRail';
import { PaperBotsRail } from './PaperBotsRail';
import { SpendRail } from './SpendRail';
import { CronPulseRail } from './CronPulseRail';

interface ActivityResponse {
  decisions: AiDecisionPublic[];
  nextCursor: string | null;
  signals: AiSignalPublic[];
  paperBots: PaperBotPublic[];
  summary: SpendSummary;
  lastTickAt: string | null;
}

function buildQuery(params: URLSearchParams, cursor: string | null): string {
  const out = new URLSearchParams();
  for (const k of ['status', 'actionType', 'symbol', 'from', 'to']) {
    const v = params.get(k);
    if (v) out.set(k, v);
  }
  if (cursor) out.set('cursor', cursor);
  const s = out.toString();
  return s ? `?${s}` : '';
}

export function ActivityClient() {
  const params = useSearchParams();
  const t = useTranslations('AiPm.Activity');

  const [data, setData] = useState<ActivityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter signature derived only from URL — cursor is internal
  const filterSig = useMemo(() => {
    return ['status', 'actionType', 'symbol', 'from', 'to']
      .map((k) => `${k}=${params.get(k) ?? ''}`)
      .join('&');
  }, [params]);

  const fetchFresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/ai-pm/activity${buildQuery(params, null)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as ActivityResponse;
      setData(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setLoading(false);
    }
  }, [params]);

  const fetchMore = useCallback(async () => {
    if (!data?.nextCursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/ai-pm/activity${buildQuery(params, data.nextCursor)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as ActivityResponse;
      setData({
        ...data,
        decisions: [...data.decisions, ...body.decisions],
        nextCursor: body.nextCursor,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setLoading(false);
    }
  }, [data, loading, params]);

  // Refetch when filter signature changes
  useEffect(() => {
    fetchFresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterSig]);

  const hasFilters = filterSig.split('&').some((p) => !p.endsWith('='));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-4">
        <FilterBar loading={loading} onRefresh={fetchFresh} />

        {error && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 flex items-center justify-between">
            <span className="text-sm">{t('errorBanner')}: {error}</span>
            <button
              type="button"
              onClick={fetchFresh}
              className="text-xs px-3 py-1 rounded bg-background"
            >
              {t('retry')}
            </button>
          </div>
        )}

        <DecisionsList
          decisions={data?.decisions ?? []}
          nextCursor={data?.nextCursor ?? null}
          loading={loading}
          hasFilters={hasFilters}
          onLoadMore={fetchMore}
        />
      </div>

      <aside className="space-y-4">
        <CronPulseRail lastTickAt={data?.lastTickAt ?? null} />
        <SpendRail summary={data?.summary ?? { decisionsToday: 0, tokensInputToday: 0, tokensOutputToday: 0, costUsdToday: '0' }} />
        <SignalsRail signals={data?.signals ?? []} />
        <PaperBotsRail bots={data?.paperBots ?? []} />
      </aside>
    </div>
  );
}
