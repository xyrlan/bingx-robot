'use client';

import { useState, useEffect } from 'react';
import { Card, TextField, Input, Label, Button, toast } from '@heroui/react';
import { getAvailableMargin } from '@/lib/balance';
import { useActiveAccount } from '@/contexts/active-account';

function formatUsdt(value: number): string {
  return `${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
}

type SymbolConfig = {
  symbol: string;
  marginType: string;
  leverage: number;
};

export function GridShortConfigForm() {
  const { activeAccountId } = useActiveAccount();
  const [priceMin, setPriceMin] = useState('');
  const [priceMax, setPriceMax] = useState('');
  const [positionSizeUsdt, setPositionSizeUsdt] = useState('10');
  const [takeProfitPercentage, setTakeProfitPercentage] = useState('2');
  const [gridCount, setGridCount] = useState('5');
  const [loading, setLoading] = useState(false);
  const [availableMargin, setAvailableMargin] = useState<number | null>(null);
  const [symbolConfig, setSymbolConfig] = useState<SymbolConfig | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      setBalanceLoading(true);
      try {
        const apiKeyParam = activeAccountId ? `?apiKeyId=${activeAccountId}` : '';
        const [balanceRes, configRes] = await Promise.all([
          fetch(`/api/bingx/balance${apiKeyParam}`),
          fetch(`/api/bingx/symbol-config${apiKeyParam}`),
        ]);
        const balanceData = await balanceRes.json();
        const configData = await configRes.json();
        setAvailableMargin(balanceRes.ok ? getAvailableMargin(balanceData) : null);
        setSymbolConfig(configRes.ok ? configData : null);
      } catch {
        setAvailableMargin(null);
        setSymbolConfig(null);
      } finally {
        setBalanceLoading(false);
      }
    }
    fetchData();
  }, [activeAccountId]);

  const posSize = parseFloat(positionSizeUsdt) || 0;
  const lev = symbolConfig?.leverage ?? 1;
  const gridNum = Math.max(1, Math.min(100, parseInt(gridCount, 10) || 1));
  const marginPerGrid = lev > 0 ? posSize / lev : 0;
  const totalMarginNeeded = marginPerGrid * gridNum;
  const hasEnoughMargin =
    availableMargin !== null && totalMarginNeeded > 0 && availableMargin >= totalMarginNeeded;
  const canSubmit =
    !loading &&
    !balanceLoading &&
    symbolConfig !== null &&
    availableMargin !== null &&
    hasEnoughMargin &&
    posSize > 0 &&
    lev >= 1 &&
    gridNum >= 1;

  async function handleStart(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    if (availableMargin === null || !hasEnoughMargin) {
      if (availableMargin === null) {
        toast.danger('Could not fetch balance. Please refresh and try again.');
      } else {
        toast.danger(
          `Insufficient margin. Required: ${formatUsdt(totalMarginNeeded)} | Available: ${formatUsdt(availableMargin)}`
        );
      }
      return;
    }

    if (!symbolConfig) {
      toast.danger('Could not fetch symbol config. Please refresh and try again.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/bingx/bot/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          priceMin: priceMin.trim(),
          priceMax: priceMax.trim(),
          positionSizeUsdt: positionSizeUsdt.trim(),
          takeProfitPercentage: takeProfitPercentage.trim(),
          gridCount: gridNum,
          apiKeyId: activeAccountId,
          botType: 'GRID_SHORT',
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
        <h3 className="text-lg font-semibold mb-1">Grid Short Bot</h3>
        <p className="text-sm text-default-500 mb-4">
          Places sell orders in a price range, buying back at lower prices for profit.
        </p>
        <form onSubmit={handleStart} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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

          {!balanceLoading && symbolConfig && posSize > 0 && lev >= 1 && gridNum >= 1 && (
            <div className="rounded-lg bg-default-100 p-4 space-y-2">
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <span className="text-default-600">
                  Required margin: <strong className="font-numeric">{formatUsdt(totalMarginNeeded)}</strong>
                </span>
                <span className="text-default-600">
                  Available margin:{' '}
                  <strong className="font-numeric">
                    {availableMargin !== null ? formatUsdt(availableMargin) : '\u2014'}
                  </strong>
                </span>
                <span className="text-default-600">
                  Leverage: <strong className="font-numeric">{lev}x</strong> (from Symbol & Leverage card)
                </span>
              </div>
              {availableMargin !== null && !hasEnoughMargin && (
                <p className="text-sm text-danger">
                  Insufficient margin. You need {formatUsdt(totalMarginNeeded - availableMargin)}{' '}
                  more.
                </p>
              )}
            </div>
          )}

          <span
            title={
              balanceLoading
                ? 'Loading...'
                : symbolConfig === null
                  ? 'Symbol config unavailable. Connect keys and refresh.'
                  : availableMargin === null
                    ? 'Balance unavailable. Connect keys and refresh.'
                    : !hasEnoughMargin
                      ? 'Insufficient margin'
                      : undefined
            }
          >
            <Button type="submit" variant="primary" isDisabled={loading || !canSubmit}>
              {loading ? 'Starting...' : 'Start Bot'}
            </Button>
          </span>
        </form>
      </Card.Content>
    </Card>
  );
}
