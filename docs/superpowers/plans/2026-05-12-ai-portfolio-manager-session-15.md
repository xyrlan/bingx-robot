# AI Portfolio Manager — Session 15: Chat UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a conversational dashboard UI at `/dashboard/ai-pm/chat` so users can read AI Portfolio Manager chat history and send new messages, with sync UX delivered via short polling on top of the existing async chat backend.

**Architecture:** Server-rendered page hydrates a single client orchestrator (`ChatClient`) that owns state, polling, and fetches. One new backend endpoint `GET /api/ai-pm/chat/history` with cursor-paginate-older and `since`-poll-newer modes. No DB migration. No changes to existing chat POST or pipeline. Single per-user thread; config picker only routes outbound messages.

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind v4, HeroUI v3, Drizzle ORM, next-intl, Vitest + React Testing Library.

**Spec:** `docs/superpowers/specs/2026-05-12-ai-pm-chat-ui-design.md`

**Branch:** `feat/ai-pm-chat-ui` (already created, spec committed).

---

## File Manifest

**New:**
- `src/services/ai-pm-chat-history.service.ts`
- `src/services/__tests__/ai-pm-chat-history.service.test.ts`
- `src/app/api/ai-pm/chat/history/route.ts`
- `src/app/api/ai-pm/chat/history/__tests__/route.test.ts`
- `src/components/ai-pm/chat/MessageBubble.tsx`
- `src/components/ai-pm/chat/__tests__/MessageBubble.test.tsx`
- `src/components/ai-pm/chat/ComposeBar.tsx`
- `src/components/ai-pm/chat/__tests__/ComposeBar.test.tsx`
- `src/components/ai-pm/chat/MessageList.tsx`
- `src/components/ai-pm/chat/ChatHeader.tsx`
- `src/components/ai-pm/chat/ChatClient.tsx`
- `src/components/ai-pm/chat/__tests__/ChatClient.test.tsx`
- `src/app/(dashboard)/dashboard/ai-pm/chat/page.tsx`

**Modified:**
- `src/components/ai-pm/types.ts` (add `ChatMessagePublic` re-export)
- `src/components/layout/sidebar.tsx` (add Chat nav entry)
- `messages/en.json`, `messages/pt.json`, `messages/zh.json` (`AiPm.Chat.*` + `Nav.aiChat`)

---

## Task 1: Chat history service

**Files:**
- Create: `src/services/ai-pm-chat-history.service.ts`
- Test: `src/services/__tests__/ai-pm-chat-history.service.test.ts`

Exports `ChatMessagePublic`, `listChatMessages`, `decodeChatCursor`, `encodeChatCursor`. Returned rows are ordered `createdAt DESC, id DESC` (newest first). `nextCursor` is `null` when `since` is used or when fewer than `limit` rows returned.

- [ ] **Step 1: Write failing tests**

```ts
// src/services/__tests__/ai-pm-chat-history.service.test.ts
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { db } from '@/db';
import { users, aiChatMessages } from '@/db/schema';
import { eq } from 'drizzle-orm';
import {
  listChatMessages,
  encodeChatCursor,
  decodeChatCursor,
} from '@/services/ai-pm-chat-history.service';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000060';
const OTHER_USER_ID = '00000000-0000-0000-0000-000000000061';

async function ensureUsers() {
  await db.insert(users).values({ id: TEST_USER_ID, email: 'chat-svc@example.com' }).onConflictDoNothing();
  await db.insert(users).values({ id: OTHER_USER_ID, email: 'chat-svc-other@example.com' }).onConflictDoNothing();
}

async function cleanup() {
  await db.delete(aiChatMessages).where(eq(aiChatMessages.userId, TEST_USER_ID));
  await db.delete(aiChatMessages).where(eq(aiChatMessages.userId, OTHER_USER_ID));
}

async function seed(userId: string, count: number, startMs: number) {
  const rows = Array.from({ length: count }, (_, i) => ({
    userId,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `msg-${i}`,
    createdAt: new Date(startMs + i * 1000),
  }));
  await db.insert(aiChatMessages).values(rows);
}

describe('ai-pm-chat-history service', () => {
  beforeAll(async () => {
    await ensureUsers();
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
  });

  it('listChatMessages returns newest-first up to limit', async () => {
    await seed(TEST_USER_ID, 5, Date.now() - 60_000);
    const got = await listChatMessages(TEST_USER_ID, { limit: 3 });
    expect(got.messages).toHaveLength(3);
    expect(got.messages[0].content).toBe('msg-4');
    expect(got.messages[2].content).toBe('msg-2');
    expect(got.nextCursor).not.toBeNull();
  });

  it('listChatMessages returns null cursor when fewer than limit', async () => {
    await seed(TEST_USER_ID, 2, Date.now() - 60_000);
    const got = await listChatMessages(TEST_USER_ID, { limit: 30 });
    expect(got.messages).toHaveLength(2);
    expect(got.nextCursor).toBeNull();
  });

  it('listChatMessages paginates older with cursor', async () => {
    await seed(TEST_USER_ID, 6, Date.now() - 60_000);
    const first = await listChatMessages(TEST_USER_ID, { limit: 3 });
    expect(first.messages.map(m => m.content)).toEqual(['msg-5', 'msg-4', 'msg-3']);
    const cursor = decodeChatCursor(first.nextCursor!);
    const second = await listChatMessages(TEST_USER_ID, { limit: 3, cursor });
    expect(second.messages.map(m => m.content)).toEqual(['msg-2', 'msg-1', 'msg-0']);
    expect(second.nextCursor).toBeNull();
  });

  it('listChatMessages with since returns only newer rows and null cursor', async () => {
    const start = Date.now() - 60_000;
    await seed(TEST_USER_ID, 4, start);
    const cutoff = new Date(start + 1500); // includes msg-2, msg-3
    const got = await listChatMessages(TEST_USER_ID, { limit: 30, since: cutoff });
    expect(got.messages.map(m => m.content).sort()).toEqual(['msg-2', 'msg-3']);
    expect(got.nextCursor).toBeNull();
  });

  it('listChatMessages scopes by userId', async () => {
    await seed(TEST_USER_ID, 2, Date.now() - 60_000);
    await seed(OTHER_USER_ID, 2, Date.now() - 60_000);
    const got = await listChatMessages(TEST_USER_ID, { limit: 30 });
    expect(got.messages).toHaveLength(2);
    expect(got.messages.every(m => m.content.startsWith('msg-'))).toBe(true);
  });

  it('encodeChatCursor / decodeChatCursor round-trip', () => {
    const c = { createdAt: new Date('2026-05-12T00:00:00Z'), id: '00000000-0000-0000-0000-0000000000aa' };
    const enc = encodeChatCursor(c);
    const dec = decodeChatCursor(enc);
    expect(dec.id).toBe(c.id);
    expect(dec.createdAt.toISOString()).toBe(c.createdAt.toISOString());
  });

  it('decodeChatCursor throws on bad input', () => {
    expect(() => decodeChatCursor('not-base64-json')).toThrow(/Invalid cursor/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/services/__tests__/ai-pm-chat-history.service.test.ts
```
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement service**

