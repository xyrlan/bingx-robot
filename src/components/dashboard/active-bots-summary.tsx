'use client';

import { Card, Spinner } from '@heroui/react';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';

type BotSummary = {
  id: string;
  symbol: string;
  status: string;
  gridCount: number;
};

export function ActiveBotsSummary() {
  const t = useTranslations('Dashboard');
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/bingx/bot')
      .then((r) => r.json())
      .then((data) => setBots(Array.isArray(data) ? data : data.bots ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center py-4">
        <Spinner />
      </div>
    );
  }

  const running = bots.filter((b) => b.status === 'RUNNING');
  const stopped = bots.filter((b) => b.status === 'STOPPED');

  return (
    <Card>
      <Card.Content className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground">{t('bots')}</h3>
          <Link href="/dashboard/bots" className="text-xs text-accent hover:underline">
            {t('viewAll')}
          </Link>
        </div>
        <div className="flex gap-4 text-sm">
          <div>
            <span className="text-success font-medium">{running.length}</span>
            <span className="text-muted ml-1">{t('running')}</span>
          </div>
          <div>
            <span className="text-muted font-medium">{stopped.length}</span>
            <span className="text-muted ml-1">{t('stopped')}</span>
          </div>
        </div>
        {running.length > 0 && (
          <div className="mt-3 space-y-2">
            {running.slice(0, 3).map((bot) => (
              <div key={bot.id} className="flex items-center justify-between text-sm py-1">
                <span className="font-medium">{bot.symbol}</span>
                <span className="text-xs text-muted">{bot.gridCount} {t('grids')}</span>
              </div>
            ))}
          </div>
        )}
      </Card.Content>
    </Card>
  );
}
