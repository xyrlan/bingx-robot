import { NextResponse } from 'next/server';
import { inngest } from '@/inngest/client';
import { requireAuth } from '@/services/auth.service';
import {
  getBotById,
  setBotStatus,
  getGridLevelsByBotId,
  getBingxClient,
  cancelBatchOrders,
  clearGridLevelOrderIds,
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
    const levels = await getGridLevelsByBotId(botId);

    const orderIds: string[] = [];
    for (const level of levels) {
      if (level.orderId?.trim()) orderIds.push(level.orderId.trim());
      if (level.tpOrderId?.trim()) orderIds.push(level.tpOrderId.trim());
    }

    if (orderIds.length > 0) {
      const client = await getBingxClient(user.id);
      if (client) {
        try {
          await cancelBatchOrders(client, symbol, orderIds);
        } catch (cancelErr) {
          console.warn('[BingX] Some orders may already be filled/cancelled:', cancelErr);
        }
      }
      await clearGridLevelOrderIds(botId);
    }

    await setBotStatus(botId, user.id, 'STOPPED');

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
