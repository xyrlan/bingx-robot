'use client';

// i18n: replace in Task 3
const STRINGS = {
  label: 'Paper mode',
  description: 'Simulate trades without real orders.',
};

import { useState } from 'react';
import { Switch, toast } from '@heroui/react';

interface PaperModeToggleProps {
  configId: string;
  paperMode: boolean;
  onChange: () => Promise<void>;
}

export function PaperModeToggle({ configId, paperMode, onChange }: PaperModeToggleProps) {
  const [optimistic, setOptimistic] = useState(paperMode);
  const [loading, setLoading] = useState(false);

  async function handleChange(checked: boolean) {
    setOptimistic(checked);
    setLoading(true);
    try {
      const res = await fetch(`/api/ai-pm/config/${configId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paperMode: checked }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        // Revert optimistic update
        setOptimistic(!checked);
        toast.danger(data.error ?? 'Failed to update paper mode');
        return;
      }
      await onChange();
    } catch {
      // Revert optimistic update
      setOptimistic(!checked);
      toast.danger('Network error — please try again');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-start gap-3">
      <Switch
        isSelected={optimistic}
        onChange={handleChange}
        isDisabled={loading}
        aria-label={STRINGS.label}
      >
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
      </Switch>
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{STRINGS.label}</p>
        <p className="text-xs text-slate-500 dark:text-slate-400">{STRINGS.description}</p>
      </div>
    </div>
  );
}
