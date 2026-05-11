import { NextResponse } from 'next/server';
import { requireAuth } from '@/services/auth.service';
import {
  createAiPmConfig,
  listAiPmConfigsForUser,
  type AiPmConfigDecrypted,
} from '@/services/ai-pm-config.service';
import { db } from '@/db';
import { bingxApiKeys } from '@/db/schema';
import { and, eq } from 'drizzle-orm';

type AiPmConfigPublic = Omit<AiPmConfigDecrypted, 'anthropicApiKey'>;

function toPublic(cfg: AiPmConfigDecrypted): AiPmConfigPublic {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { anthropicApiKey, ...rest } = cfg;
  return rest;
}

export async function GET() {
  try {
    const user = await requireAuth();
    const configs = await listAiPmConfigsForUser(user.id);
    return NextResponse.json({ configs: configs.map(toPublic) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list configs';
    if (message.includes('Authentication required')) {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireAuth();
    const body = await request.json() as {
      bingxApiKeyId?: string;
      anthropicApiKey?: string;
      mode?: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE' | 'CUSTOM';
    };

    if (!body.bingxApiKeyId || typeof body.bingxApiKeyId !== 'string') {
      return NextResponse.json({ error: 'bingxApiKeyId is required' }, { status: 400 });
    }
    if (!body.anthropicApiKey || typeof body.anthropicApiKey !== 'string') {
      return NextResponse.json({ error: 'anthropicApiKey is required' }, { status: 400 });
    }

    // Verify the bingxApiKeyId belongs to this user
    const ownedKey = await db.query.bingxApiKeys.findFirst({
      where: and(eq(bingxApiKeys.id, body.bingxApiKeyId), eq(bingxApiKeys.userId, user.id)),
    });
    if (!ownedKey) {
      return NextResponse.json({ error: 'Subaccount not found' }, { status: 404 });
    }

    const row = await createAiPmConfig(user.id, {
      bingxApiKeyId: body.bingxApiKeyId,
      anthropicApiKeyPlaintext: body.anthropicApiKey,
      mode: body.mode,
    });

    // createAiPmConfig returns AiPmConfigRow (with anthropicApiKeyEncrypted), strip it
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { anthropicApiKeyEncrypted: _, ...publicRow } = row;
    return NextResponse.json({ config: publicRow });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create config';
    if (message.includes('Authentication required')) {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    // DrizzleQueryError wraps the Postgres error in `.cause`
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const pgCode = cause?.code ?? (err as { code?: string }).code;
    const causeMsg = cause?.message ?? '';
    if (
      pgCode === '23505' ||
      message.toLowerCase().includes('duplicate key') ||
      causeMsg.toLowerCase().includes('duplicate key')
    ) {
      return NextResponse.json({ error: 'Config already exists for this subaccount' }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
