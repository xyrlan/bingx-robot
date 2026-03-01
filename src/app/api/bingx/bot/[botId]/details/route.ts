import { NextResponse } from 'next/server';
import { requireAuth } from '@/services/auth.service';
import { getBotDetails } from '@/services/bingx.service';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ botId: string }> }
) {
  try {
    const user = await requireAuth();
    const { botId } = await params;

    if (!botId) {
      return NextResponse.json({ error: 'botId is required' }, { status: 400 });
    }

    const details = await getBotDetails(user.id, botId);
    if (!details) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 });
    }

    return NextResponse.json(details);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch bot details';
    if (message.includes('Authentication required')) {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
