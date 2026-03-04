import { NextResponse } from 'next/server';
import { requireAuth } from '@/services/auth.service';
import { getBingxClient } from '@/services/bingx.service';

const SYMBOL = 'BTC-USDT';

export async function GET() {
  try {
    const user = await requireAuth();
    const client = await getBingxClient(user.id);

    if (!client) {
      return NextResponse.json(
        { error: 'BingX API keys not configured. Connect your keys first.' },
        { status: 400 }
      );
    }

    const [marginRes, leverageRes] = await Promise.all([
      client.get('/openApi/swap/v2/trade/marginType', { symbol: SYMBOL }) as Promise<{ marginType?: string }>,
      client.get('/openApi/swap/v2/trade/leverage', { symbol: SYMBOL }) as Promise<{ longLeverage?: number; shortLeverage?: number }>,
    ]);

    const marginType = String(marginRes?.marginType ?? 'SEPARATE_ISOLATED').trim().toUpperCase() || 'SEPARATE_ISOLATED';
    const leverage = leverageRes?.longLeverage ?? leverageRes?.shortLeverage ?? 1;

    return NextResponse.json({
      symbol: SYMBOL,
      marginType,
      leverage: Math.max(1, Math.min(125, Number(leverage) || 1)),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch symbol config';
    if (message.includes('Authentication required')) {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireAuth();
    const client = await getBingxClient(user.id);

    if (!client) {
      return NextResponse.json(
        { error: 'BingX API keys not configured. Connect your keys first.' },
        { status: 400 }
      );
    }

    const body = await request.json();
    const leverage = Math.max(1, Math.min(125, Math.floor(Number(body.leverage ?? 1))));

    await client.post(
      '/openApi/swap/v2/trade/leverage',
      {
        symbol: SYMBOL,
        side: 'LONG',
        leverage,
      },
      true
    );

    return NextResponse.json({ success: true, leverage });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update leverage';
    if (message.includes('Authentication required')) {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
