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
    botType?: string;
    config?: Record<string, unknown>;
  };
  orders?: Array<{
    type: 'ENTRY' | 'TP';
    status: 'OPEN' | 'FILLED' | 'CANCELLED' | 'UNKNOWN';
  }>;
};

export type EditBotSaveParams = {
  positionSizeUsdt?: string;
  takeProfitPercentage?: string;
  priceMin?: string;
  priceMax?: string;
  gridCount?: number;
  config?: Record<string, unknown>;
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

function trimDecimal(s: string | undefined, fallback: string): string {
  if (s == null || s === '') return fallback;
  const n = parseFloat(s);
  return Number.isNaN(n) ? fallback : String(n);
}

function formatUsdt(value: number): string {
  return `${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
}

// ==========================================
// Grid Bot Edit Form
// ==========================================
function GridEditForm({ item, onClose, onSave }: EditBotModalProps) {
  const { activeAccountId } = useActiveAccount();
  const bot = item.bot;
  const [positionSizeUsdt, setPositionSizeUsdt] = useState(() => trimDecimal(bot.positionSizeUsdt, '10'));
  const [takeProfitPercentage, setTakeProfitPercentage] = useState(() => trimDecimal(bot.takeProfitPercentage, '2'));
  const [priceMin, setPriceMin] = useState(() => trimDecimal(bot.priceMin, ''));
  const [priceMax, setPriceMax] = useState(() => trimDecimal(bot.priceMax, ''));
  const [gridCount, setGridCount] = useState(() => String(bot.gridCount ?? 5));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const depsKey = activeAccountId ? (['edit-bot-modal-deps', activeAccountId] as const) : null;
  const { data: depsData, error: depsError } = useSWR(
    depsKey,
    async (key) => {
      const apiKeyParam = key[1] ? `?apiKeyId=${key[1]}` : '';
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
    { revalidateOnFocus: false, refreshInterval: 0, dedupingInterval: 60_000, shouldRetryOnError: false }
  );

  const balanceLoading = depsData === undefined && depsError === undefined;
  const availableMargin = depsData?.availableMargin ?? null;
  const symbolConfig = depsData?.symbolConfig ?? null;

  const computed = useMemo(() => {
    const posSize = parseFloat(positionSizeUsdt);
    const gridNum = Math.max(1, Math.min(100, parseInt(gridCount, 10) || 1));
    const lev = symbolConfig?.leverage ?? 1;
    const currentEntryOrders = item.orders ?? [];
    const filledEntryCount = currentEntryOrders.filter((o) => o.type === 'ENTRY' && o.status === 'FILLED').length;
    const openEntryCount = currentEntryOrders.filter((o) => o.type === 'ENTRY' && (o.status === 'OPEN' || o.status === 'UNKNOWN')).length;
    const oldPosSize = parseFloat(bot.positionSizeUsdt ?? '');
    const marginPerGridNew = lev > 0 ? (Number.isFinite(posSize) ? posSize : 0) / lev : 0;
    const marginPerGridOld = lev > 0 ? (Number.isFinite(oldPosSize) ? oldPosSize : 0) / lev : 0;
    const estimatedNewOpenCount = Math.max(0, gridNum - filledEntryCount);
    const estimatedMarginDeltaNeeded = marginPerGridNew * estimatedNewOpenCount - marginPerGridOld * openEntryCount;
    const hasEnoughMarginDelta = availableMargin !== null && estimatedMarginDeltaNeeded <= availableMargin;

    return { posSize, gridNum, estimatedMarginDeltaNeeded, hasEnoughMarginDelta };
  }, [gridCount, availableMargin, positionSizeUsdt, symbolConfig, item.orders, bot.positionSizeUsdt]);

  const canSave = !loading &&
    parseFloat(priceMin) > 0 && parseFloat(priceMax) > parseFloat(priceMin) &&
    computed.posSize > 0 && parseFloat(takeProfitPercentage) > 0 &&
    (availableMargin === null || symbolConfig === null || computed.hasEnoughMarginDelta);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const err = await onSave(bot.id, {
      positionSizeUsdt: positionSizeUsdt.trim(),
      takeProfitPercentage: takeProfitPercentage.trim(),
      priceMin: priceMin.trim(),
      priceMax: priceMax.trim(),
      gridCount: computed.gridNum,
    });
    setLoading(false);
    if (err) setError(err);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && <div className="p-3 rounded-lg text-sm bg-danger/10 border border-danger/30 text-danger">{error}</div>}

      {/* Margin info */}
      <div className="rounded-xl border border-default-200 bg-default-50/60 p-3 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-default-500">Available margin</span>
          <span className="font-numeric">{balanceLoading ? '...' : availableMargin !== null ? formatUsdt(availableMargin) : '—'}</span>
        </div>
        {availableMargin !== null && symbolConfig !== null && (
          <div className={`text-xs mt-1 ${computed.hasEnoughMarginDelta ? 'text-success' : 'text-danger'}`}>
            {computed.hasEnoughMarginDelta ? 'Margin sufficient' : `Need ${formatUsdt(Math.max(0, computed.estimatedMarginDeltaNeeded - availableMargin))} more`}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <TextField variant="primary" isDisabled={loading}>
          <Label>Price Min</Label>
          <Input type="text" inputMode="decimal" value={priceMin} onChange={(e) => setPriceMin(e.target.value)} />
        </TextField>
        <TextField variant="primary" isDisabled={loading}>
          <Label>Price Max</Label>
          <Input type="text" inputMode="decimal" value={priceMax} onChange={(e) => setPriceMax(e.target.value)} />
        </TextField>
      </div>
      <TextField variant="primary" isDisabled={loading}>
        <Label>Grid Count</Label>
        <Input type="number" min={1} max={100} value={gridCount} onChange={(e) => setGridCount(e.target.value)} />
      </TextField>
      <TextField variant="primary" isDisabled={loading}>
        <Label>Position Size (USDT) per grid</Label>
        <Input type="text" inputMode="decimal" value={positionSizeUsdt} onChange={(e) => setPositionSizeUsdt(e.target.value)} />
      </TextField>
      <TextField variant="primary" isDisabled={loading}>
        <Label>Take Profit (%)</Label>
        <Input type="text" inputMode="decimal" value={takeProfitPercentage} onChange={(e) => setTakeProfitPercentage(e.target.value)} />
      </TextField>

      <div className="flex gap-2 justify-end pt-2">
        <Button variant="outline" onPress={onClose} isDisabled={loading}>Cancel</Button>
        <Button type="submit" variant="primary" isDisabled={loading || !canSave}>
          {loading ? <Spinner size="sm" /> : 'Save'}
        </Button>
      </div>
    </form>
  );
}

// ==========================================
// DCA / DCA Spot Edit Form
// ==========================================
function DCAEditForm({ item, onClose, onSave }: EditBotModalProps) {
  const cfg = (item.bot.config ?? {}) as Record<string, unknown>;
  const [intervalMinutes, setIntervalMinutes] = useState(String(cfg.intervalMinutes ?? 60));
  const [totalOrders, setTotalOrders] = useState(String(cfg.totalOrders ?? 10));
  const [orderSizeUsdt, setOrderSizeUsdt] = useState(String(cfg.orderSizeUsdt ?? 10));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const err = await onSave(item.bot.id, {
      config: {
        intervalMinutes: Number(intervalMinutes),
        totalOrders: Number(totalOrders),
        orderSizeUsdt: Number(orderSizeUsdt),
        positionSizeUsdt: Number(orderSizeUsdt),
      },
    });
    setLoading(false);
    if (err) setError(err);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && <div className="p-3 rounded-lg text-sm bg-danger/10 border border-danger/30 text-danger">{error}</div>}
      <TextField variant="primary" isDisabled={loading}>
        <Label>Interval (minutes)</Label>
        <Input type="text" inputMode="numeric" value={intervalMinutes} onChange={(e) => setIntervalMinutes(e.target.value)} />
      </TextField>
      <TextField variant="primary" isDisabled={loading}>
        <Label>Total Orders</Label>
        <Input type="text" inputMode="numeric" value={totalOrders} onChange={(e) => setTotalOrders(e.target.value)} />
      </TextField>
      <TextField variant="primary" isDisabled={loading}>
        <Label>Order Size (USDT)</Label>
        <Input type="text" inputMode="decimal" value={orderSizeUsdt} onChange={(e) => setOrderSizeUsdt(e.target.value)} />
      </TextField>
      <div className="flex gap-2 justify-end pt-2">
        <Button variant="outline" onPress={onClose} isDisabled={loading}>Cancel</Button>
        <Button type="submit" variant="primary" isDisabled={loading}>
          {loading ? <Spinner size="sm" /> : 'Save'}
        </Button>
      </div>
    </form>
  );
}

// ==========================================
// Trailing Stop Edit Form
// ==========================================
function TrailingStopEditForm({ item, onClose, onSave }: EditBotModalProps) {
  const cfg = (item.bot.config ?? {}) as Record<string, unknown>;
  const [positionSizeUsdt, setPositionSizeUsdt] = useState(String(cfg.positionSizeUsdt ?? 50));
  const [activationPricePct, setActivationPricePct] = useState(String(cfg.activationPricePct ?? 2));
  const [trailingPct, setTrailingPct] = useState(String(cfg.trailingPct ?? 1));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const err = await onSave(item.bot.id, {
      config: {
        positionSizeUsdt: Number(positionSizeUsdt),
        activationPricePct: Number(activationPricePct),
        trailingPct: Number(trailingPct),
      },
    });
    setLoading(false);
    if (err) setError(err);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && <div className="p-3 rounded-lg text-sm bg-danger/10 border border-danger/30 text-danger">{error}</div>}
      <TextField variant="primary" isDisabled={loading}>
        <Label>Position Size (USDT)</Label>
        <Input type="text" inputMode="decimal" value={positionSizeUsdt} onChange={(e) => setPositionSizeUsdt(e.target.value)} />
      </TextField>
      <TextField variant="primary" isDisabled={loading}>
        <Label>Activation (%)</Label>
        <Input type="text" inputMode="decimal" value={activationPricePct} onChange={(e) => setActivationPricePct(e.target.value)} />
      </TextField>
      <TextField variant="primary" isDisabled={loading}>
        <Label>Trailing Distance (%)</Label>
        <Input type="text" inputMode="decimal" value={trailingPct} onChange={(e) => setTrailingPct(e.target.value)} />
      </TextField>
      <div className="flex gap-2 justify-end pt-2">
        <Button variant="outline" onPress={onClose} isDisabled={loading}>Cancel</Button>
        <Button type="submit" variant="primary" isDisabled={loading}>
          {loading ? <Spinner size="sm" /> : 'Save'}
        </Button>
      </div>
    </form>
  );
}

// ==========================================
// SMA Crossover Edit Form
// ==========================================
function SMAEditForm({ item, onClose, onSave }: EditBotModalProps) {
  const cfg = (item.bot.config ?? {}) as Record<string, unknown>;
  const [positionSizeUsdt, setPositionSizeUsdt] = useState(String(cfg.positionSizeUsdt ?? 50));
  const [adxThreshold, setAdxThreshold] = useState(String(cfg.adxThreshold ?? 25));
  const [activationAtrMult, setActivationAtrMult] = useState(String(cfg.activationAtrMult ?? 3));
  const [trailingAtrMult, setTrailingAtrMult] = useState(String(cfg.trailingAtrMult ?? 1));
  const [initialStopAtrMult, setInitialStopAtrMult] = useState(String(cfg.initialStopAtrMult ?? 2));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const err = await onSave(item.bot.id, {
      config: {
        positionSizeUsdt: Number(positionSizeUsdt),
        adxThreshold: Number(adxThreshold),
        activationAtrMult: Number(activationAtrMult),
        trailingAtrMult: Number(trailingAtrMult),
        initialStopAtrMult: Number(initialStopAtrMult),
      },
    });
    setLoading(false);
    if (err) setError(err);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && <div className="p-3 rounded-lg text-sm bg-danger/10 border border-danger/30 text-danger">{error}</div>}
      <TextField variant="primary" isDisabled={loading}>
        <Label>Position Size per Symbol (USDT)</Label>
        <Input type="text" inputMode="decimal" value={positionSizeUsdt} onChange={(e) => setPositionSizeUsdt(e.target.value)} />
      </TextField>
      <TextField variant="primary" isDisabled={loading}>
        <Label>ADX Threshold</Label>
        <Input type="text" inputMode="numeric" value={adxThreshold} onChange={(e) => setAdxThreshold(e.target.value)} />
      </TextField>
      <div className="grid grid-cols-3 gap-3">
        <TextField variant="primary" isDisabled={loading}>
          <Label>Activation (ATR x)</Label>
          <Input type="text" inputMode="decimal" value={activationAtrMult} onChange={(e) => setActivationAtrMult(e.target.value)} />
        </TextField>
        <TextField variant="primary" isDisabled={loading}>
          <Label>Trail (ATR x)</Label>
          <Input type="text" inputMode="decimal" value={trailingAtrMult} onChange={(e) => setTrailingAtrMult(e.target.value)} />
        </TextField>
        <TextField variant="primary" isDisabled={loading}>
          <Label>Stop (ATR x)</Label>
          <Input type="text" inputMode="decimal" value={initialStopAtrMult} onChange={(e) => setInitialStopAtrMult(e.target.value)} />
        </TextField>
      </div>
      <div className="flex gap-2 justify-end pt-2">
        <Button variant="outline" onPress={onClose} isDisabled={loading}>Cancel</Button>
        <Button type="submit" variant="primary" isDisabled={loading}>
          {loading ? <Spinner size="sm" /> : 'Save'}
        </Button>
      </div>
    </form>
  );
}

// ==========================================
// Main Modal (shell + type switch)
// ==========================================
export function EditBotModal({ item, onClose, onSave }: EditBotModalProps) {
  const botType = item.bot.botType;
  const typeLabel = botType === 'GRID_LONG' ? 'Grid Long' :
    botType === 'GRID_SHORT' ? 'Grid Short' :
    botType === 'DCA' ? 'DCA' :
    botType === 'TRAILING_STOP' ? 'Trailing Stop' :
    botType === 'DCA_SPOT' ? 'DCA Spot' :
    botType === 'SMA_CROSSOVER' ? 'SMA Crossover' : 'Bot';

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center md:justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <Card
        variant="default"
        className="w-full rounded-t-2xl md:rounded-xl md:max-w-md md:mx-4 max-h-[90vh] overflow-y-auto overscroll-contain"
        onClick={(e) => e.stopPropagation()}
      >
        <Card.Content className="p-6 safe-area-pb">
          <div className="md:hidden w-10 h-1 rounded-full bg-default-300 mx-auto mb-4" />
          <h3 className="text-lg font-semibold mb-1">Edit {typeLabel}</h3>
          <p className="text-sm text-default-500 mb-4">{item.bot.symbol}</p>

          {(botType === 'GRID_LONG' || botType === 'GRID_SHORT') && (
            <GridEditForm item={item} onClose={onClose} onSave={onSave} />
          )}
          {(botType === 'DCA' || botType === 'DCA_SPOT') && (
            <DCAEditForm item={item} onClose={onClose} onSave={onSave} />
          )}
          {botType === 'TRAILING_STOP' && (
            <TrailingStopEditForm item={item} onClose={onClose} onSave={onSave} />
          )}
          {botType === 'SMA_CROSSOVER' && (
            <SMAEditForm item={item} onClose={onClose} onSave={onSave} />
          )}
        </Card.Content>
      </Card>
    </div>
  );
}
