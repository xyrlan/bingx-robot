'use client';

import { useEffect, useState } from 'react';
import { Card, Button } from '@heroui/react';

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
        setError(data.error ?? 'Failed to fetch balance');
        setBalance(null);
        return;
      }
      setBalance(data);
    } catch {
      setError('Network error');
      setBalance(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchBalance();
  }, []);

  return (
    <Card variant="default" className="w-full">
      <Card.Content className="p-6">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-lg font-semibold">Balance</h3>
          <Button size="sm" variant="outline" onPress={fetchBalance} isDisabled={loading}>
            {loading ? 'Loading...' : 'Refresh'}
          </Button>
        </div>
        {error && (
          <p className="text-sm text-danger mb-2">{error}</p>
        )}
        {balance != null ? (
          <pre className="text-xs overflow-auto max-h-48 bg-default-100 p-3 rounded">
            {JSON.stringify(balance, null, 2)}
          </pre>
        ) : null}
      </Card.Content>
    </Card>
  );
}
