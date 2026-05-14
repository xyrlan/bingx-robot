'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { UIMessage } from 'ai';

export interface MessageBubbleProps {
  message: UIMessage;
  pending?: boolean;
  failed?: boolean;
  onRetry?: () => void;
}

type ToolStatus =
  | 'EXECUTED'
  | 'REJECTED_GUARDRAIL'
  | 'REJECTED_BACKTEST'
  | 'REJECTED_REVIEWER'
  | 'EXECUTION_FAILED';

interface ToolOutputShape {
  status?: ToolStatus | string;
  decisionId?: string | null;
  summary?: string;
}

function statusIcon(status: string | undefined): string {
  if (!status || status === 'EXECUTED') return '🔧';
  return '❌';
}

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
  const isUser = props.message.role === 'user';
  const containerClass = isUser ? 'flex justify-end mb-3' : 'flex justify-start mb-3';
  // max-width lives on the wrapper, not the bubble. Putting it on the bubble
  // while the flex-col wrapper is content-sized creates a circular constraint
  // that collapses the bubble to ~1ch and break-words shatters words per-char.
  const bubbleBase = 'w-fit rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap break-words';
  const userTint = props.failed
    ? 'bg-danger/10 border border-danger/40 text-danger-foreground'
    : 'bg-accent/15 text-foreground';
  const assistantTint = 'bg-default-100 border border-default-200 text-foreground';

  const textContent = props.message.parts
    .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');

  const toolParts = props.message.parts.filter(
    (p) => typeof p.type === 'string' && p.type.startsWith('tool-'),
  );

  const showTypingDots = props.pending && !textContent && toolParts.length === 0;
  const showBubble = !!textContent || showTypingDots;

  return (
    <div className={containerClass}>
      <div className="flex flex-col gap-1 max-w-[80%]">
        {showBubble && (
          <div className={`${bubbleBase} ${isUser ? userTint : assistantTint}`}>
            {showTypingDots ? (
              <span className="text-muted" aria-label={t('typing')}>
                <span className="inline-flex items-center gap-1 align-middle mr-2">
                  <Dot delay={0} />
                  <Dot delay={150} />
                  <Dot delay={300} />
                </span>
                {t('typing')}
              </span>
            ) : (
              renderInlineMarkdown(textContent)
            )}
          </div>
        )}

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

        {!isUser && toolParts.length > 0 && (
          <div className="text-xs text-muted pl-2 mt-1 space-y-0.5">
            <div className="font-semibold">{t('toolCallsHeader')}</div>
            <ul className="space-y-0.5">
              {toolParts.map((part) => {
                const toolName = part.type.startsWith('tool-')
                  ? part.type.slice('tool-'.length)
                  : 'unknown';
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const p = part as any;
                const state = p.state as
                  | 'input-streaming'
                  | 'input-available'
                  | 'output-available'
                  | 'output-error'
                  | undefined;
                const output = p.output as ToolOutputShape | undefined;
                const status = output?.status ?? (state === 'output-error' ? 'EXECUTION_FAILED' : 'EXECUTED');
                const decisionId = output?.decisionId ?? null;
                const summary =
                  state === 'input-streaming' || state === 'input-available'
                    ? t('toolStatus.executing')
                    : output?.summary ?? p.errorText ?? '';
                const inner = (
                  <span>
                    <span className="mr-1">{statusIcon(status)}</span>
                    <span className="font-mono mr-1">{toolName}</span>
                    <span>— {summary}</span>
                  </span>
                );
                return (
                  <li key={p.toolCallId ?? `${toolName}-${state}`}>
                    {decisionId ? (
                      <Link
                        href={`/dashboard/ai-pm/activity?focus=${decisionId}`}
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
