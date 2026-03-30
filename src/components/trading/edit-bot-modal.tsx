'use client';

import { useMemo, useState } from 'react';
import { Card, Button, TextField, Input, Label, Spinner } from '@heroui/react';
import { getAvailableMargin } from '@/lib/balance';
import { useActiveAccount } from '@/contexts/active-account';
import useSWR from 'swr';

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
  orders?: Array<{
    type: 'ENTRY' | 'TP';
    status: 'OPEN' | 'FILLED' | 'CANCELLED' | 'UNKNOWN';
  }>;
};

export type EditBotSaveParams = {
  positionSizeUsdt: string;
  takeProfitPercentage: string;
  priceMin: string;
  priceMax: string;
  gridCount: number;
};

type SymbolConfig = {
  symbol: string;
  marginType: string;
  leverage: number;
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

function formatUsdt(value: number): string {
  return `${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
}

export function EditBotModal({ item, onClose, onSave }: EditBotModalProps) {
  const { activeAccountId } = useActiveAccount();
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

  const depsKey = activeAccountId ? (['edit-bot-modal-deps', activeAccountId] as const) : null;
  const {
    data: depsData,
    error: depsError,
  } = useSWR(
    depsKey,
    async (key) => {
      const apiKeyId = key[1];
      const apiKeyParam = apiKeyId ? `?apiKeyId=${apiKeyId}` : '';

      const [balanceRes, configRes] = await Promise.all([
        fetch(`/api/bingx/balance${apiKeyParam}`),
        fetch(`/api/bingx/symbol-config${apiKeyParam}`),
      ]);

      const [balanceJson, configJson] = await Promise.all([
        balanceRes.json().catch(() => null),
        configRes.json().catch(() => null),
      ]);

      return {
        availableMargin: balanceRes.ok && balanceJson != null ? getAvailableMargin(balanceJson) : null,
        symbolConfig: configRes.ok && configJson != null ? (configJson as SymbolConfig | null) : null,
      };
    },
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshInterval: 0,
      dedupingInterval: 60_000,
      shouldRetryOnError: false,
    }
  );

  const balanceLoading = depsData === undefined && depsError === undefined;
  const availableMargin = depsData?.availableMargin ?? null;
  const symbolConfig = depsData?.symbolConfig ?? null;

  const computed = useMemo(() => {
    const priceMinNum = parseFloat(priceMin);
    const priceMaxNum = parseFloat(priceMax);
    const posSize = parseFloat(positionSizeUsdt);
    const tpPct = parseFloat(takeProfitPercentage);

    const gridCountInt = parseInt(gridCount, 10);
    const gridNum = Math.max(1, Math.min(100, gridCountInt || 1));

    const lev = symbolConfig && Number.isFinite(symbolConfig.leverage) ? symbolConfig.leverage : 1;

    // Existing bot state matters for edit:
    // - FILLED ENTRY orders already consumed margin for created positions.
    // - OPEN ENTRY orders will be cancelled and recreated, so their reserved margin should be accounted for as "released".
    const currentEntryOrders = item.orders ?? [];
    const filledEntryCount =
      currentEntryOrders.filter((o) => o.type === 'ENTRY' && o.status === 'FILLED').length ?? 0;
    const openEntryCount =
      currentEntryOrders.filter((o) => o.type === 'ENTRY' && (o.status === 'OPEN' || o.status === 'UNKNOWN')).length ?? 0;

    const oldPosSize = parseFloat(bot.positionSizeUsdt ?? '');
    const marginPerGridNew = lev > 0 ? (Number.isFinite(posSize) ? posSize : 0) / lev : 0;
    const marginPerGridOld = lev > 0 ? (Number.isFinite(oldPosSize) ? oldPosSize : 0) / lev : 0;

    // After edit, we expect to keep FILLED positions and recreate entry orders for the remaining grid levels.
    const estimatedNewOpenCount = Math.max(0, gridNum - filledEntryCount);
    const estimatedNewReservedMargin = marginPerGridNew * estimatedNewOpenCount;
    const estimatedCurrentReservedMargin = marginPerGridOld * openEntryCount;

    // Net delta: reserved margin for new OPEN orders minus currently reserved margin that should be released on cancel.
    const estimatedMarginDeltaNeeded = estimatedNewReservedMargin - estimatedCurrentReservedMargin;

    const hasValidPrices =
      Number.isFinite(priceMinNum) &&
      Number.isFinite(priceMaxNum) &&
      priceMinNum > 0 &&
      priceMaxNum > 0 &&
      priceMinNum < priceMaxNum;

    const hasValidPosSize = Number.isFinite(posSize) && posSize > 0;
    const hasValidTakeProfit = Number.isFinite(tpPct) && tpPct > 0;
    const hasValidGridCountInput = Number.isFinite(gridCountInt) && gridCountInt >= 1 && gridCountInt <= 100;

    const hasValidLeverage =
      symbolConfig !== null && Number.isFinite(symbolConfig.leverage) && symbolConfig.leverage >= 1;

    const hasEnoughMarginDelta =
      availableMargin !== null && estimatedMarginDeltaNeeded <= availableMargin;

    return {
      priceMinNum,
      priceMaxNum,
      posSize,
      tpPct,
      gridCountInt,
      gridNum,
      lev,
      hasValidPrices,
      hasValidPosSize,
      hasValidTakeProfit,
      hasValidGridCountInput,
      hasValidLeverage,
      marginPerGridNew,
      marginPerGridOld,
      filledEntryCount,
      openEntryCount,
      estimatedNewOpenCount,
      estimatedNewReservedMargin,
      estimatedCurrentReservedMargin,
      estimatedMarginDeltaNeeded,
      hasEnoughMarginDelta,
    };
  }, [
    gridCount,
    availableMargin,
    positionSizeUsdt,
    priceMin,
    priceMax,
    symbolConfig,
    takeProfitPercentage,
    item.orders,
    bot.positionSizeUsdt,
  ]);

  const canSave =
    !loading &&
    computed.hasValidPrices &&
    computed.hasValidPosSize &&
    computed.hasValidTakeProfit &&
    computed.hasValidGridCountInput &&
    (availableMargin === null || symbolConfig === null || computed.hasEnoughMarginDelta);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Keep backend as source of truth, but fail fast with better UX.
    if (!computed.hasValidPrices) {
      setError('Review Price Min and Price Max (Min < Max and both > 0).');
      return;
    }
    if (!computed.hasValidPosSize) {
      setError('Review Position Size (USDT) per grid (must be > 0).');
      return;
    }
    if (!computed.hasValidTakeProfit) {
      setError('Review Take Profit (%) per grid (must be > 0).');
      return;
    }
    if (!computed.hasValidGridCountInput) {
      setError('Review Grid Count (between 1 and 100).');
      return;
    }
    if (symbolConfig !== null && availableMargin !== null && !computed.hasEnoughMarginDelta) {
      setError('Estimated additional margin is insufficient to recreate the pending orders.');
      return;
    }

    const priceMinTrim = priceMin.trim();
    const priceMaxTrim = priceMax.trim();
    setLoading(true);
    setError(null);
    const params: EditBotSaveParams = {
      positionSizeUsdt: positionSizeUsdt.trim(),
      takeProfitPercentage: takeProfitPercentage.trim(),
      priceMin: priceMinTrim,
      priceMax: priceMaxTrim,
      gridCount: computed.gridNum,
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
        className="w-full rounded-t-2xl md:rounded-xl md:max-w-md md:mx-4 max-h-[90vh] overflow-y-auto overscroll-contain"
        onClick={(e) => e.stopPropagation()}
      >
        <Card.Content className="p-6 safe-area-pb">
          {/* Mobile drag handle */}
          <div className="md:hidden w-10 h-1 rounded-full bg-default-300 mx-auto mb-4" />
          <h3 className="text-lg font-semibold mb-4">Edit Bot</h3>
          <p className="text-sm text-default-500 mb-4">
            {bot.symbol} • Orders will be cancelled and new ones will be created in ~1 minute
          </p>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="p-3 rounded-lg text-sm bg-danger/10 border border-danger/30 text-danger">
                {error}
              </div>
            )}

            <div className="rounded-2xl border border-default-200 bg-default-50/60 p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">Margin & Validation</p>
                  <p className="text-xs text-default-500 mt-1">
                    {balanceLoading
                      ? 'Calculating margin...'
                      : availableMargin === null || symbolConfig === null
                        ? 'Could not fetch balance/leverage to estimate.'
                            : computed.hasEnoughMarginDelta
                              ? 'Estimated additional margin is enough to apply the edit.'
                          : 'Estimated additional margin is insufficient to apply this edit.'}
                  </p>
                </div>

                <div
                  className={`px-3 py-1 rounded-full text-xs font-semibold border ${
                    balanceLoading || availableMargin === null || symbolConfig === null
                      ? 'border-default-200 text-default-600 bg-default-100'
                          : computed.hasEnoughMarginDelta
                        ? 'border-success/50 text-success bg-success/10'
                        : 'border-danger/50 text-danger bg-danger/10'
                  }`}
                >
                      {balanceLoading || availableMargin === null || symbolConfig === null
                        ? 'Margin: —'
                        : computed.hasEnoughMarginDelta
                          ? 'Margin: With margin'
                          : 'Margin: Without margin'}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2">
                <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="text-default-600">Required (estimated delta)</span>
                  <span className="font-semibold font-numeric">
                    {availableMargin !== null && symbolConfig !== null
                      ? formatUsdt(Math.max(0, computed.estimatedMarginDeltaNeeded))
                      : '—'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-default-600">Available</span>
                  <span className="font-semibold font-numeric">
                    {availableMargin !== null ? formatUsdt(availableMargin) : '—'}
                  </span>
                </div>
                    {availableMargin !== null && symbolConfig !== null && (
                      computed.hasEnoughMarginDelta ? (
                        <p className="text-xs text-success">
                          Leftover {formatUsdt(Math.max(0, availableMargin - Math.max(0, computed.estimatedMarginDeltaNeeded)))}.
                        </p>
                      ) : (
                        <p className="text-xs text-danger">
                          Missing {formatUsdt(Math.max(0, Math.max(0, computed.estimatedMarginDeltaNeeded) - availableMargin))}.
                        </p>
                      )
                    )}
              </div>
            </div>

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
              <p className="text-xs text-default-500 mt-1">Entre 1 e 100.</p>
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
              <p className="text-xs text-default-500 mt-1">Margin per grid depends on leverage: `margin = pos / leverage`.</p>
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
              <p className="text-xs text-default-500 mt-1">e.g. 2 means +2%.</p>
            </TextField>
            <div className="flex gap-2 justify-end pt-2">
              <Button variant="outline" onPress={onClose} isDisabled={loading}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" isDisabled={loading || !canSave}>
                {loading ? <Spinner size="sm" /> : 'Save'}
              </Button>
            </div>
          </form>
        </Card.Content>
      </Card>
    </div>
  );
}
