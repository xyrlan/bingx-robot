'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Card, TextField, Input, Label, Button, Spinner, Checkbox, toast } from '@heroui/react';
import { AI_PM_SYMBOLS } from '@/lib/ai-pm/symbols';
import type { AiPmConfigPublic } from './types';

type Mode = 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE' | 'CUSTOM';

interface GuardrailFormProps {
  config: AiPmConfigPublic | null;
  configId: string;
  onSaved: (cfg: AiPmConfigPublic) => void;
  onCancel?: () => void;
}

const PRESETS: Record<'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE', { maxCapitalUsdt: number; maxConcurrentBots: number }> = {
  CONSERVATIVE: { maxCapitalUsdt: 500, maxConcurrentBots: 2 },
  BALANCED: { maxCapitalUsdt: 1000, maxConcurrentBots: 5 },
  AGGRESSIVE: { maxCapitalUsdt: 5000, maxConcurrentBots: 10 },
};

const STRATEGIES = ['DCA', 'TRAILING_STOP', 'DCA_SPOT', 'SMA_CROSSOVER'] as const;
type Strategy = (typeof STRATEGIES)[number];

export function GuardrailForm({ config, configId, onSaved, onCancel }: GuardrailFormProps) {
  const t = useTranslations('AiPm.Settings');
  const initialMode: Mode = config?.mode ?? 'BALANCED';
  const [mode, setMode] = useState<Mode>(initialMode);
  const [maxCapital, setMaxCapital] = useState<string>(
    config?.maxCapitalUsdt != null ? String(config.maxCapitalUsdt) : String(PRESETS.BALANCED.maxCapitalUsdt)
  );
  const [maxBots, setMaxBots] = useState<string>(
    config?.maxConcurrentBots != null ? String(config.maxConcurrentBots) : String(PRESETS.BALANCED.maxConcurrentBots)
  );
  const [selectedSymbols, setSelectedSymbols] = useState<Set<string>>(
    new Set(config?.allowedSymbols ?? [])
  );
  const [symbolSearch, setSymbolSearch] = useState('');
  const [allowedStrategies, setAllowedStrategies] = useState<Set<Strategy>>(
    new Set((config?.allowedStrategies ?? []) as Strategy[])
  );
  const [saving, setSaving] = useState(false);

  const query = symbolSearch.trim().toLowerCase();
  const filteredSymbols = query
    ? AI_PM_SYMBOLS.filter(
        (s) => s.name.toLowerCase().includes(query) || s.code.toLowerCase().includes(query),
      )
    : AI_PM_SYMBOLS;

  function selectPreset(preset: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE') {
    setMode(preset);
    setMaxCapital(String(PRESETS[preset].maxCapitalUsdt));
    setMaxBots(String(PRESETS[preset].maxConcurrentBots));
  }

  function handleCustomFieldChange(setter: () => void) {
    setter();
    setMode('CUSTOM');
  }

  function toggleSymbol(code: string) {
    setSelectedSymbols((prev) => {
      const next = new Set(prev);
      if (next.has(code)) {
        next.delete(code);
      } else {
        next.add(code);
      }
      return next;
    });
    setMode('CUSTOM');
  }

  function toggleStrategy(strategy: Strategy) {
    setAllowedStrategies((prev) => {
      const next = new Set(prev);
      if (next.has(strategy)) {
        next.delete(strategy);
      } else {
        next.add(strategy);
      }
      return next;
    });
    setMode('CUSTOM');
  }

  async function handleSave() {
    setSaving(true);
    try {
      const symbolsArray = Array.from(selectedSymbols);

      const patch = {
        mode,
        maxCapitalUsdt: maxCapital.trim() ? maxCapital.trim() : null,
        maxConcurrentBots: maxBots.trim() ? parseInt(maxBots.trim(), 10) : null,
        allowedSymbols: symbolsArray.length > 0 ? symbolsArray : null,
        allowedStrategies: allowedStrategies.size > 0 ? Array.from(allowedStrategies) : null,
      };

      const res = await fetch(`/api/ai-pm/config/${configId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json() as { config?: AiPmConfigPublic; error?: string };
      if (!res.ok) {
        toast.danger(data.error ?? 'Failed to save guardrails');
        return;
      }
      toast.success(t('guardrailsSavedToast'));
      onSaved(data.config!);
    } catch {
      toast.danger('Network error — please try again');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Profile cards */}
      <div className="grid grid-cols-3 gap-3">
        {(['CONSERVATIVE', 'BALANCED', 'AGGRESSIVE'] as const).map((preset) => {
          const presetLabel = preset === 'CONSERVATIVE'
            ? t('modeConservative')
            : preset === 'BALANCED'
            ? t('modeBalanced')
            : t('modeAggressive');
          return (
            <button
              key={preset}
              type="button"
              onClick={() => selectPreset(preset)}
              className={`rounded-xl border p-3 text-left text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                mode === preset
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-default-200 bg-default-50/60 text-slate-700 dark:text-slate-300 hover:border-accent/50'
              }`}
              aria-pressed={mode === preset}
              aria-label={`Select ${presetLabel} profile`}
            >
              <span className="block text-xs font-normal text-slate-500 dark:text-slate-400">
                {preset === 'CONSERVATIVE' && t('lowRisk')}
                {preset === 'BALANCED' && t('moderateRisk')}
                {preset === 'AGGRESSIVE' && t('highRisk')}
              </span>
              <span>{presetLabel}</span>
            </button>
          );
        })}
      </div>

      {/* Custom config — always visible: a hidden $0 cap or empty symbol list
          silently blocks every AI order, so these fields stay discoverable. */}
      <Card variant="default">
        <Card.Content className="p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <TextField variant="primary" isDisabled={saving}>
              <Label>{t('maxCapital')}</Label>
              <Input
                type="number"
                min={0}
                value={maxCapital}
                onChange={(e) => handleCustomFieldChange(() => setMaxCapital(e.target.value))}
                aria-label={t('maxCapital')}
              />
            </TextField>
            <TextField variant="primary" isDisabled={saving}>
              <Label>{t('maxBots')}</Label>
              <Input
                type="number"
                min={1}
                value={maxBots}
                onChange={(e) => handleCustomFieldChange(() => setMaxBots(e.target.value))}
                aria-label={t('maxBots')}
              />
            </TextField>
          </div>

          {/* Allowed symbols — searchable checkbox list over a curated set */}
          <div role="group" aria-label={t('allowedSymbols')}>
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100 mb-2">
              {t('allowedSymbols')}
            </p>
            <TextField variant="primary" isDisabled={saving}>
              <Input
                type="text"
                value={symbolSearch}
                onChange={(e) => setSymbolSearch(e.target.value)}
                placeholder={t('symbolSearchPlaceholder')}
                aria-label={t('symbolSearchPlaceholder')}
              />
            </TextField>
            {selectedSymbols.size === 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-500 mt-2">
                {t('noSymbolsWarning')}
              </p>
            )}
            <div className="mt-2 grid grid-cols-2 gap-2 max-h-56 overflow-y-auto pr-1">
              {filteredSymbols.map((s) => (
                <Checkbox
                  key={s.code}
                  isSelected={selectedSymbols.has(s.code)}
                  onChange={() => toggleSymbol(s.code)}
                  isDisabled={saving}
                  aria-label={s.name}
                >
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <span className="text-sm text-slate-700 dark:text-slate-300">
                    {s.name}
                    <span className="ml-1 text-xs text-slate-400 dark:text-slate-500">{s.code}</span>
                  </span>
                </Checkbox>
              ))}
            </div>
          </div>

          {/* Strategy multi-checkbox */}
          <div role="group" aria-label={t('allowedStrategies')}>
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100 mb-2">
              {t('allowedStrategies')}
            </p>
            <div className="grid grid-cols-2 gap-2">
              {STRATEGIES.map((strategy) => (
                <Checkbox
                  key={strategy}
                  isSelected={allowedStrategies.has(strategy)}
                  onChange={() => toggleStrategy(strategy)}
                  isDisabled={saving}
                  aria-label={strategy}
                >
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <span className="text-sm text-slate-700 dark:text-slate-300">{strategy}</span>
                </Checkbox>
              ))}
            </div>
          </div>
        </Card.Content>
      </Card>

      <div className="flex gap-2">
        <Button
          variant="primary"
          onPress={handleSave}
          isDisabled={saving}
          aria-label={t('save')}
        >
          {saving ? <Spinner size="sm" /> : t('save')}
        </Button>
        {onCancel && (
          <Button
            variant="outline"
            onPress={onCancel}
            isDisabled={saving}
            aria-label={t('cancel')}
          >
            {t('cancel')}
          </Button>
        )}
      </div>
    </div>
  );
}
