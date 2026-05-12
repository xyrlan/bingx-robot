'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { ChatMessagePublic } from '@/services/ai-pm-chat-history.service';
import { ChatHeader, type ChatHeaderConfigOption } from './ChatHeader';
import { MessageList } from './MessageList';
import { ComposeBar } from './ComposeBar';

export interface ChatClientProps {
  configs: ChatHeaderConfigOption[];
  /**
   * Initial messages in ASC display order (oldest first, newest last).
   * The server page is responsible for reversing service DESC output before passing in.
   */
  initialMessages: ChatMessagePublic[];
  initialOldestCursor: string | null;
}

type Msg = ChatMessagePublic & { failed?: boolean; tempId?: string };

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 30;

export function ChatClient({ configs, initialMessages, initialOldestCursor }: ChatClientProps) {
  const t = useTranslations('AiPm.Chat');

  const defaultConfigId = useMemo(() => {
    const enabled = configs.find((c) => c.enabled);
    return enabled?.id ?? configs[0]?.id ?? '';
  }, [configs]);

  const [selectedConfigId, setSelectedConfigId] = useState(defaultConfigId);
  const [messages, setMessages] = useState<Msg[]>(() => initialMessages.slice());
  const [oldestCursor, setOldestCursor] = useState<string | null>(initialOldestCursor);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [pending, setPending] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollAttemptsRef = useRef(0);
  const pollSinceRef = useRef<string | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    pollAttemptsRef.current = 0;
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollAttemptsRef.current = 0;
    pollRef.current = setInterval(async () => {
      pollAttemptsRef.current += 1;
      try {
        const sinceParam = pollSinceRef.current ? `?since=${encodeURIComponent(pollSinceRef.current)}` : '';
        const res = await fetch(`/api/ai-pm/chat/history${sinceParam}`);
        if (res.ok) {
          const body = (await res.json()) as { messages: ChatMessagePublic[] };
          const assistantMsg = body.messages.find((m) => m.role === 'assistant');
          if (assistantMsg) {
            setMessages((prev) => [...prev, assistantMsg]);
            setPending(false);
            stopPolling();
            return;
          }
        }
      } catch {
        // silent, counted toward attempts
      }
      if (pollAttemptsRef.current >= POLL_MAX_ATTEMPTS) {
        setPending(false);
        setToast(t('noResponse'));
        stopPolling();
      }
    }, POLL_INTERVAL_MS);
  }, [stopPolling, t]);

  const send = useCallback(async (text: string) => {
    const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const optimistic: Msg = {
      id: tempId,
      tempId,
      role: 'user',
      content: text,
      decisionId: null,
      toolCalls: null,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    setPending(true);
    setToast(null);
    pollSinceRef.current = new Date().toISOString();

    try {
      const res = await fetch('/api/ai-pm/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ configId: selectedConfigId, message: text }),
      });
      if (!res.ok) {
        setMessages((prev) =>
          prev.map((m) => (m.tempId === tempId ? { ...m, failed: true } : m)),
        );
        setPending(false);
        return;
      }
      startPolling();
    } catch {
      setMessages((prev) =>
        prev.map((m) => (m.tempId === tempId ? { ...m, failed: true } : m)),
      );
      setPending(false);
    }
  }, [selectedConfigId, startPolling]);

  const loadOlder = useCallback(async () => {
    if (!oldestCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const res = await fetch(`/api/ai-pm/chat/history?cursor=${encodeURIComponent(oldestCursor)}`);
      if (res.ok) {
        const body = (await res.json()) as { messages: ChatMessagePublic[]; nextCursor: string | null };
        // returned DESC, prepend in ASC
        const asc = body.messages.slice().reverse();
        setMessages((prev) => [...asc, ...prev]);
        setOldestCursor(body.nextCursor);
      }
    } finally {
      setLoadingOlder(false);
    }
  }, [oldestCursor, loadingOlder]);

  if (configs.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted px-4 text-center">
        {t('noConfigsCta')}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <ChatHeader
        configs={configs}
        selectedConfigId={selectedConfigId}
        onSelectConfig={setSelectedConfigId}
      />

      {toast && (
        <div className="px-4 py-2 bg-danger/10 border-b border-danger/30 text-danger text-sm flex justify-between items-center">
          <span>{toast}</span>
          <button onClick={() => setToast(null)} className="text-xs underline" aria-label="dismiss">
            ×
          </button>
        </div>
      )}

      <MessageList
        messages={messages}
        pending={pending}
        oldestCursor={oldestCursor}
        onLoadOlder={loadOlder}
        loadingOlder={loadingOlder}
      />

      <ComposeBar onSend={send} disabled={pending} />
    </div>
  );
}
