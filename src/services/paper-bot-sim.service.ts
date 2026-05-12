import { eq, and } from 'drizzle-orm';
import { paperBots } from '@/db/schema';
import { fetchKlines } from '@/lib/bingx/market-data';
import type { BingxClient } from '@/lib/bingx/client';
import type { Kline } from '@/services/bingx.service';
import type { db as Db } from '@/db';
import type { AiPmEventName, AiPmEventPayload } from '@/lib/ai-pm/events';

export interface PaperBotSimRow {
  id: string;
  symbol: string;
  capitalUsdt: string;
  pnlUsdt: string;
  newPnlUsdt: number;
  drawdownPct: number;
}

export interface TickResult {
  advanced: number;
  bots: PaperBotSimRow[];
}

export interface TickPaperBotsParams {
  db: typeof Db;
  configId: string;
  userId: string;
  allowedSymbols: string[];
  maxDrawdownPct: number;
  fetchKlinesFn?: (client: BingxClient, symbol: string, interval: string, limit: number) => Promise<Kline[]>;
  sendEventFn: (event: { name: AiPmEventName; data: AiPmEventPayload }) => Promise<void> | void;
  bingxClient: BingxClient;
  logger: { info: (msg: string, ctx?: unknown) => void; warn: (msg: string, ctx?: unknown) => void; error: (msg: string, ctx?: unknown) => void };
}

const INTERVAL = '5m';
const CANDLE_LIMIT = 2;

export function computeDrawdownPct(input: { pnlUsdt: string; capitalUsdt: string }): number {
  const pnl = Number(input.pnlUsdt);
  const capital = Number(input.capitalUsdt);
  if (capital === 0) return 0;
  return (pnl / capital) * 100;
}

export async function tickPaperBots(params: TickPaperBotsParams): Promise<TickResult> {
  const fetcher = params.fetchKlinesFn ?? fetchKlines;
  const out: PaperBotSimRow[] = [];

  const bots = await params.db.query.paperBots.findMany({
    where: and(eq(paperBots.userId, params.userId), eq(paperBots.status, 'RUNNING')),
  });

  for (const bot of bots) {
    if (!params.allowedSymbols.includes(bot.symbol)) continue;

    const candles = await fetcher(params.bingxClient, bot.symbol, INTERVAL, CANDLE_LIMIT);
    if (candles.length === 0) continue;

    const lastClose = Number(candles[candles.length - 1].close);
    const botParams = (bot.params as { lastSimPrice?: number } | null) ?? {};
    const lastSimPrice = botParams.lastSimPrice ?? lastClose;
    const capital = Number(bot.capitalUsdt);
    const prevPnl = Number(bot.pnlUsdt ?? 0);
    const pctChange = (lastClose - lastSimPrice) / lastSimPrice;
    const newPnl = prevPnl + capital * pctChange;

    await params.db
      .update(paperBots)
      .set({
        pnlUsdt: String(newPnl.toFixed(8)),
        params: { ...botParams, lastSimPrice: lastClose },
      })
      .where(eq(paperBots.id, bot.id))
      .returning();

    const drawdownPct = computeDrawdownPct({ pnlUsdt: String(newPnl), capitalUsdt: bot.capitalUsdt });
    out.push({
      id: bot.id,
      symbol: bot.symbol,
      capitalUsdt: bot.capitalUsdt,
      pnlUsdt: bot.pnlUsdt ?? '0',
      newPnlUsdt: newPnl,
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
          botKind: 'paper',
          drawdownPct,
          thresholdPct: params.maxDrawdownPct,
          currentPnlUsdt: String(newPnl),
          capitalUsdt: bot.capitalUsdt,
        },
      });
    }
  }

  return { advanced: out.length, bots: out };
}
