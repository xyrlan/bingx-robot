'use client';

import { useState } from 'react';
import { Card, TextField, Input, Label, Button, toast, Spinner } from '@heroui/react';
import { useActiveAccount } from '@/contexts/active-account';

export function DCAConfigForm() {
  const { activeAccountId } = useActiveAccount();
  const [loading, setLoading] = useState(false);
  const [symbol, setSymbol] = useState('BTC-USDT');
  const [intervalMinutes, setIntervalMinutes] = useState('60');
  const [totalOrders, setTotalOrders] = useState('10');
  const [orderSizeUsdt, setOrderSizeUsdt] = useState('10');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!activeAccountId) return;
    setLoading(true);
    try {
      const res = await fetch('/api/bingx/bot/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          botType: 'DCA',
          apiKeyId: activeAccountId,
          config: {
            intervalMinutes: Number(intervalMinutes),
            totalOrders: Number(totalOrders),
            orderSizeUsdt: Number(orderSizeUsdt),
            ordersPlaced: 0,
            side: 'BUY',
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.danger(data.error ?? 'Failed to start bot');
        return;
      }
      toast.success(`DCA bot started (ID: ${data.botId})`);
    } catch {
      toast.danger('Network error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card variant="default" className="w-full">
      <Card.Content className="p-6">
        <h3 className="text-lg font-semibold mb-4">DCA Bot</h3>
        <p className="text-sm text-default-600 mb-4">
          Dollar Cost Average — places market buy orders at fixed intervals.
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <TextField variant="primary" isDisabled={loading}>
              <Label>Symbol</Label>
              <Input
                name="symbol"
                type="text"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                placeholder="BTC-USDT"
              />
            </TextField>
            <TextField variant="primary" isDisabled={loading}>
              <Label>Interval (minutes)</Label>
              <Input
                name="intervalMinutes"
                type="number"
                min={1}
                value={intervalMinutes}
                onChange={(e) => setIntervalMinutes(e.target.value)}
                placeholder="60"
              />
            </TextField>
            <TextField variant="primary" isDisabled={loading}>
              <Label>Total Orders</Label>
              <Input
                name="totalOrders"
                type="number"
                min={1}
                value={totalOrders}
                onChange={(e) => setTotalOrders(e.target.value)}
                placeholder="10"
              />
            </TextField>
            <TextField variant="primary" isDisabled={loading}>
              <Label>Order Size (USDT)</Label>
              <Input
                name="orderSizeUsdt"
                type="number"
                min={1}
                value={orderSizeUsdt}
                onChange={(e) => setOrderSizeUsdt(e.target.value)}
                placeholder="10"
              />
            </TextField>
          </div>
          <Button
            type="submit"
            variant="primary"
            isDisabled={loading || !activeAccountId}
          >
            {loading ? <Spinner size="sm" /> : 'Start DCA Bot'}
          </Button>
        </form>
      </Card.Content>
    </Card>
  );
}
