'use client';

import { useEffect, useState } from 'react';
import { Card, Button, Spinner, Accordion, toast } from '@heroui/react';
import { EditBotModal } from './edit-bot-modal';
import { useActiveAccount } from '@/contexts/active-account';

type BotOrderInfo = {
  priceLevel: string;
  type: 'ENTRY' | 'TP';
  orderId: string | null;
  status: 'OPEN' | 'FILLED' | 'CANCELLED' | 'UNKNOWN';
  price?: number;
  stopPrice?: number;
  quantity?: number;
};

type BotPositionInfo = {
  entryPrice: number;
  positionAmt: number;
  positionSide: string;
  unrealizedPnl: number;
  estimatedProfit: number;
  leverage?: number;
};

type BotDetails = {
  bot: {
    id: string;
    symbol: string;
    priceMin: string;
    priceMax: string;
    gridCount: number;
    positionSizeUsdt?: string;
    takeProfitPercentage?: string;
    leverage?: number;
    status: 'STOPPED' | 'RUNNING';
    botType?: 'GRID_LONG' | 'GRID_SHORT' | 'DCA' | 'TRAILING_STOP';
    config?: Record<string, unknown>;
    createdAt: string;
  };
  runtime: string;
  orders: BotOrderInfo[];
  positions: BotPositionInfo[];
  unrealizedPnl: number;
  realizedPnl: number;
};

type StatusFilter = 'ALL' | 'RUNNING' | 'STOPPED';

