'use client';

import { Card, Spinner } from '@heroui/react';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useActiveAccount } from '@/contexts/active-account';
import { parseBalanceData, getNum } from '@/lib/balance';

export function OverviewStats() {
  const t = useTranslations('Dashboard');
  const { activeAccountId } = useActiveAccount();
  const [data, setData] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!activeAccountId) return;
    setLoading(true);
    fetch(`/api/bingx/balance?apiKeyId=${activeAccountId}`)
      .then((r) => r.json())
      .then((d) => {
        if (!d.error) setData(d);
      })
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

  const items = parseBalanceData(data);
  const item = items.find((i) => (i.asset as string)?.toUpperCase() === 'USDT') ?? items[0];
  if (!item) return null;

  const balance = getNum(item, 'balance');
  const equity = getNum(item, 'equity');
  const unrealized = getNum(item, 'unrealizedProfit', 'unrealized_profit');
  const available = getNum(item, 'availableMargin', 'available_margin');

  const stats = [
    { labelKey: 'balance' as const, value: `$${balance.toFixed(2)}` },
    { labelKey: 'equity' as const, value: `$${equity.toFixed(2)}` },
    {
      labelKey: 'unrealizedPnl' as const,
      value: `$${unrealized.toFixed(2)}`,
      color: unrealized >= 0 ? 'text-success' : 'text-danger',
    },
    { labelKey: 'available' as const, value: `$${available.toFixed(2)}` },
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
