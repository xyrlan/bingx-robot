import { NextResponse } from 'next/server';
import { requireAuth } from '@/services/auth.service';
import { getBotById, editActiveBot } from '@/services/bingx.service';

export async function PATCH(request: Request) {
  try {
    const user = await requireAuth();
    const body = await request.json();
    const {
      botId,
      priceMin,
      priceMax,
      positionSizeUsdt,
      takeProfitPercentage,
      gridCount,
    } = body as {
      botId?: string;
      priceMin?: string | number;
      priceMax?: string | number;
      positionSizeUsdt?: string | number;
      takeProfitPercentage?: string | number;
      gridCount?: number;
    };

    if (!botId || typeof botId !== 'string') {
      return NextResponse.json({ error: 'botId is required' }, { status: 400 });
    }

    const bot = await getBotById(botId, user.id);
    if (!bot) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 });
    }

    if (bot.status !== 'RUNNING') {
      return NextResponse.json(
        { error: 'Bot must be RUNNING to edit. Stop the bot first or start it.' },
        { status: 400 }
      );
    }

    const priceMinStr = String(priceMin ?? bot.priceMin ?? '').trim();
    const priceMaxStr = String(priceMax ?? bot.priceMax ?? '').trim();
    const positionSizeStr = String(positionSizeUsdt ?? bot.positionSizeUsdt ?? '').trim();
    const takeProfitStr = String(takeProfitPercentage ?? bot.takeProfitPercentage ?? '').trim();
    const gridCountNum = Math.floor(Number(gridCount ?? bot.gridCount ?? 1));

    if (!priceMinStr || !priceMaxStr || !positionSizeStr || !takeProfitStr) {
      return NextResponse.json(
        {
          error: 'priceMin, priceMax, positionSizeUsdt, and takeProfitPercentage are required',
        },
        { status: 400 }
      );
    }

    const min = parseFloat(priceMinStr);
    const max = parseFloat(priceMaxStr);
    const posSize = parseFloat(positionSizeStr);
    const tpPct = parseFloat(takeProfitStr);

    if (isNaN(min) || isNaN(max) || min >= max) {
      return NextResponse.json(
        { error: 'priceMin must be less than priceMax' },
        { status: 400 }
      );
    }
    if (isNaN(posSize) || posSize <= 0) {
      return NextResponse.json(
        { error: 'positionSizeUsdt must be a positive number' },
        { status: 400 }
      );
    }
    if (isNaN(tpPct) || tpPct <= 0 || tpPct > 100) {
      return NextResponse.json(
        { error: 'takeProfitPercentage must be between 0 and 100' },
        { status: 400 }
      );
    }
    if (gridCountNum < 1 || gridCountNum > 100) {
      return NextResponse.json(
        { error: 'gridCount must be between 1 and 100' },
        { status: 400 }
      );
    }

    await editActiveBot(user.id, botId, {
      priceMin: priceMinStr,
      priceMax: priceMaxStr,
      gridCount: gridCountNum,
      positionSizeUsdt: positionSizeStr,
      takeProfitPercentage: takeProfitStr,
    });

    return NextResponse.json({ success: true, botId });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to edit bot';
    if (message.includes('Authentication required')) {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
