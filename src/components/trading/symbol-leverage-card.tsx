'use client';

import { useState, useEffect } from 'react';
import {
  Card,
  TextField,
  Input,
  Label,
  Button,
  Description,
  Select,
  ListBox,
  toast,
} from '@heroui/react';

type SymbolConfig = {
  symbol: string;
  marginType: string;
  leverage: number;
};

const MARGIN_TYPE_OPTIONS = [
  { value: 'SEPARATE_ISOLATED', label: 'Separated Isolated (recomendado)' },
  { value: 'ISOLATED', label: 'Isolated' },
  { value: 'CROSSED', label: 'Cross' },
] as const;

export function SymbolLeverageCard() {
  const [config, setConfig] = useState<SymbolConfig | null>(null);
  const [marginTypeInput, setMarginTypeInput] = useState('SEPARATE_ISOLATED');
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
        setMarginTypeInput(data.marginType ?? 'SEPARATE_ISOLATED');
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

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    const lev = Math.max(1, Math.min(125, parseInt(leverageInput, 10) || 1));
    const marginType = marginTypeInput || 'SEPARATE_ISOLATED';
    setLoading(true);
    try {
      const res = await fetch('/api/bingx/symbol-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leverage: lev, marginType }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.danger(data.error ?? 'Failed to update');
        return;
      }
      toast.success('Settings updated');
      setConfig((prev) =>
        prev ? { ...prev, leverage: lev, marginType: data.marginType ?? marginType } : null
      );
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
        <form onSubmit={handleUpdate} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <TextField className={"col-span-2"} variant="primary" isDisabled>
              <Label>Symbol</Label>
              <Input name="symbol" type="text" value={config.symbol} readOnly />
            </TextField>
            <Select
              className="w-full"
              variant="primary"
              placeholder="Select margin type"
              value={marginTypeInput}
              onChange={(value) => setMarginTypeInput((value as string) ?? 'SEPARATE_ISOLATED')}
              isDisabled={loading}
            >
              <Label>Margin Type</Label>
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Description>Recomendamos SEPARATE_ISOLATED para grid trading.</Description>
              <Select.Popover>
                <ListBox>
                  {MARGIN_TYPE_OPTIONS.map((opt) => (
                    <ListBox.Item key={opt.value} id={opt.value} textValue={opt.label}>
                      {opt.label}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
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
            {loading ? 'Updating...' : 'Update'}
          </Button>
        </form>
        <p className="text-xs text-default-500 mt-3">
          It&apos;s not possible to change margin type or leverage with active positions or orders. Close them first if you get an error.
        </p>
      </Card.Content>
    </Card>
  );
}
