# AI Portfolio Manager — Session 16: Chat-pipeline v2 (Agentic Tool-Use)

**Date:** 2026-05-12
**Status:** Approved
**Branch:** `feat/ai-pm-chat-tools`
**Predecessors:** S0–S15 (cron pipeline, settings UI, activity feed, event monitor, chat UI)

## Goal

Promote the AI Portfolio Manager chat from reply-only to a full agentic conversation: the LLM can read portfolio state, propose actions, and execute bot operations directly through a multi-turn tool-use loop, gated by existing guardrails and audited into `ai_decisions`.

## Non-Goals (v1)

- **`adjust_params` and `reallocate_capital` tools.** The existing `executor.ts` returns `EXECUTION_FAILED: NOT_IMPLEMENTED` for both. Implementing the executors is a separate workstream; we ship the 6 tools that ride on real executors.
- Streaming token-by-token responses (poll-based UX from S15 stays).
- Per-config chat threads (still one global thread per user).
- Approval/confirmation gates ("are you sure?" UX). Full-agentic means the model commits directly inside guardrails.
- Voice/audio input.
- Multi-step plan generation beyond one tool loop per user message.

## Tools (v1, six)

| Tool | Args | Side effects | Reuses |
|------|------|--------------|--------|
| `read_portfolio` | — | none | `loadPortfolioState` |
| `read_signals` | `{ limit?: 1..20 }` | none | direct `db.query.aiSignals` |
| `read_decisions` | `{ limit?: 1..20, status?: ai_decision_status }` | none | direct `db.query.aiDecisions` |
| `create_bot` | `{ symbol: string, strategy: bot_type, capitalUsdt: number, leverage: number, reasoning: string }` | inserts `ai_decisions` (PROPOSED→EXECUTED/REJECTED_*), optionally creates `trading_bots` or paper bot | `validate()` + `execute()` |
| `stop_bot` | `{ botId: string, reasoning: string }` | inserts `ai_decisions`, updates `trading_bots.status='STOPPED'` | `validate()` + `execute()` |
| `pause_kill_switch` | `{ reason: string }` | flips `ai_pm_configs.killSwitch=true`, inserts `ai_decisions(NO_ACTION, EXECUTED, reasoning=reason)` | `setKillSwitch` from `ai-pm-config.service` |

All mutating tools (the bottom 3) route through `validate()` first. The validation chain already handles guardrails + backtest + Opus review for create_bot. `stop_bot` and `pause_kill_switch` skip backtest/review (they’re reversible-ish defensive actions); they still record a decision row with `status=EXECUTED` (or `EXECUTION_FAILED` if the underlying op throws).

## Architecture

```
runChatPipeline(payload, config, portfolioState, db, ...)
  ├── kill switch active?  → canned msg, persist, return
  ├── monthly budget exceeded?  → canned msg, persist, return
  ├── load history (last 20 messages, anthropic format)
  ├── runToolLoop({
  │      messages, tools, anthropicApiKey, config, db, userId,
  │      budgets: { maxTurns: 8, maxCostUsd: 0.50 }
  │   })
  │     loop 1..maxTurns:
  │       callSonnetTools(messages, tools) → { kind: 'tool_use', ... } | { kind: 'text', text }
  │       if text → break, that's the final reply
  │       if tool_use →
  │         re-check kill switch (mid-loop abort if flipped)
  │         dispatch tool by name → ToolExecResult
  │         append { role: 'assistant', content: [tool_use block] }
  │         append { role: 'user', content: [tool_result block, text=ToolExecResult.summary] }
  │         accumulate cost; if cost > maxCostUsd → force-terminate with synthetic
  │           text 'Budget exhausted, stopping.'
  │       record entry: { toolName, args, status, decisionId, summary }
  │     if loop hits maxTurns without text → append synthetic 'Hit tool-call limit, here is what I did so far.'
  │  └── returns { assistantText, toolCallEntries[] }
  └── persist assistant ai_chat_messages row:
        content = assistantText
        toolCalls = JSON.stringify(toolCallEntries)
        decisionId = first executed-or-proposed decisionId, or null
```

