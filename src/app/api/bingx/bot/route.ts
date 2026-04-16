import { NextResponse } from 'next/server';
import { requireAuth } from '@/services/auth.service';
import {
  getUserBots,
  getUserBotsByApiKey,
  getBotsDetailsBatched,
  getBingxClient,
  getBingxClientByApiKeyId,
  getIncome,
} from '@/services/bingx.service';

function getBotSymbolsFromConfig(bot: { symbol: string | null; botType: string | null; config: unknown }): string[] {
  const primary = String(bot.symbol ?? '').trim().toUpperCase() || 'BTC-USDT';
  if (bot.botType === 'SMA_CROSSOVER' && bot.config && typeof bot.config === 'object') {
    const cfg = bot.config as Record<string, unknown>;
    if (Array.isArray(cfg.symbols) && cfg.symbols.length > 0) {
      return (cfg.symbols as string[]).map((s) => s.trim().toUpperCase());
    }
  }
  return [primary];
}

function formatRuntime(createdAt: Date): string {
  const ms = Date.now() - new Date(createdAt).getTime();
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export async function GET(request: Request) {
  try {
    const user = await requireAuth();
    const { searchParams } = new URL(request.url);
    const details = searchParams.get('details') === 'true';
    const apiKeyId = searchParams.get('apiKeyId');

    const bots = apiKeyId
      ? await getUserBotsByApiKey(user.id, apiKeyId)
      : await getUserBots(user.id);

    if (!details) {
      return NextResponse.json({ bots });
    }

    const runningBots = bots.filter((b) => b.status === 'RUNNING' && b.botType !== 'DCA_SPOT');
    const dcaSpotBots = bots.filter((b) => b.botType === 'DCA_SPOT');
    const stoppedBots = bots.filter((b) => b.status === 'STOPPED' && b.botType !== 'DCA_SPOT');

    const enrichedRunning = await getBotsDetailsBatched(user.id, runningBots);
    const enrichedDcaSpot = dcaSpotBots.map((bot) => ({
      bot,
      runtime: formatRuntime(bot.createdAt),
      orders: [],
      positions: [],
      unrealizedPnl: 0,
      realizedPnl: 0,
    }));

    // Fetch realized P&L for stopped bots (no positions, just income history)
    const enrichedStopped = await Promise.all(
      stoppedBots.map(async (bot) => {
        let realizedPnl = 0;
        try {
          const client = bot.apiKeyId
            ? await getBingxClientByApiKeyId(bot.apiKeyId)
            : await getBingxClient(user.id);
          if (client) {
            const symbols = getBotSymbolsFromConfig(bot);
            for (const sym of symbols) {
              realizedPnl += await getIncome(client, sym, bot.createdAt.getTime(), Date.now());
            }
          }
        } catch {
          // If income fetch fails, show 0
        }
        return {
          bot,
          runtime: formatRuntime(bot.createdAt),
          orders: [],
          positions: [],
          unrealizedPnl: 0,
          realizedPnl,
        };
      })
    );

    const botOrder = new Map(bots.map((b, i) => [b.id, i]));
    const enriched = [...enrichedRunning, ...enrichedDcaSpot, ...enrichedStopped].sort(
      (a, b) => (botOrder.get(a.bot.id) ?? 0) - (botOrder.get(b.bot.id) ?? 0)
    );

    return NextResponse.json({ bots: enriched });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch bots';
    if (message.includes('Authentication required')) {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
