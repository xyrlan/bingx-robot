'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { TextField, Input, Label, Button, Spinner, toast } from '@heroui/react';
import { Eye, EyeOff } from 'lucide-react';
import type { AiPmConfigPublic } from './types';

interface AnthropicKeyFormProps {
  existingConfigId: string | null;
  bingxApiKeyId: string;
  defaultMode?: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';
  onSaved: (cfg: AiPmConfigPublic) => void;
  onCancel?: () => void;
}

export function AnthropicKeyForm({
  existingConfigId,
  bingxApiKeyId,
  defaultMode = 'BALANCED',
  onSaved,
  onCancel,
}: AnthropicKeyFormProps) {
  const t = useTranslations('AiPm.Settings');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testPassed, setTestPassed] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testSuccess, setTestSuccess] = useState(false);

  async function handleTest() {
    if (!apiKey.trim()) return;
    setTesting(true);
    setTestError(null);
    setTestSuccess(false);
    setTestPassed(false);
    try {
      const res = await fetch('/api/ai-pm/anthropic-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ anthropicApiKey: apiKey.trim() }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (res.ok && data.ok) {
        setTestPassed(true);
        setTestSuccess(true);
      } else {
        setTestError(data.error ?? 'Key test failed');
      }
    } catch {
      setTestError('Network error — please try again');
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    if (!testPassed || !apiKey.trim()) return;
    setSaving(true);
    try {
      let res: Response;
      if (existingConfigId) {
        res = await fetch(`/api/ai-pm/config/${existingConfigId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ anthropicApiKey: apiKey.trim() }),
        });
      } else {
        res = await fetch('/api/ai-pm/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bingxApiKeyId,
            anthropicApiKey: apiKey.trim(),
            mode: defaultMode,
          }),
        });
      }
      const data = await res.json() as { config?: AiPmConfigPublic; error?: string };
      if (!res.ok) {
        toast.danger(data.error ?? 'Failed to save key');
        return;
      }
      toast.success(t('anthropicKeySavedToast'));
      onSaved(data.config!);
    } catch {
      toast.danger('Network error — please try again');
    } finally {
      setSaving(false);
    }
  }

  const isLoading = testing || saving;

  return (
    <div className="space-y-4">
      <TextField variant="primary" isDisabled={isLoading}>
        <Label>{t('anthropicKey')}</Label>
        <div className="relative">
          <Input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              // Reset test state when key changes
              setTestPassed(false);
              setTestSuccess(false);
              setTestError(null);
            }}
            placeholder="sk-ant-..."
            autoComplete="off"
            aria-label={t('anthropicKey')}
          />
          <button
            type="button"
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
            onClick={() => setShowKey((v) => !v)}
            aria-label={showKey ? t('hideKey') : t('showKey')}
          >
            {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
      </TextField>

      {testError && (
        <p className="text-sm text-red-600 dark:text-red-400">{testError}</p>
      )}
      {testSuccess && (
        <p className="text-sm text-green-600 dark:text-green-400">{t('keyTested')}</p>
      )}

      <div className="flex gap-2">
        <Button
          variant="outline"
          onPress={handleTest}
          isDisabled={isLoading || !apiKey.trim()}
          aria-label={t('testKey')}
        >
          {testing ? <Spinner size="sm" /> : t('testKey')}
        </Button>
        <Button
          variant="primary"
          onPress={handleSave}
          isDisabled={isLoading || !testPassed}
          aria-label={t('saveKey')}
        >
          {saving ? <Spinner size="sm" /> : t('saveKey')}
        </Button>
        {onCancel && (
          <Button
            variant="outline"
            onPress={onCancel}
            isDisabled={isLoading}
            aria-label={t('cancel')}
          >
            {t('cancel')}
          </Button>
        )}
      </div>
    </div>
  );
}
