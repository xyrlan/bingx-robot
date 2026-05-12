'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

export interface ToolCallEntry {
  toolName: string;
  args: unknown;
  status: 'EXECUTED' | 'REJECTED_GUARDRAIL' | 'REJECTED_BACKTEST' | 'REJECTED_REVIEWER' | 'EXECUTION_FAILED';
  decisionId: string | null;
  summary: string;
}

export interface MessageBubbleProps {
  role: 'user' | 'assistant';
  content: string;
  decisionId: string | null;
  toolCalls: ToolCallEntry[] | null;
  createdAt: string;
  pending?: boolean;
  failed?: boolean;
  onRetry?: () => void;
}

function statusIcon(status: ToolCallEntry['status']): string {
  return status === 'EXECUTED' ? '🔧' : '❌';
}

// Minimal inline markdown — handles **bold**, *italic*, `code`. Multi-line text
// is preserved by `whitespace-pre-wrap` on the bubble container.
function renderInlineMarkdown(text: string): React.ReactNode {
  if (!text) return null;
  const parts: React.ReactNode[] = [];
  const re = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const m = match[0];
    if (m.startsWith('**')) parts.push(<strong key={key++}>{m.slice(2, -2)}</strong>);
    else if (m.startsWith('`')) parts.push(
      <code key={key++} className="bg-default-200/60 px-1 py-0.5 rounded text-xs font-mono">{m.slice(1, -1)}</code>,
    );
    else parts.push(<em key={key++}>{m.slice(1, -1)}</em>);
    lastIndex = match.index + m.length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length ? parts : text;
}

export function MessageBubble(props: MessageBubbleProps) {
  const t = useTranslations('AiPm.Chat');
  const isUser = props.role === 'user';

  const containerClass = isUser ? 'flex justify-end mb-3' : 'flex justify-start mb-3';
  const bubbleBase = 'max-w-[80%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap break-words';
  const userTint = props.failed
    ? 'bg-danger/10 border border-danger/40 text-danger-foreground'
    : 'bg-accent/15 text-foreground';
  const assistantTint = 'bg-default-100 border border-default-200 text-foreground';

  const hasToolCalls = Array.isArray(props.toolCalls) && props.toolCalls.length > 0;

  return (
    <div className={containerClass}>
      <div className="flex flex-col gap-1 max-w-full">
        <div className={`${bubbleBase} ${isUser ? userTint : assistantTint}`}>
          {props.pending ? (
            <span className="text-muted" aria-label={t('typing')}>
              <span className="inline-flex items-center gap-1 align-middle mr-2">
                <Dot delay={0} />
                <Dot delay={150} />
                <Dot delay={300} />
              </span>
              {t('typing')}
            </span>
          ) : (
            renderInlineMarkdown(props.content)
          )}
        </div>

        {props.failed && (
          props.onRetry ? (
            <button
              type="button"
              onClick={props.onRetry}
              className="text-xs text-danger pl-2 text-left hover:underline"
            >
              {t('sendFailed')}
            </button>
          ) : (
            <span className="text-xs text-danger pl-2">{t('sendFailed')}</span>
          )
        )}

        {!props.pending && !isUser && hasToolCalls && (
          <div className="text-xs text-muted pl-2 mt-1 space-y-0.5">
            <div className="font-semibold">{t('toolCallsHeader')}</div>
            <ul className="space-y-0.5">
              {(props.toolCalls as ToolCallEntry[]).map((entry, i) => {
                const inner = (
                  <span>
                    <span className="mr-1">{statusIcon(entry.status)}</span>
                    <span className="font-mono mr-1">{entry.toolName}</span>
                    <span>— {entry.summary}</span>
                  </span>
                );
                return (
                  <li key={`${entry.toolName}-${i}`}>
                    {entry.decisionId ? (
                      <Link
                        href={`/dashboard/ai-pm/activity?focus=${entry.decisionId}`}
                        className="hover:underline text-accent"
                      >
                        {inner}
                      </Link>
                    ) : (
                      inner
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {!props.pending && !isUser && !hasToolCalls && props.decisionId && (
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
