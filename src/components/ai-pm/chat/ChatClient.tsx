'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { ChatHeader, type ChatHeaderConfigOption } from './ChatHeader';
import { MessageList } from './MessageList';
import { ComposeBar } from './ComposeBar';

export interface ChatClientProps {
  configs: ChatHeaderConfigOption[];
  /**
   * Initial messages in ASC display order (oldest first, newest last) loaded
   * from the server (existing chat history converted to AI SDK UIMessage shape).
   */
  initialMessages: UIMessage[];
}

export function ChatClient({ configs: initialConfigs, initialMessages }: ChatClientProps) {
  const t = useTranslations('AiPm.Chat');

  const [configs, setConfigs] = useState<ChatHeaderConfigOption[]>(initialConfigs);

  const defaultConfigId = useMemo(() => {
    const enabled = configs.find((c) => c.enabled);
    return enabled?.id ?? configs[0]?.id ?? '';
  }, [configs]);

  const [selectedConfigId, setSelectedConfigId] = useState(defaultConfigId);
  const mountedRef = useRef(true);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/ai-pm/chat',
        body: { configId: selectedConfigId },
      }),
    [selectedConfigId],
  );

  const { messages, sendMessage, status, error, stop, clearError } = useChat({
    id: selectedConfigId, // per-config thread isolation
    messages: initialMessages,
    transport,
  });

  const refreshConfigs = useCallback(async () => {
    try {
      const res = await fetch('/api/ai-pm/configs');
      if (!res.ok || !mountedRef.current) return;
      const body = (await res.json()) as { configs?: ChatHeaderConfigOption[] };
      if (!Array.isArray(body.configs)) return;
      setConfigs(body.configs);
    } catch {
      // best-effort; UI keeps last-known state
    }
  }, []);

  const handleSelectConfig = useCallback(
    (configId: string) => {
      setSelectedConfigId(configId);
      void refreshConfigs();
    },
    [refreshConfigs],
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onFocus = () => void refreshConfigs();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshConfigs]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const send = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      clearError?.();
      sendMessage({ text }, { body: { configId: selectedConfigId } });
    },
    [sendMessage, selectedConfigId, clearError],
  );

  const pending = status === 'submitted' || status === 'streaming';

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
        onSelectConfig={handleSelectConfig}
      />

      {error && (
        <div className="px-4 py-2 bg-danger/10 border-b border-danger/30 text-danger text-sm flex justify-between items-center">
          <span>{error.message || t('sendFailed')}</span>
          <button onClick={() => clearError?.()} className="text-xs underline" aria-label="dismiss">
            ×
          </button>
        </div>
      )}

      <MessageList
        messages={messages}
        pending={pending}
        oldestCursor={null}
        onLoadOlder={() => {}}
        loadingOlder={false}
      />

      {status === 'streaming' && (
        <div className="px-4 pb-1 text-right">
          <button
            type="button"
            onClick={stop}
            className="text-xs underline text-muted hover:text-foreground"
          >
            {t('killSwitchMidLoop')}
          </button>
        </div>
      )}

      <ComposeBar onSend={send} disabled={pending} />
    </div>
  );
}
