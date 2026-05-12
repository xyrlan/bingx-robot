# AI Portfolio Manager — Session 17: Streaming Chat (Hybrid SSE) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream Anthropic tokens + tool-call events to the chat UI in real time over SSE, while keeping the existing Inngest-driven async pipeline. Polling stays as fallback.

**Architecture:** Postgres `LISTEN/NOTIFY` is the pub/sub bus. The Inngest pipeline emits `StreamEvent`s via `NOTIFY chat:<messageId>`. A new SSE endpoint subscribes via `LISTEN`, replays persisted chunks from `chat_message_chunks` on reconnect, and forwards live events to the browser EventSource. The POST `/api/ai-pm/chat` route pre-inserts the assistant placeholder row so the client knows the stream id immediately.

**Tech Stack:** Next.js 16 App Router, `postgres-js` v3 (LISTEN/NOTIFY), Drizzle ORM, Anthropic SDK (`stream: true`), vitest, React 19 `EventSource`.

**Spec:** `docs/superpowers/specs/2026-05-12-ai-pm-chat-streaming-design.md`
**Branch:** `feat/ai-pm-chat-streaming` (already created; spec committed at `9f8e470`).

---

## File Manifest

**New:**
- `src/lib/ai-pm/streaming.ts`
- `src/lib/ai-pm/__tests__/streaming.test.ts`
- `src/app/api/ai-pm/chat/stream/[messageId]/route.ts`
- `src/app/api/ai-pm/chat/stream/[messageId]/__tests__/route.test.ts`
- One Drizzle migration file

**Modified:**
- `src/db/schema.ts` (`chatMessageChunks` table + relation on `aiChatMessages`)
- `src/db/index.ts` (export the raw `sql` postgres client for NOTIFY/LISTEN)
- `src/lib/ai-pm/events.ts` (extend `ChatPayload` with `assistantPlaceholderId`)
- `src/lib/ai-pm/llm.ts` (`callSonnetTools` gains `onTextChunk` + `onToolUseStart`)
- `src/lib/ai-pm/chat-loop.ts` (accept `onEvent` callback)
- `src/lib/ai-pm/chat-pipeline.ts` (use `payload.assistantPlaceholderId`; wire notifier)
- `src/lib/ai-pm/__tests__/{llm,chat-loop,chat-pipeline}.test.ts`
- `src/app/api/ai-pm/chat/route.ts` (pre-insert placeholder + return `placeholderId`)
- `src/app/api/ai-pm/chat/__tests__/route.test.ts` (extend)
- `src/components/ai-pm/chat/ChatClient.tsx` (EventSource consumer + poll fallback)
- `src/components/ai-pm/chat/MessageList.tsx` (pending bubble accepts streaming overlay)
- `src/components/ai-pm/chat/__tests__/ChatClient.test.tsx`

---

## Task 1: Schema migration + raw sql export

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/index.ts`
- Create (generated): `drizzle/NNNN_chat_message_chunks.sql`

Adds the `chat_message_chunks` table and re-exports the underlying `postgres` client (`sql`) from `@/db` so the streaming module can call `sql.listen()` / `sql.notify()` directly. Drizzle does not wrap LISTEN/NOTIFY.

- [ ] **Step 1: Update `src/db/index.ts` to export the raw client**

Open file. Replace contents with:

```ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { validateEnv } from '@/lib/env';

validateEnv();

const connectionString = process.env.DATABASE_URL!;

// Main pool, multiplexed for query traffic.
export const sql = postgres(connectionString, { prepare: false });
export const db = drizzle(sql, { schema });
```

The change is renaming the previously-local `client` to `sql` and exporting it. Existing call sites importing `db` are unaffected.

- [ ] **Step 2: Add `chatMessageChunks` table to `src/db/schema.ts`**

Place it near `aiChatMessages`. After the `aiChatMessages` definition (around line 358), add:

```ts
/**
 * Streamed text deltas for an assistant chat message. Rows are appended as the
 * Anthropic SDK produces them and deleted by the pipeline once the assistant
 * row is finalized. SSE endpoints read these to replay on reconnect.
 */
export const chatMessageChunks = pgTable('chat_message_chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageId: uuid('message_id')
    .notNull()
    .references(() => aiChatMessages.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  text: text('text').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('chat_message_chunks_msg_seq_unique').on(table.messageId, table.seq),
  index('chat_message_chunks_msg_seq_idx').on(table.messageId, table.seq),
]);
```

If `uniqueIndex` or `integer`/`text` aren’t already imported at the top of the file, add them.

- [ ] **Step 3: Add a relation on `aiChatMessagesRelations`**

Find `aiChatMessagesRelations` and extend its `({ one, many })` returned object with:

```ts
  chunks: many(chatMessageChunks),
```

- [ ] **Step 4: Generate migration**

```bash
cd /Users/xyrlan/github/bingx-robot
npm run db:generate
```

Expected: new file `drizzle/0014_*.sql` containing the CREATE TABLE for `chat_message_chunks` + UNIQUE + INDEX + FK ON DELETE CASCADE.

- [ ] **Step 5: Apply + verify**

```bash
npm run db:migrate
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -iE "chat_message_chunks|chatMessageChunks" | head -10
npx vitest run src/services/__tests__/ai-pm-chat-history.service.test.ts 2>&1 | tail -5
```
Expected: migration applies, no new tsc errors, existing tests still green.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/index.ts drizzle/
git commit -m "feat(ai-pm): chat_message_chunks table + export raw postgres sql client"
```

---

## Task 2: `streaming.ts` helper module

**Files:**
- Create: `src/lib/ai-pm/streaming.ts`
- Create: `src/lib/ai-pm/__tests__/streaming.test.ts`

Wraps `sql.notify`, `sql.listen`, chunk persistence, and the `StreamEvent` union. Single responsibility: pub/sub bridge.

- [ ] **Step 1: Write failing tests**

