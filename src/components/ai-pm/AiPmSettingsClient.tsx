'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Card, Spinner } from '@heroui/react';
import { SubaccountAiCard } from './SubaccountAiCard';
import type { AiPmConfigPublic } from './types';

interface Subaccount {
  id: string;
  label: string;
}

export function AiPmSettingsClient({ subaccounts }: { subaccounts: Subaccount[] }) {
  const [configs, setConfigs] = useState<AiPmConfigPublic[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/ai-pm/config');
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? 'Failed to load configs');
      }
      const data = await res.json() as { configs: AiPmConfigPublic[] };
      setConfigs(data.configs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  if (subaccounts.length === 0) {
    return (
      <Card className="p-6">
        <p className="text-sm">No BingX subaccounts yet.</p>
        <Link href="/dashboard/accounts" className="text-sm text-accent hover:underline">Add a subaccount →</Link>
      </Card>
    );
  }

  if (configs === null && !error) {
    return <div className="flex items-center justify-center p-8"><Spinner /></div>;
  }

  if (error) {
    return <Card className="p-4"><p className="text-sm text-red-600 dark:text-red-400">{error}</p></Card>;
  }

  const configsByApiKey = new Map((configs ?? []).map(c => [c.bingxApiKeyId, c]));

  return (
    <div className="space-y-4">
      {subaccounts.map((s) => (
        <SubaccountAiCard
          key={s.id}
          subaccount={s}
          config={configsByApiKey.get(s.id) ?? null}
          onChange={refresh}
        />
      ))}
    </div>
  );
}
