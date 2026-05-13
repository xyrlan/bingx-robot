'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@heroui/react';
import type { UIMessage } from 'ai';
import { MessageBubble } from './MessageBubble';

export interface MessageListProps {
  messages: UIMessage[];
  pending: boolean;
  oldestCursor: string | null;
  onLoadOlder: () => void;
  loadingOlder: boolean;
}

const NEAR_BOTTOM_PX = 100;

export function MessageList({
  messages,
  pending,
  oldestCursor,
  onLoadOlder,
  loadingOlder,
}: MessageListProps) {
  const t = useTranslations('AiPm.Chat');
  const containerRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      wasNearBottomRef.current = distance < NEAR_BOTTOM_PX;
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (wasNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, pending]);

  if (messages.length === 0 && !pending) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted text-sm">
        {t('noMessagesYet')}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto px-3 py-4">
      {oldestCursor && (
        <div className="flex justify-center mb-3">
          <Button
            size="sm"
            variant="outline"
            isDisabled={loadingOlder}
            onPress={onLoadOlder}
          >
            {t('loadOlder')}
          </Button>
        </div>
      )}
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} />
      ))}
      {pending && (
        <MessageBubble
          message={{ id: 'pending', role: 'assistant', parts: [] } as UIMessage}
          pending
        />
      )}
    </div>
  );
}