```ts
// src/lib/ai-pm/__tests__/streaming.test.ts
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { db, sql } from '@/db';
import { users, aiChatMessages, chatMessageChunks } from '@/db/schema';
import { eq } from 'drizzle-orm';
import {
  notifyStream,
  persistChunk,
  loadChunksFromSeq,
  deleteChunks,
  streamChannel,
  type StreamEvent,
} from '@/lib/ai-pm/streaming';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000100';

async function ensureUser() {
  await db.insert(users).values({ id: TEST_USER_ID, email: 'streaming@example.com' }).onConflictDoNothing();
}

async function cleanup() {
  await db.delete(chatMessageChunks);
  await db.delete(aiChatMessages).where(eq(aiChatMessages.userId, TEST_USER_ID));
}

async function insertPlaceholder(): Promise<string> {
  const [row] = await db.insert(aiChatMessages).values({
    userId: TEST_USER_ID, role: 'assistant', content: '', toolCalls: [], decisionId: null,
  }).returning();
  return row.id;
}

describe('streaming', () => {
  beforeAll(async () => { await ensureUser(); await cleanup(); });
  afterEach(async () => { await cleanup(); });

  it('streamChannel returns prefixed channel name', () => {
    expect(streamChannel('abc-123')).toBe('chat:abc-123');
  });

  it('persistChunk + loadChunksFromSeq round-trip and order by seq', async () => {
    const id = await insertPlaceholder();
    await persistChunk(db, id, 1, 'hello ');
    await persistChunk(db, id, 2, 'world');
    await persistChunk(db, id, 3, '!');
    const got = await loadChunksFromSeq(db, id, 0);
    expect(got.map(c => c.text).join('')).toBe('hello world!');
    expect(got.map(c => c.seq)).toEqual([1, 2, 3]);
  });

  it('loadChunksFromSeq with fromSeq returns only newer rows', async () => {
    const id = await insertPlaceholder();
    await persistChunk(db, id, 1, 'a');
    await persistChunk(db, id, 2, 'b');
    await persistChunk(db, id, 3, 'c');
    const got = await loadChunksFromSeq(db, id, 1);
    expect(got.map(c => c.text)).toEqual(['b', 'c']);
  });

  it('deleteChunks wipes all chunks for a message', async () => {
    const id = await insertPlaceholder();
    await persistChunk(db, id, 1, 'a');
    await persistChunk(db, id, 2, 'b');
    await deleteChunks(db, id);
    expect(await loadChunksFromSeq(db, id, 0)).toEqual([]);
  });

  it('notifyStream + sql.listen round-trip delivers the event', async () => {
    const id = await insertPlaceholder();
    const received: StreamEvent[] = [];
    const sub = await sql.listen(streamChannel(id), (payload) => {
      received.push(JSON.parse(payload));
    });
    try {
      await notifyStream(sql, id, { type: 'text_chunk', seq: 1, text: 'hi' });
      // Give postgres a moment to deliver
      await new Promise((r) => setTimeout(r, 100));
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ type: 'text_chunk', seq: 1, text: 'hi' });
    } finally {
      await sub.unlisten();
    }
  });
});
```

- [ ] **Step 2: Run tests — fail**

```bash
npx vitest run src/lib/ai-pm/__tests__/streaming.test.ts
```
Expected: module not found.

- [ ] **Step 3: Implement `src/lib/ai-pm/streaming.ts`**

```ts
import { asc, desc, eq, gt, and } from 'drizzle-orm';
import { chatMessageChunks } from '@/db/schema';
import type { db as Db, sql as SqlClient } from '@/db';
import type { ToolCallEntry } from '@/lib/ai-pm/chat-loop';
import type { LlmUsage } from '@/lib/ai-pm/llm';

export type StreamEvent =
  | { type: 'started'; placeholderId: string }
  | { type: 'tool_start'; toolName: string; args: unknown }
  | { type: 'tool_done'; entry: ToolCallEntry }
  | { type: 'text_chunk'; seq: number; text: string }
  | { type: 'done'; decisionId: string | null; usage: LlmUsage }
  | { type: 'error'; kind: string; message: string };

export function streamChannel(messageId: string): string {
  return `chat:${messageId}`;
}

export async function notifyStream(
  sql: typeof SqlClient,
  messageId: string,
  event: StreamEvent,
): Promise<void> {
  await sql.notify(streamChannel(messageId), JSON.stringify(event));
}

export async function persistChunk(
  database: typeof Db,
  messageId: string,
  seq: number,
  text: string,
): Promise<void> {
  await database
    .insert(chatMessageChunks)
    .values({ messageId, seq, text })
    .onConflictDoNothing();
}

export async function loadChunksFromSeq(
  database: typeof Db,
  messageId: string,
  fromSeq: number,
): Promise<Array<{ seq: number; text: string }>> {
  const rows = await database
    .select({ seq: chatMessageChunks.seq, text: chatMessageChunks.text })
    .from(chatMessageChunks)
    .where(and(eq(chatMessageChunks.messageId, messageId), gt(chatMessageChunks.seq, fromSeq)))
    .orderBy(asc(chatMessageChunks.seq));
  return rows;
}

export async function deleteChunks(
  database: typeof Db,
  messageId: string,
): Promise<void> {
  await database.delete(chatMessageChunks).where(eq(chatMessageChunks.messageId, messageId));
}
```

Note: `ToolCallEntry` lives in `@/lib/ai-pm/chat-loop`. The `StreamEvent` import there creates a one-way dependency (streaming → chat-loop), not a cycle.

- [ ] **Step 4: Run tests — pass**

```bash
npx vitest run src/lib/ai-pm/__tests__/streaming.test.ts
```
Expected: 5/5 green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai-pm/streaming.ts src/lib/ai-pm/__tests__/streaming.test.ts
git commit -m "feat(ai-pm): streaming bridge (NOTIFY/LISTEN + chunk persistence)"
```

---

## Task 3: `callSonnetTools` streaming support

**Files:**
- Modify: `src/lib/ai-pm/llm.ts`
- Modify: `src/lib/ai-pm/__tests__/llm.test.ts`

`callSonnetTools` gains two optional callbacks: `onTextChunk` and `onToolUseStart`. When `onTextChunk` is set, the helper uses the Anthropic SDK's streaming API and forwards each text delta.

- [ ] **Step 1: Append failing tests**

Append to `src/lib/ai-pm/__tests__/llm.test.ts`:

```ts
describe('callSonnetTools — streaming', () => {
  it('invokes onTextChunk for each text delta and returns the assembled text', async () => {
    const chunks: string[] = [];
    function makeStreamFactory() {
      return () => ({
        messages: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stream: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } };
              yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo!' } };
            },
            finalMessage: async () => ({
              content: [{ type: 'text', text: 'Hello!' }],
              usage: { input_tokens: 2, output_tokens: 2 },
            }),
          }),
        },
      });
    }

    const got = await callSonnetTools({
      apiKey: 'k', systemPrompt: 'sys', messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      factory: makeStreamFactory() as any,
      onTextChunk: (c) => { chunks.push(c); },
    });
    expect(got.ok).toBe(true);
    if (got.ok && got.data.kind === 'text') {
      expect(got.data.text).toBe('Hello!');
    }
    expect(chunks).toEqual(['Hel', 'lo!']);
  });

  it('streaming path forwards onToolUseStart when the model picks a tool', async () => {
    const starts: Array<{ toolName: string; args: unknown }> = [];
    function makeFactory() {
      return () => ({
        messages: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stream: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_5', name: 'read_portfolio', input: {} } };
            },
            finalMessage: async () => ({
              content: [{ type: 'tool_use', id: 'tu_5', name: 'read_portfolio', input: {} }],
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          }),
        },
      });
    }

    const got = await callSonnetTools({
      apiKey: 'k', systemPrompt: 'sys', messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'read_portfolio', description: 'x', schema: (await import('zod')).z.object({}) }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      factory: makeFactory() as any,
      onTextChunk: () => {},
      onToolUseStart: (info) => { starts.push(info); },
    });
    expect(got.ok).toBe(true);
    if (got.ok && got.data.kind === 'tool_use') {
      expect(got.data.toolName).toBe('read_portfolio');
    }
    expect(starts).toEqual([{ toolName: 'read_portfolio', args: {} }]);
  });
});
```

- [ ] **Step 2: Run — fail**

```bash
npx vitest run src/lib/ai-pm/__tests__/llm.test.ts -t streaming
```

- [ ] **Step 3: Extend `callSonnetTools` in `src/lib/ai-pm/llm.ts`**

Add the new optional params to the signature:

```ts
export async function callSonnetTools(params: {
  apiKey: string;
  systemPrompt: string;
  messages: AnthropicChatMessage[];
  tools: ToolDefinition<unknown>[];
  factory?: AnthropicFactory;
  maxTokens?: number;
  cacheSystem?: boolean;
  onTextChunk?: (chunk: string) => void | Promise<void>;
  onToolUseStart?: (info: { toolName: string; args: unknown }) => void | Promise<void>;
}): Promise<LlmResult<SonnetToolsResponse>>
```

Inside the function body, branch on whether streaming is requested:

```ts
const useStream = typeof params.onTextChunk === 'function';

