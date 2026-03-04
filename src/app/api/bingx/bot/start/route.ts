import { NextResponse } from 'next/server';
import { inngest } from '@/inngest/client';
import { requireAuth } from '@/services/auth.service';
import {
  hasBingxKeys,
  getBingxClient,
  createBot,
  getBotById,
  setBotStatus,
} from '@/services/bingx.service';
import { getAvailableMargin } from '@/lib/balance';

const SYMBOL = 'BTC-USDT';

export async function POST(request: Request) {
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

    if (!(await hasBingxKeys(user.id))) {
      return NextResponse.json(
        { error: 'BingX API keys not configured. Connect your keys first.' },
        { status: 400 }
      );
    }

    if (botId) {
      const bot = await getBotById(botId, user.id);
      if (!bot) {
        return NextResponse.json({ error: 'Bot not found' }, { status: 404 });
      }
      await setBotStatus(botId, user.id, 'RUNNING');

      await inngest.send({
        name: 'trading/bot.start',
        data: { userId: user.id, botId: bot.id },
      });

      return NextResponse.json({ success: true, botId: bot.id });
    }

    const priceMinStr = String(priceMin ?? '').trim();
    const priceMaxStr = String(priceMax ?? '').trim();
    const positionSizeStr = String(positionSizeUsdt ?? '').trim();
    const takeProfitStr = String(takeProfitPercentage ?? '').trim();
    const gridCountNum = Math.floor(Number(gridCount ?? 1));

    if (!priceMinStr || !priceMaxStr || !positionSizeStr || !takeProfitStr) {
      return NextResponse.json(
        {
          error:
            'priceMin, priceMax, positionSizeUsdt, and takeProfitPercentage are required',
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

    const client = await getBingxClient(user.id);
    if (!client) {
      return NextResponse.json(
        { error: 'BingX API keys not configured. Connect your keys first.' },
        { status: 400 }
      );
    }

    let leverageNum = 1;
    let marginTypeStr = 'SEPARATE_ISOLATED';
    try {
      const [marginRes, leverageRes] = await Promise.all([
        client.get('/openApi/swap/v2/trade/marginType', { symbol: SYMBOL }) as Promise<{ marginType?: string }>,
        client.get('/openApi/swap/v2/trade/leverage', { symbol: SYMBOL }) as Promise<{ longLeverage?: number; shortLeverage?: number }>,
      ]);
      marginTypeStr = String(marginRes?.marginType ?? 'SEPARATE_ISOLATED').trim().toUpperCase() || 'SEPARATE_ISOLATED';
      leverageNum = Math.max(1, Math.min(125, leverageRes?.longLeverage ?? leverageRes?.shortLeverage ?? 1));
    } catch {
      return NextResponse.json(
        { error: 'Failed to fetch symbol config (margin type, leverage)' },
        { status: 500 }
      );
    }

    const totalMarginNeeded = (posSize / leverageNum) * gridCountNum;
    try {
      const balanceData = await client.get('/openApi/swap/v2/user/balance');
      const availableMargin = getAvailableMargin(balanceData);
      if (availableMargin !== null && availableMargin < totalMarginNeeded) {
        return NextResponse.json(
          {
            error: `Insufficient margin. Required: ${totalMarginNeeded.toFixed(2)} USDT, available: ${availableMargin.toFixed(2)} USDT`,
          },
          { status: 400 }
        );
      }
    } catch {
      // If balance fetch fails, proceed - frontend validation is primary
    }

    const bot = await createBot(user.id, {
      symbol: SYMBOL,
      priceMin: priceMinStr,
      priceMax: priceMaxStr,
      positionSizeUsdt: positionSizeStr,
      takeProfitPercentage: takeProfitStr,
      gridCount: gridCountNum,
      leverage: leverageNum,
      marginType: marginTypeStr,
    });
    await setBotStatus(bot.id, user.id, 'RUNNING');

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
