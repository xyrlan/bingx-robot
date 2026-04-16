import { NextResponse } from 'next/server';
import { requireAuth } from '@/services/auth.service';
import { getUserBots, getUserBotsByApiKey, getBotsDetailsBatched } from '@/services/bingx.service';

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

    // Stopped bots: return instantly with zero P&L.
    // Use /api/bingx/bot/[botId]/details to fetch realized P&L on demand.
    const enrichedStopped = stoppedBots.map((bot) => ({
      bot,
      runtime: formatRuntime(bot.createdAt),
      orders: [],
      positions: [],
      unrealizedPnl: 0,
      realizedPnl: 0,
    }));

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
