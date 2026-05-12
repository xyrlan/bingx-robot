import { db, sql } from '@/db';
import { aiChatMessages } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { requireAuth } from '@/services/auth.service';
import {
  loadChunksFromSeq,
  streamChannel,
  type StreamEvent,
} from '@/lib/ai-pm/streaming';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_DURATION_MS = 270_000;

function sseLine(event: StreamEvent, id?: number | string): string {
  const idLine = id !== undefined ? `id: ${id}\n` : '';
  return `${idLine}data: ${JSON.stringify(event)}\n\n`;
}

interface RouteCtx { params: { messageId: string } | Promise<{ messageId: string }> }

export async function GET(req: Request, ctx: RouteCtx) {
  let user;
  try {
    user = await requireAuth();
  } catch {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const params = await ctx.params;
  const messageId = params.messageId;
  const row = await db.query.aiChatMessages.findFirst({
    where: and(eq(aiChatMessages.id, messageId), eq(aiChatMessages.userId, user.id)),
  });
  if (!row) {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const lastEventId = Number(req.headers.get('Last-Event-ID') ?? '0') || 0;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const send = (event: StreamEvent, id?: number): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sseLine(event, id)));
        } catch {
          closed = true;
        }
      };
      const close = (): void => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      };

      // 1. Replay persisted chunks newer than lastEventId
      try {
        const replay = await loadChunksFromSeq(db, messageId, lastEventId);
        for (const c of replay) {
          send({ type: 'text_chunk', seq: c.seq, text: c.text }, c.seq);
        }
      } catch {
        /* ignore replay errors */
      }

      // 2. If row already finalized, send synthetic done and close
      if (row.content && row.content.length > 0) {
        send({
          type: 'done',
          decisionId: row.decisionId ?? null,
          usage: {
            inputTokens: row.tokensInput ?? 0,
            outputTokens: row.tokensOutput ?? 0,
            cachedInputTokens: row.cachedInputTokens ?? 0,
            costUsd: Number(row.costUsd ?? 0),
            model: 'claude-sonnet-4-6',
          },
        });
        close();
        return;
      }

      send({ type: 'started', placeholderId: messageId });

      // 3. Subscribe to live NOTIFY
      let subscription: { unlisten: () => Promise<void> } | undefined;
      try {
        subscription = await sql.listen(streamChannel(messageId), (payload: string) => {
          if (closed) return;
          try {
            const evt = JSON.parse(payload) as StreamEvent;
            const id = evt.type === 'text_chunk' ? evt.seq : undefined;
            send(evt, id);
            if (evt.type === 'done' || evt.type === 'error') {
              void subscription?.unlisten().catch(() => {});
              close();
            }
          } catch {
            /* ignore malformed payload */
          }
        });
      } catch {
        send({ type: 'error', kind: 'LISTEN_FAILED', message: 'Subscriber failed to attach' });
        close();
        return;
      }

      // 4. Safety timeout
      const timeout = setTimeout(() => {
        void subscription?.unlisten().catch(() => {});
        close();
      }, MAX_DURATION_MS);

      // 5. Cleanup on client disconnect
      req.signal.addEventListener('abort', () => {
        clearTimeout(timeout);
        void subscription?.unlisten().catch(() => {});
        close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