if (useStream) {
  const tools = params.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: zodToJsonSchema(t.schema),
  }));

  let stream: ReturnType<NonNullable<ReturnType<AnthropicFactory>['messages']['stream']>>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stream = (client.messages as any).stream({
      model: MODEL_SONNET,
      max_tokens: params.maxTokens ?? 2048,
      system: buildSystem(params.systemPrompt, cacheSystem),
      tools,
      messages: params.messages,
    });
  } catch (err) {
    return {
      ok: false,
      error: { kind: 'API_ERROR', message: err instanceof Error ? err.message : String(err) },
    };
  }

  try {
    for await (const evt of stream) {
      if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && typeof evt.delta.text === 'string') {
        await params.onTextChunk!(evt.delta.text);
      } else if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use' && params.onToolUseStart) {
        await params.onToolUseStart({ toolName: evt.content_block.name, args: evt.content_block.input ?? {} });
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: { kind: 'API_ERROR', message: err instanceof Error ? err.message : String(err) },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const final = await (stream as any).finalMessage() as AnthropicMessageResponse;
  return parseSonnetToolsResponse(final, params.tools);
}

// Non-streaming path (existing implementation untouched below):
```

Refactor the existing non-streaming body into a helper `parseSonnetToolsResponse(response, tools)` that returns the same `LlmResult<SonnetToolsResponse>`. Both branches reuse it.

You must also widen the `AnthropicLike.messages` interface to include an optional `stream` method:

```ts
interface AnthropicLike {
  messages: {
    create: (params: Record<string, unknown>) => Promise<AnthropicMessageResponse>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stream?: (params: Record<string, unknown>) => any;
  };
}
```

The existing `defaultFactory` returns the real Anthropic SDK client, which already exposes `messages.stream(...)`.

- [ ] **Step 4: Run tests — pass**

```bash
npx vitest run src/lib/ai-pm/__tests__/llm.test.ts
```
Expected: all existing tests + the 2 streaming tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai-pm/llm.ts src/lib/ai-pm/__tests__/llm.test.ts
git commit -m "feat(ai-pm): callSonnetTools streaming via onTextChunk/onToolUseStart"
```

---

## Task 4: `runToolLoop` `onEvent` callback

**Files:**
- Modify: `src/lib/ai-pm/chat-loop.ts`
- Modify: `src/lib/ai-pm/__tests__/chat-loop.test.ts`

`runToolLoop` accepts `onEvent?: (event: StreamEvent) => Promise<void> | void` and emits events at well-defined points. Failures inside the callback are caught and logged, never abort the loop.

- [ ] **Step 1: Append failing tests**

Append to `src/lib/ai-pm/__tests__/chat-loop.test.ts`:

```ts
import type { StreamEvent } from '@/lib/ai-pm/streaming';

describe('runToolLoop — onEvent', () => {
  it('emits started, tool_start/tool_done per tool, and done at end', async () => {
    const events: StreamEvent[] = [];
    const llmFn = vi.fn()
      .mockResolvedValueOnce(llmOk({ kind: 'tool_use', toolName: 'read_portfolio', toolUseId: 'tu1', args: {} }))
      .mockResolvedValueOnce(llmOk({ kind: 'text', text: 'ok' }));
    const executeToolFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: null, summary: 'snap', payload: {} });

    await runToolLoop({
      userMessage: 'x', history: [], ctx: ctxStub(),
      llmFn, executeToolFn,
      onEvent: (e) => { events.push(e); },
    });

    const types = events.map((e) => e.type);
    expect(types).toContain('started');
    expect(types.filter((t) => t === 'tool_start')).toHaveLength(1);
    expect(types.filter((t) => t === 'tool_done')).toHaveLength(1);
    expect(types).toContain('done');
  });

  it('onEvent throwing does not abort the loop', async () => {
    const llmFn = vi.fn().mockResolvedValueOnce(llmOk({ kind: 'text', text: 'fine' }));
    const onEvent = vi.fn().mockRejectedValue(new Error('downstream dead'));
    const got = await runToolLoop({
      userMessage: 'x', history: [], ctx: ctxStub(),
      llmFn, executeToolFn: vi.fn(),
      onEvent,
    });
    expect(got.assistantText).toBe('fine');
  });

  it('emits an error event when llmFn returns API_ERROR', async () => {
    const events: StreamEvent[] = [];
    const llmFn = vi.fn().mockResolvedValueOnce({ ok: false as const, error: { kind: 'API_ERROR', message: 'boom' } });
    await runToolLoop({
      userMessage: 'x', history: [], ctx: ctxStub(),
      llmFn, executeToolFn: vi.fn(),
      onEvent: (e) => { events.push(e); },
    });
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });
});
```

- [ ] **Step 2: Run — fail**

```bash
npx vitest run src/lib/ai-pm/__tests__/chat-loop.test.ts
```

- [ ] **Step 3: Wire `onEvent` in `src/lib/ai-pm/chat-loop.ts`**

Extend `RunToolLoopParams`:

```ts
import type { StreamEvent } from '@/lib/ai-pm/streaming';

export interface RunToolLoopParams {
  ...existing fields...
  onEvent?: (event: StreamEvent) => Promise<void> | void;
}
```

Helper inside the function:

```ts
const onEvent = params.onEvent;
const emit = async (event: StreamEvent): Promise<void> => {
  if (!onEvent) return;
  try {
    await onEvent(event);
  } catch (err) {
    // never abort the loop on a downstream notify failure
    // eslint-disable-next-line no-console
    console.warn('runToolLoop.onEvent threw', err);
  }
};
```

Emit the events at the right points:

