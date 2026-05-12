import { NextResponse } from 'next/server';
import { requireAuth } from '@/services/auth.service';
import {
  listChatMessages,
  decodeChatCursor,
  getChatMessageById,
} from '@/services/ai-pm-chat-history.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseLimit(raw: string | null): number {
  if (!raw) return 30;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 50) throw new Error('Invalid limit');
  return n;
}

function parseSince(raw: string | null): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid since');
  return d;
}

export async function GET(req: Request) {
  try {
    const user = await requireAuth();
    const url = new URL(req.url);
    const params = url.searchParams;

    // Direct-by-id fast path: `?id=<uuid>` returns just that one row (used by
    // the chat client's poll fallback to find the pre-inserted placeholder
    // without depending on a `since` filter that may exclude it).
    const idParam = params.get('id');
    if (idParam) {
      if (!UUID_RE.test(idParam)) {
        return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
      }
      const row = await getChatMessageById(user.id, idParam);
      return NextResponse.json({
        messages: row ? [row] : [],
        nextCursor: null,
      });
    }

    let limit: number;
    let since: Date | undefined;
    let cursor: { createdAt: Date; id: string } | undefined;

    try {
      limit = parseLimit(params.get('limit'));
      since = parseSince(params.get('since'));
      if (!since) {
        const cursorRaw = params.get('cursor');
        if (cursorRaw) cursor = decodeChatCursor(cursorRaw);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Bad request';
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    const result = await listChatMessages(user.id, { limit, since, cursor });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed';
    if (message.includes('Authentication')) {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
