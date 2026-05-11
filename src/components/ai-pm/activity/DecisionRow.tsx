'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { AiDecisionPublic, AiDecisionStatus } from '@/services/ai-pm-activity.service';
import { DecisionDetail } from './DecisionDetail';

function statusClass(s: AiDecisionStatus): string {
  switch (s) {
    case 'EXECUTED': return 'bg-emerald-500/10 text-emerald-500';
    case 'PROPOSED': return 'bg-sky-500/10 text-sky-500';
    case 'REJECTED_GUARDRAIL':
    case 'REJECTED_BACKTEST': return 'bg-amber-500/10 text-amber-500';
    case 'REJECTED_REVIEWER': return 'bg-orange-500/10 text-orange-500';
    case 'EXECUTION_FAILED': return 'bg-rose-500/10 text-rose-500';
  }
}

function relativeAge(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diffMs / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function DecisionRow({ decision }: { decision: AiDecisionPublic }) {
  const [open, setOpen] = useState(false);
  const tStatus = useTranslations('AiPm.Activity.status');
  const tAction = useTranslations('AiPm.Activity.action');

  return (
    <li className="border-b border-default-200 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-default-50"
      >
        {open ? <ChevronDown className="w-4 h-4 text-muted" /> : <ChevronRight className="w-4 h-4 text-muted" />}
        <span className={`px-2 py-0.5 rounded text-[10px] uppercase font-semibold ${statusClass(decision.status)}`}>
          {tStatus(decision.status)}
        </span>
        <span className="text-sm">{tAction(decision.actionType)}</span>
        <span className="text-sm font-mono">{decision.symbol ?? '—'}</span>
        <span className="ml-auto text-xs text-muted">{relativeAge(decision.createdAt)}</span>
      </button>
      {open && <DecisionDetail decision={decision} />}
    </li>
  );
}
