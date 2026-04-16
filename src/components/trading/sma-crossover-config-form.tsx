'use client';

import { useState } from 'react';
import { Card, TextField, Input, Label, Button, toast, Spinner } from '@heroui/react';
import { useActiveAccount } from '@/contexts/active-account';

const DEFAULT_SYMBOLS = 'BTC-USDT';

export function SMACrossoverConfigForm() {
  const { activeAccountId } = useActiveAccount();
  const [loading, setLoading] = useState(false);

  // Symbols (comma-separated)
  const [symbolsInput, setSymbolsInput] = useState(DEFAULT_SYMBOLS);

  // Timeframe
  const [timeframe, setTimeframe] = useState('4h');

  // SMA periods
  const [fastPeriod, setFastPeriod] = useState('3');
  const [mediumPeriod, setMediumPeriod] = useState('20');
  const [trendPeriod, setTrendPeriod] = useState('150');

  // ADX filter
  const [adxPeriod, setAdxPeriod] = useState('14');
  const [adxThreshold, setAdxThreshold] = useState('25');

  // ATR trailing stop
  const [atrPeriod, setAtrPeriod] = useState('14');
  const [activationAtrMult, setActivationAtrMult] = useState('3');
  const [trailingAtrMult, setTrailingAtrMult] = useState('1');
  const [initialStopAtrMult, setInitialStopAtrMult] = useState('2');

  // Position sizing
  const [positionSizeUsdt, setPositionSizeUsdt] = useState('50');
  const [leverage, setLeverage] = useState('1');
  const [marginType, setMarginType] = useState('SEPARATE_ISOLATED');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!activeAccountId) return;

    const symbols = symbolsInput
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0);

    if (symbols.length === 0) {
      toast.danger('At least one symbol is required');
      return;
    }

    const fast = Number(fastPeriod);
    const medium = Number(mediumPeriod);
    const trend = Number(trendPeriod);

    if (fast >= medium || medium >= trend) {
      toast.danger('SMA periods must be in ascending order (fast < medium < trend)');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/bingx/bot/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: symbols[0],
          botType: 'SMA_CROSSOVER',
          apiKeyId: activeAccountId,
          config: {
            symbols,
            timeframe,
            fastPeriod: fast,
            mediumPeriod: medium,
            trendPeriod: trend,
            adxPeriod: Number(adxPeriod),
            adxThreshold: Number(adxThreshold),
            atrPeriod: Number(atrPeriod),
            activationAtrMult: Number(activationAtrMult),
            trailingAtrMult: Number(trailingAtrMult),
            initialStopAtrMult: Number(initialStopAtrMult),
            positionSizeUsdt: Number(positionSizeUsdt),
            leverage: Number(leverage),
            marginType,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.danger(data.error ?? 'Failed to start bot');
        return;
      }
      toast.success(`SMA Crossover bot started (ID: ${data.botId})`);
    } catch {
      toast.danger('Network error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card variant="default" className="w-full">
      <Card.Content className="p-6">
        <h3 className="text-lg font-semibold mb-4">SMA Crossover Bot</h3>
        <p className="text-sm text-default-600 mb-4">
          Trades based on SMA crossover signals confirmed by trend direction. Entry when fast SMA crosses medium SMA in trend direction (SMA 150). Exits via trailing stop.
        </p>
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Symbols & Timeframe */}
          <div>
            <h4 className="text-sm font-medium mb-3 text-default-700">Market</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <TextField variant="primary" isDisabled={loading}>
                <Label>Symbols (comma-separated)</Label>
                <Input
                  name="symbols"
                  type="text"
                  value={symbolsInput}
                  onChange={(e) => setSymbolsInput(e.target.value)}
                  placeholder="BTC-USDT, ETH-USDT"
                />
              </TextField>
              <TextField variant="primary" isDisabled={loading}>
                <Label>Timeframe</Label>
                <select
                  name="timeframe"
                  value={timeframe}
                  onChange={(e) => setTimeframe(e.target.value)}
                  className="w-full h-10 rounded-lg border border-default-200 bg-default-100 px-3 text-sm"
                  disabled={loading}
                >
                  <option value="1h">1 Hour</option>
                  <option value="4h">4 Hours</option>
                  <option value="1d">1 Day</option>
                </select>
              </TextField>
            </div>
          </div>

          {/* SMA Periods */}
          <div>
            <h4 className="text-sm font-medium mb-3 text-default-700">SMA Periods</h4>
            <div className="grid grid-cols-3 gap-4">
              <TextField variant="primary" isDisabled={loading}>
                <Label>Fast</Label>
                <Input
                  name="fastPeriod"
                  type="text"
                  inputMode="numeric"
                  value={fastPeriod}
                  onChange={(e) => setFastPeriod(e.target.value)}
                  placeholder="3"
                />
              </TextField>
              <TextField variant="primary" isDisabled={loading}>
                <Label>Medium</Label>
                <Input
                  name="mediumPeriod"
                  type="text"
                  inputMode="numeric"
                  value={mediumPeriod}
                  onChange={(e) => setMediumPeriod(e.target.value)}
                  placeholder="20"
                />
              </TextField>
              <TextField variant="primary" isDisabled={loading}>
                <Label>Trend</Label>
                <Input
                  name="trendPeriod"
                  type="text"
                  inputMode="numeric"
                  value={trendPeriod}
                  onChange={(e) => setTrendPeriod(e.target.value)}
                  placeholder="150"
                />
              </TextField>
            </div>
          </div>

          {/* ADX Filter */}
          <div>
            <h4 className="text-sm font-medium mb-3 text-default-700">ADX Filter</h4>
            <p className="text-xs text-default-500 mb-3">Blocks entries when market is not trending (ADX below threshold)</p>
            <div className="grid grid-cols-2 gap-4">
              <TextField variant="primary" isDisabled={loading}>
                <Label>ADX Period</Label>
                <Input
                  name="adxPeriod"
                  type="text"
                  inputMode="numeric"
                  value={adxPeriod}
                  onChange={(e) => setAdxPeriod(e.target.value)}
                  placeholder="14"
                />
              </TextField>
              <TextField variant="primary" isDisabled={loading}>
                <Label>ADX Threshold</Label>
                <Input
                  name="adxThreshold"
                  type="text"
                  inputMode="numeric"
                  value={adxThreshold}
                  onChange={(e) => setAdxThreshold(e.target.value)}
                  placeholder="25"
                />
              </TextField>
            </div>
          </div>

          {/* ATR Trailing Stop */}
          <div>
            <h4 className="text-sm font-medium mb-3 text-default-700">ATR Trailing Stop</h4>
            <p className="text-xs text-default-500 mb-3">Volatility-adaptive stop distances using ATR multipliers</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <TextField variant="primary" isDisabled={loading}>
                <Label>ATR Period</Label>
                <Input
                  name="atrPeriod"
                  type="text"
                  inputMode="numeric"
                  value={atrPeriod}
                  onChange={(e) => setAtrPeriod(e.target.value)}
                  placeholder="14"
                />
              </TextField>
              <TextField variant="primary" isDisabled={loading}>
                <Label>Activation (ATR x)</Label>
                <Input
                  name="activationAtrMult"
                  type="text"
                  inputMode="decimal"
                  value={activationAtrMult}
                  onChange={(e) => setActivationAtrMult(e.target.value)}
                  placeholder="3"
                />
              </TextField>
              <TextField variant="primary" isDisabled={loading}>
                <Label>Trail (ATR x)</Label>
                <Input
                  name="trailingAtrMult"
                  type="text"
                  inputMode="decimal"
                  value={trailingAtrMult}
                  onChange={(e) => setTrailingAtrMult(e.target.value)}
                  placeholder="1"
                />
              </TextField>
              <TextField variant="primary" isDisabled={loading}>
                <Label>Initial Stop (ATR x)</Label>
                <Input
                  name="initialStopAtrMult"
                  type="text"
                  inputMode="decimal"
                  value={initialStopAtrMult}
                  onChange={(e) => setInitialStopAtrMult(e.target.value)}
                  placeholder="2"
                />
              </TextField>
            </div>
          </div>

          {/* Position Sizing */}
          <div>
            <h4 className="text-sm font-medium mb-3 text-default-700">Position</h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <TextField variant="primary" isDisabled={loading}>
                <Label>Size per Symbol (USDT)</Label>
                <Input
                  name="positionSizeUsdt"
                  type="text"
                  inputMode="decimal"
                  value={positionSizeUsdt}
                  onChange={(e) => setPositionSizeUsdt(e.target.value)}
                  placeholder="50"
                />
              </TextField>
              <TextField variant="primary" isDisabled={loading}>
                <Label>Leverage</Label>
                <Input
                  name="leverage"
                  type="text"
                  inputMode="numeric"
                  value={leverage}
                  onChange={(e) => setLeverage(e.target.value)}
                  placeholder="1"
                />
              </TextField>
              <TextField variant="primary" isDisabled={loading}>
                <Label>Margin Type</Label>
                <select
                  name="marginType"
                  value={marginType}
                  onChange={(e) => setMarginType(e.target.value)}
                  className="w-full h-10 rounded-lg border border-default-200 bg-default-100 px-3 text-sm"
                  disabled={loading}
                >
                  <option value="SEPARATE_ISOLATED">Separate Isolated</option>
                  <option value="ISOLATED">Isolated</option>
                  <option value="CROSSED">Cross</option>
                </select>
              </TextField>
            </div>
          </div>

          <Button
            type="submit"
            variant="primary"
            isDisabled={loading || !activeAccountId}
            className="w-full sm:w-auto"
          >
            {loading ? <Spinner size="sm" /> : 'Start SMA Crossover Bot'}
          </Button>
        </form>
      </Card.Content>
    </Card>
  );
}