```ts
await emit({ type: 'started', placeholderId: params.ctx.chatMessageId ?? '' });
```

After `if (!llmRes.ok)`:
```ts
await emit({ type: 'error', kind: llmRes.error.kind, message: llmRes.error.message });
return { ... };
```

Before each tool dispatch:
```ts
await emit({ type: 'tool_start', toolName, args: tu.args });
```

After each tool dispatch and before pushing the entry:
```ts
const entry: ToolCallEntry = { toolName, args: tu.args, status: exec.status, decisionId: exec.decisionId, summary: exec.summary };
toolCallEntries.push(entry);
await emit({ type: 'tool_done', entry });
```

Before each early return (`text reply`, `MAX_TURNS`, `kill switch mid-loop`, `cost cap`) emit:
```ts
await emit({
  type: 'done',
  decisionId: toolCallEntries.find((e) => e.decisionId)?.decisionId ?? null,
  usage: cumulativeUsage,
});
```

Be careful to emit `done` BEFORE returning (use `await` so SSE order is right).

- [ ] **Step 4: Run tests — pass**

```bash
npx vitest run src/lib/ai-pm/__tests__/chat-loop.test.ts
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai-pm/chat-loop.ts src/lib/ai-pm/__tests__/chat-loop.test.ts
git commit -m "feat(ai-pm): runToolLoop emits StreamEvents via onEvent"
```

---

## Task 5: POST route pre-inserts placeholder + returns `placeholderId`

**Files:**
- Modify: `src/app/api/ai-pm/chat/route.ts`
- Modify: `src/app/api/ai-pm/chat/__tests__/route.test.ts`
- Modify: `src/lib/ai-pm/events.ts`

The placeholder assistant row is created synchronously in the POST handler so the client can immediately open the stream. The Inngest event carries the new id.

- [ ] **Step 1: Update `ChatPayload` in `src/lib/ai-pm/events.ts`**

Add a field:
```ts
export interface ChatPayload extends BaseEventPayload {
  symbol: null;
  chatMessageId: string;
  userMessage: string;
  assistantPlaceholderId: string;
}
```

- [ ] **Step 2: Extend tests in `src/app/api/ai-pm/chat/__tests__/route.test.ts`**

If the file doesn't have route tests today (the existing tests live under `/chat/history/`), create one. Otherwise, add:

```ts
it('inserts placeholder assistant row and returns placeholderId', async () => {
  // existing user+config setup ...
  const res = await POST(req(JSON.stringify({ configId: CONFIG_ID, message: 'hello' })));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.placeholderId).toMatch(/^[0-9a-f-]{36}$/);
  const rows = await db.select().from(aiChatMessages).where(eq(aiChatMessages.userId, TEST_USER_ID));
  const assistantRow = rows.find((r) => r.id === body.placeholderId);
  expect(assistantRow).toBeTruthy();
  expect(assistantRow?.role).toBe('assistant');
  expect(assistantRow?.content).toBe('');
});
```

Update the existing event-send assertion (if any) to also include `assistantPlaceholderId` in the emitted event body.

- [ ] **Step 3: Run — fail**

```bash
npx vitest run src/app/api/ai-pm/chat/__tests__/route.test.ts
```

- [ ] **Step 4: Update route in `src/app/api/ai-pm/chat/route.ts`**

Read the current body. After the user-row insert and before the `inngest.send`, add the assistant placeholder insert:

```ts
const [assistantPlaceholder] = await db
  .insert(aiChatMessages)
  .values({ userId: user.id, role: 'assistant', content: '', toolCalls: [], decisionId: null })
  .returning();
```

Update the `inngest.send` payload:

```ts
await inngest.send({
  name: 'ai-pm/event.chat',
  data: {
    configId: body.configId,
    emittedAt: new Date().toISOString(),
    symbol: null,
    chatMessageId: row.id,
    userMessage: truncated,
    assistantPlaceholderId: assistantPlaceholder.id,
  },
});
```

Update the response:
```ts
return NextResponse.json({ ok: true, chatMessageId: row.id, placeholderId: assistantPlaceholder.id });
```

- [ ] **Step 5: Tests pass**

```bash
npx vitest run src/app/api/ai-pm/chat/__tests__/route.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/app/api/ai-pm/chat/route.ts src/app/api/ai-pm/chat/__tests__/ src/lib/ai-pm/events.ts
git commit -m "feat(ai-pm): POST /api/ai-pm/chat pre-inserts assistant placeholder"
```

---

## Task 6: `runChatPipeline` uses `payload.assistantPlaceholderId` + notifier

**Files:**
- Modify: `src/lib/ai-pm/chat-pipeline.ts`
- Modify: `src/lib/ai-pm/__tests__/chat-pipeline.test.ts`

Pipeline reads `payload.assistantPlaceholderId` instead of inserting its own row, and supplies a notifier to `runToolLoop` that forwards events to `notifyStream` + persists text chunks.

- [ ] **Step 1: Append failing test**

Append to `src/lib/ai-pm/__tests__/chat-pipeline.test.ts`:

```ts
import { sql } from '@/db';
import { chatMessageChunks } from '@/db/schema';

it('uses payload.assistantPlaceholderId, emits notifications, and persists text chunks', async () => {
  const [placeholder] = await db.insert(aiChatMessages).values({
    userId: TEST_USER_ID, role: 'assistant', content: '', toolCalls: [], decisionId: null,
  }).returning();

  const events: unknown[] = [];
  const unlisten = await sql.listen(`chat:${placeholder.id}`, (p) => { events.push(JSON.parse(p)); });

  const runToolLoopFn = vi.fn().mockImplementation(async ({ onEvent }) => {
    await onEvent({ type: 'started', placeholderId: placeholder.id });
    // simulate the loop calling onTextChunk via emit:
    await onEvent({ type: 'text_chunk', seq: 1, text: 'Hel' });
    await onEvent({ type: 'text_chunk', seq: 2, text: 'lo' });
    await onEvent({ type: 'done', decisionId: null, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: 0, model: 'claude-sonnet-4-6' } });
    return {
      assistantText: 'Hello',
      toolCallEntries: [],
      cumulativeUsage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: 0, model: 'claude-sonnet-4-6' },
    };
  });

  await runChatPipeline({
    payload: {
      configId: CONFIG_ID, userMessage: 'hi', symbol: null,
      chatMessageId: 'src-stream', emittedAt: new Date().toISOString(),
      assistantPlaceholderId: placeholder.id,
    },
    aiEventId: 'evt',
    config: baseConfig,
    portfolioState: { runningBots: [], capitalUsedUsdt: 0, bingxApiKeyId: API_KEY_ID },
    db,
    loadChatHistoryFn: async () => [],
    isKillSwitchActive: async () => false,
    runToolLoopFn,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  // Wait for postgres LISTEN delivery
  await new Promise((r) => setTimeout(r, 150));

  expect(events.length).toBeGreaterThanOrEqual(4);
  // Chunks are deleted at the end of a successful pipeline run.
  const chunks = await db.select().from(chatMessageChunks).where(eq(chatMessageChunks.messageId, placeholder.id));
  expect(chunks).toEqual([]);

  await unlisten.unlisten();
});
```

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Rewrite `src/lib/ai-pm/chat-pipeline.ts`**

