'use client';

import { useTranslations } from 'next-intl';
import type { AiDecisionPublic } from '@/services/ai-pm-activity.service';
import { DecisionRow } from './DecisionRow';

interface Props {
  decisions: AiDecisionPublic[];
  nextCursor: string | null;
  loading: boolean;
  hasFilters: boolean;
  onLoadMore: () => void;
}

export function DecisionsList({ decisions, nextCursor, loading, hasFilters, onLoadMore }: Props) {
  const t = useTranslations('AiPm.Activity');

  if (decisions.length === 0 && !loading) {
    return (
      <div className="rounded-lg border border-default-200 bg-background p-8 text-center text-sm text-muted">
        {hasFilters ? t('emptyFiltered') : t('emptyAll')}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-default-200 bg-background">
      <ul>
        {decisions.map((d) => (
          <DecisionRow key={d.id} decision={d} />
        ))}
      </ul>
      {nextCursor && (
        <div className="border-t border-default-200 p-3 flex justify-center">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loading}
            className="text-sm px-4 py-2 rounded-lg bg-default-100 hover:bg-default-200 disabled:opacity-50"
          >
            {loading ? t('loading') : t('loadMore')}
          </button>
        </div>
      )}
    </div>
  );
}
