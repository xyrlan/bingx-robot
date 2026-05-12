import { NextResponse } from 'next/server';
import { requireAuth } from '@/services/auth.service';
import { listAiPmConfigsForUser } from '@/services/ai-pm-config.service';

/**
 * Lightweight refresh endpoint for the chat header picker. Returns just the
 * fields ChatHeader needs (id, label, enabled, killSwitch, paperMode) so
 * switching subaccounts immediately reflects the live kill_switch / enabled
 * state without a full page reload.
 *
 * Filters to enabled configs only (matches the server page behavior so the
 * picker doesn't suddenly show a disabled config after a refresh).
 */
export async function GET() {
  try {
    const user = await requireAuth();
    const all = await listAiPmConfigsForUser(user.id);
    const configs = all
      .filter((c) => c.enabled)
      .map((c) => ({
        id: c.id,
        label: c.bingxApiKeyId.slice(0, 8),
        enabled: c.enabled,
        killSwitch: c.killSwitch,
        paperMode: c.paperMode,
      }));
    return NextResponse.json({ configs });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed';
    if (message.includes('Authentication')) {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