### Multi-turn LLM helper — `callSonnetTools`

New export in `src/lib/ai-pm/llm.ts`. **Does not replace** existing `callSonnet` (single-shot used by signal/decision/reviewer pipelines).

```ts
export type SonnetToolsResponse =
  | { kind: 'tool_use'; toolName: string; toolUseId: string; args: unknown }
  | { kind: 'text'; text: string };

export async function callSonnetTools(params: {
  apiKey: string;
  systemPrompt: string;
  messages: Array<AnthropicMessage>;   // role + content blocks; supports tool_use & tool_result
  tools: ToolDefinition<unknown>[];
  factory?: AnthropicFactory;
  maxTokens?: number;
  cacheSystem?: boolean;
}): Promise<LlmResult<SonnetToolsResponse>>;
```

Behaviour:
- Send all `messages` as-is to Anthropic.
- Inspect `response.content`:
  - First `tool_use` block (if any) → return `{kind:'tool_use', toolName, toolUseId, args: validated_via_zod}`.
  - Otherwise concatenate `text` blocks → return `{kind:'text', text}`.
- Args validation reuses the tool's zod schema (same pattern as existing `callSonnet`).
- `SCHEMA_REJECTED` on bad args — caller should treat as a tool failure and append a `tool_result` with `is_error: true` so the model can self-correct.

### Tool dispatcher — `src/lib/ai-pm/chat-tools.ts`

```ts
export type ToolName =
  | 'read_portfolio' | 'read_signals' | 'read_decisions'
  | 'create_bot' | 'stop_bot' | 'pause_kill_switch';

export interface ToolExecContext {
  userId: string;
  configId: string;
  config: AiPmConfigDecrypted;
  portfolioState: PortfolioState;
  db: typeof Db;
  bingxClient?: BingxClient;          // optional, only needed for create_bot backtest
  validateFn?: typeof validate;
  executeFn?: typeof execute;
}

export interface ToolExecResult {
  status: 'EXECUTED' | 'REJECTED_GUARDRAIL' | 'REJECTED_BACKTEST' | 'REJECTED_REVIEWER' | 'EXECUTION_FAILED';
  decisionId: string | null;          // null for read-only tools
  summary: string;                    // human-readable; goes into tool_result + UI
  payload: unknown;                    // structured data; goes into tool_result as JSON string
}

export const ALL_TOOL_DEFINITIONS: ToolDefinition<unknown>[] = [/* zod schemas per tool */];

export async function executeTool(
  name: ToolName,
  args: unknown,
  ctx: ToolExecContext,
): Promise<ToolExecResult>;
```

Each tool function is small (1 file, one responsibility each handler).

### Loop driver — `src/lib/ai-pm/chat-loop.ts`

```ts
export interface ToolCallEntry {
  toolName: ToolName;
  args: unknown;
  status: ToolExecResult['status'];
  decisionId: string | null;
  summary: string;
}

export interface RunToolLoopParams {
  userMessage: string;
  history: Array<{role:'user'|'assistant'; content:string}>;
  ctx: ToolExecContext;
  llmFn?: typeof callSonnetTools;
  budgets?: { maxTurns?: number; maxCostUsdPerTurn?: number };
}

export interface RunToolLoopResult {
  assistantText: string;
  toolCallEntries: ToolCallEntry[];
  cumulativeUsage: LlmUsage;
}

export async function runToolLoop(params: RunToolLoopParams): Promise<RunToolLoopResult>;
```

`MAX_TURNS=8`, `MAX_COST_USD=0.50` (defaults; budgets override). Kill-switch checked from db before each mutating tool dispatch (re-reads `aiPmConfigs.killSwitch`).

### `runChatPipeline` integration

`src/lib/ai-pm/chat-pipeline.ts` — replace the body of `runChatDecision` flow with a call to `runToolLoop`. Persist:

```ts
await db.insert(aiChatMessages).values({
  userId: config.userId,
  role: 'assistant',
  content: result.assistantText,
  toolCalls: result.toolCallEntries,                 // jsonb
  decisionId: result.toolCallEntries.find(e => e.decisionId)?.decisionId ?? null,
});
```

