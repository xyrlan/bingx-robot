'use client';

import { useEffect, useState } from 'react';
import { Card, Button, toast } from '@heroui/react';

type BalanceItem = {
  asset?: string;
  balance?: number;
  availableMargin?: number;
  available_margin?: number;
  equity?: number;
  freezedMargin?: number;
  freezed_margin?: number;
  realizedProfit?: number;
  realized_profit?: number;
  unrealizedProfit?: number;
  unrealized_profit?: number;
  usedMargin?: number;
  used_margin?: number;
};

function getNum(obj: BalanceItem, ...keys: (keyof BalanceItem)[]): number {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && !Number.isNaN(v)) return v;
    if (typeof v === 'string') {
      const n = parseFloat(v);
      if (!Number.isNaN(n)) return n;
    }
  }
  return 0;
}

function formatUsdt(value: number): string {
  return `${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
}

function formatPnl(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
}

function parseBalanceData(data: unknown): BalanceItem[] {
  if (!data || typeof data !== 'object') return [];
  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj)) {
    return obj as BalanceItem[];
  }
  if (Array.isArray(obj.balance)) {
    return obj.balance as BalanceItem[];
  }
  if (typeof obj.balance === 'object' && obj.balance !== null) {
    const bal = obj.balance as Record<string, unknown>;
    if (Array.isArray(bal.balance)) {
      return bal.balance as BalanceItem[];
    }
    return [obj.balance as BalanceItem];
  }
  if (obj.asset !== undefined || (typeof obj.balance === 'number') || obj.equity !== undefined) {
    return [obj as BalanceItem];
  }
  return [];
}

export function BalanceDisplay() {
  const [balance, setBalance] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchBalance() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/bingx/balance');
      const data = await res.json();
      if (!res.ok) {
        const err = data.error ?? 'Failed to fetch balance';
        setError(err);
        setBalance(null);
        toast.danger(err);
        return;
      }
      setBalance(data);
    } catch {
      setError('Network error');
      setBalance(null);
      toast.danger('Network error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchBalance();
  }, []);

  const items = parseBalanceData(balance);
  const hasItems = items.length > 0;

  return (
    <Card variant="default" className="w-full">
      <Card.Content className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Balance</h3>
          <Button size="sm" variant="outline" onPress={fetchBalance} isDisabled={loading}>
            {loading ? 'Loading...' : 'Refresh'}
          </Button>
        </div>
        {balance != null && !error && (
          hasItems ? (
            <div className="space-y-4">
              {items.map((item, i) => {
                const balanceVal = getNum(item, 'balance');
                const available = getNum(item, 'availableMargin', 'available_margin');
                const equity = getNum(item, 'equity');
                const unrealized = getNum(item, 'unrealizedProfit', 'unrealized_profit');
                const realized = getNum(item, 'realizedProfit', 'realized_profit');
                const used = getNum(item, 'usedMargin', 'used_margin');
                const freezed = getNum(item, 'freezedMargin', 'freezed_margin');
                const asset = (item.asset as string) || 'USDT';

                return (
                  <div key={i} className="space-y-3">
                    {items.length > 1 && (
                      <h4 className="text-sm font-medium text-default-600">{asset}</h4>
                    )}
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      <div className="p-3 rounded-lg bg-default-100">
                        <p className="text-xs text-default-500 mb-0.5">Total balance</p>
                        <p className="font-semibold">{formatUsdt(balanceVal)}</p>
                      </div>
                      {equity !== 0 && (
                        <div className="p-3 rounded-lg bg-default-100">
                          <p className="text-xs text-default-500 mb-0.5">Equity</p>
                          <p className="font-semibold">{formatUsdt(equity)}</p>
                        </div>
                      )}
                       {unrealized !== 0 && (
                        <div className="p-3 rounded-lg bg-default-100">
                          <p className="text-xs text-default-500 mb-0.5">Unrealized PnL</p>
                          <p className={`font-semibold ${unrealized >= 0 ? 'text-success' : 'text-danger'}`}>
                            {formatPnl(unrealized)}
                          </p>
                        </div>
                      )}
                      {available !== 0 && (
                        <div className="p-3 rounded-lg bg-default-100">
                          <p className="text-xs text-default-500 mb-0.5">Available margin</p>
                          <p className="font-semibold">{formatUsdt(available)}</p>
                        </div>
                      )}
                      {realized !== 0 && (
                        <div className="p-3 rounded-lg bg-default-100">
                          <p className="text-xs text-default-500 mb-0.5">Realized PnL</p>
                          <p className={`font-semibold ${realized >= 0 ? 'text-success' : 'text-danger'}`}>
                            {formatPnl(realized)}
                          </p>
                        </div>
                      )}
                      {used !== 0 && (
                        <div className="p-3 rounded-lg bg-default-100">
                          <p className="text-xs text-default-500 mb-0.5">Used margin</p>
                          <p className="font-semibold">{formatUsdt(used)}</p>
                        </div>
                      )}
                      {freezed !== 0 && (
                        <div className="p-3 rounded-lg bg-default-100">
                          <p className="text-xs text-default-500 mb-0.5">Frozen margin</p>
                          <p className="font-semibold">{formatUsdt(freezed)}</p>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-default-500">No balance data available.</p>
          )
        )}
      </Card.Content>
    </Card>
  );
}
