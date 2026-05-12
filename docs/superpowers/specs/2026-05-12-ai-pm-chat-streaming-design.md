# AI Portfolio Manager — Session 17: Streaming Chat (Hybrid SSE)

**Date:** 2026-05-12
**Status:** Approved
**Branch:** `feat/ai-pm-chat-streaming`
**Predecessors:** S0–S16 (cron pipeline, settings, activity feed, event monitor, chat UI, agentic tools) + chat bug fixes

## Goal

Replace the chat client's 2-second poll loop with real Server-Sent Events. Tokens appear in the assistant bubble as the model generates them. Tool-call start/done notifications stream in real time. Backend keeps the existing Inngest-driven pipeline (audit + retry + budget enforcement intact); SSE acts as a real-time read channel sitting on top of Postgres `LISTEN/NOTIFY`. Polling is retained as a fallback.

## Non-Goals (v1)

- Streaming tool execution sub-events (we emit `tool_start` and `tool_done`; intermediate steps within a single tool call are not streamed).
- Server-side push for non-chat events (activity feed stays poll-based).
- Streaming audio / voice.
- Replacing Inngest with a fully synchronous request — the multi-turn loop can exceed Vercel's HTTP timeout; keeping the async pipeline lets it finish even after the client disconnects.
- WebSocket transport (SSE is enough; we never need client → server frames after initial POST).

## Architecture

```
Client                          Server                            Inngest worker (Postgres pub/sub)
──────                          ──────                            ──────
POST /api/ai-pm/chat
  body {configId, message}
                          ─────► inserts user row
                                 inserts EMPTY placeholder
                                   assistant row
                                 emits ai-pm/event.chat with
                                   placeholderId
                          ◄───── 200 {chatMessageId, placeholderId}
                                                                  picks up event
                                                                  runChatPipeline:
                                                                    NOTIFY chat:<placeholderId>
                                                                          {started}

EventSource(
  /api/ai-pm/chat/stream/[placeholderId])
                          ─────► auth + start SSE
                                 sql.listen('chat:<placeholderId>',
                                            forward each NOTIFY)
                                 also replays any chat_message_chunks
                                   already persisted (resume)
                                                                  tool loop:
                                                                    on tool_use turn:
                                                                      NOTIFY {tool_start, toolName, args}
                                                                      execute
                                                                      NOTIFY {tool_done, entry}
                                                                    on text turn:
                                                                      Anthropic stream:true
                                                                      per chunk:
                                                                        INSERT chunk(messageId, seq, text)
                                                                        NOTIFY {text_chunk, seq, text}
                                                                    end:
                                                                      UPDATE ai_chat_messages
                                                                          content, toolCalls, usage
                                                                      NOTIFY {done, decisionId, usage}
                                                                      DELETE chunks WHERE messageId = $1
                          ◄───── chunk events streamed
event_source.onmessage:
  text_chunk → append to pending bubble
  tool_start → render "🔧 calling X..."
  tool_done  → replace with summary entry
  done       → close, move pending → real
  error      → fallback to poll
```

## Components

### 1. Schema migration

```sql
CREATE TABLE chat_message_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES ai_chat_messages(id) ON DELETE CASCADE,
  seq int NOT NULL,
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, seq)
);
CREATE INDEX chat_message_chunks_msg_seq_idx ON chat_message_chunks (message_id, seq);
```

Drizzle table `chatMessageChunks`. Rows are short-lived: pipeline deletes them once the final UPDATE on `ai_chat_messages` commits. They exist only to support SSE resume during a stream.

### 2. POST `/api/ai-pm/chat` — synchronous pre-insert + placeholder

Today the route inserts the user message and emits the event. We extend it to also pre-insert the assistant placeholder row so the client immediately knows the stream ID.

```
input  : {configId, message}
output : {ok: true, chatMessageId, placeholderId}
side   : insert user row, insert placeholder assistant row (content=''), emit ai-pm/event.chat with both ids
```

`ChatPayload` gains an `assistantPlaceholderId: string` field.

### 3. `chat-pipeline.ts` — uses the supplied placeholderId

