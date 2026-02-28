import { NextResponse } from 'next/server';
import { inngest } from '@/inngest/client';
import { requireAuth } from '@/services/auth.service';
import {
  hasBingxKeys,
  createBot,
  getBotById,
  setBotStatus,
  getUserBots,
} from '@/services/bingx.service';

export async function POST(request: Request) {
  try {
    const user = await requireAuth();
    const body = await request.json();
    const { botId, symbol, priceMin, priceMax } = body as {
      botId?: string;
      symbol?: string;
      priceMin?: string | number;
      priceMax?: string | number;
    };

    if (!(await hasBingxKeys(user.id))) {
      return NextResponse.json(
        { error: 'BingX API keys not configured. Connect your keys first.' },
        { status: 400 }
      );
    }

    const priceMinStr = String(priceMin ?? '').trim();
    const priceMaxStr = String(priceMax ?? '').trim();
    const symbolStr = String(symbol ?? '').trim();

    if (!symbolStr || !priceMinStr || !priceMaxStr) {
      return NextResponse.json(
        { error: 'symbol, priceMin, and priceMax are required' },
        { status: 400 }
      );
    }

    const min = parseFloat(priceMinStr);
    const max = parseFloat(priceMaxStr);
    if (isNaN(min) || isNaN(max) || min >= max) {
      return NextResponse.json(
        { error: 'priceMin must be less than priceMax' },
        { status: 400 }
      );
    }

    let bot;
    if (botId) {
      bot = await getBotById(botId, user.id);
      if (!bot) {
        return NextResponse.json({ error: 'Bot not found' }, { status: 404 });
      }
      await setBotStatus(botId, user.id, 'RUNNING');
    } else {
      const existing = await getUserBots(user.id);
      const match = existing.find(
        (b) =>
          b.symbol === symbolStr &&
          String(b.priceMin) === priceMinStr &&
          String(b.priceMax) === priceMaxStr &&
          b.status === 'STOPPED'
      );
      if (match) {
        await setBotStatus(match.id, user.id, 'RUNNING');
        bot = match;
      } else {
        bot = await createBot(user.id, {
          symbol: symbolStr,
          priceMin: priceMinStr,
          priceMax: priceMaxStr,
        });
        await setBotStatus(bot.id, user.id, 'RUNNING');
      }
    }

    await inngest.send({
      name: 'trading/bot.start',
      data: { userId: user.id, botId: bot.id },
    });

    return NextResponse.json({ success: true, botId: bot.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to start bot';
    if (message.includes('Authentication required')) {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
