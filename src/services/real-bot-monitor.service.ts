import { and, eq } from 'drizzle-orm';
import { tradingBots } from '@/db/schema';
import { getAllOpenPositions, type OpenPosition } from '@/services/bingx.service';
import { computeDrawdownPct } from '@/services/paper-bot-sim.service';
import type { BingxClient } from '@/lib/bingx/client';
import type { db as Db } from '@/db';
import type { AiPmEventName, AiPmEventPayload } from '@/lib/ai-pm/events';

const NON_GRID_BOT_TYPES = ['DCA', 'DCA_SPOT', 'TRAILING_STOP', 'SMA_CROSSOVER'];

export interface RealBotMonitorRow {
  id: string;
  symbol: string;
  capitalUsdt: string;
  unrealizedPnlUsdt: number;
  drawdownPct: number;
}

export interface RealTickResult {
  advanced: number;
  bots: RealBotMonitorRow[];
}

export interface TickRealBotsParams {
  db: typeof Db;
  configId: string;
  userId: string;
  bingxApiKeyId: string;
  allowedSymbols: string[];
  maxDrawdownPct: number;
  bingxClient: BingxClient;
  fetchPositionsFn?: (client: BingxClient) => Promise<OpenPosition[]>;
  sendEventFn: (event: { name: AiPmEventName; data: AiPmEventPayload }) => Promise<void> | void;
  logger: { info: (msg: string, ctx?: unknown) => void; warn: (msg: string, ctx?: unknown) => void; error: (msg: string, ctx?: unknown) => void };
}

function normalizeSymbol(s: string): string {
  return s.toUpperCase().replace(/\s/g, '');
}

export async function tickRealBots(params: TickRealBotsParams): Promise<RealTickResult> {
  const fetchPositions = params.fetchPositionsFn ?? getAllOpenPositions;
  const out: RealBotMonitorRow[] = [];

  const bots = await params.db
    .select()
    .from(tradingBots)
    .where(
      and(
        eq(tradingBots.userId, params.userId),
        eq(tradingBots.apiKeyId, params.bingxApiKeyId),
        eq(tradingBots.status, 'RUNNING'),
      ),
    );

  const scoped = bots.filter(
    (b) => NON_GRID_BOT_TYPES.includes(b.botType) && params.allowedSymbols.includes(b.symbol),
  );
  if (scoped.length === 0) return { advanced: 0, bots: [] };

  let positions: OpenPosition[];
  try {
    positions = await fetchPositions(params.bingxClient);
  } catch (err) {
    params.logger.warn('real_positions_fetch_failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return { advanced: 0, bots: [] };
  }

  for (const bot of scoped) {
    const sym = normalizeSymbol(bot.symbol);
    const pnl = positions
      .filter((p) => normalizeSymbol(p.symbol) === sym)
      .reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0);

    const drawdownPct = computeDrawdownPct({
      pnlUsdt: String(pnl),
      capitalUsdt: bot.positionSizeUsdt,
    });

    out.push({
      id: bot.id,
      symbol: bot.symbol,
      capitalUsdt: bot.positionSizeUsdt,
      unrealizedPnlUsdt: pnl,
      drawdownPct,
    });

    if (drawdownPct < -params.maxDrawdownPct) {
      await params.sendEventFn({
        name: 'ai-pm/event.drawdown',
        data: {
          configId: params.configId,
          emittedAt: new Date().toISOString(),
          symbol: bot.symbol,
          botId: bot.id,
          botKind: 'real',
          drawdownPct,
          thresholdPct: params.maxDrawdownPct,
          currentPnlUsdt: String(pnl),
          capitalUsdt: bot.positionSizeUsdt,
        },
      });
    }
  }

  return { advanced: out.length, bots: out };
}
