import { NextResponse } from 'next/server';
import { requireAuth } from '@/services/auth.service';
import { getUserBotsByApiKey } from '@/services/bingx.service';
import { getBotsStats } from '@/services/bot-stats.service';

export async function GET(request: Request) {
  try {
    const user = await requireAuth();
    const { searchParams } = new URL(request.url);
    const apiKeyId = searchParams.get('apiKeyId');

    if (!apiKeyId) {
      return NextResponse.json({ error: 'apiKeyId required' }, { status: 400 });
    }

    const bots = await getUserBotsByApiKey(user.id, apiKeyId);
    const statsById = await getBotsStats(bots.map((b) => b.id));

    return NextResponse.json({ stats: Object.values(statsById) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch bot stats';
    if (message.includes('Authentication required')) {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