```ts
import { aiChatMessages } from '@/db/schema';
import type { db as Db } from '@/db';
import { sql } from '@/db';
import type { ChatPayload } from '@/lib/ai-pm/events';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';
import type { AiPmConfigDecrypted } from '@/services/ai-pm-config.service';
import { eq } from 'drizzle-orm';
import { runToolLoop, type ToolCallEntry } from '@/lib/ai-pm/chat-loop';
import type { ToolExecContext } from '@/lib/ai-pm/chat-tools';
import type { LlmUsage } from '@/lib/ai-pm/llm';
import { notifyStream, persistChunk, deleteChunks, type StreamEvent } from '@/lib/ai-pm/streaming';

export interface ChatPipelineResult {
  decisionId: string | null;
  assistantText: string;
  toolCallEntries: ToolCallEntry[];
  usage: LlmUsage;
}

export interface RunChatPipelineParams {
  payload: ChatPayload;
  aiEventId: string;
  config: AiPmConfigDecrypted;
  portfolioState: PortfolioState;
  db: typeof Db;
  loadChatHistoryFn: (userId: string, limit: number) => Promise<Array<{ role: 'user' | 'assistant'; content: string }>>;
  isKillSwitchActive: () => Promise<boolean>;
  runToolLoopFn?: typeof runToolLoop;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bingxClient?: any;
  logger: {
    info: (msg: string, ctx?: unknown) => void;
    warn: (msg: string, ctx?: unknown) => void;
    error: (msg: string, ctx?: unknown) => void;
  };
}

const HISTORY_LIMIT = 20;

function zeroUsage(): LlmUsage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, model: 'claude-sonnet-4-6' };
}

export async function runChatPipeline(params: RunChatPipelineParams): Promise<ChatPipelineResult> {
  const loop = params.runToolLoopFn ?? runToolLoop;
  const placeholderId = params.payload.assistantPlaceholderId;

  const setAssistantText = async (text: string, opts: Partial<{ toolCalls: ToolCallEntry[]; decisionId: string | null; usage: LlmUsage }>) => {
    const { toolCalls, decisionId, usage } = opts;
    await params.db
      .update(aiChatMessages)
      .set({
        content: text,
        toolCalls: toolCalls ?? [],
        decisionId: decisionId ?? null,
        ...(usage ? {
          tokensInput: usage.inputTokens,
          tokensOutput: usage.outputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          costUsd: String(usage.costUsd),
        } : {}),
      })
      .where(eq(aiChatMessages.id, placeholderId));
  };

  if (!params.config.enabled) {
    const text = 'AI is not enabled for this subaccount. Enable it from the AI PM settings page.';
    await setAssistantText(text, {});
    await notifyStream(sql, placeholderId, { type: 'done', decisionId: null, usage: zeroUsage() });
    return { decisionId: null, assistantText: text, toolCallEntries: [], usage: zeroUsage() };
  }

  if (await params.isKillSwitchActive()) {
    const text = 'AI is currently disabled (kill switch active).';
    await setAssistantText(text, {});
    await notifyStream(sql, placeholderId, { type: 'done', decisionId: null, usage: zeroUsage() });
    return { decisionId: null, assistantText: text, toolCallEntries: [], usage: zeroUsage() };
  }

  const history = await params.loadChatHistoryFn(params.config.userId, HISTORY_LIMIT);

  const ctx: ToolExecContext = {
    userId: params.config.userId,
    configId: params.config.id,
    chatMessageId: placeholderId,
    portfolioState: params.portfolioState,
    config: params.config,
    db: params.db,
    bingxClient: params.bingxClient ?? undefined,
  };

  let textSeq = 0;
  const onEvent = async (event: StreamEvent): Promise<void> => {
    if (event.type === 'text_chunk') {
      textSeq = Math.max(textSeq, event.seq);
      try {
        await persistChunk(params.db, placeholderId, event.seq, event.text);
      } catch (err) {
        params.logger.warn('persistChunk failed', { err });
      }
    }
    try {
      await notifyStream(sql, placeholderId, event);
    } catch (err) {
      params.logger.warn('notifyStream failed', { err });
    }
  };

  let result: Awaited<ReturnType<typeof runToolLoop>>;
  try {
    result = await loop({
      userMessage: params.payload.userMessage,
      history,
      ctx,
      isKillSwitchOnFn: async () => (await params.isKillSwitchActive()),
      onEvent,
    });
  } catch (err) {
    params.logger.error('chat tool loop threw', { err });
    const text = 'Internal error during chat processing.';
    await setAssistantText(text, {});
    await onEvent({ type: 'error', kind: 'INTERNAL', message: 'pipeline crashed' });
    await onEvent({ type: 'done', decisionId: null, usage: zeroUsage() });
    await deleteChunks(params.db, placeholderId);
    return { decisionId: null, assistantText: text, toolCallEntries: [], usage: zeroUsage() };
  }

  const firstDecisionId = result.toolCallEntries.find((e) => e.decisionId)?.decisionId ?? null;
  await setAssistantText(result.assistantText, {
    toolCalls: result.toolCallEntries,
    decisionId: firstDecisionId,
    usage: result.cumulativeUsage,
  });

  // Final 'done' is normally emitted from inside runToolLoop. We emit again as a
  // safety net in case the loop returns without emitting (e.g. mocked runToolLoopFn).
  await onEvent({ type: 'done', decisionId: firstDecisionId, usage: result.cumulativeUsage });
  await deleteChunks(params.db, placeholderId);

  return {
    decisionId: firstDecisionId,
    assistantText: result.assistantText,
    toolCallEntries: result.toolCallEntries,
    usage: result.cumulativeUsage,
  };
}
```

Note: the pipeline now relies on the placeholder being created by the POST route. Existing tests that mocked `runToolLoopFn` and assumed pipeline-side insert must be updated to insert a placeholder row first (the test we just added does this).

- [ ] **Step 4: Update existing chat-pipeline tests**

The 4 pre-existing tests (`kill switch is active`, `pre-inserts ... persists toolCalls + usage`, `loop throwing`, `forwards bingxClient ...`) all assumed the pipeline inserts its own row. Update each so the test first inserts a placeholder via `db.insert(aiChatMessages)...returning()` and passes its id as `payload.assistantPlaceholderId`. The "pre-inserts" test naming becomes inaccurate — rename to "uses provided placeholder, updates it, persists toolCalls + usage".

The "kill switch / disabled" tests now expect `setAssistantText` (an UPDATE) instead of an INSERT — assertions should look up the placeholder row by id and check `content` was set, not that a new row was created.

- [ ] **Step 5: Tests pass**