```ts
// src/services/ai-pm-chat-history.service.ts
import { db } from '@/db';
import { aiChatMessages } from '@/db/schema';
import { and, desc, eq, gt, lt, or } from 'drizzle-orm';

export interface ChatMessagePublic {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  decisionId: string | null;
  toolCalls: unknown;
  createdAt: string;
}

export interface ListChatMessagesOpts {
  limit: number;
  cursor?: { createdAt: Date; id: string };
  since?: Date;
}

export interface ListChatMessagesResult {
  messages: ChatMessagePublic[];
  nextCursor: string | null;
}

const MAX_LIMIT = 50;

export function encodeChatCursor(c: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: c.createdAt.toISOString(), id: c.id }),
  ).toString('base64');
}

export function decodeChatCursor(s: string): { createdAt: Date; id: string } {
  let parsed: { createdAt?: unknown; id?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
  } catch {
    throw new Error('Invalid cursor');
  }
  if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') {
    throw new Error('Invalid cursor');
  }
  const createdAt = new Date(parsed.createdAt);
  if (Number.isNaN(createdAt.getTime())) throw new Error('Invalid cursor');
  return { createdAt, id: parsed.id };
}

export async function listChatMessages(
  userId: string,
  opts: ListChatMessagesOpts,
): Promise<ListChatMessagesResult> {
  const limit = Math.min(Math.max(opts.limit, 1), MAX_LIMIT);

  // Mutual exclusion: since wins if both supplied.
  if (opts.since) {
    const rows = await db
      .select()
      .from(aiChatMessages)
      .where(and(eq(aiChatMessages.userId, userId), gt(aiChatMessages.createdAt, opts.since)))
      .orderBy(desc(aiChatMessages.createdAt), desc(aiChatMessages.id))
      .limit(limit);
    return { messages: rows.map(toPublic), nextCursor: null };
  }

  const whereClause = opts.cursor
    ? and(
        eq(aiChatMessages.userId, userId),
        or(
          lt(aiChatMessages.createdAt, opts.cursor.createdAt),
          and(
            eq(aiChatMessages.createdAt, opts.cursor.createdAt),
            lt(aiChatMessages.id, opts.cursor.id),
          ),
        ),
      )
    : eq(aiChatMessages.userId, userId);

  const rows = await db
    .select()
    .from(aiChatMessages)
    .where(whereClause)
    .orderBy(desc(aiChatMessages.createdAt), desc(aiChatMessages.id))
    .limit(limit);

  const messages = rows.map(toPublic);
  const nextCursor =
    rows.length === limit
      ? encodeChatCursor({ createdAt: rows[rows.length - 1].createdAt, id: rows[rows.length - 1].id })
      : null;

  return { messages, nextCursor };
}

function toPublic(row: typeof aiChatMessages.$inferSelect): ChatMessagePublic {
  const role: 'user' | 'assistant' = row.role === 'assistant' ? 'assistant' : 'user';
  return {
    id: row.id,
    role,
    content: row.content ?? '',
    decisionId: row.decisionId,
    toolCalls: row.toolCalls ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/services/__tests__/ai-pm-chat-history.service.test.ts
```
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/services/ai-pm-chat-history.service.ts src/services/__tests__/ai-pm-chat-history.service.test.ts
git commit -m "feat(ai-pm): chat history service with cursor + since pagination"
```

---

## Task 2: GET /api/ai-pm/chat/history route

**Files:**
- Create: `src/app/api/ai-pm/chat/history/route.ts`
- Test: `src/app/api/ai-pm/chat/history/__tests__/route.test.ts`

Parses `limit`, `cursor`, `since`. Returns 401 on missing auth, 400 on parse error, 200 with `{messages, nextCursor}` otherwise. `since` wins over `cursor` if both passed.

- [ ] **Step 1: Write failing tests**

```ts
// src/app/api/ai-pm/chat/history/__tests__/route.test.ts
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { db } from '@/db';
import { users, aiChatMessages } from '@/db/schema';
import { eq } from 'drizzle-orm';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000070';
let currentUserId: string | null = TEST_USER_ID;

vi.mock('@/services/auth.service', () => ({
  requireAuth: vi.fn(() => {
    if (currentUserId === null) {
      throw new Error('Authentication required. User is not logged in.');
    }
    return Promise.resolve({ id: currentUserId });
  }),
}));

import { GET } from '../route';

async function ensureUser() {
  await db.insert(users).values({ id: TEST_USER_ID, email: 'chat-route@example.com' }).onConflictDoNothing();
}

async function cleanup() {
  await db.delete(aiChatMessages).where(eq(aiChatMessages.userId, TEST_USER_ID));
}