Existing chat-pipeline tests adapt; the `runChatDecision` export stays for backwards-compat but becomes a thin wrapper around `runToolLoop` for tests that don't want the full tool surface.

## Schema migration

```sql
-- One nullable FK so a decision can be linked back to the chat message that triggered it.
ALTER TABLE ai_decisions
  ADD COLUMN chat_message_id UUID
  REFERENCES ai_chat_messages(id) ON DELETE SET NULL;

CREATE INDEX ai_decisions_chat_message_idx ON ai_decisions(chat_message_id);
```

Drizzle schema update mirrors the column; relation declared bidirectionally so the activity feed can pull "chat-originated" decisions later.

`validate()` and `execute()` accept an optional `chatMessageId` parameter that is forwarded into `persistDecision()`. Existing call sites (signal-decision pipeline) pass `null`; chat-loop tool dispatchers pass the in-flight assistant chat message id.

Caveat: at tool-dispatch time we don't yet have the persisted assistant `chat_message_id` because we persist the assistant row AFTER the loop. Two options:

1. **Pre-insert** an empty assistant row at loop start, capture its id, finalize fields at end.
2. **Use the user-message id** as the link.

We pick **option 1** (pre-insert + update). It guarantees one-to-one linkage and lets the activity feed filter `WHERE chat_message_id IS NOT NULL` to surface chat-originated decisions. The empty row starts with `content=''` and is updated atomically when the loop returns.

## UI changes

**`MessageBubble.tsx`** — when `toolCalls` is a non-empty array, render a small expandable block under content:

```
🔧 read_portfolio → "3 bots, $1,240 free"
🔧 create_bot SOL-USDT grid → "EXECUTED — bot 8a4c…"
❌ create_bot ETH-USDT grid → "REJECTED_GUARDRAIL: max_concurrent_bots"
```

- Each row clickable if `decisionId` present → links `/dashboard/ai-pm/activity?focus=<decisionId>`.
- Status icon: `🔧` for EXECUTED/read-only, `❌` for any REJECTED_*/EXECUTION_FAILED.
- Component remains pure (no state); takes `toolCalls: ToolCallEntry[]` as decoded prop.

`MessageBubble` already has `toolCalls: unknown | null` prop reserved from S15. Decode in `ChatClient` before pass-down: if jsonb, parse-and-validate via lightweight zod schema, default to `[]` on parse error.

## Error handling

| Scenario | Behavior |
|----------|----------|
| Kill switch active at entry | canned text, no loop, persist message |
| Monthly budget exceeded | canned text, no loop, persist message |
| `callSonnetTools` API error | return text `"AI service error: <kind>"`, persist any tool entries accumulated |
| Tool args fail zod | append `tool_result` with `is_error: true`, content `"invalid args: <issue>"` — model self-corrects next turn |
| Tool execution throws | mark entry status=EXECUTION_FAILED, summary=error.message, append tool_result `is_error: true` |
| Kill switch flipped mid-loop | abort remaining iterations, finalize text `"Kill switch activated mid-conversation. Stopping."` |
| Cost cap hit | finalize text `"Budget exhausted, stopping after N tool calls."` |
| Max turns hit | finalize text `"Hit ${MAX_TURNS}-tool limit; here is what I did."` |

## Testing

| File | What |
|------|------|
| `src/lib/ai-pm/__tests__/llm.test.ts` (extend) | `callSonnetTools`: tool_use returned, text returned, schema rejection path. Mocked `AnthropicFactory`. |
| `src/lib/ai-pm/__tests__/chat-tools.test.ts` (new) | One `describe` per tool: happy path + key failure mode. Mock `validate`, `execute`, `setKillSwitch`. |
| `src/lib/ai-pm/__tests__/chat-loop.test.ts` (new) | Loop terminates on text reply, on MAX_TURNS, on cost cap, on kill-switch mid-loop. Mock `callSonnetTools` + `executeTool`. |
| `src/lib/ai-pm/__tests__/chat-pipeline.test.ts` (extend) | Tool entries persisted in `aiChatMessages.toolCalls`; chat_message_id is set on the decision row when create_bot succeeds. |
| `src/components/ai-pm/chat/__tests__/MessageBubble.test.tsx` (extend) | Renders toolCalls entries: read row, executed-with-link row, rejected row. |