```bash
npx vitest run src/lib/ai-pm/__tests__/chat-pipeline.test.ts
```
Expected: all green (existing + 1 new).

- [ ] **Step 6: Commit**

```bash
git add src/lib/ai-pm/chat-pipeline.ts src/lib/ai-pm/__tests__/chat-pipeline.test.ts
git commit -m "feat(ai-pm): chat-pipeline uses payload placeholder + emits stream events"
```

---

## Task 7: SSE endpoint `GET /api/ai-pm/chat/stream/[messageId]`

**Files:**
- Create: `src/app/api/ai-pm/chat/stream/[messageId]/route.ts`
- Create: `src/app/api/ai-pm/chat/stream/[messageId]/__tests__/route.test.ts`

The endpoint:
1. Verifies the message belongs to the authenticated user.
2. Replays persisted chunks newer than `Last-Event-ID`.
3. Subscribes to `chat:<messageId>` via `sql.listen` and forwards each NOTIFY.
4. Auto-closes on `done` / `error` or 270s timeout.

- [ ] **Step 1: Write failing tests**

```ts
// src/app/api/ai-pm/chat/stream/[messageId]/__tests__/route.test.ts
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { db, sql } from '@/db';
import { users, aiChatMessages, chatMessageChunks } from '@/db/schema';
import { eq } from 'drizzle-orm';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000110';
const OTHER_USER_ID = '00000000-0000-0000-0000-000000000111';
let currentUserId: string | null = TEST_USER_ID;

vi.mock('@/services/auth.service', () => ({
  requireAuth: vi.fn(() => {
    if (currentUserId === null) throw new Error('Authentication required.');
    return Promise.resolve({ id: currentUserId });
  }),
}));

import { GET } from '../route';

async function ensureUsers() {
  await db.insert(users).values({ id: TEST_USER_ID, email: 'stream-route@example.com' }).onConflictDoNothing();
  await db.insert(users).values({ id: OTHER_USER_ID, email: 'stream-other@example.com' }).onConflictDoNothing();
}

async function cleanup() {
  for (const u of [TEST_USER_ID, OTHER_USER_ID]) {
    await db.delete(aiChatMessages).where(eq(aiChatMessages.userId, u));
  }
}

async function placeholder(userId: string, content = ''): Promise<string> {
  const [row] = await db.insert(aiChatMessages).values({ userId, role: 'assistant', content, toolCalls: [], decisionId: null }).returning();
  return row.id;
}

describe('GET /api/ai-pm/chat/stream/[messageId]', () => {
  beforeAll(async () => { await ensureUsers(); await cleanup(); currentUserId = TEST_USER_ID; });
  afterEach(async () => { await cleanup(); currentUserId = TEST_USER_ID; });

  it('returns 401 when not authenticated', async () => {
    currentUserId = null;
    const id = await placeholder(TEST_USER_ID);
    currentUserId = null; // also after the seed
    const res = await GET(new Request(`http://localhost/api/ai-pm/chat/stream/${id}`), { params: { messageId: id } });
    expect(res.status).toBe(401);
  });

  it('returns 404 when message belongs to another user', async () => {
    const id = await placeholder(OTHER_USER_ID);
    const res = await GET(new Request(`http://localhost/api/ai-pm/chat/stream/${id}`), { params: { messageId: id } });
    expect(res.status).toBe(404);
  });

  it('replays persisted chunks for late subscribers (content already final)', async () => {
    const id = await placeholder(TEST_USER_ID, 'final reply');
    const res = await GET(new Request(`http://localhost/api/ai-pm/chat/stream/${id}`), { params: { messageId: id } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('"type":"done"');
    expect(text).toContain('final reply');
  });

  it('replays chunks newer than Last-Event-ID', async () => {
    const id = await placeholder(TEST_USER_ID);
    await db.insert(chatMessageChunks).values([
      { messageId: id, seq: 1, text: 'a' },
      { messageId: id, seq: 2, text: 'b' },
      { messageId: id, seq: 3, text: 'c' },
    ]);
    // Mark assistant row as finalized to short-circuit live LISTEN
    await db.update(aiChatMessages).set({ content: 'abc' }).where(eq(aiChatMessages.id, id));
    const res = await GET(
      new Request(`http://localhost/api/ai-pm/chat/stream/${id}`, { headers: { 'Last-Event-ID': '1' } }),
      { params: { messageId: id } },
    );
    const text = await res.text();
    expect(text).toContain('"text":"b"');
    expect(text).toContain('"text":"c"');
    expect(text).not.toContain('"text":"a"');
  });
});
```

- [ ] **Step 2: Tests fail (module not found)**

- [ ] **Step 3: Implement `src/app/api/ai-pm/chat/stream/[messageId]/route.ts`**

```ts
import { db, sql } from '@/db';
import { aiChatMessages } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
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

