'use client';

import { useState, useEffect } from 'react';
import { Card, TextField, Input, Label, Button, toast } from '@heroui/react';

type SymbolConfig = {
  symbol: string;
  marginType: string;
  leverage: number;
};

export function SymbolLeverageCard() {
  const [config, setConfig] = useState<SymbolConfig | null>(null);
  const [leverageInput, setLeverageInput] = useState('1');
  const [loading, setLoading] = useState(false);
  const [configLoading, setConfigLoading] = useState(true);

  async function fetchConfig() {
    setConfigLoading(true);
    try {
      const res = await fetch('/api/bingx/symbol-config');
      const data = await res.json();
      if (res.ok) {
        setConfig(data);
        setLeverageInput(String(data.leverage ?? 1));
      } else {
        setConfig(null);
      }
    } catch {
      setConfig(null);
    } finally {
      setConfigLoading(false);
    }
  }

  useEffect(() => {
    fetchConfig();
  }, []);

  async function handleUpdateLeverage(e: React.FormEvent) {
    e.preventDefault();
    const lev = Math.max(1, Math.min(125, parseInt(leverageInput, 10) || 1));
    setLoading(true);
    try {
      const res = await fetch('/api/bingx/symbol-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leverage: lev }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.danger(data.error ?? 'Failed to update leverage');
        return;
      }
      toast.success('Leverage updated');
      setConfig((prev) => (prev ? { ...prev, leverage: lev } : null));
    } catch {
      toast.danger('Network error');
    } finally {
      setLoading(false);
    }
  }

  if (configLoading) {
    return (
      <Card variant="default" className="w-full">
        <Card.Content className="p-6">
          <h3 className="text-lg font-semibold mb-4">Symbol & Leverage</h3>
          <p className="text-sm text-default-500">Loading...</p>
        </Card.Content>
      </Card>
    );
  }

  if (!config) {
    return (
      <Card variant="default" className="w-full">
        <Card.Content className="p-6">
          <h3 className="text-lg font-semibold mb-4">Symbol & Leverage</h3>
          <p className="text-sm text-default-500">
            Connect your BingX API keys to view and configure symbol settings.
          </p>
        </Card.Content>
      </Card>
    );
  }

  return (
    <Card variant="default" className="w-full">
      <Card.Content className="p-6">
        <h3 className="text-lg font-semibold mb-4">Symbol & Leverage</h3>
        <form onSubmit={handleUpdateLeverage} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <TextField variant="primary" isDisabled>
              <Label>Symbol</Label>
              <Input name="symbol" type="text" value={config.symbol} readOnly />
            </TextField>
            <TextField variant="primary" isDisabled>
              <Label>Margin Type</Label>
              <Input name="marginType" type="text" value={config.marginType} readOnly />
            </TextField>
            <TextField variant="primary" isDisabled={loading}>
              <Label>Leverage</Label>
              <Input
                name="leverage"
                type="number"
                min={1}
                max={125}
                value={leverageInput}
                onChange={(e) => setLeverageInput(e.target.value)}
                placeholder="1"
              />
            </TextField>
          </div>
          <Button type="submit" variant="primary" isDisabled={loading}>
            {loading ? 'Updating...' : 'Update Leverage'}
          </Button>
        </form>
        <p className="text-xs text-default-500 mt-3">
          Cannot change leverage with active positions. Close positions first if you see an error.
        </p>
      </Card.Content>
    </Card>
  );
}
