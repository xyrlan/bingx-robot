import { NextResponse } from 'next/server';
import { inngest } from '@/inngest/client';
import { requireAuth } from '@/services/auth.service';
import {
  getBotById,
  setBotStatus,
  getBingxClient,
  getBingxClientByApiKeyId,
  stopBotAndCancelEntries,
} from '@/services/bingx.service';

export async function POST(request: Request) {
  try {
    const user = await requireAuth();
    const body = await request.json();
    const { botId } = body as { botId?: string };

    if (!botId || typeof botId !== 'string') {
      return NextResponse.json({ error: 'botId is required' }, { status: 400 });
    }

    const bot = await getBotById(botId, user.id);
    if (!bot) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 });
    }

    const symbol = String(bot.symbol ?? '').trim().toUpperCase() || 'BTC-USDT';

    await setBotStatus(botId, user.id, 'STOPPED');

    const client = bot.apiKeyId
      ? await getBingxClientByApiKeyId(bot.apiKeyId)
      : await getBingxClient(user.id);
    if (client && bot.botType !== 'DCA_SPOT' && bot.botType !== 'DCA') {
      try {
        await stopBotAndCancelEntries(client, botId, symbol);
      } catch (cancelErr) {
        console.warn('[BingX] Some orders may already be filled/cancelled:', cancelErr);
      }
    }

    await inngest.send({
      name: 'trading/bot.stop',
      data: { userId: user.id, botId },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to stop bot';
    if (message.includes('Authentication required')) {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
