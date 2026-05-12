'use client';

import { useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@heroui/react';
import { Send } from 'lucide-react';

export interface ComposeBarProps {
  onSend: (text: string) => void;
  disabled: boolean;
}

const MAX = 2000;

export function ComposeBar({ onSend, disabled }: ComposeBarProps) {
  const t = useTranslations('AiPm.Chat');
  const [text, setText] = useState('');

  const submit = () => {
    if (disabled) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="sticky bottom-0 border-t border-default-200 bg-background px-3 py-3">
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, MAX))}
          onKeyDown={onKeyDown}
          maxLength={MAX}
          rows={1}
          placeholder={t('placeholder')}
          disabled={disabled}
          className="flex-1 resize-none rounded-lg border border-default-200 bg-default-50 px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50 max-h-32"
        />
        <Button
          variant="primary"
          size="md"
          isDisabled={disabled || !text.trim()}
          onPress={submit}
        >
          <Send className="w-4 h-4" />
          {t('send')}
        </Button>
      </div>
      {text.length > 1800 && (
        <div className="text-xs text-muted text-right mt-1">{text.length} / {MAX}</div>
      )}
    </div>
  );
}