export async function GET(req: Request, ctx: { params: { messageId: string } }) {
  let user;
  try {
    user = await requireAuth();
  } catch {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  const messageId = ctx.params.messageId;
  const row = await db.query.aiChatMessages.findFirst({
    where: and(eq(aiChatMessages.id, messageId), eq(aiChatMessages.userId, user.id)),
  });
  if (!row) {
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }

  const lastEventId = Number(req.headers.get('Last-Event-ID') ?? '0') || 0;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: StreamEvent, id?: number) => {
        controller.enqueue(encoder.encode(sseLine(event, id)));
      };

      // 1. Replay any chunks newer than lastEventId
      const replay = await loadChunksFromSeq(db, messageId, lastEventId);
      for (const c of replay) {
        send({ type: 'text_chunk', seq: c.seq, text: c.text }, c.seq);
      }

      // 2. If the row has already been finalized, send synthetic done + close
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
        controller.close();
        return;
      }

      send({ type: 'started', placeholderId: messageId });

      // 3. Subscribe to live updates
      const subscription = await sql.listen(streamChannel(messageId), (payload: string) => {
        try {
          const evt = JSON.parse(payload) as StreamEvent;
          const id = evt.type === 'text_chunk' ? evt.seq : undefined;
          send(evt, id);
          if (evt.type === 'done' || evt.type === 'error') {
            void subscription.unlisten().catch(() => {});
            controller.close();
          }
        } catch {
          // ignore malformed
        }
      });

      // 4. Auto-close after 270s safety
      const timeout = setTimeout(() => {
        void subscription.unlisten().catch(() => {});
        controller.close();
      }, MAX_DURATION_MS);

      // 5. Cleanup on client disconnect
      req.signal.addEventListener('abort', () => {
        clearTimeout(timeout);
        void subscription.unlisten().catch(() => {});
        try { controller.close(); } catch {}
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
```

- [ ] **Step 4: Tests pass**

```bash
npx vitest run src/app/api/ai-pm/chat/stream/
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/ai-pm/chat/stream/
git commit -m "feat(ai-pm): SSE endpoint GET /api/ai-pm/chat/stream/[messageId]"
```

---

## Task 8: `ChatClient` EventSource consumer + poll fallback

**Files:**
- Modify: `src/components/ai-pm/chat/ChatClient.tsx`
- Modify: `src/components/ai-pm/chat/MessageList.tsx`
- Modify: `src/components/ai-pm/chat/__tests__/ChatClient.test.tsx`

Client opens an `EventSource` after a successful POST. Falls back to the existing 2s poll on SSE error.

- [ ] **Step 1: Append failing test**

```tsx
it('opens EventSource after POST and assembles streamed chunks into a final bubble', async () => {
  let esInstance: { onmessage: ((e: MessageEvent) => void) | null; onerror: (() => void) | null; close: () => void; readyState: number };
  const EventSourceMock = vi.fn().mockImplementation(() => {
    esInstance = { onmessage: null, onerror: null, close: vi.fn(), readyState: 1 };
    return esInstance;
  });
  vi.stubGlobal('EventSource', EventSourceMock);

  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, chatMessageId: 'u1', placeholderId: 'ph1' }), { status: 200 }));

  render(wrap(
    <ChatClient configs={[CONFIG]} initialMessages={[]} initialOldestCursor={null} />,
  ));

  const ta = screen.getByPlaceholderText('Ask the portfolio manager...') as HTMLTextAreaElement;
  fireEvent.change(ta, { target: { value: 'hi' } });
  fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false });

  await waitFor(() => expect(EventSourceMock).toHaveBeenCalled());

  // Drive a couple of chunks then done
  act(() => {
    esInstance!.onmessage!(new MessageEvent('message', { data: JSON.stringify({ type: 'started', placeholderId: 'ph1' }) }));
    esInstance!.onmessage!(new MessageEvent('message', { data: JSON.stringify({ type: 'text_chunk', seq: 1, text: 'Hel' }) }));
    esInstance!.onmessage!(new MessageEvent('message', { data: JSON.stringify({ type: 'text_chunk', seq: 2, text: 'lo' }) }));
    esInstance!.onmessage!(new MessageEvent('message', { data: JSON.stringify({ type: 'done', decisionId: null, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, model: 'claude-sonnet-4-6' } }) }));
  });

  await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());
});

it('falls back to poll if EventSource errors', async () => {
  let esInstance: { onmessage: ((e: MessageEvent) => void) | null; onerror: (() => void) | null; close: () => void; readyState: number };
  const EventSourceMock = vi.fn().mockImplementation(() => {
    esInstance = { onmessage: null, onerror: null, close: vi.fn(), readyState: 1 };
    return esInstance;
  });
  vi.stubGlobal('EventSource', EventSourceMock);

  fetchMock
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, chatMessageId: 'u1', placeholderId: 'ph2' }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ id: 'pl2', role: 'assistant', content: 'poll wins', decisionId: null, toolCalls: null, createdAt: new Date().toISOString() }], nextCursor: null }), { status: 200 }));

  render(wrap(
    <ChatClient configs={[CONFIG]} initialMessages={[]} initialOldestCursor={null} />,
  ));

  const ta = screen.getByPlaceholderText('Ask the portfolio manager...') as HTMLTextAreaElement;
  fireEvent.change(ta, { target: { value: 'x' } });
  fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false });

  await waitFor(() => expect(EventSourceMock).toHaveBeenCalled());

  act(() => { esInstance!.onerror!(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

  await waitFor(() => expect(screen.getByText('poll wins')).toBeInTheDocument());
});
```

Add `EventSource` stubbing to the existing setup if not already present:
```ts
afterEach(() => {
  vi.unstubAllGlobals();
  ...
});
```

- [ ] **Step 2: Run — fail**

```bash
npx vitest run src/components/ai-pm/chat/__tests__/ChatClient.test.tsx
```

- [ ] **Step 3: Modify `ChatClient.tsx`**

Refactor `send` to:

```ts
const send = useCallback(async (text: string) => {
  const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const optimistic: Msg = {
    id: tempId, tempId, role: 'user', content: text, decisionId: null, toolCalls: null, createdAt: new Date().toISOString(),
  };
  setMessages((prev) => [...prev, optimistic]);
  setPending(true);
  setToast(null);
  pollSinceRef.current = new Date().toISOString();
  setStreamingText('');
  setStreamingToolCalls([]);

  try {
    const res = await fetch('/api/ai-pm/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configId: selectedConfigId, message: text }),
    });
    if (!res.ok) {
      setMessages((prev) => prev.map((m) => (m.tempId === tempId ? { ...m, failed: true } : m)));
      setPending(false);
      return;
    }
    const body = (await res.json()) as { placeholderId: string };
    openStream(body.placeholderId);
  } catch {
    if (!mountedRef.current) return;
    setMessages((prev) => prev.map((m) => (m.tempId === tempId ? { ...m, failed: true } : m)));
    setPending(false);
  }
}, [selectedConfigId, openStream]);
```

Add new state + refs at the top of the component:

```ts
const [streamingText, setStreamingText] = useState<string>('');
const [streamingToolCalls, setStreamingToolCalls] = useState<ToolCallEntry[]>([]);
const eventSourceRef = useRef<EventSource | null>(null);
```

Add `openStream(placeholderId: string)` callback:

```ts
const openStream = useCallback((placeholderId: string) => {
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
    startPolling();
    return;
  }
  let buffer = '';
  const toolCalls: ToolCallEntry[] = [];
  try {
    const es = new EventSource(`/api/ai-pm/chat/stream/${placeholderId}`);
    eventSourceRef.current = es;
    es.onmessage = (e: MessageEvent) => {
      let evt: StreamEvent;
      try { evt = JSON.parse(e.data); } catch { return; }
      switch (evt.type) {
        case 'text_chunk': buffer += evt.text; setStreamingText(buffer); break;
        case 'tool_start': toolCalls.push({ toolName: evt.toolName, args: evt.args, status: 'EXECUTED', decisionId: null, summary: '…' }); setStreamingToolCalls([...toolCalls]); break;
        case 'tool_done': {
          const idx = toolCalls.findIndex((t) => t.toolName === evt.entry.toolName && t.summary === '…');
          if (idx >= 0) toolCalls[idx] = evt.entry; else toolCalls.push(evt.entry);
          setStreamingToolCalls([...toolCalls]);
          break;
        }
        case 'done': {
          finalizePending(buffer, toolCalls, evt.decisionId);
          es.close();
          break;
        }
        case 'error': {
          es.close();
          startPolling();
          break;
        }
      }
    };
    es.onerror = () => {
      es.close();
      startPolling();
    };
  } catch {
    startPolling();
  }
}, [startPolling]);

