'use client';

import { useState } from 'react';
import { Card, Button, TextField, Input, Label } from '@heroui/react';

export type EditBotModalItem = {
  bot: {
    id: string;
    symbol: string;
    priceMin: string;
    priceMax: string;
    gridCount: number;
    positionSizeUsdt?: string;
    takeProfitPercentage?: string;
  };
};

export type EditBotSaveParams = {
  positionSizeUsdt: string;
  takeProfitPercentage: string;
  priceMin: string;
  priceMax: string;
  gridCount: number;
};

type EditBotModalProps = {
  item: EditBotModalItem;
  onClose: () => void;
  onSave: (botId: string, params: EditBotSaveParams) => Promise<string | null>;
};

/** Remove trailing zeros from decimal string (e.g. "10.00000000" → "10") */
function trimDecimal(s: string | undefined, fallback: string): string {
  if (s == null || s === '') return fallback;
  const n = parseFloat(s);
  return Number.isNaN(n) ? fallback : String(n);
}

export function EditBotModal({ item, onClose, onSave }: EditBotModalProps) {
  const bot = item.bot;
  const [positionSizeUsdt, setPositionSizeUsdt] = useState(
    () => trimDecimal(bot.positionSizeUsdt, '10')
  );
  const [takeProfitPercentage, setTakeProfitPercentage] = useState(
    () => trimDecimal(bot.takeProfitPercentage, '2')
  );
  const [priceMin, setPriceMin] = useState(
    () => trimDecimal(bot.priceMin, '')
  );
  const [priceMax, setPriceMax] = useState(
    () => trimDecimal(bot.priceMax, '')
  );
  const [gridCount, setGridCount] = useState(
    () => String(bot.gridCount ?? 5)
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const priceMinTrim = priceMin.trim();
    const priceMaxTrim = priceMax.trim();
    if (!priceMinTrim || !priceMaxTrim) {
      setError('Price Min and Price Max are required');
      return;
    }
    setLoading(true);
    setError(null);
    const params: EditBotSaveParams = {
      positionSizeUsdt: positionSizeUsdt.trim(),
      takeProfitPercentage: takeProfitPercentage.trim(),
      priceMin: priceMinTrim,
      priceMax: priceMaxTrim,
      gridCount: Math.max(1, Math.min(100, parseInt(gridCount, 10) || 5)),
    };
    const err = await onSave(bot.id, params);
    setLoading(false);
    if (err) setError(err);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center md:justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <Card
        variant="default"
        className="w-full rounded-t-2xl md:rounded-xl md:max-w-md md:mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <Card.Content className="p-6 safe-area-pb">
          <h3 className="text-lg font-semibold mb-4">Edit Bot</h3>
          <p className="text-sm text-default-500 mb-4">
            {bot.symbol} • Orders will be cancelled and new ones placed with these values within ~1 minute
          </p>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="p-3 rounded-lg text-sm bg-danger/10 border border-danger/30 text-danger">
                {error}
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <TextField variant="primary" isDisabled={loading}>
                <Label>Price Min</Label>
                <Input
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
                  type="text"
                  inputMode="decimal"
                  value={priceMax}
                  onChange={(e) => setPriceMax(e.target.value)}
                  placeholder="95000"
                />
              </TextField>
            </div>
            <TextField variant="primary" isDisabled={loading}>
              <Label>Grid Count</Label>
              <Input
                type="number"
                min={1}
                max={100}
                value={gridCount}
                onChange={(e) => setGridCount(e.target.value)}
                placeholder="5"
              />
            </TextField>
            <TextField variant="primary" isDisabled={loading}>
              <Label>Position Size (USDT) per grid</Label>
              <Input
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
                type="text"
                inputMode="decimal"
                value={takeProfitPercentage}
                onChange={(e) => setTakeProfitPercentage(e.target.value)}
                placeholder="2"
              />
            </TextField>
            <div className="flex gap-2 justify-end pt-2">
              <Button variant="outline" onPress={onClose} isDisabled={loading}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" isDisabled={loading}>
                {loading ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </form>
        </Card.Content>
      </Card>
    </div>
  );
}