function req(qs = ''): Request {
  return new Request(`http://localhost/api/ai-pm/chat/history${qs}`, { method: 'GET' });
}

describe('GET /api/ai-pm/chat/history', () => {
  beforeAll(async () => {
    await ensureUser();
    await cleanup();
    currentUserId = TEST_USER_ID;
  });

  afterEach(async () => {
    await cleanup();
    currentUserId = TEST_USER_ID;
  });

  it('returns 401 when not authenticated', async () => {
    currentUserId = null;
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it('returns messages newest-first', async () => {
    await db.insert(aiChatMessages).values([
      { userId: TEST_USER_ID, role: 'user', content: 'a', createdAt: new Date(Date.now() - 2000) },
      { userId: TEST_USER_ID, role: 'assistant', content: 'b', createdAt: new Date(Date.now() - 1000) },
    ]);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].content).toBe('b');
    expect(body.nextCursor).toBeNull();
  });

  it('returns 400 on invalid limit', async () => {
    const res = await GET(req('?limit=abc'));
    expect(res.status).toBe(400);
  });

  it('returns 400 on invalid cursor', async () => {
    const res = await GET(req('?cursor=garbage'));
    expect(res.status).toBe(400);
  });

  it('returns 400 on invalid since', async () => {
    const res = await GET(req('?since=not-a-date'));
    expect(res.status).toBe(400);
  });

  it('since wins over cursor if both passed', async () => {
    const old = new Date(Date.now() - 10_000);
    const recent = new Date(Date.now() - 1_000);
    await db.insert(aiChatMessages).values([
      { userId: TEST_USER_ID, role: 'user', content: 'old', createdAt: old },
      { userId: TEST_USER_ID, role: 'user', content: 'recent', createdAt: recent },
    ]);
    const cutoff = new Date(Date.now() - 5_000).toISOString();
    const res = await GET(req(`?since=${encodeURIComponent(cutoff)}&cursor=garbage`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content).toBe('recent');
    expect(body.nextCursor).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/app/api/ai-pm/chat/history/__tests__/route.test.ts
```
Expected: FAIL — route does not exist.

- [ ] **Step 3: Implement route**

```ts
// src/app/api/ai-pm/chat/history/route.ts
import { NextResponse } from 'next/server';
import { requireAuth } from '@/services/auth.service';
import {
  listChatMessages,
  decodeChatCursor,
} from '@/services/ai-pm-chat-history.service';

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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/app/api/ai-pm/chat/history/__tests__/route.test.ts
```
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/ai-pm/chat/history/
git commit -m "feat(ai-pm): GET /api/ai-pm/chat/history endpoint"
```

---

## Task 3: i18n keys

**Files:**
- Modify: `messages/en.json`, `messages/pt.json`, `messages/zh.json`

Adds `Nav.aiChat` and the full `AiPm.Chat` block.

- [ ] **Step 1: Update `messages/en.json`**

Find the `"Nav"` object. After the existing `"aiActivity"` line, insert:

```json
"aiChat": "AI Chat",
```

Find the `"AiPm"` object. Add a `"Chat"` block alongside existing sub-objects:

```json
"Chat": {
  "title": "AI Chat",
  "subtitle": "Talk to your portfolio manager",
  "placeholder": "Ask the portfolio manager...",
  "send": "Send",
  "loadOlder": "Load older messages",
  "noMessagesYet": "No messages yet. Say hi.",
  "configLabel": "Subaccount",
  "killSwitchActive": "Kill switch is ON. AI is paused.",
  "sendFailed": "Couldn't send. Tap to retry.",
  "noResponse": "No response after 60s. Try again.",
  "sessionExpired": "Session expired. Reloading...",
  "noConfigsCta": "Set up AI Portfolio Manager first.",
  "typing": "Thinking...",
  "viewDecision": "View decision",
  "you": "You",
  "assistant": "AI"
}
```

- [ ] **Step 2: Update `messages/pt.json` with the same structure**

```json
"aiChat": "Chat IA",
```

```json
"Chat": {
  "title": "Chat IA",
  "subtitle": "Fale com seu gerente de portfólio",
  "placeholder": "Pergunte ao gerente de portfólio...",
  "send": "Enviar",
  "loadOlder": "Carregar mensagens antigas",
  "noMessagesYet": "Nenhuma mensagem ainda. Diga olá.",
  "configLabel": "Subconta",
  "killSwitchActive": "Kill switch está ON. IA pausada.",
  "sendFailed": "Falha ao enviar. Toque para tentar novamente.",
  "noResponse": "Sem resposta após 60s. Tente novamente.",
  "sessionExpired": "Sessão expirou. Recarregando...",
  "noConfigsCta": "Configure o AI Portfolio Manager primeiro.",
  "typing": "Pensando...",
  "viewDecision": "Ver decisão",
  "you": "Você",
  "assistant": "IA"
}
```

- [ ] **Step 3: Update `messages/zh.json` with the same structure**

```json
"aiChat": "AI 聊天",
```

```json
"Chat": {
  "title": "AI 聊天",
  "subtitle": "与投资组合经理对话",
  "placeholder": "向投资组合经理提问...",
  "send": "发送",
  "loadOlder": "加载更早的消息",
  "noMessagesYet": "暂无消息。打个招呼吧。",
  "configLabel": "子账户",
  "killSwitchActive": "Kill switch 已开启。AI 已暂停。",
  "sendFailed": "发送失败。点击重试。",
  "noResponse": "60秒无响应。请重试。",
  "sessionExpired": "会话已过期。重新加载...",
  "noConfigsCta": "请先配置 AI Portfolio Manager。",
  "typing": "思考中...",
  "viewDecision": "查看决策",
  "you": "你",
  "assistant": "AI"
}
```

- [ ] **Step 4: Verify JSON validity**

```bash
node -e "JSON.parse(require('fs').readFileSync('messages/en.json','utf8'))" && \
node -e "JSON.parse(require('fs').readFileSync('messages/pt.json','utf8'))" && \
node -e "JSON.parse(require('fs').readFileSync('messages/zh.json','utf8'))"
```
Expected: no output, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add messages/en.json messages/pt.json messages/zh.json
git commit -m "feat(ai-pm): i18n keys for chat UI (en/pt/zh)"
```

---

## Task 4: MessageBubble component

**Files:**
- Create: `src/components/ai-pm/chat/MessageBubble.tsx`
- Test: `src/components/ai-pm/chat/__tests__/MessageBubble.test.tsx`

Pure render. Variants: `user` (right-aligned filled), `assistant` (left-aligned Card), `pending` (left-aligned, three dots), `failed` (red tint on user bubble). If `decisionId` present on assistant, render a "View decision" link to `/dashboard/ai-pm/activity?focus=<decisionId>`.

- [ ] **Step 1: Write failing tests**

```tsx
// src/components/ai-pm/chat/__tests__/MessageBubble.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { MessageBubble } from '../MessageBubble';

const messages = {
  AiPm: {
    Chat: {
      typing: 'Thinking...',
      viewDecision: 'View decision',
      sendFailed: 'Couldn\'t send. Tap to retry.',
      you: 'You',
      assistant: 'AI',
    },
  },
};

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {node}
    </NextIntlClientProvider>
  );
}

describe('MessageBubble', () => {
  it('renders user content', () => {
    render(wrap(
      <MessageBubble
        role="user"
        content="hello"
        decisionId={null}
        toolCalls={null}
        createdAt="2026-05-12T00:00:00Z"
      />,
    ));
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('renders assistant content', () => {
    render(wrap(
      <MessageBubble
        role="assistant"
        content="hi back"
        decisionId={null}
        toolCalls={null}
        createdAt="2026-05-12T00:00:00Z"
      />,
    ));
    expect(screen.getByText('hi back')).toBeInTheDocument();
  });

  it('renders pending typing indicator instead of content', () => {
    render(wrap(
      <MessageBubble
        role="assistant"
        content=""
        decisionId={null}
        toolCalls={null}
        createdAt="2026-05-12T00:00:00Z"
        pending
      />,
    ));
    expect(screen.getByText('Thinking...')).toBeInTheDocument();
  });

  it('renders decision badge link when decisionId is present', () => {
    render(wrap(
      <MessageBubble
        role="assistant"
        content="done"
        decisionId="dec-123"
        toolCalls={null}
        createdAt="2026-05-12T00:00:00Z"
      />,
    ));
    const link = screen.getByRole('link', { name: /view decision/i });
    expect(link).toHaveAttribute('href', '/dashboard/ai-pm/activity?focus=dec-123');
  });

  it('renders failed retry hint for user role', () => {
    render(wrap(
      <MessageBubble
        role="user"
        content="x"
        decisionId={null}
        toolCalls={null}
        createdAt="2026-05-12T00:00:00Z"
        failed
      />,
    ));
    expect(screen.getByText(/Couldn't send/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/components/ai-pm/chat/__tests__/MessageBubble.test.tsx
```
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement MessageBubble**

```tsx
// src/components/ai-pm/chat/MessageBubble.tsx
'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

export interface MessageBubbleProps {
  role: 'user' | 'assistant';
  content: string;
  decisionId: string | null;
  toolCalls: unknown;
  createdAt: string;
  pending?: boolean;
  failed?: boolean;
}

export function MessageBubble(props: MessageBubbleProps) {
  const t = useTranslations('AiPm.Chat');
  const isUser = props.role === 'user';

  const containerClass = isUser
    ? 'flex justify-end mb-3'
    : 'flex justify-start mb-3';

  const bubbleBase = 'max-w-[80%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap break-words';
  const userTint = props.failed
    ? 'bg-danger/10 border border-danger/40 text-danger-foreground'
    : 'bg-accent/15 text-foreground';
  const assistantTint = 'bg-default-100 border border-default-200 text-foreground';

  return (
    <div className={containerClass}>
      <div className="flex flex-col gap-1 max-w-full">
        <div className={`${bubbleBase} ${isUser ? userTint : assistantTint}`}>
          {props.pending ? (
            <span className="inline-flex items-center gap-1 text-muted" aria-label={t('typing')}>
              <Dot delay={0} />
              <Dot delay={150} />
              <Dot delay={300} />
              <span className="ml-2">{t('typing')}</span>
            </span>
          ) : (
            props.content
          )}
        </div>

        {props.failed && (
          <span className="text-xs text-danger pl-2">{t('sendFailed')}</span>
        )}

        {!props.pending && !isUser && props.decisionId && (
          <Link
            href={`/dashboard/ai-pm/activity?focus=${props.decisionId}`}
            className="text-xs text-accent hover:underline pl-2"
          >
            {t('viewDecision')}
          </Link>
        )}
      </div>
    </div>
  );
}

function Dot({ delay }: { delay: number }) {
  return (
    <span
      className="inline-block w-1.5 h-1.5 rounded-full bg-muted animate-pulse"
      style={{ animationDelay: `${delay}ms` }}
    />
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/components/ai-pm/chat/__tests__/MessageBubble.test.tsx
```
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/components/ai-pm/chat/MessageBubble.tsx src/components/ai-pm/chat/__tests__/MessageBubble.test.tsx
git commit -m "feat(ai-pm): MessageBubble component with role + pending + failed variants"
```

---

## Task 5: ComposeBar component

**Files:**
- Create: `src/components/ai-pm/chat/ComposeBar.tsx`
- Test: `src/components/ai-pm/chat/__tests__/ComposeBar.test.tsx`

Sticky textarea + send button. Enter submits, Shift+Enter inserts newline. Max 2000 chars enforced. Disabled state hides send + greys textarea.

- [ ] **Step 1: Write failing tests**

```tsx
// src/components/ai-pm/chat/__tests__/ComposeBar.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { ComposeBar } from '../ComposeBar';

const messages = {
  AiPm: {
    Chat: {
      placeholder: 'Ask the portfolio manager...',
      send: 'Send',
    },
  },
};

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {node}
    </NextIntlClientProvider>
  );
}

describe('ComposeBar', () => {
  it('renders placeholder and send button', () => {
    render(wrap(<ComposeBar onSend={() => {}} disabled={false} />));
    expect(screen.getByPlaceholderText('Ask the portfolio manager...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
  });

  it('calls onSend with text when Enter pressed', () => {
    const onSend = vi.fn();
    render(wrap(<ComposeBar onSend={onSend} disabled={false} />));
    const ta = screen.getByPlaceholderText('Ask the portfolio manager...') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'hello' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false });
    expect(onSend).toHaveBeenCalledWith('hello');
  });

  it('does not call onSend on Shift+Enter', () => {
    const onSend = vi.fn();
    render(wrap(<ComposeBar onSend={onSend} disabled={false} />));
    const ta = screen.getByPlaceholderText('Ask the portfolio manager...') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'hello' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not call onSend with empty text', () => {
    const onSend = vi.fn();
    render(wrap(<ComposeBar onSend={onSend} disabled={false} />));
    const ta = screen.getByPlaceholderText('Ask the portfolio manager...') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '   ' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('disabled state prevents send', () => {
    const onSend = vi.fn();
    render(wrap(<ComposeBar onSend={onSend} disabled={true} />));
    const ta = screen.getByPlaceholderText('Ask the portfolio manager...') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'hi' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('caps input at 2000 chars', () => {
    render(wrap(<ComposeBar onSend={() => {}} disabled={false} />));
    const ta = screen.getByPlaceholderText('Ask the portfolio manager...') as HTMLTextAreaElement;
    expect(ta.maxLength).toBe(2000);
  });

  it('clears textarea after successful send', () => {
    const onSend = vi.fn();
    render(wrap(<ComposeBar onSend={onSend} disabled={false} />));
    const ta = screen.getByPlaceholderText('Ask the portfolio manager...') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'msg' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false });
    expect(ta.value).toBe('');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/components/ai-pm/chat/__tests__/ComposeBar.test.tsx
```
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement ComposeBar**

```tsx
// src/components/ai-pm/chat/ComposeBar.tsx
'use client';

import { useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@heroui/react';
import { Send } from 'lucide-react';

export interface ComposeBarProps {
  onSend: (text: string) => void;
  disabled: boolean;
}

const MAX = 2000;

export function ComposeBar({ onSend, disabled }: ComposeBarProps) {
  const t = useTranslations('AiPm.Chat');
  const [text, setText] = useState('');

  const submit = () => {
    if (disabled) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="sticky bottom-0 border-t border-default-200 bg-background px-3 py-3">
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, MAX))}
          onKeyDown={onKeyDown}
          maxLength={MAX}
          rows={1}
          placeholder={t('placeholder')}
          disabled={disabled}
          className="flex-1 resize-none rounded-lg border border-default-200 bg-default-50 px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50 max-h-32"
        />
        <Button
          color="primary"
          size="md"
          isDisabled={disabled || !text.trim()}
          onPress={submit}
          startContent={<Send className="w-4 h-4" />}
        >
          {t('send')}
        </Button>
      </div>
      {text.length > 1800 && (
        <div className="text-xs text-muted text-right mt-1">{text.length} / {MAX}</div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/components/ai-pm/chat/__tests__/ComposeBar.test.tsx
```
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/components/ai-pm/chat/ComposeBar.tsx src/components/ai-pm/chat/__tests__/ComposeBar.test.tsx
git commit -m "feat(ai-pm): ComposeBar with Enter-send and 2000-char limit"
```

---

## Task 6: MessageList component

**Files:**
- Create: `src/components/ai-pm/chat/MessageList.tsx`

Scroll container. Renders a "Load older" button when `oldestCursor` is non-null. Auto-scrolls to bottom on mount + on new message only if user is already near bottom (within 100px). Renders `MessageBubble` per entry. Includes a `pending` bubble when `pending=true`.

- [ ] **Step 1: Implement**

```tsx
// src/components/ai-pm/chat/MessageList.tsx
'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@heroui/react';
import { MessageBubble } from './MessageBubble';
import type { ChatMessagePublic } from '@/services/ai-pm-chat-history.service';

export interface MessageListProps {
  messages: Array<ChatMessagePublic & { failed?: boolean }>;
  pending: boolean;
  oldestCursor: string | null;
  onLoadOlder: () => void;
  loadingOlder: boolean;
}

const NEAR_BOTTOM_PX = 100;

export function MessageList({
  messages,
  pending,
  oldestCursor,
  onLoadOlder,
  loadingOlder,
}: MessageListProps) {
  const t = useTranslations('AiPm.Chat');
  const containerRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);

  // Track whether we're near the bottom right before render commits
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      wasNearBottomRef.current = distance < NEAR_BOTTOM_PX;
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Auto-scroll on mount and when messages/pending grow if user was near bottom
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (wasNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, pending]);

  if (messages.length === 0 && !pending) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted text-sm">
        {t('noMessagesYet')}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto px-3 py-4"
    >
      {oldestCursor && (
        <div className="flex justify-center mb-3">
          <Button
            size="sm"
            variant="flat"
            isLoading={loadingOlder}
            onPress={onLoadOlder}
          >
            {t('loadOlder')}
          </Button>
        </div>
      )}
      {messages.map((m) => (
        <MessageBubble
          key={m.id}
          role={m.role}
          content={m.content}
          decisionId={m.decisionId}
          toolCalls={m.toolCalls}
          createdAt={m.createdAt}
          failed={m.failed}
        />
      ))}
      {pending && (
        <MessageBubble
          role="assistant"
          content=""
          decisionId={null}
          toolCalls={null}
          createdAt={new Date().toISOString()}
          pending
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify it type-checks**

```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: no errors (or only errors unrelated to this file).

- [ ] **Step 3: Commit**

```bash
git add src/components/ai-pm/chat/MessageList.tsx
git commit -m "feat(ai-pm): MessageList scroll container with load-older + auto-anchor"
```

---

## Task 7: ChatHeader component

**Files:**
- Create: `src/components/ai-pm/chat/ChatHeader.tsx`

Title + subtitle, kill-switch badge when active, config picker when 2+ configs.

- [ ] **Step 1: Implement**

```tsx
// src/components/ai-pm/chat/ChatHeader.tsx
'use client';

import { useTranslations } from 'next-intl';
import { Select, SelectItem, Chip } from '@heroui/react';

export interface ChatHeaderConfigOption {
  id: string;
  label: string;
  enabled: boolean;
  killSwitch: boolean;
}

export interface ChatHeaderProps {
  configs: ChatHeaderConfigOption[];
  selectedConfigId: string;
  onSelectConfig: (configId: string) => void;
}

export function ChatHeader({ configs, selectedConfigId, onSelectConfig }: ChatHeaderProps) {
  const t = useTranslations('AiPm.Chat');
  const selected = configs.find((c) => c.id === selectedConfigId);
  const killOn = selected?.killSwitch ?? false;

  return (
    <header className="border-b border-default-200 px-4 py-3 flex items-center justify-between bg-background">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold text-foreground truncate">{t('title')}</h1>
        <p className="text-xs text-muted truncate">{t('subtitle')}</p>
      </div>

      <div className="flex items-center gap-2">
        {killOn && (
          <Chip color="danger" variant="flat" size="sm">
            {t('killSwitchActive')}
          </Chip>
        )}

        {configs.length > 1 && (
          <Select
            size="sm"
            aria-label={t('configLabel')}
            selectedKeys={[selectedConfigId]}
            onSelectionChange={(keys) => {
              const next = Array.from(keys)[0];
              if (typeof next === 'string') onSelectConfig(next);
            }}
            className="w-48"
          >
            {configs.map((c) => (
              <SelectItem key={c.id}>{c.label}</SelectItem>
            ))}
          </Select>
        )}
      </div>
    </header>
  );
}
```

- [ ] **Step 2: Verify type-check**

```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: no errors related to this file.

- [ ] **Step 3: Commit**

```bash
git add src/components/ai-pm/chat/ChatHeader.tsx
git commit -m "feat(ai-pm): ChatHeader with config picker and kill-switch badge"
```

---

## Task 8: ChatClient orchestrator

**Files:**
- Create: `src/components/ai-pm/chat/ChatClient.tsx`
- Test: `src/components/ai-pm/chat/__tests__/ChatClient.test.tsx`

Owns state. Sends message via `POST /api/ai-pm/chat`. Starts poll loop after success. Stops on assistant message arrival or 60s timeout. Handles load-older + failed-send retry.

- [ ] **Step 1: Write failing tests (fake timers + mocked fetch)**

```tsx
// src/components/ai-pm/chat/__tests__/ChatClient.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { ChatClient } from '../ChatClient';

const messages = {
  AiPm: {
    Chat: {
      title: 'AI Chat',
      subtitle: 'Talk',
      placeholder: 'Ask the portfolio manager...',
      send: 'Send',
      loadOlder: 'Load older messages',
      noMessagesYet: 'No messages yet. Say hi.',
      configLabel: 'Subaccount',
      killSwitchActive: 'KILL',
      sendFailed: "Couldn't send. Tap to retry.",
      noResponse: 'No response after 60s. Try again.',
      sessionExpired: 'Session expired',
      noConfigsCta: 'Set up first',
      typing: 'Thinking...',
      viewDecision: 'View decision',
      you: 'You',
      assistant: 'AI',
    },
  },
};

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {node}
    </NextIntlClientProvider>
  );
}

const CONFIG = { id: 'cfg-1', label: 'main', enabled: true, killSwitch: false };

describe('ChatClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders initial messages', () => {
    render(wrap(
      <ChatClient
        configs={[CONFIG]}
        initialMessages={[
          { id: 'm1', role: 'user', content: 'hi', decisionId: null, toolCalls: null, createdAt: '2026-05-12T00:00:00Z' },
          { id: 'm2', role: 'assistant', content: 'hello', decisionId: null, toolCalls: null, createdAt: '2026-05-12T00:00:01Z' },
        ]}
        initialOldestCursor={null}
      />,
    ));
    expect(screen.getByText('hi')).toBeInTheDocument();
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('sends message then polls and renders assistant reply', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, chatMessageId: 'u1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [], nextCursor: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        messages: [{ id: 'a1', role: 'assistant', content: 'reply', decisionId: null, toolCalls: null, createdAt: new Date().toISOString() }],
        nextCursor: null,
      }), { status: 200 }));

    render(wrap(
      <ChatClient configs={[CONFIG]} initialMessages={[]} initialOldestCursor={null} />,
    ));

    const ta = screen.getByPlaceholderText('Ask the portfolio manager...') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'ping' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false });

    await waitFor(() => {
      expect(screen.getByText('ping')).toBeInTheDocument();
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

    await waitFor(() => {
      expect(screen.getByText('reply')).toBeInTheDocument();
    });
  });

  it('marks user message failed when POST errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'boom' }), { status: 500 }));

    render(wrap(
      <ChatClient configs={[CONFIG]} initialMessages={[]} initialOldestCursor={null} />,
    ));

    const ta = screen.getByPlaceholderText('Ask the portfolio manager...') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'x' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false });

    await waitFor(() => {
      expect(screen.getByText(/Couldn't send/i)).toBeInTheDocument();
    });
  });

  it('shows timeout toast after 60s of empty poll responses', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, chatMessageId: 'u1' }), { status: 200 }));
    // 30 empty polls
    for (let i = 0; i < 31; i++) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ messages: [], nextCursor: null }), { status: 200 }));
    }

    render(wrap(
      <ChatClient configs={[CONFIG]} initialMessages={[]} initialOldestCursor={null} />,
    ));

    const ta = screen.getByPlaceholderText('Ask the portfolio manager...') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'x' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false });

    for (let i = 0; i < 31; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    }

    await waitFor(() => {
      expect(screen.getByText(/No response after 60s/i)).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/components/ai-pm/chat/__tests__/ChatClient.test.tsx
```
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement ChatClient**

```tsx
// src/components/ai-pm/chat/ChatClient.tsx
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { ChatMessagePublic } from '@/services/ai-pm-chat-history.service';
import { ChatHeader, type ChatHeaderConfigOption } from './ChatHeader';
import { MessageList } from './MessageList';
import { ComposeBar } from './ComposeBar';

export interface ChatClientProps {
  configs: ChatHeaderConfigOption[];
  initialMessages: ChatMessagePublic[];
  initialOldestCursor: string | null;
}

type Msg = ChatMessagePublic & { failed?: boolean; tempId?: string };

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 30;

export function ChatClient({ configs, initialMessages, initialOldestCursor }: ChatClientProps) {
  const t = useTranslations('AiPm.Chat');

  const defaultConfigId = useMemo(() => {
    const enabled = configs.find((c) => c.enabled);
    return enabled?.id ?? configs[0]?.id ?? '';
  }, [configs]);

  const [selectedConfigId, setSelectedConfigId] = useState(defaultConfigId);
  const [messages, setMessages] = useState<Msg[]>(() => initialMessages.slice().reverse());
  const [oldestCursor, setOldestCursor] = useState<string | null>(initialOldestCursor);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [pending, setPending] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollAttemptsRef = useRef(0);
  const pollSinceRef = useRef<string | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    pollAttemptsRef.current = 0;
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollAttemptsRef.current = 0;
    pollRef.current = setInterval(async () => {
      pollAttemptsRef.current += 1;
      try {
        const sinceParam = pollSinceRef.current ? `?since=${encodeURIComponent(pollSinceRef.current)}` : '';
        const res = await fetch(`/api/ai-pm/chat/history${sinceParam}`);
        if (res.ok) {
          const body = (await res.json()) as { messages: ChatMessagePublic[] };
          const assistantMsg = body.messages.find((m) => m.role === 'assistant');
          if (assistantMsg) {
            setMessages((prev) => [...prev, assistantMsg]);
            setPending(false);
            stopPolling();
            return;
          }
        }
      } catch {
        // silent, counted toward attempts
      }
      if (pollAttemptsRef.current >= POLL_MAX_ATTEMPTS) {
        setPending(false);
        setToast(t('noResponse'));
        stopPolling();
      }
    }, POLL_INTERVAL_MS);
  }, [stopPolling, t]);

  const send = useCallback(async (text: string) => {
    const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const optimistic: Msg = {
      id: tempId,
      tempId,
      role: 'user',
      content: text,
      decisionId: null,
      toolCalls: null,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    setPending(true);
    setToast(null);
    pollSinceRef.current = new Date().toISOString();

    try {
      const res = await fetch('/api/ai-pm/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ configId: selectedConfigId, message: text }),
      });
      if (!res.ok) {
        setMessages((prev) =>
          prev.map((m) => (m.tempId === tempId ? { ...m, failed: true } : m)),
        );
        setPending(false);
        return;
      }
      startPolling();
    } catch {
      setMessages((prev) =>
        prev.map((m) => (m.tempId === tempId ? { ...m, failed: true } : m)),
      );
      setPending(false);
    }
  }, [selectedConfigId, startPolling]);

  const loadOlder = useCallback(async () => {
    if (!oldestCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const res = await fetch(`/api/ai-pm/chat/history?cursor=${encodeURIComponent(oldestCursor)}`);
      if (res.ok) {
        const body = (await res.json()) as { messages: ChatMessagePublic[]; nextCursor: string | null };
        // returned DESC, prepend in ASC
        const asc = body.messages.slice().reverse();
        setMessages((prev) => [...asc, ...prev]);
        setOldestCursor(body.nextCursor);
      }
    } finally {
      setLoadingOlder(false);
    }
  }, [oldestCursor, loadingOlder]);

  if (configs.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted px-4 text-center">
        {t('noConfigsCta')}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <ChatHeader
        configs={configs}
        selectedConfigId={selectedConfigId}
        onSelectConfig={setSelectedConfigId}
      />

      {toast && (
        <div className="px-4 py-2 bg-danger/10 border-b border-danger/30 text-danger text-sm flex justify-between items-center">
          <span>{toast}</span>
          <button onClick={() => setToast(null)} className="text-xs underline" aria-label="dismiss">
            ×
          </button>
        </div>
      )}

      <MessageList
        messages={messages}
        pending={pending}
        oldestCursor={oldestCursor}
        onLoadOlder={loadOlder}
        loadingOlder={loadingOlder}
      />

      <ComposeBar onSend={send} disabled={pending} />
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/components/ai-pm/chat/__tests__/ChatClient.test.tsx
```
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/components/ai-pm/chat/ChatClient.tsx src/components/ai-pm/chat/__tests__/ChatClient.test.tsx
git commit -m "feat(ai-pm): ChatClient orchestrator with poll-based sync UX"
```

---

## Task 9: Server page + sidebar nav + types export

**Files:**
- Create: `src/app/(dashboard)/dashboard/ai-pm/chat/page.tsx`
- Modify: `src/components/layout/sidebar.tsx`
- Modify: `src/components/ai-pm/types.ts`

Server-renders auth check + initial history (30 newest) + config list. Renders `ChatClient`. Adds sidebar entry.

- [ ] **Step 1: Implement server page**

```tsx
// src/app/(dashboard)/dashboard/ai-pm/chat/page.tsx
import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/services/auth.service';
import { listChatMessages } from '@/services/ai-pm-chat-history.service';
import { listAiPmConfigsForUser } from '@/services/ai-pm-config.service';
import { ChatClient } from '@/components/ai-pm/chat/ChatClient';

export const dynamic = 'force-dynamic';

export default async function ChatPage() {
  const user = await getAuthenticatedUser();
  if (!user) redirect('/login');

  const [history, configs] = await Promise.all([
    listChatMessages(user.id, { limit: 30 }),
    listAiPmConfigsForUser(user.id),
  ]);

  const configOptions = configs.map((c) => ({
    id: c.id,
    label: c.bingxApiKeyId.slice(0, 8),
    enabled: c.enabled,
    killSwitch: c.killSwitch,
  }));

  return (
    <div className="h-[calc(100vh-4rem)] md:h-screen flex flex-col">
      <ChatClient
        configs={configOptions}
        initialMessages={history.messages}
        initialOldestCursor={history.nextCursor}
      />
    </div>
  );
}
```

- [ ] **Step 2: Update sidebar — add Chat entry between AI Activity and Accounts**

In `src/components/layout/sidebar.tsx`, find:
```tsx
import {
  LayoutDashboard,
  Bot,
  KeyRound,
  Settings,
  Sparkles,
  Activity,
} from 'lucide-react';
```
Replace with:
```tsx
import {
  LayoutDashboard,
  Bot,
  KeyRound,
  Settings,
  Sparkles,
  Activity,
  MessageSquare,
} from 'lucide-react';
```

Then find:
```tsx
  { href: '/dashboard/ai-pm/activity', icon: Activity, labelKey: 'aiActivity' },
  { href: '/dashboard/accounts', icon: KeyRound, labelKey: 'accounts' },
```
Replace with:
```tsx
  { href: '/dashboard/ai-pm/activity', icon: Activity, labelKey: 'aiActivity' },
  { href: '/dashboard/ai-pm/chat', icon: MessageSquare, labelKey: 'aiChat' },
  { href: '/dashboard/accounts', icon: KeyRound, labelKey: 'accounts' },
```

- [ ] **Step 3: Update types re-export**

In `src/components/ai-pm/types.ts`, append:

```ts
export type { ChatMessagePublic } from '@/services/ai-pm-chat-history.service';
```

- [ ] **Step 4: Type-check + lint + full test**

```bash
npx tsc --noEmit -p tsconfig.json
npm run lint
npx vitest run
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/app/\(dashboard\)/dashboard/ai-pm/chat/page.tsx src/components/layout/sidebar.tsx src/components/ai-pm/types.ts
git commit -m "feat(ai-pm): chat page route + sidebar nav entry"
```

---

## Task 10: Final integration check + PR

**Files:**
- None (verification only)

- [ ] **Step 1: Full test suite + build**

```bash
npx vitest run
npm run build
```
Expected: 0 failing tests, build succeeds.

- [ ] **Step 2: Manual smoke (interactive)**

Start dev server (`npm run dev` + `npm run inngest`), log in, navigate to `/dashboard/ai-pm/chat`. Verify:
1. History loads (if any prior messages exist).
2. Send a message — bubble appears immediately, typing dots show.
3. Assistant reply replaces typing dots within ~15s (kill switch off, valid Anthropic key).
4. Toggle kill switch in `/dashboard/ai-pm` → reload chat → red `KILL` chip visible in header.
5. Mobile viewport (Chrome devtools) → sticky compose bar stays at bottom, list scrolls.

Document any deviations in a follow-up issue, do not block.

- [ ] **Step 3: Open PR**

```bash
git push -u origin feat/ai-pm-chat-ui
gh pr create --title "feat(ai-pm): Session 15 — chat UI" --body "$(cat <<'EOF'
## Summary
- New `/dashboard/ai-pm/chat` route with read history + send messages
- `GET /api/ai-pm/chat/history` (cursor + since modes)
- Sync UX via 2 s short polling; no SSE, no schema migration
- i18n (en/pt/zh), sidebar entry, kill-switch badge

## Test plan
- [ ] `npx vitest run` green
- [ ] `npm run build` green
- [ ] Manual: send message, receive reply
- [ ] Manual: kill switch shows red KILL chip
- [ ] Manual: load older paginates back

Spec: `docs/superpowers/specs/2026-05-12-ai-pm-chat-ui-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Goal (sync UX via polling) — Tasks 1, 2, 8 ✓
- Route `/dashboard/ai-pm/chat` — Task 9 ✓
- `GET /api/ai-pm/chat/history` (cursor + since) — Tasks 1, 2 ✓
- Components (Header / List / Bubble / Compose / Client) — Tasks 4–8 ✓
- Sidebar nav — Task 9 ✓
- i18n en/pt/zh — Task 3 ✓
- 0/1/N config picker — Task 7 + Task 8 + Task 9 ✓
- Kill switch badge — Task 7 ✓
- Pending bubble + 60 s timeout — Task 8 ✓
- Load older — Tasks 6, 8 ✓
- Failed-send retry hint — Task 4 (UI) + Task 8 (state) ✓ (full retry button is a UX polish for S15b; the failed badge is shown today)
- Decision badge link — Task 4 ✓
- Tests (service / route / 3 component) — Tasks 1, 2, 4, 5, 8 ✓
- No schema migration — confirmed throughout ✓

**Placeholder scan:** none — every code block is concrete.

**Type consistency:** `ChatMessagePublic` defined in Task 1 is consumed identically in Tasks 4–9. `ChatHeaderConfigOption` defined in Task 7 used in Tasks 8–9. `MessageBubbleProps` matches calls in `MessageList`. `failed` is `Msg`-level state in `ChatClient`, surfaced to `MessageBubble` via the same prop name.

**Known polish gaps (intentional, not blockers):** failed-message retry is a hint only (no button); auto-scroll button-on-new-msg is omitted (auto-scroll only when near bottom). Both are S15b candidates.
