'use client';

import { useTranslations } from 'next-intl';
import type { SpendSummary } from '@/services/ai-pm-activity.service';

export function SpendRail({ summary }: { summary: SpendSummary }) {
  const t = useTranslations('AiPm.Activity.rails');
  const detailT = useTranslations('AiPm.Activity.detail');
  const cost = Number(summary.costUsdToday).toFixed(4);

  return (
    <div className="rounded-lg border border-default-200 bg-background p-4">
      <h3 className="text-sm font-semibold mb-3">{t('spendTitle')}</h3>
      <dl className="grid grid-cols-2 gap-y-1 text-xs">
        <dt className="text-muted">{t('decisions')}</dt>
        <dd className="text-right font-mono">{summary.decisionsToday}</dd>
        <dt className="text-muted">{detailT('tokensIn')}</dt>
        <dd className="text-right font-mono">{summary.tokensInputToday.toLocaleString()}</dd>
        <dt className="text-muted">{detailT('tokensOut')}</dt>
        <dd className="text-right font-mono">{summary.tokensOutputToday.toLocaleString()}</dd>
        <dt className="text-muted">{detailT('cost')}</dt>
        <dd className="text-right font-mono">${cost}</dd>
      </dl>
    </div>
  );
}
