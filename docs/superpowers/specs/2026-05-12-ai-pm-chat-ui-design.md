# AI Portfolio Manager — Session 15: Chat UI

**Date:** 2026-05-12
**Status:** Approved
**Branch:** `feat/ai-pm-chat-ui`
**Predecessors:** S0–S14 (cron pipeline, settings UI, activity feed, event-driven monitor)

## Goal

Ship a conversational UI for the AI Portfolio Manager. Users can read their chat history and send new messages. v1 is a dedicated dashboard route with synchronous request/response semantics implemented via short polling on top of the existing async chat backend.

## Non-Goals (v1)

- Server-Sent Events / token-by-token streaming.
- Per-config conversation threads (would require a schema migration on `ai_chat_messages`).
- Inline "decision proposal" cards triggered by tool-use (chat-pipeline v2 will produce these; the renderer hook is reserved for them).
- Markdown rendering in messages (plain text + line breaks only).
- An "Events" tab in the activity feed (`ai_events`). Deferred to S15b.

## Existing Backend (reuse, do not modify)

- `POST /api/ai-pm/chat` — body `{configId, message}`. Inserts a `user`-role row in `ai_chat_messages`, emits `ai-pm/event.chat`, returns `{ok: true, chatMessageId}`.
- `runChatPipeline` (Inngest handler) — loads history, calls Sonnet, inserts an `assistant`-role row. Kill switch returns canned `"AI is currently disabled (kill switch active)."`.
- Schema `ai_chat_messages`: `id, userId, role, content, toolCalls (jsonb), decisionId, createdAt`. Index on `(userId, createdAt)`. **No `configId` column** — the table is per-user, not per-config.

The backend is already asynchronous: POST returns immediately, the assistant row appears later. The UI bridges this gap with short polling.

## Architecture

### Route layout

```
/dashboard/ai-pm/chat
  ├─ page.tsx              server shell; auth + initial history fetch (30 newest)
  └─ ChatClient.tsx        client orchestrator (state, polling, fetches)
       ├─ ChatHeader.tsx   title, config picker (Select), kill-switch badge
       ├─ MessageList.tsx  scroll container, "Load older" button at top
       │    └─ MessageBubble.tsx   role-aware renderer (user / assistant / pending)
       └─ ComposeBar.tsx   sticky textarea + send button
```

Sidebar entry added: `Nav.aiChat` → `/dashboard/ai-pm/chat`.

### New backend endpoint

```
GET /api/ai-pm/chat/history
Query params:
  - limit?:  integer 1..50 (default 30)
  - cursor?: base64 JSON `{createdAt: ISO, id: UUID}` — paginate older
  - since?:  ISO timestamp — return only rows newer than this (poll mode)
Response:
  {
    messages: [
      { id, role, content, decisionId, toolCalls, createdAt }
    ],
    nextCursor: string | null
  }
Auth: getAuthenticatedUser. Rows scoped by userId.
Order: createdAt DESC, id DESC.
nextCursor: null when `since` is set (poll mode never paginates).
```

`cursor` and `since` are mutually exclusive; if both are passed, `since` wins and `cursor` is ignored.

### Service layer

New file `src/services/ai-pm-chat-history.service.ts`:

```ts
listChatMessages(
  userId: string,
  opts: { limit: number; cursor?: { createdAt: Date; id: string }; since?: Date }
): Promise<{ messages: ChatMessagePublic[]; nextCursor: string | null }>
```

`ChatMessagePublic` type is exported from this service and re-exported via `src/components/ai-pm/types.ts` (same pattern as activity feed).

## Data Flow

### Initial load (server)

1. `page.tsx` calls `listChatMessages(userId, { limit: 30 })`.
2. Result is reversed (ASC for display) and passed as `initialMessages` prop to `ChatClient`.
3. `oldestCursor` is set from the returned `nextCursor`.

### Send (client)

1. User submits via Enter or send button.
2. `ChatClient`:
   - Appends optimistic user bubble (temp id, `createdAt = now`).
   - Appends pending assistant bubble (3-dot typing indicator).
   - Disables `ComposeBar`.
   - `POST /api/ai-pm/chat` with `{configId, message}`.
3. On POST success: store `lastSeenAt = now`, start poll loop.
4. On POST failure: mark user bubble as `failed` with a retry button; drop pending bubble; re-enable input.

### Poll loop (client)

Runs every **2000ms** while a pending bubble exists.

1. `GET /api/ai-pm/chat/history?since=<lastSeenISO>`.
2. If response contains an `assistant`-role row → swap pending bubble for it, stop loop, re-enable input.
3. If 30 consecutive polls (≈ 60 s) pass without an assistant row → stop loop, drop pending bubble, show error toast `Chat.noResponse`, re-enable input.
4. Network errors during polling are silent (counted against the same 30-attempt budget).

### Load older (client)

1. User clicks "Load older" button at top of list.
2. `GET /api/ai-pm/chat/history?cursor=<oldestCursor>&limit=30`.
3. Returned messages are prepended (ASC); `oldestCursor` updated; button hidden when `nextCursor` is null.

### Auto-scroll behavior

- On initial mount: scroll list to bottom.
- On new outgoing/incoming message: scroll to bottom only if the user is already near the bottom (within 100 px). Otherwise show a small "↓ new message" floating button.

## Components — contracts

**`MessageBubble`** (pure)
```ts
interface Props {
  role: 'user' | 'assistant';
  content: string;
  decisionId: string | null;
  toolCalls: unknown | null;
  createdAt: string;
  pending?: boolean;   // shows typing dots, ignores content
  failed?: boolean;    // shows error tint + retry handled by parent
}
```
- `user` → right-aligned filled bubble (primary tint).
- `assistant` → left-aligned `Card` with subtle border.
- `pending` → left-aligned card with three animated dots.
- If `decisionId` is non-null → render a "View decision" badge linking to `/dashboard/ai-pm/activity?focus=<decisionId>`. (The `focus` query param itself is reserved here for S15b; activity feed already ignores unknown params.)
- `toolCalls` is forwarded but unused in v1 (reserved for future inline decision cards).