The pre-insert previously happened inside the pipeline. Move it to the POST route. Pipeline reads `payload.assistantPlaceholderId`, uses it as `chatMessageId` in `ToolExecContext`, and ultimately UPDATEs that row at the end. All other behavior unchanged.

### 4. `streaming.ts` — the bridge

New helper module:

```ts
type StreamEvent =
  | { type: 'started'; placeholderId: string }
  | { type: 'tool_start'; toolName: string; args: unknown }
  | { type: 'tool_done'; entry: ToolCallEntry }
  | { type: 'text_chunk'; seq: number; text: string }
  | { type: 'done'; decisionId: string | null; usage: LlmUsage }
  | { type: 'error'; kind: string; message: string };

export function streamChannel(placeholderId: string): string  // returns 'chat:<placeholderId>'

export async function notifyStream(
  sql: PgSql,
  placeholderId: string,
  event: StreamEvent,
): Promise<void>

export async function persistChunk(
  db: typeof Db,
  messageId: string,
  seq: number,
  text: string,
): Promise<void>

export async function loadChunksFromSeq(
  db: typeof Db,
  messageId: string,
  fromSeq: number,
): Promise<Array<{ seq: number; text: string }>>

export async function deleteChunks(
  db: typeof Db,
  messageId: string,
): Promise<void>
```

`sql` here is the underlying `postgres` client (not the Drizzle wrapper). The chunked-text persistence is awaited so the SSE endpoint can resume cleanly after reconnect.

### 5. `callSonnetTools` — optional `onTextChunk` callback

Existing single-shot version is preserved as default. When the caller passes `onTextChunk(chunk)`, the helper switches to `stream: true` on the Anthropic SDK and forwards each `content_block_delta` text. Returns the same `SonnetToolsResponse` shape once the stream ends.

```ts
callSonnetTools(params: {
  ...,
  onTextChunk?: (chunk: string) => void | Promise<void>;
  onToolUseStart?: (info: { toolName: string; args: unknown }) => void | Promise<void>;
}): Promise<LlmResult<SonnetToolsResponse>>;
```

`onToolUseStart` is invoked when the model commits to a tool call but before the executor runs.

### 6. `runToolLoop` — optional `onEvent` callback

Accepts:

```ts
onEvent?: (event: StreamEvent) => Promise<void> | void;
```

Emits:
- `started` before turn 0
- `tool_start` / `tool_done` per tool call
- `text_chunk` (via `callSonnetTools.onTextChunk` forwarded)
- `done` with the cumulative usage and first decisionId
- `error` if the LLM call fails

The loop's bookkeeping for `toolCallEntries` and `cumulativeUsage` is unchanged. `onEvent` is purely observation; failures inside the callback are caught and logged but never abort the loop.

### 7. `runChatPipeline` — wires the notifier

When invoked, builds an `onEvent` callback that:
1. Forwards each event to `notifyStream(sql, placeholderId, event)`.
2. For `text_chunk` also calls `persistChunk` so SSE consumers can resume.

If `notifyStream` throws (DB busy, NOTIFY oversize), the error is logged and the loop continues — the row will still be UPDATEd at the end so polling clients see the final result.

Final write path unchanged: pipeline updates the placeholder with content, toolCalls, usage, decisionId, then `deleteChunks(placeholderId)`.

