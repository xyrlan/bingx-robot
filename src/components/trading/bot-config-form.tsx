'use client';

import { useState, useEffect } from 'react';
import { Card, TextField, Input, Label, Button, Description, toast } from '@heroui/react';
import { getAvailableMargin } from '@/lib/balance';

function formatUsdt(value: number): string {
  return `${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
}

export function BotConfigForm() {
  const [symbol, setSymbol] = useState('BTC-USDT');
  const [priceMin, setPriceMin] = useState('');
  const [priceMax, setPriceMax] = useState('');
  const [positionSizeUsdt, setPositionSizeUsdt] = useState('10');
  const [takeProfitPercentage, setTakeProfitPercentage] = useState('2');
  const [gridCount, setGridCount] = useState('5');
  const [leverage, setLeverage] = useState('1');
  const [loading, setLoading] = useState(false);
  const [availableMargin, setAvailableMargin] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(true);

  useEffect(() => {
    async function fetchBalance() {
      setBalanceLoading(true);
      try {
        const res = await fetch('/api/bingx/balance');
        const data = await res.json();
        if (res.ok) {
          setAvailableMargin(getAvailableMargin(data));
        } else {
          setAvailableMargin(null);
        }
      } catch {
        setAvailableMargin(null);
      } finally {
        setBalanceLoading(false);
      }
    }
    fetchBalance();
  }, []);

  const posSize = parseFloat(positionSizeUsdt) || 0;
  const lev = Math.max(1, Math.min(125, parseInt(leverage, 10) || 1));
  const gridNum = Math.max(1, Math.min(100, parseInt(gridCount, 10) || 1));
  const marginPerGrid = lev > 0 ? posSize / lev : 0;
  const totalMarginNeeded = marginPerGrid * gridNum;
  const hasEnoughMargin =
    availableMargin !== null && totalMarginNeeded > 0 && availableMargin >= totalMarginNeeded;
  const canSubmit =
    !loading &&
    !balanceLoading &&
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
          gridCount: gridNum,
          leverage: lev,
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
          <div className="grid grid-cols-2 gap-4">
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
          </div>
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

          {!balanceLoading && posSize > 0 && lev >= 1 && gridNum >= 1 && (
            <div className="rounded-lg bg-default-100 p-4 space-y-2">
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <span className="text-default-600">
                  Required margin: <strong>{formatUsdt(totalMarginNeeded)}</strong>
                </span>
                <span className="text-default-600">
                  Available margin:{' '}
                  <strong>
                    {availableMargin !== null ? formatUsdt(availableMargin) : '—'}
                  </strong>
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
                ? 'Loading balance...'
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
