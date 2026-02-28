'use client';

import { useState } from 'react';
import { Card, TextField, Input, Label, Button } from '@heroui/react';

export function BotConfigForm() {
  const [symbol, setSymbol] = useState('BTC-USDT');
  const [priceMin, setPriceMin] = useState('');
  const [priceMax, setPriceMax] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  async function handleStart(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch('/api/bingx/bot/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: symbol.trim(),
          priceMin: priceMin.trim(),
          priceMax: priceMax.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ type: 'error', text: data.error ?? 'Failed to start bot' });
        return;
      }
      setMessage({ type: 'success', text: `Bot started (ID: ${data.botId})` });
    } catch {
      setMessage({ type: 'error', text: 'Network error' });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card variant="default" className="w-full">
      <Card.Content className="p-6">
        <h3 className="text-lg font-semibold mb-4">Start Trading Bot</h3>
        <form onSubmit={handleStart} className="space-y-4">
          {message && (
            <div
              className={`p-3 rounded-lg text-sm ${
                message.type === 'success'
                  ? 'bg-success/10 border border-success/30 text-success'
                  : 'bg-danger/10 border border-danger/30 text-danger'
              }`}
            >
              {message.text}
            </div>
          )}
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
            <Label>Price Min</Label>
            <Input
              name="priceMin"
              type="text"
              inputMode="decimal"
              value={priceMin}
              onChange={(e) => setPriceMin(e.target.value)}
              placeholder="85000"
            />
          </TextField>
          <TextField variant="primary" isDisabled={loading}>
            <Label>Price Max</Label>
            <Input
              name="priceMax"
              type="text"
              inputMode="decimal"
              value={priceMax}
              onChange={(e) => setPriceMax(e.target.value)}
              placeholder="95000"
            />
          </TextField>
          <Button type="submit" variant="primary" isDisabled={loading}>
            {loading ? 'Starting...' : 'Start Bot'}
          </Button>
        </form>
      </Card.Content>
    </Card>
  );
}
