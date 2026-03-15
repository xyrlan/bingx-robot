'use client';

import { Card, Spinner } from '@heroui/react';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useActiveAccount } from '@/contexts/active-account';

type BalanceData = {
  balance: string;
  equity: string;
  unrealizedProfit: string;
  availableMargin: string;
};

export function OverviewStats() {
  const t = useTranslations('Dashboard');
  const { activeAccountId } = useActiveAccount();
  const [data, setData] = useState<BalanceData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/bingx/balance${activeAccountId ? `?apiKeyId=${activeAccountId}` : ''}`)
      .then((r) => r.json())
      .then((d) => setData(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [activeAccountId]);

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!data) return null;

  const stats = [
    { labelKey: 'balance' as const, value: `$${Number(data.balance).toFixed(2)}` },
    { labelKey: 'equity' as const, value: `$${Number(data.equity).toFixed(2)}` },
    {
      labelKey: 'unrealizedPnl' as const,
      value: `$${Number(data.unrealizedProfit).toFixed(2)}`,
      color: Number(data.unrealizedProfit) >= 0 ? 'text-success' : 'text-danger',
    },
    { labelKey: 'available' as const, value: `$${Number(data.availableMargin).toFixed(2)}` },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {stats.map((stat) => (
        <Card key={stat.labelKey}>
          <Card.Content className="p-4">
            <p className="text-xs text-muted">{t(stat.labelKey)}</p>
            <p className={`text-lg font-bold ${stat.color ?? 'text-foreground'}`}>
              {stat.value}
            </p>
          </Card.Content>
        </Card>
      ))}
    </div>
  );
}
