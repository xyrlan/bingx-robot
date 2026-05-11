import { NextResponse } from 'next/server';
import { requireAuth } from '@/services/auth.service';
import {
  getAiPmConfigById,
  updateAiPmConfig,
  deleteAiPmConfig,
  type AiPmConfigDecrypted,
  type UpdateAiPmConfigInput,
} from '@/services/ai-pm-config.service';

type AiPmConfigPublic = Omit<AiPmConfigDecrypted, 'anthropicApiKey'>;

function toPublic(cfg: AiPmConfigDecrypted): AiPmConfigPublic {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { anthropicApiKey, ...rest } = cfg;
  return rest;
}

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const user = await requireAuth();
    const { id } = await context.params;

    const cfg = await getAiPmConfigById(id);
    if (!cfg || cfg.userId !== user.id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const body = await request.json() as UpdateAiPmConfigInput & { anthropicApiKey?: string };

    // Map anthropicApiKey → anthropicApiKeyPlaintext for the service helper
    const input: UpdateAiPmConfigInput = { ...body };
    if (body.anthropicApiKey !== undefined) {
      input.anthropicApiKeyPlaintext = body.anthropicApiKey;
    }

    await updateAiPmConfig(id, input);

    const updated = await getAiPmConfigById(id);
    if (!updated) {
      return NextResponse.json({ error: 'Not found after update' }, { status: 404 });
    }

    return NextResponse.json({ config: toPublic(updated) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update config';
    if (message.includes('Authentication required')) {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const user = await requireAuth();
    const { id } = await context.params;

    const cfg = await getAiPmConfigById(id);
    if (!cfg || cfg.userId !== user.id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    await deleteAiPmConfig(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete config';
    if (message.includes('Authentication required')) {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
