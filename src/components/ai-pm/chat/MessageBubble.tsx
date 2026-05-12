'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

export interface MessageBubbleProps {
  role: 'user' | 'assistant';
  content: string;
  decisionId: string | null;
  toolCalls: unknown;
  createdAt: string;
  pending?: boolean;
  failed?: boolean;
}

export function MessageBubble(props: MessageBubbleProps) {
  const t = useTranslations('AiPm.Chat');
  const isUser = props.role === 'user';

  const containerClass = isUser
    ? 'flex justify-end mb-3'
    : 'flex justify-start mb-3';

  const bubbleBase = 'max-w-[80%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap break-words';
  const userTint = props.failed
    ? 'bg-danger/10 border border-danger/40 text-danger-foreground'
    : 'bg-accent/15 text-foreground';
  const assistantTint = 'bg-default-100 border border-default-200 text-foreground';

  return (
    <div className={containerClass}>
      <div className="flex flex-col gap-1 max-w-full">
        <div className={`${bubbleBase} ${isUser ? userTint : assistantTint}`}>
          {props.pending ? (
            <span className="inline-flex items-center gap-1 text-muted" aria-label={t('typing')}>
              <Dot delay={0} />
              <Dot delay={150} />
              <Dot delay={300} />
              <span className="ml-2">{t('typing')}</span>
            </span>
          ) : (
            props.content
          )}
        </div>

        {props.failed && (
          <span className="text-xs text-danger pl-2">{t('sendFailed')}</span>
        )}

        {!props.pending && !isUser && props.decisionId && (
          <Link
            href={`/dashboard/ai-pm/activity?focus=${props.decisionId}`}
            className="text-xs text-accent hover:underline pl-2"
          >
            {t('viewDecision')}
          </Link>
        )}
      </div>
    </div>
  );
}

function Dot({ delay }: { delay: number }) {
  return (
    <span
      className="inline-block w-1.5 h-1.5 rounded-full bg-muted animate-pulse"
      style={{ animationDelay: `${delay}ms` }}
    />
  );
}
