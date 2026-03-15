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

                    {positions.length > 0 && (
                        <div>
                          <p className="text-sm font-medium mb-2">Positions</p>
                          <div className="space-y-1 text-sm">
                            {positions.map((p, i) => (
                              <div
                                key={i}
                                className="flex justify-between items-center py-1"
                              >
                                <span>
                                  Entry {p.entryPrice.toFixed(2)} × {p.positionAmt}
                                </span>
                                <span
                                  className={
                                    p.unrealizedPnl >= 0 ? 'text-success' : 'text-danger'
                                  }
                                >
                               {formatPnl(p.unrealizedPnl)}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {orders.length > 0 && (
                        <div>
                          <p className="text-sm font-medium mb-2">Orders</p>
                          <div className="space-y-1 text-sm">
                            {orders.map((o, i) => (
                              <div
                                key={`${o.priceLevel}-${o.type}-${i}`}
                                className="flex justify-between items-center py-1"
                              >
                                <span>
                                  {o.type} @ {Number(o.priceLevel).toFixed(2)}
                                  {o.stopPrice != null && ` (TP: ${o.stopPrice.toFixed(2)})`}
                                </span>
                                <span
                                  className={
                                    o.status === 'OPEN'
                                      ? 'text-primary'
                                      : o.status === 'FILLED'
                                        ? 'text-success'
                                        : 'text-default-400'
                                  }
                                >
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