**`MessageList`**
- Props: `messages`, `oldestCursor`, `onLoadOlder`, `loadingOlder`.
- Renders virtualization-free list (v1 caps history at ~hundreds of msgs per user; sufficient).

**`ComposeBar`**
- Props: `disabled`, `onSend(text)`, `maxLength = 2000`.
- Enter sends, Shift+Enter inserts newline, character counter visible when text > 1800.

**`ChatHeader`**
- Props: `configs: AiPmConfigPublic[]`, `selectedConfigId`, `onSelectConfig`, `killSwitch`.
- Picker disabled when only one config exists.
- Kill switch badge: red `KILL` chip when active.

**`ChatClient`** owns:
- `messages` array (ASC).
- `oldestCursor`, `pendingMessage` flag, `lastSeenAt`, `sending` flag.
- Poll lifecycle (`setInterval` ref cleaned up on unmount, on success, on timeout).

## Config selection

`page.tsx` fetches the user's `aiPmConfigs` rows (existing service). Renders:
- 0 configs → empty state CTA linking to `/dashboard/ai-pm` (settings). No chat UI.
- 1 config → picker hidden, that config is auto-selected.
- 2+ configs → picker visible, defaults to first `enabled=true` config (or the first row if none enabled).

The selected `configId` is sent on every POST. History is shown as a single per-user thread (schema constraint).

## Error handling

| Scenario | Behavior |
|----------|----------|
| Server-side auth fail on `page.tsx` | Redirect to `/login` (existing middleware handles this). |
| Client-side 401 from any fetch | Show `Chat.sessionExpired` toast, soft-reload page. |
| POST `/api/ai-pm/chat` non-2xx | User bubble enters `failed` state with retry. |
| Poll fetch error | Silent retry, counted toward 30-attempt budget. |
| Poll timeout (60 s) | Drop pending bubble, toast `Chat.noResponse`. |
| Kill switch active | Backend returns canned assistant text. UI shows red `KILL` badge in header. No special branching needed. |

## Testing

| File | What |
|------|------|
| `src/services/__tests__/ai-pm-chat-history.service.test.ts` | `listChatMessages` — cursor pagination, `since` mode, userId scoping, ordering. |
| `src/app/api/ai-pm/chat/history/__tests__/route.test.ts` | GET handler — auth, param parsing, mutual exclusion of cursor+since. |
| `src/components/ai-pm/chat/__tests__/MessageBubble.test.tsx` | role variants, pending, failed, decision badge link. |
| `src/components/ai-pm/chat/__tests__/ComposeBar.test.tsx` | Enter sends, Shift+Enter newline, max-length, disabled state. |
| `src/components/ai-pm/chat/__tests__/ChatClient.test.tsx` | initial render, send → poll → resolve, timeout → error toast, load-older prepends. Polling uses fake timers. |

Targets: ~80 % backend, ~60 % UI. No Playwright.

## i18n

`messages/{en,pt,zh}.json` additions:

```jsonc
// Nav
"aiChat": "AI Chat" / "Chat IA" / "AI 聊天"

// AiPm.Chat
{
  "title": "...",
  "subtitle": "...",
  "placeholder": "Ask the portfolio manager...",
  "send": "Send",
  "loadOlder": "Load older messages",
  "noMessagesYet": "No messages yet. Say hi.",
  "configLabel": "Subaccount",
  "killSwitchActive": "Kill switch is ON. AI is paused.",
  "sendFailed": "Couldn’t send. Tap to retry.",
  "noResponse": "No response after 60 s. Try again.",
  "sessionExpired": "Session expired. Reloading...",
  "noConfigsCta": "Set up AI Portfolio Manager first.",
  "typing": "Thinking...",
  "viewDecision": "View decision"
}
```

## Out of Scope / Deferred

- **S15b (next)**: per-config threads — migration `ALTER TABLE ai_chat_messages ADD COLUMN config_id UUID REFERENCES ai_pm_configs(id)`; thread switcher in header; route param `/dashboard/ai-pm/chat/[configId]`. Events tab in activity feed showing `ai_events` (status pulse for THROTTLED/PROCESSED).
- **S16**: tool-use in chat-pipeline → inline `DecisionProposalCard` rendered by `MessageBubble` when `toolCalls` is populated; streaming via SSE; markdown rendering.

## File Manifest (estimated)

New:
- `src/app/(dashboard)/dashboard/ai-pm/chat/page.tsx`
- `src/components/ai-pm/chat/ChatClient.tsx`
- `src/components/ai-pm/chat/ChatHeader.tsx`
- `src/components/ai-pm/chat/MessageList.tsx`
- `src/components/ai-pm/chat/MessageBubble.tsx`
- `src/components/ai-pm/chat/ComposeBar.tsx`
- `src/app/api/ai-pm/chat/history/route.ts`
- `src/services/ai-pm-chat-history.service.ts`
- `src/components/ai-pm/chat/__tests__/*.test.tsx`
- `src/services/__tests__/ai-pm-chat-history.service.test.ts`
- `src/app/api/ai-pm/chat/history/__tests__/route.test.ts`

Modified:
- `src/components/layout/sidebar.tsx` (add nav entry)
- `src/components/ai-pm/types.ts` (export `ChatMessagePublic`)
- `messages/en.json`, `messages/pt.json`, `messages/zh.json`

No DB migrations. No changes to existing chat backend code paths.
