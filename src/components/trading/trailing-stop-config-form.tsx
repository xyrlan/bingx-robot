'use client';

import { useState } from 'react';
import { Card, TextField, Input, Label, Button, toast, Spinner } from '@heroui/react';
import { useActiveAccount } from '@/contexts/active-account';

export function TrailingStopConfigForm() {
  const { activeAccountId } = useActiveAccount();
  const [loading, setLoading] = useState(false);
  const [symbol, setSymbol] = useState('BTC-USDT');
  const [positionSizeUsdt, setPositionSizeUsdt] = useState('50');
  const [activationPricePct, setActivationPricePct] = useState('2');
  const [trailingPct, setTrailingPct] = useState('1');

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
          botType: 'TRAILING_STOP',
          apiKeyId: activeAccountId,
          config: {
            positionSizeUsdt: Number(positionSizeUsdt),
            activationPricePct: Number(activationPricePct),
            trailingPct: Number(trailingPct),
            highestPrice: 0,
            isActivated: false,
            entryOrderId: null,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.danger(data.error ?? 'Failed to start bot');
        return;
      }
      toast.success(`Trailing Stop bot started (ID: ${data.botId})`);
    } catch {
      toast.danger('Network error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card variant="default" className="w-full">
      <Card.Content className="p-6">
        <h3 className="text-lg font-semibold mb-4">Trailing Stop Bot</h3>
        <p className="text-sm text-default-600 mb-4">
          Opens a position, follows price up. Closes when price drops by the trailing percentage from highest point.
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
              <Label>Position Size (USDT)</Label>
              <Input
                name="positionSizeUsdt"
                type="number"
                min={1}
                value={positionSizeUsdt}
                onChange={(e) => setPositionSizeUsdt(e.target.value)}
                placeholder="50"
              />
            </TextField>
            <TextField variant="primary" isDisabled={loading}>
              <Label>Activation (%)</Label>
              <Input
                name="activationPricePct"
                type="number"
                min={0}
                step="0.1"
                value={activationPricePct}
                onChange={(e) => setActivationPricePct(e.target.value)}
                placeholder="2"
              />
            </TextField>
            <TextField variant="primary" isDisabled={loading}>
              <Label>Trailing Distance (%)</Label>
              <Input
                name="trailingPct"
                type="number"
                min={0}
                step="0.1"
                value={trailingPct}
                onChange={(e) => setTrailingPct(e.target.value)}
                placeholder="1"
              />
            </TextField>
          </div>
          <Button
            type="submit"
            variant="primary"
            isDisabled={loading || !activeAccountId}
          >
            {loading ? <Spinner size="sm" /> : 'Start Trailing Stop Bot'}
          </Button>
        </form>
      </Card.Content>
    </Card>
  );
}
