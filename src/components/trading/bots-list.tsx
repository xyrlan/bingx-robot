'use client';

import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { useQueryState } from 'nuqs';
import { useTranslations } from 'next-intl';
import { Card, Button, Spinner, Accordion, toast } from '@heroui/react';
import { EditBotModal } from './edit-bot-modal';
import { useActiveAccount } from '@/contexts/active-account';
import { formatPnl } from '@/lib/format-pnl';
import { STAT_WINDOW_KEYS, type BotStats, type StatWindowKey } from '@/lib/bot-stats-types';
import { BotStatsSection } from './bot-stat-card';
import { AggregateTiles } from './bots-stats/aggregate-tiles';
import { PeriodSelector } from './bots-stats/period-selector';

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
    botType?: 'GRID_LONG' | 'GRID_SHORT' | 'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER';
    config?: Record<string, unknown>;
    createdAt: string;
  };
  runtime: string;
  orders: BotOrderInfo[];
  positions: BotPositionInfo[];
  unrealizedPnl: number;
  realizedPnl: number;
};

const statsFetcher = (url: string) => fetch(url).then((res) => res.json());

function isWindowKey(value: string): value is StatWindowKey {
  return (STAT_WINDOW_KEYS as readonly string[]).includes(value);
}

export function BotsList() {
  const { activeAccountId } = useActiveAccount();
  const t = useTranslations('Bots');
  const [bots, setBots] = useState<BotDetails[]>([]);
  const [loading, setLoading] = useState(false);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const [restartingId, setRestartingId] = useState<string | null>(null);
  const [editingBot, setEditingBot] = useState<BotDetails | null>(null);

  const [periodRaw, setPeriod] = useQueryState('period', { defaultValue: '30d' });
  const period: StatWindowKey = isWindowKey(periodRaw) ? periodRaw : '30d';

  const { data: statsData, isLoading: statsLoading } = useSWR<{ stats: BotStats[] }>(
    activeAccountId ? `/api/bingx/bot/stats?apiKeyId=${activeAccountId}` : null,
    statsFetcher,
    { refreshInterval: 60_000 }
  );
  const statsByBot = new Map<string, BotStats>(
    (statsData?.stats ?? []).map((s) => [s.botId, s])
  );

  function openEditModal(item: BotDetails) {
    setEditingBot(item);
  }

  function closeEditModal() {
    setEditingBot(null);
  }

  async function handleUpdate(
    botId: string,
    params: {
      positionSizeUsdt?: string;
      takeProfitPercentage?: string;
      priceMin?: string;
      priceMax?: string;
      gridCount?: number;
      config?: Record<string, unknown>;
    }
  ): Promise<string | null> {
    try {
      const res = await fetch('/api/bingx/bot/edit', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId, ...params }),
      });
      const data = await res.json();
      if (!res.ok) {
        const err = data.error ?? 'Failed to update bot';
        toast.danger(err);
        return err;
      }
      closeEditModal();
      fetchBots();
      toast.success(t('botUpdated'));
      return null;
    } catch {
      const err = t('networkError');
      toast.danger(err);
      return err;
    }
  }

  async function fetchBots(silent = false) {
    if (!activeAccountId) {
      setBots([]);
      if (!silent) setLoading(false);
      return;
    }
    if (!silent) setLoading(true);
    try {
      const res = await fetch(`/api/bingx/bot?details=true&apiKeyId=${activeAccountId}`);
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
        toast.success(t('botStopped'));
        fetchBots();
      } else {
        toast.danger(data.error ?? 'Failed to stop bot');
      }
    } catch {
      toast.danger(t('networkError'));
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
        toast.success(t('botRestarted'));
        fetchBots();
      } else {
        toast.danger(data.error ?? 'Failed to restart bot');
      }
    } catch {
      toast.danger(t('networkError'));
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

  const runningBots = bots.filter((b) => b.bot.status === 'RUNNING');
  const stoppedBots = bots.filter((b) => b.bot.status === 'STOPPED');

  const totalUnrealized = runningBots.reduce((sum, b) => sum + b.unrealizedPnl, 0);
  const totalEstimatedProfit = runningBots.reduce(
    (sum, b) => sum + b.positions.reduce((s, p) => s + p.estimatedProfit, 0),
    0
  );

  function allocatedCapital(bot: BotDetails['bot']): number {
    return Number(bot.positionSizeUsdt ?? 0) * (bot.gridCount || 1);
  }

  function renderBotItem(item: BotDetails) {
              const { bot, runtime, orders, positions, unrealizedPnl } = item;
              const exchangeLeverage = positions.find((p) => p.leverage)?.leverage;
              const displayLeverage = exchangeLeverage ?? bot.leverage;

              return (
                <Accordion.Item key={bot.id} id={bot.id}>
                  <Accordion.Heading>
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 py-3 pr-2 w-full">
                      <Accordion.Trigger className="flex-1 min-w-0 text-left">
                        <div className="space-y-1">
                          <p className="font-medium flex flex-wrap items-center gap-1.5">
                            <span>{bot.symbol}</span>
                            <span className={`text-xs px-2 py-0.5 rounded-full ${
                              bot.botType === 'GRID_LONG' ? 'bg-success/10 text-success' :
                              bot.botType === 'GRID_SHORT' ? 'bg-danger/10 text-danger' :
                              bot.botType === 'DCA' ? 'bg-accent/10 text-accent' :
                              bot.botType === 'TRAILING_STOP' ? 'bg-warning/10 text-warning' :
                              bot.botType === 'DCA_SPOT' ? 'bg-primary/10 text-primary' :
                              bot.botType === 'SMA_CROSSOVER' ? 'bg-secondary/10 text-secondary' :
                              'bg-success/10 text-success'
                            }`}>
                              {bot.botType === 'GRID_LONG' ? 'Grid Long' :
                               bot.botType === 'GRID_SHORT' ? 'Grid Short' :
                               bot.botType === 'DCA' ? 'DCA' :
                               bot.botType === 'TRAILING_STOP' ? 'Trailing Stop' :
                               bot.botType === 'DCA_SPOT' ? 'DCA Spot' :
                               bot.botType === 'SMA_CROSSOVER' ? 'SMA Crossover' :
                               'Grid Long'}
                            </span>
                            <span className={`text-xs px-2 py-0.5 rounded-full ${
                              bot.status === 'RUNNING'
                                ? 'bg-success/10 text-success'
                                : 'bg-default-200 text-muted'
                            }`}>
                              {bot.status === 'RUNNING' ? t('running').toUpperCase() : t('stopped').toUpperCase()}
                            </span>
                          </p>
                          {bot.botType !== 'SMA_CROSSOVER' && (
                          <p className="text-sm text-default-500 font-numeric">
                            {Number(bot.priceMin).toFixed(2)} – {Number(bot.priceMax).toFixed(2)} • {bot.gridCount ?? 1} {t('grids')}
                          </p>
                          )}
                          <p className="text-xs text-default-400">
                            {displayLeverage && `${displayLeverage}x`}
                            {bot.positionSizeUsdt && ` • ${Number(bot.positionSizeUsdt)} USDT/level`}
                            {bot.takeProfitPercentage && ` • ${Number(bot.takeProfitPercentage)}% TP`}
                            {' • '}
                            {new Date(bot.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </p>
                          {bot.status === 'RUNNING' && runtime && (
                            <p className="text-xs text-default-400">{t('runningFor', { runtime })}</p>
                          )}
                          {(unrealizedPnl !== 0 || positions.length > 0) && (
                            <div className="flex flex-col gap-0.5 sm:flex-row sm:flex-wrap sm:gap-x-3 sm:gap-y-0.5 text-sm mt-0.5">
                              <span
                                className={`font-numeric ${
                                  unrealizedPnl >= 0 ? 'text-success' : 'text-danger'
                                }`}
                              >
                                {t('stats.unrealized')}: {formatPnl(unrealizedPnl)}
                              </span>
                              {positions.length > 0 && (() => {
                                const estProfit = positions.reduce((s, p) => s + p.estimatedProfit, 0);
                                return estProfit !== 0 ? (
                                  <span className="text-default-500 font-numeric">
                                    {t('stats.projected')}: {formatPnl(estProfit)}
                                  </span>
                                ) : null;
                              })()}
                            </div>
                          )}
                          {bot.botType === 'DCA' && bot.config && (
                            <span className="text-xs text-muted">
                              {(bot.config as Record<string, unknown>).ordersPlaced as number ?? 0}/{(bot.config as Record<string, unknown>).totalOrders as number ?? 0} orders
                            </span>
                          )}
                          {bot.botType === 'DCA_SPOT' && bot.config && (
                            <span className="text-xs text-muted">
                              {(bot.config as Record<string, unknown>).ordersPlaced as number ?? 0}/{(bot.config as Record<string, unknown>).totalOrders as number ?? 0} orders (spot)
                            </span>
                          )}
                          {bot.botType === 'TRAILING_STOP' && bot.config && (
                            <span className="text-xs text-muted">
                              {(bot.config as Record<string, unknown>).isActivated ? 'Trailing active' : 'Waiting for activation'}
                            </span>
                          )}
                          {bot.botType === 'SMA_CROSSOVER' && bot.config && (() => {
                            const cfg = bot.config as Record<string, unknown>;
                            const symbols = (cfg.symbols as string[]) ?? [];
                            const states = (cfg.symbolStates as Record<string, Record<string, unknown>>) ?? {};
                            const activePositions = Object.values(states).filter((s) => s.position != null).length;
                            return (
                              <span className="text-xs text-muted">
                                SMA {String(cfg.fastPeriod ?? 3)}/{String(cfg.mediumPeriod ?? 20)}/{String(cfg.trendPeriod ?? 150)} • {String(cfg.timeframe ?? '4h')} • ADX&gt;{String(cfg.adxThreshold ?? 25)} • {symbols.length} symbols • {activePositions} active
                              </span>
                            );
                          })()}
                          <BotStatsSection
                            stats={statsByBot.get(bot.id)}
                            statsLoading={statsLoading}
                            period={period}
                            allocatedUsdt={allocatedCapital(bot)}
                          />
                        </div>
                        <Accordion.Indicator />
                      </Accordion.Trigger>
                      <div className="flex items-center gap-2 self-start sm:self-auto shrink-0">
                        {bot.status === 'RUNNING' && (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              className="touch-target"
                              onPress={() => openEditModal(item)}
                            >
                              {t('edit')}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onPress={() => handleStop(bot.id)}
                              isDisabled={stoppingId === bot.id}
                              className="text-danger border-danger/50 hover:bg-danger/10 touch-target"
                            >
                              {stoppingId === bot.id ? <Spinner size="sm" /> : t('stop')}
                            </Button>
                          </>
                        )}
                        {bot.status === 'STOPPED' && (
                          <Button
                            size="sm"
                            variant="outline"
                            onPress={() => handleRestart(bot.id)}
                            isDisabled={restartingId === bot.id}
                            className="text-success border-success/50 hover:bg-success/10 touch-target"
                          >
                            {restartingId === bot.id ? <Spinner size="sm" /> : t('restart')}
                          </Button>
                        )}
                      </div>
                    </div>
                  </Accordion.Heading>
                  <Accordion.Panel>
                    <Accordion.Body className="space-y-3">
                      {/* Positions — compact display with USDT value */}
                      {positions.length > 0 && (
                        <div className="bg-default-50 rounded-lg divide-y divide-default-200">
                          {positions.map((p, i) => {
                            const usdtValue = p.entryPrice * p.positionAmt;
                            return (
                              <div key={i} className="px-3 py-2 flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${
                                    p.positionSide === 'LONG' ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'
                                  }`}>
                                    {p.positionSide}
                                  </span>
                                  <span className="text-sm font-numeric truncate">
                                    {p.entryPrice.toFixed(2)}
                                  </span>
                                  <span className="text-xs text-default-400 font-numeric shrink-0">
                                    {usdtValue.toFixed(2)} USDT
                                  </span>
                                </div>
                                <span className={`text-sm font-numeric shrink-0 ${p.unrealizedPnl >= 0 ? 'text-success' : 'text-danger'}`}>
                                  {formatPnl(p.unrealizedPnl)}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Orders — compact summary instead of individual rows */}
                      {orders.length > 0 && (() => {
                        const openEntries = orders.filter(o => o.type === 'ENTRY' && o.status === 'OPEN');
                        const filledEntries = orders.filter(o => o.type === 'ENTRY' && o.status === 'FILLED');
                        const openTPs = orders.filter(o => o.type === 'TP' && o.status === 'OPEN');
                        const filledTPs = orders.filter(o => o.type === 'TP' && o.status === 'FILLED');
                        const entryPrices = openEntries.map(o => Number(o.priceLevel));
                        const minEntry = entryPrices.length > 0 ? Math.min(...entryPrices) : null;
                        const maxEntry = entryPrices.length > 0 ? Math.max(...entryPrices) : null;

                        return (
                          <div className="bg-default-50 rounded-lg p-3 space-y-2 text-sm">
                            <div className="flex items-center justify-between">
                              <span className="text-default-500">{t('entryOrders')}</span>
                              <span className="font-numeric">
                                <span className="text-primary">{openEntries.length} {t('open')}</span>
                                {filledEntries.length > 0 && (
                                  <span className="text-success ml-2">{filledEntries.length} {t('filled')}</span>
                                )}
                              </span>
                            </div>
                            {minEntry != null && maxEntry != null && (
                              <div className="text-xs text-default-400 font-numeric">
                                {t('range')}: {minEntry.toFixed(2)} – {maxEntry.toFixed(2)}
                              </div>
                            )}
                            <div className="flex items-center justify-between">
                              <span className="text-default-500">{t('tpOrders')}</span>
                              <span className="font-numeric">
                                <span className="text-warning">{openTPs.length} {t('open')}</span>
                                {filledTPs.length > 0 && (
                                  <span className="text-success ml-2">{filledTPs.length} {t('filled')}</span>
                                )}
                              </span>
                            </div>
                          </div>
                        );
                      })()}

                      {orders.length === 0 && positions.length === 0 && (
                        <p className="text-sm text-default-500 text-center py-2">
                          {t('noOrdersPositions')}
                        </p>
                      )}
                    </Accordion.Body>
                  </Accordion.Panel>
                </Accordion.Item>
              );
  }

  return (
    <div className="space-y-6">
      {/* Running Bots Section */}
      <Card variant="default" className="w-full">
        <Card.Content className="p-4 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-success animate-pulse" />
              <h3 className="text-lg font-semibold">{t('running')}</h3>
              <span className="text-sm text-muted font-numeric">({runningBots.length})</span>
            </div>
            <div className="flex items-center gap-2">
              <PeriodSelector value={period} onChange={setPeriod} />
              <Button size="sm" variant="outline" onPress={() => fetchBots()} isDisabled={loading}>
                {loading ? <Spinner size="sm" /> : t('refresh')}
              </Button>
            </div>
          </div>

          {runningBots.length > 0 && (
            <AggregateTiles
              stats={runningBots.map((b) => statsByBot.get(b.bot.id))}
              period={period}
              totalUnrealized={totalUnrealized}
              totalProjected={totalEstimatedProfit}
            />
          )}

          {loading && bots.length === 0 ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : runningBots.length === 0 ? (
            <p className="text-sm text-muted py-4 text-center">
              {bots.length === 0 ? t('noBots') : t('noRunning')}
            </p>
          ) : (
            <Accordion className="w-full" allowsMultipleExpanded variant="surface">
              {runningBots.map(renderBotItem)}
            </Accordion>
          )}
        </Card.Content>
      </Card>

      {/* Stopped Bots Section */}
      {(stoppedBots.length > 0 || bots.length > 0) && (
        <Card variant="default" className="w-full">
          <Card.Content className="p-4 sm:p-6">
            <div className="flex items-center gap-2 mb-4">
              <span className="h-2.5 w-2.5 rounded-full bg-default-300" />
              <h3 className="text-lg font-semibold text-muted">{t('stopped')}</h3>
              <span className="text-sm text-muted font-numeric">({stoppedBots.length})</span>
            </div>

            {stoppedBots.length === 0 ? (
              <p className="text-sm text-muted py-4 text-center">
                {t('noStopped')}
              </p>
            ) : (
              <Accordion className="w-full" allowsMultipleExpanded variant="surface">
                {stoppedBots.map(renderBotItem)}
              </Accordion>
            )}
          </Card.Content>
        </Card>
      )}

      {editingBot && (
        <EditBotModal
          item={editingBot}
          onClose={closeEditModal}
          onSave={handleUpdate}
        />
      )}
    </div>
  );
}
