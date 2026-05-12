'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { ChatMessagePublic } from '@/services/ai-pm-chat-history.service';
import type { StreamEvent } from '@/lib/ai-pm/streaming';
import { ChatHeader, type ChatHeaderConfigOption } from './ChatHeader';
import { MessageList } from './MessageList';
import { ComposeBar } from './ComposeBar';
import type { ToolCallEntry } from './MessageBubble';

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
// 90 polls × 2s = 180s. Real-mode tool loops (backtest + Opus reviewer for
// create_bot, plus multi-turn) can legitimately exceed 60s; 180s covers ~p99.
const POLL_MAX_ATTEMPTS = 90;
// SSE idle watchdog — if no event (data OR heartbeat) arrives within this
// window, treat the stream as dead and fall back to polling.
const STREAM_IDLE_TIMEOUT_MS = 30_000;

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
  const [streamingText, setStreamingText] = useState<string>('');
  const [streamingToolCalls, setStreamingToolCalls] = useState<ToolCallEntry[]>([]);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollAttemptsRef = useRef(0);
  const pollSinceRef = useRef<string | null>(null);
  const pollPlaceholderIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const eventSourceRef = useRef<EventSource | null>(null);
  const streamIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    pollAttemptsRef.current = 0;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopPolling();
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      if (streamIdleTimerRef.current) {
        clearTimeout(streamIdleTimerRef.current);
        streamIdleTimerRef.current = null;
      }
    };
  }, [stopPolling]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollAttemptsRef.current = 0;
    pollRef.current = setInterval(async () => {
      pollAttemptsRef.current += 1;
      try {
        // Prefer direct-by-id when we know the placeholder. The `since` filter
        // can race against pipeline writes (placeholder is pre-inserted by the
        // POST route before pollSinceRef is set on the client).
        const placeholderId = pollPlaceholderIdRef.current;
        const query = placeholderId
          ? `?id=${encodeURIComponent(placeholderId)}`
          : pollSinceRef.current
            ? `?since=${encodeURIComponent(pollSinceRef.current)}`
            : '';
        const res = await fetch(`/api/ai-pm/chat/history${query}`);
        if (!mountedRef.current) return;
        if (res.ok) {
          const body = (await res.json()) as { messages: ChatMessagePublic[] };
          if (!mountedRef.current) return;
          // Skip empty placeholder rows: chat-pipeline pre-inserts an assistant
          // row with content='' before running the tool loop, then UPDATEs the
          // content at the end. We must wait for the real content to land.
          const assistantMsg = body.messages.find(
            (m) => m.role === 'assistant' && m.content.trim().length > 0,
          );
          if (assistantMsg) {
            setMessages((prev) => [...prev, assistantMsg]);
            setPending(false);
            pollPlaceholderIdRef.current = null;
            stopPolling();
            return;
          }
        }
      } catch {
        if (!mountedRef.current) return;
      }
      if (!mountedRef.current) return;
      if (pollAttemptsRef.current >= POLL_MAX_ATTEMPTS) {
        setPending(false);
        setToast(t('noResponse'));
        pollPlaceholderIdRef.current = null;
        stopPolling();
      }
    }, POLL_INTERVAL_MS);
  }, [stopPolling, t]);

  const finalizePending = useCallback((text: string, calls: ToolCallEntry[], decisionId: string | null) => {
    if (!mountedRef.current) return;
    const realId = `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setMessages((prev) => [...prev, {
      id: realId,
      role: 'assistant',
      content: text,
      decisionId,
      toolCalls: calls,
      createdAt: new Date().toISOString(),
    }]);
    setStreamingText('');
    setStreamingToolCalls([]);
    setPending(false);
  }, []);

  const openStream = useCallback((placeholderId: string) => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
      pollPlaceholderIdRef.current = placeholderId;
      startPolling();
      return;
    }
    let buffer = '';
    const toolCalls: ToolCallEntry[] = [];
    let es: EventSource;
    try {
      es = new EventSource(`/api/ai-pm/chat/stream/${placeholderId}`);
    } catch {
      pollPlaceholderIdRef.current = placeholderId;
      startPolling();
      return;
    }
    eventSourceRef.current = es;

    const clearIdle = () => {
      if (streamIdleTimerRef.current) {
        clearTimeout(streamIdleTimerRef.current);
        streamIdleTimerRef.current = null;
      }
    };
    const fallbackToPoll = () => {
      clearIdle();
      try { es.close(); } catch { /* ignore */ }
      eventSourceRef.current = null;
      if (!mountedRef.current) return;
      pollPlaceholderIdRef.current = placeholderId;
      startPolling();
    };
    const armIdle = () => {
      clearIdle();
      streamIdleTimerRef.current = setTimeout(fallbackToPoll, STREAM_IDLE_TIMEOUT_MS);
    };

    armIdle();

    es.onmessage = (e: MessageEvent) => {
      if (!mountedRef.current) return;
      armIdle();
      let evt: StreamEvent;
      try {
        evt = JSON.parse(e.data) as StreamEvent;
      } catch {
        return;
      }
      switch (evt.type) {
        case 'text_chunk':
          buffer += evt.text;
          setStreamingText(buffer);
          break;
        case 'tool_start':
          toolCalls.push({
            toolName: evt.toolName,
            args: evt.args,
            status: 'EXECUTED',
            decisionId: null,
            summary: '…',
          });
          setStreamingToolCalls([...toolCalls]);
          break;
        case 'tool_done': {
          const idx = toolCalls.findIndex((t) => t.toolName === evt.entry.toolName && t.summary === '…');
          if (idx >= 0) toolCalls[idx] = evt.entry;
          else toolCalls.push(evt.entry);
          setStreamingToolCalls([...toolCalls]);
          break;
        }
        case 'done':
          clearIdle();
          finalizePending(buffer, toolCalls, evt.decisionId);
          try { es.close(); } catch { /* ignore */ }
          eventSourceRef.current = null;
          break;
        case 'error':
          fallbackToPoll();
          break;
      }
    };
    es.onerror = () => {
      fallbackToPoll();
    };
  }, [startPolling, finalizePending]);

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
    setStreamingText('');
    setStreamingToolCalls([]);
    pollSinceRef.current = new Date().toISOString();
    pollPlaceholderIdRef.current = null;

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
      const body = (await res.json()) as { placeholderId?: string };
      if (body.placeholderId) {
        openStream(body.placeholderId);
      } else {
        // Older server build — fall back to poll
        startPolling();
      }
    } catch {
      if (!mountedRef.current) return;
      setMessages((prev) =>
        prev.map((m) => (m.tempId === tempId ? { ...m, failed: true } : m)),
      );
      setPending(false);
    }
  }, [selectedConfigId, openStream, startPolling]);

  const retryFailed = useCallback((msg: Msg) => {
    if (!msg.failed || !msg.content) return;
    setMessages((prev) => prev.filter((m) => m.id !== msg.id));
    void send(msg.content);
  }, [send]);

  const loadOlder = useCallback(async () => {
    if (!oldestCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const res = await fetch(`/api/ai-pm/chat/history?cursor=${encodeURIComponent(oldestCursor)}`);
      if (!mountedRef.current) return;
      if (res.ok) {
        const body = (await res.json()) as { messages: ChatMessagePublic[]; nextCursor: string | null };
        if (!mountedRef.current) return;
        // returned DESC, prepend in ASC
        const asc = body.messages.slice().reverse();
        setMessages((prev) => [...asc, ...prev]);
        setOldestCursor(body.nextCursor);
      }
    } finally {
      if (mountedRef.current) setLoadingOlder(false);
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
        onRetry={retryFailed}
        streamingText={streamingText}
        streamingToolCalls={streamingToolCalls}
      />

      <ComposeBar onSend={send} disabled={pending} />
    </div>
  );
}
