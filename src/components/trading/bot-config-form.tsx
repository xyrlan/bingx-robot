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

export function BotConfigForm() {
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

  const priceMinNum = parseFloat(priceMin);
  const priceMaxNum = parseFloat(priceMax);
  const posSize = parseFloat(positionSizeUsdt);
  const tpPct = parseFloat(takeProfitPercentage);

  const gridCountInt = parseInt(gridCount, 10);
  const gridNum = Math.max(1, Math.min(100, gridCountInt || 1));

  const lev = symbolConfig && Number.isFinite(symbolConfig.leverage) ? symbolConfig.leverage : 1;

  const hasValidPrices =
    Number.isFinite(priceMinNum) &&
    Number.isFinite(priceMaxNum) &&
    priceMinNum > 0 &&
    priceMaxNum > 0 &&
    priceMinNum < priceMaxNum;

  const hasValidPosSize = Number.isFinite(posSize) && posSize > 0;
  const hasValidTakeProfit = Number.isFinite(tpPct) && tpPct > 0;

  const hasValidGridCountInput = Number.isFinite(gridCountInt) && gridCountInt >= 1 && gridCountInt <= 100;
  const hasValidLeverage = symbolConfig !== null && Number.isFinite(symbolConfig.leverage) && symbolConfig.leverage >= 1;

  const marginPerGrid = lev > 0 ? (Number.isFinite(posSize) ? posSize : 0) / lev : 0;
  const totalMarginNeeded = marginPerGrid * gridNum;
  const hasEnoughMargin =
    availableMargin !== null && totalMarginNeeded > 0 && availableMargin >= totalMarginNeeded;

  const canSubmit =
    !loading &&
    !balanceLoading &&
    symbolConfig !== null &&
    availableMargin !== null &&
    hasEnoughMargin &&
    hasValidPrices &&
    hasValidPosSize &&
    hasValidLeverage &&
    hasValidGridCountInput &&
    hasValidTakeProfit;

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
          botType: 'GRID_LONG',
          priceMin: priceMin.trim(),
          priceMax: priceMax.trim(),
          positionSizeUsdt: positionSizeUsdt.trim(),
          takeProfitPercentage: takeProfitPercentage.trim(),
          gridCount: gridNum,
          apiKeyId: activeAccountId,
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
          <div className="space-y-6">
            <div>
              <h3 className="text-lg font-semibold mb-1">Start Grid Trading Bot</h3>
              <p className="text-sm text-default-600">
                Creates orders in a grid within the selected price range. The button is enabled only when entries and margin make sense.
              </p>
            </div>

            {/* Mobile sticky margin summary */}
            <div className="lg:hidden sticky top-16 z-20 -mx-4 px-4 py-3 bg-background/95 backdrop-blur-sm border-b border-default-200">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-default-500">Margin:</span>
                  <span className="font-numeric font-semibold">
                    {hasValidPosSize && hasValidLeverage ? formatUsdt(totalMarginNeeded) : '—'}
                  </span>
                  <span className="text-default-400">/</span>
                  <span className="font-numeric font-semibold">
                    {availableMargin !== null ? formatUsdt(availableMargin) : '—'}
                  </span>
                </div>
                <div
                  className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${
                    balanceLoading || availableMargin === null
                      ? 'border-default-200 text-default-600 bg-default-100'
                      : hasEnoughMargin
                        ? 'border-success/50 text-success bg-success/10'
                        : 'border-danger/50 text-danger bg-danger/10'
                  }`}
                >
                  {balanceLoading || availableMargin === null
                    ? '—'
                    : hasEnoughMargin
                      ? 'OK'
                      : 'Insufficient'}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <form onSubmit={handleStart} className="space-y-4 lg:col-span-2">
                <div className="rounded-2xl border border-default-200 bg-default-50/60 p-4 space-y-4">
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
                    <p className="text-xs text-default-500 mt-1">
                      USDT used per grid. Margin per grid depends on leverage: `margin = pos / leverage`.
                    </p>
                  </TextField>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                      <p className="text-xs text-default-500 mt-1">Between 1 and 100.</p>
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
                      <p className="text-xs text-default-500 mt-1">
                        Percentage above the entry price (e.g. 2 means 2%).
                      </p>
                    </TextField>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <span
                    title={
                      balanceLoading
                        ? 'Loading balance...'
                        : symbolConfig === null
                          ? 'Symbol config unavailable. Connect keys and refresh.'
                          : availableMargin === null
                            ? 'Balance unavailable. Connect keys and refresh.'
                            : !hasValidPrices
                              ? 'Revise Price Min / Price Max (min < max).'
                              : !hasValidPosSize
                                ? 'Revise Position Size (USDT) per grid (must be > 0).'
                                : !hasValidGridCountInput
                                  ? 'Revise Grid Count (between 1 and 100).'
                                  : !hasValidTakeProfit
                                    ? 'Revise Take Profit (%): must be > 0.'
                                    : !hasValidLeverage
                                      ? 'Invalid leverage for the selected symbol.'
                                      : !hasEnoughMargin
                                        ? 'Insufficient margin.'
                                        : undefined
                    }
                  >
                    <Button type="submit" variant="primary" isDisabled={loading || !canSubmit}>
                      {loading ? 'Starting...' : 'Start Bot'}
                    </Button>
                  </span>
                </div>
              </form>

              <aside className="lg:col-span-1">
                <div className="rounded-2xl border border-default-200 bg-default-50/60 p-4 space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold">Margin & Preparation</p>
                      <p className="text-xs text-default-500 mt-1">
                        {balanceLoading
                          ? 'Calculating based on your balance and leverage.'
                          : availableMargin === null
                            ? 'Could not fetch your balance.'
                            : hasEnoughMargin
                              ? 'You have enough margin to start the grid.'
                              : 'You do not have enough margin to cover the grid.'}
                      </p>
                    </div>

                    <div
                      className={`px-3 py-1 rounded-full text-xs font-semibold border ${
                        balanceLoading || availableMargin === null
                          ? 'border-default-200 text-default-600 bg-default-100'
                          : hasEnoughMargin
                            ? 'border-success/50 text-success bg-success/10'
                            : 'border-danger/50 text-danger bg-danger/10'
                      }`}
                    >
                      {balanceLoading || availableMargin === null
                        ? 'Margin: —'
                        : hasEnoughMargin
                          ? 'Margin: With margin'
                          : 'Margin: Without margin'}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-3">
                    <div className="rounded-xl border border-default-200 bg-background p-3">
                      <p className="text-xs text-default-500">Margin per grid</p>
                      <p className="text-sm font-semibold font-numeric mt-1">
                        {hasValidPosSize && hasValidLeverage ? formatUsdt(marginPerGrid) : '—'}
                      </p>
                      <p className="text-xs text-default-500 mt-1">
                        {hasValidLeverage ? `pos / ${lev}x` : '—'}
                      </p>
                    </div>

                    <div className="rounded-xl border border-default-200 bg-background p-3">
                      <p className="text-xs text-default-500">Required margin (total)</p>
                      <p className="text-sm font-semibold font-numeric mt-1">
                        {hasValidPosSize && hasValidLeverage && gridNum >= 1 ? formatUsdt(totalMarginNeeded) : '—'}
                      </p>
                      <p className="text-xs text-default-500 mt-1">= margin per grid * {gridNum} grids</p>
                    </div>

                    <div className="rounded-xl border border-default-200 bg-background p-3">
                      <p className="text-xs text-default-500">Available margin</p>
                      <p className="text-sm font-semibold font-numeric mt-1">
                        {availableMargin !== null ? formatUsdt(availableMargin) : '—'}
                      </p>
                      {availableMargin !== null && totalMarginNeeded > 0 && (
                        hasEnoughMargin ? (
                          <p className="text-xs text-success mt-1">
                            Leftover {formatUsdt(Math.max(0, availableMargin - totalMarginNeeded))} to start.
                          </p>
                        ) : (
                          <p className="text-xs text-danger mt-1">
                            Missing {formatUsdt(Math.max(0, totalMarginNeeded - availableMargin))} to start.
                          </p>
                        )
                      )}
                    </div>
                  </div>

                  <div className="pt-3 border-t border-default-200 space-y-3">
                    <p className="text-xs font-semibold text-default-600 uppercase tracking-wide">
                      Fill checklist
                    </p>
                    <div className="space-y-2">
                      <div
                        className={`flex items-center gap-2 text-sm ${
                          hasValidPrices ? 'text-success' : 'text-default-600'
                        }`}
                      >
                        <span
                          className={`h-2 w-2 rounded-full ${hasValidPrices ? 'bg-success' : 'bg-default-300'}`}
                        />
                        Price range (Min &lt; Max)
                      </div>
                      <div
                        className={`flex items-center gap-2 text-sm ${
                          hasValidPosSize ? 'text-success' : 'text-default-600'
                        }`}
                      >
                        <span
                          className={`h-2 w-2 rounded-full ${hasValidPosSize ? 'bg-success' : 'bg-default-300'}`}
                        />
                        Position Size &gt; 0
                      </div>
                      <div
                        className={`flex items-center gap-2 text-sm ${
                          hasValidGridCountInput ? 'text-success' : 'text-default-600'
                        }`}
                      >
                        <span
                          className={`h-2 w-2 rounded-full ${hasValidGridCountInput ? 'bg-success' : 'bg-default-300'}`}
                        />
                        Grid Count between 1 and 100
                      </div>
                      <div
                        className={`flex items-center gap-2 text-sm ${
                          hasValidTakeProfit ? 'text-success' : 'text-default-600'
                        }`}
                      >
                        <span
                          className={`h-2 w-2 rounded-full ${hasValidTakeProfit ? 'bg-success' : 'bg-default-300'}`}
                        />
                        Take Profit (%), &gt; 0
                      </div>
                      <div
                        className={`flex items-center gap-2 text-sm ${
                          hasEnoughMargin ? 'text-success' : availableMargin === null ? 'text-default-600' : 'text-danger'
                        }`}
                      >
                        <span
                          className={`h-2 w-2 rounded-full ${
                            hasEnoughMargin ? 'bg-success' : availableMargin === null ? 'bg-default-300' : 'bg-danger'
                          }`}
                        />
                        Enough margin to start
                      </div>
                    </div>
                  </div>
                </div>
              </aside>
            </div>
          </div>
      </Card.Content>
    </Card>
  );
}
