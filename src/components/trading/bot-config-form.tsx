'use client';

import { useState } from 'react';
import { Card, TextField, Input, Label, Button, Description, toast } from '@heroui/react';

export function BotConfigForm() {
  const [symbol, setSymbol] = useState('BTC-USDT');
  const [priceMin, setPriceMin] = useState('');
  const [priceMax, setPriceMax] = useState('');
  const [positionSizeUsdt, setPositionSizeUsdt] = useState('10');
  const [takeProfitPercentage, setTakeProfitPercentage] = useState('2');
  const [gridCount, setGridCount] = useState('5');
  const [leverage, setLeverage] = useState('1');
  const [loading, setLoading] = useState(false);

  async function handleStart(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch('/api/bingx/bot/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: symbol.trim(),
          priceMin: priceMin.trim(),
          priceMax: priceMax.trim(),
          positionSizeUsdt: positionSizeUsdt.trim(),
          takeProfitPercentage: takeProfitPercentage.trim(),
          gridCount: parseInt(gridCount, 10) || 5,
          leverage: parseInt(leverage, 10) || 1,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.danger(data.error ?? 'Failed to start bot');
        return;
      }
      toast.success(`Bot started (ID: ${data.botId})`);
    } catch {
      toast.danger('Network error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card variant="default" className="w-full">
      <Card.Content className="p-6">
        <h3 className="text-lg font-semibold mb-4">Start Grid Trading Bot</h3>
        <form onSubmit={handleStart} className="space-y-4">
          <TextField variant="primary" isDisabled={loading}>
            <Label>Symbol</Label>
            <Input
              name="symbol"
              type="text"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder="BTC-USDT"
              readOnly
            />
            <Description>For now, only BTC-USDT is supported.</Description>
          </TextField>
          <div className="grid grid-cols-2 gap-4">
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
          </div>
          <TextField variant="primary" isDisabled={loading}>
            <Label>Position Size (USDT) per grid</Label>
            <Input
              name="positionSizeUsdt"
              type="text"
              inputMode="decimal"
              value={positionSizeUsdt}
              onChange={(e) => setPositionSizeUsdt(e.target.value)}
              placeholder="10"
            />
          </TextField>
          <TextField variant="primary" isDisabled={loading}>
            <Label>Take Profit (%) per grid</Label>
            <Input
              name="takeProfitPercentage"
              type="text"
              inputMode="decimal"
              value={takeProfitPercentage}
              onChange={(e) => setTakeProfitPercentage(e.target.value)}
              placeholder="2"
            />
          </TextField>
          <div className="grid grid-cols-2 gap-4">
            <TextField variant="primary" isDisabled={loading}>
              <Label>Grid Count</Label>
              <Input
                name="gridCount"
                type="number"
                min={1}
                max={100}
                value={gridCount}
                onChange={(e) => setGridCount(e.target.value)}
                placeholder="5"
              />
            </TextField>
            <TextField variant="primary" isDisabled={loading}>
              <Label>Leverage</Label>
              <Input
                name="leverage"
                type="number"
                min={1}
                max={125}
                value={leverage}
                onChange={(e) => setLeverage(e.target.value)}
                placeholder="1"
              />
            </TextField>
          </div>
          <Button type="submit" variant="primary" isDisabled={loading}>
            {loading ? 'Starting...' : 'Start Bot'}
          </Button>
        </form>
      </Card.Content>
    </Card>
  );
}