const finalizePending = useCallback((text: string, calls: ToolCallEntry[], decisionId: string | null) => {
  const realId = `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  setMessages((prev) => [...prev, {
    id: realId, role: 'assistant', content: text, decisionId, toolCalls: calls, createdAt: new Date().toISOString(),
  }]);
  setStreamingText('');
  setStreamingToolCalls([]);
  setPending(false);
}, []);
```

Cleanup EventSource alongside the polling unmount cleanup:

```ts
useEffect(() => {
  mountedRef.current = true;
  return () => {
    mountedRef.current = false;
    stopPolling();
    eventSourceRef.current?.close();
  };
}, [stopPolling]);
```

Pass `streamingText` / `streamingToolCalls` into the pending bubble area via MessageList prop.

- [ ] **Step 4: Modify `MessageList.tsx`**

Add new optional props:

```ts
export interface MessageListProps {
  messages: Array<ChatMessagePublic & { failed?: boolean }>;
  pending: boolean;
  oldestCursor: string | null;
  onLoadOlder: () => void;
  loadingOlder: boolean;
  onRetry?: (msg: ChatMessagePublic & { failed?: boolean }) => void;
  streamingText?: string;
  streamingToolCalls?: ToolCallEntry[];
}
```

Use them in the pending bubble:

```tsx
{pending && (
  <MessageBubble
    role="assistant"
    content={streamingText ?? ''}
    decisionId={null}
    toolCalls={streamingToolCalls && streamingToolCalls.length > 0 ? streamingToolCalls : null}
    createdAt={new Date().toISOString()}
    pending={!streamingText}
  />
)}
```

In `ChatClient`'s render:

```tsx
<MessageList
  messages={messages}
  pending={pending}
  oldestCursor={oldestCursor}
  onLoadOlder={loadOlder}
  loadingOlder={loadingOlder}
  onRetry={retryFailed}
  streamingText={streamingText}
  streamingToolCalls={streamingToolCalls}
/>
```

- [ ] **Step 5: Tests pass**

```bash
npx vitest run src/components/ai-pm/chat/__tests__/ChatClient.test.tsx
```

- [ ] **Step 6: Commit**

```bash
git add src/components/ai-pm/chat/
git commit -m "feat(ai-pm): ChatClient consumes SSE stream with poll fallback"
```

---

## Task 9: Final integration + PR

**Files:** none (verification + push).

- [ ] **Step 1: Full suite + build**

```bash
npx vitest run 2>&1 | tail -10
npm run build 2>&1 | tail -15
```
Expected: tests green; build clean.

- [ ] **Step 2: Manual smoke**

Run `npm run dev` + `npm run inngest`. Open `/dashboard/ai-pm/chat`:
1. Send "show me my portfolio" → typing dots transition to flowing tokens within ~1s of the model starting; Actions list appears as tools dispatch.
2. Close the tab mid-stream; reopen on `/dashboard/ai-pm/chat` → final reply already visible (UPDATE landed).
3. Open the chat, then mid-stream simulate offline (DevTools) → poll fallback engages within 2s.
4. Trigger a backend tool loop that genuinely takes > 60s (real-mode create_bot with backtest); stream resumes after Vercel's 270s timeout via `Last-Event-ID`.

- [ ] **Step 3: Push + PR**

```bash
git push -u origin feat/ai-pm-chat-streaming
gh pr create --title "feat(ai-pm): Session 17 — streaming chat (hybrid SSE)" --body "$(cat <<'EOF'
## Summary
- New SSE endpoint GET /api/ai-pm/chat/stream/[messageId] that streams tokens + tool events to the browser via Postgres LISTEN/NOTIFY
- POST /api/ai-pm/chat pre-inserts the assistant placeholder so the client knows the stream id immediately
- callSonnetTools gains onTextChunk / onToolUseStart for Anthropic streaming
- runToolLoop emits StreamEvents via onEvent; runChatPipeline forwards them to NOTIFY + persists text chunks
- chat_message_chunks table buffers chunks for SSE replay on reconnect (deleted once final row written)
- ChatClient consumes EventSource; falls back to existing 2s poll on SSE error
- No changes to guardrails, executor, tool surface, or audit trail

## Test plan
- [ ] vitest green
- [ ] build green
- [ ] Manual: token-by-token render in browser
- [ ] Manual: reconnect after network drop resumes via Last-Event-ID
- [ ] Manual: poll fallback engages when SSE blocked
- [ ] Manual: long tool loop (>270s Vercel timeout) completes via reconnect

Spec: \`docs/superpowers/specs/2026-05-12-ai-pm-chat-streaming-design.md\`
Plan: \`docs/superpowers/plans/2026-05-12-ai-portfolio-manager-session-17.md\`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Schema migration `chat_message_chunks` — Task 1 ✓
- Raw `sql` export from `@/db` — Task 1 ✓
- `streaming.ts` helper (notifyStream, persistChunk, loadChunksFromSeq, deleteChunks, streamChannel, StreamEvent type) — Task 2 ✓
- `callSonnetTools` streaming (`onTextChunk`, `onToolUseStart`) — Task 3 ✓
- `runToolLoop` `onEvent` emits started/tool_start/tool_done/text_chunk/done/error — Task 4 ✓
- POST `/api/ai-pm/chat` pre-insert placeholder + return `placeholderId`, `ChatPayload.assistantPlaceholderId` — Task 5 ✓
- `runChatPipeline` uses provided placeholderId + wires notifier — Task 6 ✓
- SSE endpoint with auth, ownership, Last-Event-ID replay, synthetic done for already-finalized rows, 270s safety — Task 7 ✓
- ChatClient EventSource consumer + poll fallback + streaming overlay — Task 8 ✓
- Manual smoke + PR — Task 9 ✓

**Placeholder scan:** none — all steps show concrete code. The `Refactor the existing non-streaming body into a helper parseSonnetToolsResponse` in Task 3 names the helper precisely; the engineer extracts the existing branch body verbatim into that function.

**Type consistency:**
- `StreamEvent` defined in `streaming.ts` (Task 2), consumed in chat-loop (Task 4), chat-pipeline (Task 6), SSE route (Task 7), ChatClient (Task 8). One source of truth.
- `ToolCallEntry` imported from `@/lib/ai-pm/chat-loop` into `streaming.ts` (Task 2). One-way dependency.
- `LlmUsage` imported from `llm.ts`.
- `ChatPayload.assistantPlaceholderId` defined in Task 5, consumed in Task 6 and Task 7's mocked tests.
- `ChatClient` state `streamingText` / `streamingToolCalls` introduced in Task 8 and threaded into `MessageList` same task.

**Known gaps / accepted:**
- Tests for `callSonnetTools` streaming mock an Anthropic-like async iterator; production code relies on the real SDK conforming to the same shape (Anthropic SDK's `messages.stream(...)` does).
- SSE auto-reconnect via `Last-Event-ID` is exercised in the route test (header replay); end-to-end browser reconnect is a manual smoke item.
- Edge runtime explicitly NOT supported by the SSE endpoint (LISTEN needs a long-lived Node connection); `runtime = 'nodejs'` enforces this.
- Per-config chat threads stay deferred (S15b backlog).
