import { NextResponse } from 'next/server';
import { requireAuth } from '@/services/auth.service';
import { getUserApiKeys, saveBingxKeys, deleteBingxKey } from '@/services/bingx.service';
import { createBingxClient } from '@/lib/bingx/client';

export async function GET() {
  try {
    const user = await requireAuth();
    const keys = await getUserApiKeys(user.id);
    return NextResponse.json({ keys });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to check keys';
    if (message.includes('Authentication required')) {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireAuth();
    const body = await request.json();
    const { apiKey, secretKey, label, apiKeyId } = body as {
      apiKey?: string;
      secretKey?: string;
      label?: string;
      apiKeyId?: string;
    };

    if (!apiKey || !secretKey || typeof apiKey !== 'string' || typeof secretKey !== 'string') {
      return NextResponse.json({ error: 'apiKey and secretKey are required' }, { status: 400 });
    }

    // Verify keys work before saving (avoids "signature mismatch" with invalid/stale keys)
    const client = createBingxClient(apiKey.trim(), secretKey.trim());
    try {
      await client.get('/openApi/swap/v2/user/balance');
    } catch (verifyErr) {
      const msg = verifyErr instanceof Error ? verifyErr.message : 'Verification failed';
      const isSignatureError = msg.toLowerCase().includes('signature');
      return NextResponse.json(
        {
          error: isSignatureError
            ? 'Invalid API keys: signature verification failed. Ensure the API Key and Secret Key are from the same pair, and that you copied the Secret Key correctly (no extra spaces).'
            : msg,
        },
        { status: 400 }
      );
    }

    const id = await saveBingxKeys(user.id, apiKey, secretKey, label ?? 'Main', apiKeyId);
    return NextResponse.json({ success: true, id });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save API keys';
    if (message.includes('Authentication required')) {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireAuth();
    const body = await request.json();
    const { apiKeyId } = body as { apiKeyId?: string };

    if (!apiKeyId || typeof apiKeyId !== 'string') {
      return NextResponse.json({ error: 'apiKeyId is required' }, { status: 400 });
    }

    await deleteBingxKey(apiKeyId, user.id);
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete API keys';
    if (message.includes('Authentication required')) {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