Targets: ~80% backend (mutating paths must be covered), ~50% UI. No Playwright.

## i18n additions

`messages/{en,pt,zh}.json` — extend `AiPm.Chat`:

```
toolCalls.header       — "Actions"
toolCalls.executed     — "executed"
toolCalls.rejected     — "rejected"
toolCalls.failed       — "failed"
toolCalls.empty        — "(no result)"
budgetExhausted        — "AI hit the per-turn budget; stopping."
maxTurnsHit            — "AI hit the {n}-call limit."
killSwitchMidLoop      — "Kill switch flipped mid-conversation; stopped."
```

## Out of scope (deferred)

- `adjust_params` and `reallocate_capital` tools (S16b — requires executor implementation first).
- SSE streaming (S17 candidate).
- Per-config threads + `ai_chat_messages.config_id` migration (still S15b).
- Multi-message plan generation / chain-of-thought beyond a single loop.
- Tool-call cost accounting per user (current code charges Anthropic cost only).

## Open risks

- **Hallucinated symbols**: `create_bot` already routes through `validate` → guardrails check `allowedSymbols`. Backtest will fail fast on unknown symbol via BingX symbol-config. Existing safety holds.
- **Cost runaway**: `MAX_COST_USD=0.50/turn` hard cap. Telemetry persists usage per message via `tokensInput/tokensOutput/costUsd` cumulative across the loop (added to assistant `ai_chat_messages` row, see below).
- **Bidirectional FK on chat_message_id**: `ai_decisions.chat_message_id → ai_chat_messages.id` ON DELETE SET NULL — chat row deletion (currently impossible via UI) does not cascade.
- **Tool race across browser tabs**: each `runChatPipeline` invocation operates on its own snapshot; no per-config locking. Two simultaneous "stop all bots" requests both succeed idempotently because executor handles missing/already-stopped bots gracefully.

Cost accounting on the assistant row: `ai_chat_messages` currently lacks per-row usage columns. Add them in the same migration as `chat_message_id` (or a separate file — Drizzle output decides):

```sql
ALTER TABLE ai_chat_messages
  ADD COLUMN tokens_input INTEGER,
  ADD COLUMN tokens_output INTEGER,
  ADD COLUMN cached_input_tokens INTEGER,
  ADD COLUMN cost_usd NUMERIC(10, 6);
```

All nullable, no backfill, no impact on existing rows.

## File manifest

**New:**
- `src/lib/ai-pm/chat-tools.ts`
- `src/lib/ai-pm/chat-loop.ts`
- `src/lib/ai-pm/__tests__/chat-tools.test.ts`
- `src/lib/ai-pm/__tests__/chat-loop.test.ts`
- One Drizzle migration file (auto-generated; covers both ALTER TABLE statements).

**Modified:**
- `src/db/schema.ts` (chat_message_id + token cols + relation)
- `src/lib/ai-pm/llm.ts` (add `callSonnetTools` export)
- `src/lib/ai-pm/chat-pipeline.ts` (replace decision logic with `runToolLoop`)
- `src/lib/ai-pm/validation.ts` (accept optional `chatMessageId`)
- `src/lib/ai-pm/executor.ts` (accept optional `chatMessageId` → forward in `persistDecision`)
- `src/lib/ai-pm/__tests__/llm.test.ts` (extend)
- `src/lib/ai-pm/__tests__/chat-pipeline.test.ts` (extend)
- `src/components/ai-pm/chat/MessageBubble.tsx` (toolCalls renderer)
- `src/components/ai-pm/chat/ChatClient.tsx` (decode toolCalls before pass-down; tiny)
- `src/components/ai-pm/chat/__tests__/MessageBubble.test.tsx` (extend)
- `messages/en.json`, `messages/pt.json`, `messages/zh.json` (new keys)
