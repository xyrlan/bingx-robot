'use client';

import { useTranslations } from 'next-intl';
import type { AiDecisionPublic } from '@/services/ai-pm-activity.service';

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value as object).length === 0;
  }
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export function DecisionDetail({ decision }: { decision: AiDecisionPublic }) {
  const t = useTranslations('AiPm.Activity.detail');

  const hasSignal = !isEmpty(decision.signalSnapshot);
  const hasParams = !isEmpty(decision.params);

  return (
    <div className="space-y-4 px-4 py-3 bg-default-50 border-t border-default-200">
      {(decision.reasoning || decision.rejectionReason) && (
        <section>
          <h4 className="text-xs font-semibold uppercase text-muted mb-1">{t('reasoning')}</h4>
          {decision.reasoning && <p className="text-sm whitespace-pre-wrap">{decision.reasoning}</p>}
          {decision.rejectionReason && (
            <p className="text-sm mt-2">
              <span className="text-muted">{t('rejection')}: </span>
              <span>{decision.rejectionReason}</span>
            </p>
          )}
        </section>
      )}

      <section>
        {hasSignal ? (
          <details>
            <summary className="cursor-pointer text-xs font-semibold uppercase text-muted">{t('signal')}</summary>
            <pre className="text-xs mt-2 overflow-x-auto bg-background p-2 rounded border border-default-200">
              {JSON.stringify(decision.signalSnapshot, null, 2)}
            </pre>
          </details>
        ) : (
          <div className="text-xs font-semibold uppercase text-muted">
            {t('signal')} <span className="font-normal normal-case">— {t('noSignal')}</span>
          </div>
        )}
      </section>

      {hasParams && (
        <section>
          <details>
            <summary className="cursor-pointer text-xs font-semibold uppercase text-muted">{t('params')}</summary>
            <pre className="text-xs mt-2 overflow-x-auto bg-background p-2 rounded border border-default-200">
              {JSON.stringify(decision.params, null, 2)}
            </pre>
          </details>
        </section>
      )}

      <section>
        <h4 className="text-xs font-semibold uppercase text-muted mb-1">
          {decision.paperBot ? t('linkedPaperBot') : t('linkedBot')}
        </h4>
        {decision.paperBot ? (
          <div className="text-sm font-mono">
            {decision.paperBot.symbol} · {decision.paperBot.strategy} · {decision.paperBot.status} · pnl {Number(decision.paperBot.pnlUsdt).toFixed(2)}
          </div>
        ) : decision.resultBotId ? (
          <a className="text-sm text-accent underline" href={`/dashboard/bots/${decision.resultBotId}`}>
            {decision.resultBotId}
          </a>
        ) : (
          <span className="text-sm text-muted">{t('noLink')}</span>
        )}
      </section>

      <section>
        <dl className="grid grid-cols-4 gap-2 text-xs">
          <div>
            <dt className="text-muted">{t('model')}</dt>
            <dd className="font-mono">{decision.modelUsed ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-muted">{t('tokensIn')}</dt>
            <dd className="font-mono">{decision.tokensInput ?? 0}</dd>
          </div>
          <div>
            <dt className="text-muted">{t('tokensOut')}</dt>
            <dd className="font-mono">{decision.tokensOutput ?? 0}</dd>
          </div>
          <div>
            <dt className="text-muted">{t('cost')}</dt>
            <dd className="font-mono">${Number(decision.costUsd ?? '0').toFixed(6)}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