function formatPnl(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)} USDT`;
}

export function BotsList() {
  const { activeAccountId } = useActiveAccount();
  const [bots, setBots] = useState<BotDetails[]>([]);
  const [loading, setLoading] = useState(false);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const [restartingId, setRestartingId] = useState<string | null>(null);
  const [editingBot, setEditingBot] = useState<BotDetails | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');

  function openEditModal(item: BotDetails) {
    setEditingBot(item);
  }

  function closeEditModal() {
    setEditingBot(null);
  }

  async function handleUpdate(
    botId: string,
    params: {
      positionSizeUsdt: string;
      takeProfitPercentage: string;
      priceMin: string;
      priceMax: string;
      gridCount: number;
    }
  ): Promise<string | null> {
    try {
      const res = await fetch('/api/bingx/bot/edit', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          botId,
          priceMin: params.priceMin,
          priceMax: params.priceMax,
          gridCount: params.gridCount,
          positionSizeUsdt: params.positionSizeUsdt,
          takeProfitPercentage: params.takeProfitPercentage,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        const err = data.error ?? 'Failed to update bot';
        toast.danger(err);
        return err;
      }
      closeEditModal();
      fetchBots();
      toast.success('Bot updated');
      return null;
    } catch {
      const err = 'Network error';
      toast.danger(err);
      return err;
    }
  }

  async function fetchBots(silent = false) {
    if (!silent) setLoading(true);
    try {
      const res = await fetch(`/api/bingx/bot?details=true${activeAccountId ? `&apiKeyId=${activeAccountId}` : ''}`);
      const data = await res.json();
      if (res.ok) {
        setBots(data.bots ?? []);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }

  async function handleStop(botId: string) {
    setStoppingId(botId);
    try {
      const res = await fetch('/api/bingx/bot/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success('Bot stopped');
        fetchBots();
      } else {
        toast.danger(data.error ?? 'Failed to stop bot');
      }
    } catch {
      toast.danger('Network error');
    } finally {
      setStoppingId(null);
    }
  }

  async function handleRestart(botId: string) {
    setRestartingId(botId);
    try {
      const res = await fetch('/api/bingx/bot/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success('Bot restarted');
        fetchBots();
      } else {
        toast.danger(data.error ?? 'Failed to restart bot');
      }
    } catch {
      toast.danger('Network error');
    } finally {
      setRestartingId(null);
    }
  }

  useEffect(() => {
    fetchBots();
  }, [activeAccountId]);

  // Auto-refresh active bots every 30 seconds (silent, no loading spinner)
  const hasRunning = bots.some((b) => b.bot.status === 'RUNNING');
  useEffect(() => {
    if (!hasRunning) return;
    const interval = setInterval(() => fetchBots(true), 30_000);
    return () => clearInterval(interval);
  }, [hasRunning]);

  const filteredBots = statusFilter === 'ALL'
    ? bots
    : bots.filter((b) => b.bot.status === statusFilter);

  const runningCount = bots.filter((b) => b.bot.status === 'RUNNING').length;
  const stoppedCount = bots.filter((b) => b.bot.status === 'STOPPED').length;

  const totalUnrealized = bots.reduce((sum, b) => sum + b.unrealizedPnl, 0);
  const totalRealized = bots.reduce((sum, b) => sum + b.realizedPnl, 0);
  const totalEstimatedProfit = bots.reduce(
    (sum, b) => sum + b.positions.reduce((s, p) => s + p.estimatedProfit, 0),
    0
  );
  const totalPnl = totalUnrealized + totalRealized;

  return (
    <Card variant="default" className="w-full">
      <Card.Content className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Your Bots</h3>
          <Button size="sm" variant="outline" onPress={() => fetchBots()} isDisabled={loading}>
            {loading ? <Spinner size="sm" /> : 'Refresh'}
          </Button>
        </div>

        {/* Status filter */}
        <div className="flex gap-2 mb-4">
          {([
            { key: 'ALL' as StatusFilter, label: `All (${bots.length})` },
            { key: 'RUNNING' as StatusFilter, label: `Running (${runningCount})` },
            { key: 'STOPPED' as StatusFilter, label: `Stopped (${stoppedCount})` },
          ]).map((filter) => (
            <Button
              key={filter.key}
              size="sm"
              variant={statusFilter === filter.key ? 'primary' : 'outline'}
              onPress={() => setStatusFilter(filter.key)}
            >
              {filter.label}
            </Button>
          ))}
        </div>

        {bots.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            {[
              { label: 'Unrealized', value: totalUnrealized },
              { label: 'Realized', value: totalRealized },
              { label: 'Total P&L', value: totalPnl },
              { label: 'Projected Profit', value: totalEstimatedProfit, title: 'Profit if all take-profit orders execute' },
            ].map((stat) => (
              <div key={stat.label} className="bg-default-100 rounded-lg p-3 text-center" title={'title' in stat ? stat.title : undefined}>
                <p className="text-xs text-default-500">{stat.label}</p>
                <p className={`text-sm font-semibold ${stat.value >= 0 ? 'text-success' : 'text-danger'}`}>
                  {formatPnl(stat.value)}
                </p>
              </div>
            ))}
          </div>
        )}

        {loading && bots.length === 0 ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : filteredBots.length === 0 ? (
          <p className="text-sm text-muted py-4 text-center">
            {bots.length === 0 ? 'No bots yet. Create one above!' : 'No bots matching this filter.'}
          </p>
        ) : (
          <Accordion className="w-full" allowsMultipleExpanded variant="surface">
            {filteredBots.map((item) => {
              const { bot, runtime, orders, positions, unrealizedPnl, realizedPnl } = item;
              const exchangeLeverage = positions.find((p) => p.leverage)?.leverage;
              const displayLeverage = exchangeLeverage ?? bot.leverage;

              return (
                <Accordion.Item key={bot.id} id={bot.id}>
                  <Accordion.Heading>
                    <div className="flex flex-wrap items-center justify-between gap-3 py-3 pr-2 w-full">
                      <Accordion.Trigger className="flex-1 min-w-0 text-left">
                        <div>
                          <p className="font-medium">
                            {bot.symbol}
                            {' '}
                            <span className={`text-xs px-2 py-0.5 rounded-full ${
                              bot.botType === 'GRID_LONG' ? 'bg-success/10 text-success' :
                              bot.botType === 'GRID_SHORT' ? 'bg-danger/10 text-danger' :
                              bot.botType === 'DCA' ? 'bg-accent/10 text-accent' :
                              bot.botType === 'TRAILING_STOP' ? 'bg-warning/10 text-warning' :
                              'bg-success/10 text-success'
                            }`}>
                              {bot.botType === 'GRID_LONG' ? 'Grid Long' :
                               bot.botType === 'GRID_SHORT' ? 'Grid Short' :
                               bot.botType === 'DCA' ? 'DCA' :
                               bot.botType === 'TRAILING_STOP' ? 'Trailing Stop' :
                               'Grid Long'}
                            </span>
                            {' '}
                            <span className={`text-xs px-2 py-0.5 rounded-full ${
                              bot.status === 'RUNNING'
                                ? 'bg-success/10 text-success'
                                : 'bg-default-200 text-muted'
                            }`}>
                              {bot.status}
                            </span>
                          </p>
                          <p className="text-sm text-default-500">
                            {Number(bot.priceMin).toFixed(2)} – {Number(bot.priceMax).toFixed(2)} • {bot.gridCount ?? 1} grids
                            {bot.status === 'RUNNING' && runtime && (
                              <span className="ml-2">• Running for {runtime}</span>
                            )}
                          </p>
                          <p className="text-xs text-default-400 mt-0.5">
                            {displayLeverage && `${displayLeverage}x`}
                            {bot.positionSizeUsdt && ` • ${Number(bot.positionSizeUsdt)} USDT/level`}
                            {bot.takeProfitPercentage && ` • ${Number(bot.takeProfitPercentage)}% TP`}
                            {' • '}
                            {new Date(bot.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </p>
                          {(unrealizedPnl !== 0 || realizedPnl !== 0) && (
                            <p className="text-sm mt-1">
                              <span
                                className={
                                  unrealizedPnl >= 0 ? 'text-success' : 'text-danger'
                                }
                              >
                                Unrealized: {formatPnl(unrealizedPnl)}
                              </span>
                              <span className="mx-2 text-default-400">|</span>
                              <span
                                className={
                                  realizedPnl >= 0 ? 'text-success' : 'text-danger'
                                }
                              >
                                Realized: {formatPnl(realizedPnl)}
                              </span>
                              {positions.length > 0 && (() => {
                                const estProfit = positions.reduce((s, p) => s + p.estimatedProfit, 0);
                                return estProfit !== 0 ? (
                                  <>
                                    <span className="mx-2 text-default-400">|</span>
                                    <span className="text-default-500">
                                      Projected Profit: {formatPnl(estProfit)}
                                    </span>
                                  </>
                                ) : null;
                              })()}
                            </p>
                          )}
                          {bot.botType === 'DCA' && bot.config && (
                            <span className="text-xs text-muted">
                              {(bot.config as Record<string, unknown>).ordersPlaced as number ?? 0}/{(bot.config as Record<string, unknown>).totalOrders as number ?? 0} orders
                            </span>
                          )}
                          {bot.botType === 'TRAILING_STOP' && bot.config && (
                            <span className="text-xs text-muted">
                              {(bot.config as Record<string, unknown>).isActivated ? 'Trailing active' : 'Waiting for activation'}
                            </span>
                          )}
                        </div>
                        <Accordion.Indicator />
                      </Accordion.Trigger>
                      <div className="flex items-center gap-2">
                        {bot.status === 'RUNNING' && (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              onPress={() => openEditModal(item)}
                            >
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onPress={() => handleStop(bot.id)}
                              isDisabled={stoppingId === bot.id}
                              className="text-danger border-danger/50 hover:bg-danger/10"
                            >
                              {stoppingId === bot.id ? <Spinner size="sm" /> : 'Stop'}
                            </Button>
                          </>
                        )}
                        {bot.status === 'STOPPED' && (
                          <Button
                            size="sm"
                            variant="outline"
                            onPress={() => handleRestart(bot.id)}
                            isDisabled={restartingId === bot.id}
                            className="text-success border-success/50 hover:bg-success/10"
                          >
                            {restartingId === bot.id ? <Spinner size="sm" /> : 'Restart'}
                          </Button>
                        )}
                      </div>
                    </div>
                  </Accordion.Heading>
                  <Accordion.Panel>
                    <Accordion.Body className="space-y-4">
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                        {[
                          { label: 'Leverage', value: displayLeverage ? `${displayLeverage}x` : '1x' },
                          { label: 'Size/Level', value: bot.positionSizeUsdt ? `${Number(bot.positionSizeUsdt)} USDT` : '—' },
                          { label: 'TP %', value: bot.takeProfitPercentage ? `${Number(bot.takeProfitPercentage)}%` : '—' },
                          { label: 'Created', value: new Date(bot.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) },
                        ].map((item) => (
                          <div key={item.label} className="bg-default-100 rounded-md px-2 py-1.5">
                            <p className="text-xs text-default-500">{item.label}</p>
                            <p className="font-medium">{item.value}</p>
                          </div>
                        ))}
                      </div>

                      {positions.length > 0 && (
                        <div>
                          <p className="text-sm font-medium mb-2">Open Positions</p>
                          <div className="bg-default-50 rounded-lg divide-y divide-default-200">
                            {positions.map((p, i) => (
                              <div key={i} className="px-3 py-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                                <div className="flex items-center gap-2">
                                  <span className={`text-xs px-1.5 py-0.5 rounded ${
                                    p.positionSide === 'LONG' ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'
                                  }`}>
                                    {p.positionSide}
                                  </span>
                                  <span className="text-sm">
                                    Entry {p.entryPrice.toFixed(2)} × {p.positionAmt}
                                  </span>
                                </div>
                                <div className="flex items-center gap-3 text-sm">
                                  <span className={p.unrealizedPnl >= 0 ? 'text-success' : 'text-danger'}>
                                    {formatPnl(p.unrealizedPnl)}
                                  </span>
                                  {p.estimatedProfit !== 0 && (
                                    <span className="text-default-500 text-xs">
                                      Proj. {formatPnl(p.estimatedProfit)}
                                    </span>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {orders.length > 0 && (
                        <div>
                          <p className="text-sm font-medium mb-2">Orders ({orders.filter(o => o.status === 'OPEN').length} open)</p>
                          <div className="bg-default-50 rounded-lg divide-y divide-default-200">
                            {orders.map((o, i) => (
                              <div
                                key={`${o.priceLevel}-${o.type}-${i}`}
                                className="px-3 py-2 flex items-center justify-between"
                              >
                                <div className="flex items-center gap-2">
                                  <span className={`text-xs px-1.5 py-0.5 rounded ${
                                    o.type === 'ENTRY' ? 'bg-primary/10 text-primary' : 'bg-warning/10 text-warning'
                                  }`}>
                                    {o.type}
                                  </span>
                                  <span className="text-sm">
                                    @ {Number(o.priceLevel).toFixed(2)}
                                    {o.quantity != null && (
                                      <span className="text-default-400 ml-1">× {o.quantity}</span>
                                    )}
                                  </span>
                                  {o.stopPrice != null && (
                                    <span className="text-xs text-default-400">
                                      TP: {o.stopPrice.toFixed(2)}
                                    </span>
                                  )}
                                </div>
                                <span className={`text-xs font-medium ${
                                  o.status === 'OPEN' ? 'text-primary' :
                                  o.status === 'FILLED' ? 'text-success' :
                                  'text-default-400'
                                }`}>
                                  {o.status}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {orders.length === 0 && positions.length === 0 && (
                        <p className="text-sm text-default-500">
                          No open orders or positions
                        </p>
                      )}
                    </Accordion.Body>
                  </Accordion.Panel>
                </Accordion.Item>
              );
            })}
          </Accordion>
        )}

        {editingBot && (
          <EditBotModal
            item={editingBot}
            onClose={closeEditModal}
            onSave={handleUpdate}
          />
        )}
      </Card.Content>
    </Card>
  );
}
