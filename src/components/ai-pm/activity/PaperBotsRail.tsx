'use client';

import { useTranslations } from 'next-intl';
import type { PaperBotPublic } from '@/services/ai-pm-activity.service';

export function PaperBotsRail({ bots }: { bots: PaperBotPublic[] }) {
  const t = useTranslations('AiPm.Activity.rails');

  return (
    <div className="rounded-lg border border-default-200 bg-background p-4">
      <h3 className="text-sm font-semibold mb-3">{t('paperBotsTitle')}</h3>
      {bots.length === 0 ? (
        <p className="text-xs text-muted">{t('paperBotsEmpty')}</p>
      ) : (
        <ul className="space-y-2">
          {bots.map((b) => {
            const pnl = Number(b.pnlUsdt);
            const pnlClass = pnl > 0 ? 'text-emerald-500' : pnl < 0 ? 'text-rose-500' : 'text-muted';
            return (
              <li key={b.id} className="text-xs flex items-center justify-between">
                <div className="flex flex-col">
                  <span className="font-mono">{b.symbol}</span>
                  <span className="text-[10px] text-muted">{b.strategy} · {b.tradesCount} trades</span>
                </div>
                <span className={`font-mono ${pnlClass}`}>{pnl.toFixed(2)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
