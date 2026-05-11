'use client';

// i18n: replace in Task 3
const STRINGS = {
  conservative: 'Conservative',
  balanced: 'Balanced',
  aggressive: 'Aggressive',
  customFields: 'Custom fields',
  maxCapitalLabel: 'Max Capital (USDT)',
  maxConcurrentBotsLabel: 'Max Concurrent Bots',
  allowedSymbolsLabel: 'Allowed Symbols (comma-separated)',
  allowedSymbolsPlaceholder: 'e.g. BTC-USDT,ETH-USDT',
  allowedStrategiesLabel: 'Allowed Strategies',
  saveButton: 'Save',
  saving: 'Saving...',
  cancelButton: 'Cancel',
  savedSuccess: 'Guardrails saved',
};

import { useState } from 'react';
import { Card, TextField, Input, Label, Button, Spinner, Checkbox, toast } from '@heroui/react';
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
  const initialMode: Mode = config?.mode ?? 'BALANCED';
  const [mode, setMode] = useState<Mode>(initialMode);
  const [maxCapital, setMaxCapital] = useState<string>(
    config?.maxCapitalUsdt != null ? String(config.maxCapitalUsdt) : String(PRESETS.BALANCED.maxCapitalUsdt)
  );
  const [maxBots, setMaxBots] = useState<string>(
    config?.maxConcurrentBots != null ? String(config.maxConcurrentBots) : String(PRESETS.BALANCED.maxConcurrentBots)
  );
  const [allowedSymbols, setAllowedSymbols] = useState<string>(
    config?.allowedSymbols ? config.allowedSymbols.join(', ') : ''
  );
  const [allowedStrategies, setAllowedStrategies] = useState<Set<Strategy>>(
    new Set((config?.allowedStrategies ?? []) as Strategy[])
  );
  const [showCustom, setShowCustom] = useState(initialMode === 'CUSTOM');
  const [saving, setSaving] = useState(false);

  function selectPreset(preset: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE') {
    setMode(preset);
    setMaxCapital(String(PRESETS[preset].maxCapitalUsdt));
    setMaxBots(String(PRESETS[preset].maxConcurrentBots));
  }

  function handleCustomFieldChange(setter: () => void) {
    setter();
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
      const symbolsArray = allowedSymbols
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

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
      toast.success(STRINGS.savedSuccess);
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
        {(['CONSERVATIVE', 'BALANCED', 'AGGRESSIVE'] as const).map((preset) => (
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
            aria-label={`Select ${STRINGS[preset.toLowerCase() as keyof typeof STRINGS] ?? preset} profile`}
          >
            <span className="block text-xs font-normal text-slate-500 dark:text-slate-400">
              {preset === 'CONSERVATIVE' && 'Low risk'}
              {preset === 'BALANCED' && 'Moderate risk'}
              {preset === 'AGGRESSIVE' && 'High risk'}
            </span>
            <span>{STRINGS[preset.toLowerCase() as 'conservative' | 'balanced' | 'aggressive']}</span>
          </button>
        ))}
      </div>

      {/* Custom fields toggle */}
      <button
        type="button"
        className="text-sm font-medium text-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
        onClick={() => setShowCustom((v) => !v)}
        aria-expanded={showCustom}
      >
        {showCustom ? 'Hide' : 'Show'} {STRINGS.customFields}
      </button>

      {showCustom && (
        <Card variant="default">
          <Card.Content className="p-4 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <TextField variant="primary" isDisabled={saving}>
                <Label>{STRINGS.maxCapitalLabel}</Label>
                <Input
                  type="number"
                  min={0}
                  value={maxCapital}
                  onChange={(e) => handleCustomFieldChange(() => setMaxCapital(e.target.value))}
                  aria-label={STRINGS.maxCapitalLabel}
                />
              </TextField>
              <TextField variant="primary" isDisabled={saving}>
                <Label>{STRINGS.maxConcurrentBotsLabel}</Label>
                <Input
                  type="number"
                  min={1}
                  value={maxBots}
                  onChange={(e) => handleCustomFieldChange(() => setMaxBots(e.target.value))}
                  aria-label={STRINGS.maxConcurrentBotsLabel}
                />
              </TextField>
            </div>
            <TextField variant="primary" isDisabled={saving}>
              <Label>{STRINGS.allowedSymbolsLabel}</Label>
              <Input
                type="text"
                value={allowedSymbols}
                onChange={(e) => handleCustomFieldChange(() => setAllowedSymbols(e.target.value))}
                placeholder={STRINGS.allowedSymbolsPlaceholder}
                aria-label={STRINGS.allowedSymbolsLabel}
              />
            </TextField>

            {/* Strategy multi-checkbox */}
            <div role="group" aria-label={STRINGS.allowedStrategiesLabel}>
              <p className="text-sm font-medium text-slate-900 dark:text-slate-100 mb-2">
                {STRINGS.allowedStrategiesLabel}
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
      )}

      <div className="flex gap-2">
        <Button
          variant="primary"
          onPress={handleSave}
          isDisabled={saving}
          aria-label="Save guardrail settings"
        >
          {saving ? <Spinner size="sm" /> : STRINGS.saveButton}
        </Button>
        {onCancel && (
          <Button
            variant="outline"
            onPress={onCancel}
            isDisabled={saving}
            aria-label="Cancel"
          >
            {STRINGS.cancelButton}
          </Button>
        )}
      </div>
    </div>
  );
}