### 8. SSE endpoint `GET /api/ai-pm/chat/stream/[messageId]`

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: { messageId: string } }) {
  const user = await requireAuth();
  // ownership check: messageId belongs to user
  const lastEventId = Number(req.headers.get('Last-Event-ID') ?? '0');

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (event: StreamEvent, id?: number) => {
        const data = JSON.stringify(event);
        const prefix = id !== undefined ? `id: ${id}\n` : '';
        controller.enqueue(encoder.encode(`${prefix}data: ${data}\n\n`));
      };

      // 1. replay persisted chunks > lastEventId
      void replayAndSubscribe();

      async function replayAndSubscribe() {
        const replay = await loadChunksFromSeq(db, messageId, lastEventId);
        for (const c of replay) {
          send({ type: 'text_chunk', seq: c.seq, text: c.text }, c.seq);
        }
        // also send a 'started' marker to client so it knows session is active
        send({ type: 'started', placeholderId: messageId });

        // 2. open Postgres LISTEN
        const subscription = sql.listen(streamChannel(messageId), (payload) => {
          try {
            const evt = JSON.parse(payload) as StreamEvent;
            const id = evt.type === 'text_chunk' ? evt.seq : undefined;
            send(evt, id);
            if (evt.type === 'done' || evt.type === 'error') {
              controller.close();
            }
          } catch (err) {
            console.warn('bad SSE payload', err);
          }
        });

        // cleanup
        req.signal.addEventListener('abort', async () => {
          (await subscription).unlisten().catch(() => {});
          controller.close();
        });
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
```

Notes:
- Vercel HTTP timeout is 300s; we close proactively after 270s and rely on EventSource's auto-reconnect with `Last-Event-ID` for sessions that take longer.
- Ownership check: `SELECT user_id FROM ai_chat_messages WHERE id = $1` must equal `user.id`.
- The endpoint forces `runtime: 'nodejs'` because Edge runtime cannot keep a Postgres LISTEN connection.

### 9. `ChatClient` — EventSource consumer with poll fallback

After POST returns `{placeholderId}`:

```ts
const es = new EventSource(`/api/ai-pm/chat/stream/${placeholderId}`);
let buffer = '';
es.onmessage = (e) => {
  const evt: StreamEvent = JSON.parse(e.data);
  switch (evt.type) {
    case 'text_chunk':
      buffer += evt.text;
      updatePendingBubble(buffer);
      break;
    case 'tool_start':
      appendToolEntry({ toolName: evt.toolName, status: 'EXECUTING', summary: '...' });
      break;
    case 'tool_done':
      replaceToolEntry(evt.entry);
      break;
    case 'done':
      finalizePendingBubble(buffer, evt);
      es.close();
      break;
    case 'error':
      setToast(evt.message);
      es.close();
      fallbackToPoll();
      break;
  }
};
es.onerror = () => {
  es.close();
  fallbackToPoll();   // existing 2s poll path
};
```

The polling code from S15 stays as the fallback path. The client picks SSE first; if it errors or the browser blocks it, polling takes over.

### 10. `MessageBubble` — assistant bubble accepts a `streamingText` overlay

`MessageBubble` already renders `props.content` via the markdown helper. For the pending bubble during streaming we want to render the partial text the same way without persisting an entire row each chunk. Update `MessageList` so the pending assistant bubble takes `streamingText` and `streamingToolCalls`:

```tsx
{pending && (
  <MessageBubble
    role="assistant"
    content={streamingText ?? ''}
    decisionId={null}
    toolCalls={streamingToolCalls ?? null}
    createdAt={new Date().toISOString()}
    pending={!streamingText}   // typing dots only until first token
  />
)}
```

Once `done` fires, the pending bubble is removed and a real bubble is appended with the final content + toolCalls from the SSE event (no re-fetch needed).

## Data flow — happy path

1. POST `/api/ai-pm/chat` → server inserts user row + placeholder, emits event, returns `{placeholderId}`.
2. Client opens `EventSource('/api/ai-pm/chat/stream/<placeholderId>')`.
3. SSE endpoint listens on `chat:<placeholderId>`, emits `started`.
4. Inngest pipeline picks up event, calls `runChatPipeline` with `assistantPlaceholderId`.
5. Pipeline begins tool loop. First turn = tool_use `read_portfolio` → emits `tool_start`, runs tool, emits `tool_done`.
6. Next turn = text → calls `callSonnetTools` with streaming. Each chunk → INSERT + NOTIFY `text_chunk`.
7. End → UPDATE placeholder content + toolCalls + usage → NOTIFY `done` → DELETE chunks.
8. Client closes EventSource on `done`. Pending bubble is replaced by a final bubble holding the accumulated text + toolCalls.

## Reconnect / resume

- Browser auto-reconnects when the SSE stream drops. EventSource sets `Last-Event-ID` header to the last chunk seq it received.
- Server reads the header on each reconnect, replays chunks from `chat_message_chunks` with `seq > lastEventId`, then re-subscribes to LISTEN.
- If the pipeline has already finished by the time the client reconnects, the chunks are gone (deleted). The server detects this by checking `ai_chat_messages.content != ''`, sends a synthetic `done` event with the persisted content + toolCalls, and closes the stream.

## Errors

| Scenario | Behavior |
|----------|----------|
| Anthropic SDK error mid-stream | pipeline catches → NOTIFY `error` → finalizes row with error message → DELETE chunks |
| Postgres LISTEN dropped | postgres-js library reconnects automatically; subscriber re-listens transparently |
| SSE endpoint Vercel timeout (270s) | controller closes; client EventSource auto-reconnects with last seq |
| Client closes tab mid-stream | pipeline keeps running; final row still gets UPDATEd → user sees full reply on next page load |
| LISTEN payload > 8KB | chunks are kept small (Anthropic delta chunks are typically < 500 bytes); safeguard: split chunk before NOTIFY if `JSON.stringify(event).length > 7500` |
| Two SSE consumers for same messageId | both receive the same NOTIFY broadcasts; idempotent on client (chunks identified by seq) |

## Backward compat

- Polling endpoint `GET /api/ai-pm/chat/history?since=...` keeps working. Client falls back to it whenever EventSource fails.
- Old chat rows (no chunks) are queryable as before; SSE endpoint short-circuits to `done` for them.
- Mobile browsers / proxies that drop SSE (rare in 2026) → fallback takes over within ~1s.

## Tests

| File | What |
|------|------|
| `src/lib/ai-pm/__tests__/streaming.test.ts` (new) | round-trip notify+listen on a real test DB, chunk persistence ordering, `deleteChunks`. |
| `src/lib/ai-pm/__tests__/llm.test.ts` (extend) | `callSonnetTools` with `onTextChunk` — mocked SDK emits 3 chunks → callback invoked 3 times → final response intact. |
| `src/lib/ai-pm/__tests__/chat-loop.test.ts` (extend) | `runToolLoop` with `onEvent` — events emitted in expected order for tool_use → text → done. |
| `src/lib/ai-pm/__tests__/chat-pipeline.test.ts` (extend) | pipeline uses `payload.assistantPlaceholderId` and forwards events to a mocked notifier; chunks persisted; deleted on success. |
| `src/app/api/ai-pm/chat/__tests__/route.test.ts` (extend) | POST returns `placeholderId` + a row exists in `ai_chat_messages` with `role='assistant', content=''`. |
| `src/app/api/ai-pm/chat/stream/[messageId]/__tests__/route.test.ts` (new) | SSE handler: 401 unauth; ownership; replays chunks from `Last-Event-ID`; synthetic `done` when content already final. |
| `src/components/ai-pm/chat/__tests__/ChatClient.test.tsx` (extend) | EventSource consumer assembles chunks into bubble; falls back to poll on SSE error. Mock global `EventSource`. |

Target: 85% backend / 60% UI on new code.

## i18n

No new copy strings. The streaming UX surfaces the same `typing`, `viewDecision`, `toolCallsHeader`, etc. The error toast on stream failure reuses `sendFailed`.

## Out of scope (deferred)

- Per-config chat threads (still S15b backlog).
- Multi-region SSE fan-out (single Postgres LISTEN per node is enough at our scale).
- Push notification for new assistant messages while the user is on another tab.
- Speculative token rendering before tool calls finish (we only stream during text turns).

## Open risks

- **DB connection per active SSE stream**: each SSE endpoint instance grabs a long-lived conn for LISTEN. At 100 concurrent active chats → 100 conns. Mitigation: dedicated `postgres({max: 100})` client just for listening, separate from the Drizzle write pool. Add as part of T1.
- **Vercel cold start on SSE**: first request to `/api/ai-pm/chat/stream/...` may stall 1-2s during cold start. Acceptable; subsequent reconnects warm.
- **EventSource and cookies on cross-domain**: app runs on a single domain; not an issue here.
- **Postgres NOTIFY at scale**: cap is theoretically high (8KB payload × many notifies/sec). With our scale this is fine; if it ever bottlenecks we add Redis pub/sub later without touching the producer/consumer API.
