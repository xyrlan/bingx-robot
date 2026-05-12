'use client';

import { useTranslations } from 'next-intl';
import { Chip } from '@heroui/react';

export interface ChatHeaderConfigOption {
  id: string;
  label: string;
  enabled: boolean;
  killSwitch: boolean;
}

export interface ChatHeaderProps {
  configs: ChatHeaderConfigOption[];
  selectedConfigId: string;
  onSelectConfig: (configId: string) => void;
}

export function ChatHeader({ configs, selectedConfigId, onSelectConfig }: ChatHeaderProps) {
  const t = useTranslations('AiPm.Chat');
  const selected = configs.find((c) => c.id === selectedConfigId);
  const killOn = selected?.killSwitch ?? false;

  return (
    <header className="border-b border-default-200 px-4 py-3 flex items-center justify-between bg-background gap-3">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold text-foreground truncate">{t('title')}</h1>
        <p className="text-xs text-muted truncate">{t('subtitle')}</p>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {killOn && (
          <Chip color="danger" variant="soft" size="sm">
            {t('killSwitchActive')}
          </Chip>
        )}

        {configs.length > 1 && (
          <select
            aria-label={t('configLabel')}
            value={selectedConfigId}
            onChange={(e) => onSelectConfig(e.target.value)}
            className="rounded-md border border-default-200 bg-default-50 text-sm text-foreground px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent max-w-48"
          >
            {configs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        )}
      </div>
    </header>
  );
}
