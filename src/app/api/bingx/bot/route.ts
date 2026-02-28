import { NextResponse } from 'next/server';
import { requireAuth } from '@/services/auth.service';
import { getUserBots } from '@/services/bingx.service';

export async function GET() {
  try {
    const user = await requireAuth();
    const bots = await getUserBots(user.id);
    return NextResponse.json({ bots });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch bots';
    if (message.includes('Authentication required')) {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
