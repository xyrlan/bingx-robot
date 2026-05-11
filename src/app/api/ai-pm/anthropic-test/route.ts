import { NextResponse } from 'next/server';
import { requireAuth } from '@/services/auth.service';
import { testAnthropicApiKey } from '@/services/ai-pm-config.service';

export async function POST(request: Request) {
  try {
    const user = await requireAuth();
    void user; // auth confirmed, user id not needed for this route

    const body = await request.json() as { anthropicApiKey?: string };

    if (!body.anthropicApiKey || typeof body.anthropicApiKey !== 'string') {
      return NextResponse.json({ error: 'anthropicApiKey is required' }, { status: 400 });
    }

    const result = await testAnthropicApiKey(body.anthropicApiKey);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to test API key';
    if (message.includes('Authentication required')) {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
