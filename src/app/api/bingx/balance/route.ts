import { NextResponse } from 'next/server';
import { requireAuth } from '@/services/auth.service';
import { getBingxClient, getBingxClientByApiKeyId } from '@/services/bingx.service';

export async function GET(request: Request) {
  try {
    const user = await requireAuth();
    const url = new URL(request.url);
    const apiKeyId = url.searchParams.get('apiKeyId');

    const client = apiKeyId
      ? await getBingxClientByApiKeyId(apiKeyId)
      : await getBingxClient(user.id);

    if (!client) {
      return NextResponse.json(
        { error: 'BingX API keys not configured. Connect your keys first.' },
        { status: 400 }
      );
    }

    const data = await client.get('/openApi/swap/v2/user/balance');
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch balance';
    if (message.includes('Authentication required')) {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
