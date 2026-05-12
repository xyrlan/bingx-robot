# AI Portfolio Manager — Session 14: Event-Driven Monitor

**Date:** 2026-05-11
**Branch:** `feat/ai-pm-monitor`
**Status:** Approved design — ready for implementation plan

## 1. Purpose

The AI Portfolio Manager currently reacts only to a 30-minute cron (`ai-pm-tick`). Drawdowns, fills, funding-rate flips, errors, and user chat messages are not actioned until the next tick. Session 14 makes the AI PM responsive to these events in near-real-time without significantly increasing LLM cost.

## 2. Goals

1. Detect and react to five event sources: drawdown breach, position fill, funding-rate sign flip, bot error, and user chat message.
2. Run the existing AI PM pipeline (`signal → decision → validation → executor`) scoped to a single symbol or chat context, not the full allowed list.
3. Persist an audit trail of every detected event, including throttled events.
4. Throttle by `(configId, eventType, symbol)` with a 5-minute debounce window.
5. Do not regress the existing 30-minute cron (`ai-pm-tick`); it remains the full-portfolio sweep.

## 3. Non-goals

- Building chat UI (handled separately in a later session). S14 ships the backend route stub and event consumer; the conversation UI is out of scope.
- Replacing the 30-minute cron with pure event-driven execution. Cron remains the full sweep.
- Webhooks from BingX (BingX has no public webhook API).
- Cross-user event broadcasting or admin event dashboards.

## 4. Architecture

```
┌─────────────────────────────┐    ┌────────────────────────┐
│ Existing handlers           │    │ New ai-pm-monitor cron │
│ • trading-bot-watch (5min)  │    │ (every 5min)           │
│ • dca-bot-watch etc         │    │ • paper-bot simulator  │
│ • API route /chat (stub)    │    │   tick + drawdown      │
│                             │    │ • funding rate flip    │
│ emit on fill/error/drawdown │    │ • emit events          │
└─────────┬───────────────────┘    └────────┬───────────────┘
          │                                 │
          └───────────► Inngest events ◄────┘
                       ai-pm/event.*
                                │
                                ▼
                  ┌──────────────────────────┐
                  │ ai-pm-event-handler fn   │
                  │ 1. insert ai_events row  │
                  │ 2. dedupe-check          │
                  │ 3. dispatch pipeline     │
                  │    • CHAT → decision-only│
                  │    • else → signal       │
                  │      scoped to symbol +  │
                  │      decision+validate+  │
                  │      execute             │
                  │ 4. update ai_events.     │
                  │    processedAt + decId   │
                  └──────────────────────────┘
                                │
                                ▼
                      ai_events / ai_decisions
```

New artifacts:

- Table `ai_events` (audit + throttle ledger).
- Table `ai_pm_funding_cache` (last observed funding rate per `(configId, symbol)`).
- Inngest function `ai-pm-event-handler` (wildcard subscriber).
- Inngest cron `ai-pm-monitor` (every 5 minutes; runs paper simulator, drawdown checks, funding-flip detection).
- Event payload types in `src/lib/ai-pm/events.ts`.
- Service `src/services/ai-events.service.ts` (insert / mark / throttle-check).
- Service `src/services/paper-bot-sim.service.ts` (advance paper bots one bar; emit fills/errors).
- API route `POST /api/ai-pm/chat` (stub: insert `ai_chat_messages` row, emit `ai-pm/event.chat`).
- Sidecar event emission added to existing handlers (`trading-bot-watch`, `dca-bot-watch`, `dca-spot-bot-watch`, `trailing-stop-watch`, `sma-crossover-watch`).

## 5. Event types and payloads

```ts
// src/lib/ai-pm/events.ts

export type AiPmEventName =
  | 'ai-pm/event.fill'
  | 'ai-pm/event.error'
  | 'ai-pm/event.drawdown'
  | 'ai-pm/event.funding-flip'
  | 'ai-pm/event.chat';

export interface BaseEventPayload {
  configId: string;          // ai_pm_configs.id (resolves user + apiKey)
  emittedAt: string;         // ISO timestamp
}

export interface FillPayload extends BaseEventPayload {
  symbol: string;
  botId: string;             // trading_bots.id OR paper_bots.id
  botKind: 'real' | 'paper';
  side: 'LONG' | 'SHORT';
  fillPrice: string;         // decimal as string (avoid float)
  quantity: string;
  orderType: 'ENTRY' | 'TAKE_PROFIT' | 'STOP_LOSS';
}

export interface ErrorPayload extends BaseEventPayload {
  symbol: string;            // bot symbol (single symbol per event)
  botId: string;
  botKind: 'real' | 'paper';
  errorKind:
    | 'API_ERROR'
    | 'INSUFFICIENT_MARGIN'
    | 'INVALID_PARAMS'
    | 'ORDER_REJECTED'
    | 'UNKNOWN';
  message: string;           // truncated to 500 chars
}

export interface DrawdownPayload extends BaseEventPayload {
  symbol: string;
  botId: string;
  botKind: 'real' | 'paper';
  drawdownPct: number;       // e.g. -12.5
  thresholdPct: number;      // config.maxDrawdownPct that was breached
  currentPnlUsdt: string;
  capitalUsdt: string;
}

export interface FundingFlipPayload extends BaseEventPayload {
  symbol: string;
  previousRate: number;      // e.g. +0.0012
  currentRate: number;       // e.g. -0.0008
}

export interface ChatPayload extends BaseEventPayload {
  symbol: null;              // chat has no symbol — null
  chatMessageId: string;     // FK to ai_chat_messages.id
  userMessage: string;       // truncated to 2000 chars
}
```

Decisions:

- `configId` (not `userId`) in every payload. One user may have N configs; throttle and routing must scope per config.
- `symbol` is present in four of five events; `ai_events.symbol` is nullable for chat.
- `botKind` is included so the handler can branch: paper drawdown re-evaluates strategy, real drawdown is more likely to result in `STOP_BOT`.
- Error message is capped at 500 characters to keep Inngest event size small.

## 6. Detectors

| Event | Detector | Trigger condition |
|-------|----------|-------------------|
| `event.fill` | `trading-bot-watch.ts` (real) + `ai-pm-monitor.ts` (paper) | New row inserted into `bot_trades` since last tick (real); paper simulator records new fill |
| `event.error` | `trading-bot-watch.ts`, `dca-bot-watch.ts`, `dca-spot-bot-watch.ts`, `trailing-stop-watch.ts`, `sma-crossover-watch.ts` (real); `ai-pm-monitor.ts` (paper) | BingX API call rejects an order; paper simulator hits a guardrail |
| `event.drawdown` | `ai-pm-monitor.ts` | For each AI-managed bot (paper or real) with `status = RUNNING`: `currentDrawdownPct < -config.maxDrawdownPct` |
| `event.funding-flip` | `ai-pm-monitor.ts` | For each `(configId, symbol)` with an open AI-managed position: `sign(prevFundingRate) ≠ sign(currentFundingRate)` |
| `event.chat` | `POST /api/ai-pm/chat` | User submits a message via the chat endpoint |

**AI-managed scoping for real bots:** existing handlers iterate all of a user's bots. Event emission must be gated on `bingxApiKeys.managedByAi = true` OR the bot being a paper bot. A helper `isAiManagedBot(bot)` lives in `src/services/ai-pm-config.service.ts`.

**ai-pm-monitor cron (new):**

```ts
inngest.createFunction(
  { id: 'ai-pm-monitor', concurrency: { limit: 3 }, retries: 0 },
  { cron: '*/5 * * * *' },
  async ({ step }) => {
    const configs = await step.run('load-configs', listEnabledAiPmConfigs);
    for (const cfg of configs) {
      await step.run(`monitor-${cfg.id}`, () => runMonitor(cfg));
    }
  }
);
```

`runMonitor(cfg)` steps:

1. Tick paper bots — advance simulator one bar (5-minute candle), append fills to `paper_bots.trades` jsonb, update `paper_bots.pnlUsdt`.
2. Drawdown check — compute `pnlPct = pnlUsdt / capitalUsdt * 100` for each AI-managed bot; if `pnlPct < -cfg.maxDrawdownPct` emit `ai-pm/event.drawdown`.
3. Funding-flip check — fetch current funding rates for `cfg.allowedSymbols`; compare to cached value in `ai_pm_funding_cache`; on sign change emit `ai-pm/event.funding-flip`; upsert cache row.
4. Errors raised by the paper simulator emit `ai-pm/event.error` inline.

## 7. Throttling

`ai_events` doubles as audit log and throttle ledger.

```ts
// src/db/schema.ts (additions)

export const aiEventStatusEnum = pgEnum('ai_event_status', [
  'PENDING',
  'THROTTLED',
  'PROCESSING',
  'PROCESSED',
  'FAILED',
]);

export const aiEvents = pgTable('ai_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  configId: uuid('config_id')
    .notNull()
    .references(() => aiPmConfigs.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')                       // denormalized for query speed
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  eventType: aiTriggerSourceEnum('event_type').notNull(),
  symbol: text('symbol'),                       // null for CHAT
  payload: jsonb('payload').notNull(),
  status: aiEventStatusEnum('status').notNull().default('PENDING'),
  decisionId: uuid('decision_id').references(() => aiDecisions.id, { onDelete: 'set null' }),
  emittedAt: timestamp('emitted_at').notNull(),
  processedAt: timestamp('processed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('ai_events_cfg_type_sym_idx').on(t.configId, t.eventType, t.symbol, t.createdAt),
  index('ai_events_status_idx').on(t.status),
  index('ai_events_user_created_idx').on(t.userId, t.createdAt),
]);

export const aiPmFundingCache = pgTable('ai_pm_funding_cache', {
  id: uuid('id').primaryKey().defaultRandom(),
  configId: uuid('config_id')
    .notNull()
    .references(() => aiPmConfigs.id, { onDelete: 'cascade' }),
  symbol: text('symbol').notNull(),
  fundingRate: decimal('funding_rate', { precision: 10, scale: 8 }).notNull(),
  observedAt: timestamp('observed_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('ai_pm_funding_cache_cfg_sym').on(t.configId, t.symbol),
]);
```

Throttle algorithm inside `ai-pm-event-handler`:

```
1. INSERT ai_events row with status = 'PENDING'.
2. SELECT count(*) FROM ai_events
   WHERE configId = ?
     AND eventType = ?
     AND symbol IS NOT DISTINCT FROM ?
     AND status IN ('PROCESSING','PROCESSED')
     AND createdAt > now() - INTERVAL '5 minutes'
     AND id <> currentRowId.
3. If count > 0  → UPDATE current row to status = 'THROTTLED'; return.
4. Else          → UPDATE current row to status = 'PROCESSING'; run pipeline.
5. After pipeline: UPDATE status = 'PROCESSED' (with decisionId) or 'FAILED'; set processedAt.
```

`IS NOT DISTINCT FROM` rather than `=` so `NULL = NULL` (chat events) groups correctly.

**Race:** if two events for the same `(cfg, type, symbol)` are inserted within a few hundred milliseconds, both INSERTs complete before either sees the other's `PROCESSING` row. Both proceed. Result: two pipelines for one logical event. Acceptable for v1 — cost guardrails inside the pipeline still apply and the dedupe at `ai_decisions` level (status-transitioned actions) prevents double-execution of the same bot creation. If this becomes a real issue we add a Postgres advisory lock keyed by `hash(cfg, type, symbol)` as a follow-up.

## 8. Event handler pipeline

```ts
// src/inngest/functions/ai-pm-event-handler.ts

inngest.createFunction(
  {
    id: 'ai-pm-event-handler',
    retries: 2,
    concurrency: [
      { limit: 5 },                                        // global
      { limit: 1, key: 'event.data.configId' },            // per config
    ],
  },
  { event: 'ai-pm/event.*' },
  async ({ event, step, logger }) => {
    const { name, data } = event;
    const eventType = mapNameToEnum(name);                  // ai-pm/event.fill → EVENT_FILL

    const aiEventId = await step.run('insert-event', () =>
      insertAiEvent({
        configId: data.configId,
        eventType,
        symbol: 'symbol' in data ? data.symbol : null,
        payload: data,
        emittedAt: new Date(data.emittedAt),
      })
    );

    const throttled = await step.run('check-throttle', () =>
      checkThrottle({
        configId: data.configId,
        eventType,
        symbol: 'symbol' in data ? data.symbol : null,
        currentEventId: aiEventId,
        windowSeconds: 300,
      })
    );

    if (throttled) {
      await markEvent(aiEventId, 'THROTTLED');
      return { aiEventId, status: 'THROTTLED' };
    }

    await markEvent(aiEventId, 'PROCESSING');

    try {
      const decisionId = name === 'ai-pm/event.chat'
        ? await runChatPipeline(data, aiEventId)
        : await runScopedPipeline(data, aiEventId, eventType);

      await markEvent(aiEventId, 'PROCESSED', { decisionId });
      return { aiEventId, status: 'PROCESSED', decisionId };
    } catch (err) {
      logger.error('event_handler_failed', { aiEventId, err: String(err) });
      await markEvent(aiEventId, 'FAILED');
      throw err;
    }
  }
);
```

**`runScopedPipeline(data, aiEventId, eventType)`** (in `src/lib/ai-pm/event-pipeline.ts`):

1. Load `aiPmConfig` by `data.configId`; abort if `!enabled || killSwitch`.
2. Load BingX client via `getBingxClientByApiKeyId(cfg.bingxApiKeyId)`.
3. Load `portfolioState` via `loadPortfolioState({...})`.
4. `runSignal({ allowedSymbols: [data.symbol], anthropicApiKey, bingxClient, db, userId })` — single symbol scope.
5. `runDecision({ candidates: signal.candidates, portfolioState, config, anthropicApiKey })`.
6. For each proposed action: `validate(...)`, then if `PROPOSED` → `execute(...)`. Insert `ai_decisions` row with `triggeredBy = eventType`, `triggerDetail = JSON.stringify({ aiEventId, payloadSummary })`. Recheck kill switch before each action.
7. Return first executed `decisionId` (or null if none executed).

**`runChatPipeline(data, aiEventId)`** (in `src/lib/ai-pm/chat-pipeline.ts`):

1. Load `aiPmConfig`, kill-switch gate.
2. Load `portfolioState`.
3. Load last N=20 `ai_chat_messages` for context.
4. Call new `runChatDecision({ userMessage, history, portfolioState, config, anthropicApiKey })`. This uses Sonnet with tool-use; tools mirror those in `decision.ts` but include extra `respondToUser({message})` tool for purely conversational replies that don't propose an action.
5. If the decision proposes a trading action: validate + execute as in scoped pipeline.
6. Persist assistant reply to `ai_chat_messages` with `decisionId` FK (if action) or null (if pure reply).
7. Return decisionId.

`runChatDecision` is a thin wrapper that prepares the prompt; the underlying LLM call uses the same `llm.ts` router with model = Sonnet (matching the decision layer).

## 9. Schema migration

```sql
-- drizzle/0012_<name>.sql

CREATE TYPE "ai_event_status" AS ENUM ('PENDING','THROTTLED','PROCESSING','PROCESSED','FAILED');

CREATE TABLE "ai_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "config_id" uuid NOT NULL REFERENCES "ai_pm_configs"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "event_type" "ai_trigger_source" NOT NULL,
  "symbol" text,
  "payload" jsonb NOT NULL,
  "status" "ai_event_status" NOT NULL DEFAULT 'PENDING',
  "decision_id" uuid REFERENCES "ai_decisions"("id") ON DELETE SET NULL,
  "emitted_at" timestamp NOT NULL,
  "processed_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX "ai_events_cfg_type_sym_idx"
  ON "ai_events" ("config_id","event_type","symbol","created_at");
CREATE INDEX "ai_events_status_idx" ON "ai_events" ("status");
CREATE INDEX "ai_events_user_created_idx" ON "ai_events" ("user_id","created_at");

CREATE TABLE "ai_pm_funding_cache" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "config_id" uuid NOT NULL REFERENCES "ai_pm_configs"("id") ON DELETE CASCADE,
  "symbol" text NOT NULL,
  "funding_rate" decimal(10,8) NOT NULL,
  "observed_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "ai_pm_funding_cache_cfg_sym"
  ON "ai_pm_funding_cache" ("config_id","symbol");
```

Migration is additive — no existing rows modified.

## 10. Error handling

- **Inngest event-handler retries:** 2 retries (vs cron's 0). Event failures should be transient (Anthropic timeouts, BingX 5xx). Failed handler runs leave `ai_events.status = 'FAILED'` and surface in the activity feed.
- **Detector failures inside existing handlers:** event emission wrapped in try/catch with logger.warn; never blocks the parent bot-watch loop. A failed emit drops the event silently — acceptable because the next 5-minute tick catches recurring conditions (drawdown, funding flip).
- **Kill switch:** rechecked at start of handler, before each pipeline step, and before each action execution — matches `ai-pm-tick`.
- **Anthropic budget:** uses the same monthly budget check from `llm.ts`; event-triggered LLM calls count toward `monthlyLlmBudgetUsd`. If budget exceeded, handler logs and exits with `status = 'FAILED'`, reason = 'budget_exhausted'.
- **BingX client unavailable:** handler logs `no_bingx_client`, marks event `FAILED`. Does not retry indefinitely.
- **Chat event with disabled config:** handler still inserts the chat message + ai_events row, marks event `FAILED` with reason `config_disabled`, surfaces in chat UI as "AI is currently disabled".

## 11. Testing strategy

**Unit tests (`vitest`)**

- `src/lib/ai-pm/__tests__/events.test.ts` — payload type narrowing, `mapNameToEnum`.
- `src/services/__tests__/ai-events.service.test.ts` — insert, throttle-check window math, status transitions.
- `src/services/__tests__/paper-bot-sim.service.test.ts` — paper simulator advances correctly; emits fills + errors via mock Inngest client.
- `src/lib/ai-pm/__tests__/event-pipeline.test.ts` — scoped pipeline runs signal with single symbol; respects kill switch; writes `ai_decisions` with correct `triggeredBy`.
- `src/lib/ai-pm/__tests__/chat-pipeline.test.ts` — chat pipeline handles pure-reply tool, action-proposal tool; persists `ai_chat_messages` rows.

**Integration tests**

- `src/inngest/functions/__tests__/ai-pm-event-handler.test.ts` — full handler: insert → throttle-check → pipeline → mark processed, against in-memory Postgres (or test container if already used) + mocked LLM/BingX.
- `src/inngest/functions/__tests__/ai-pm-monitor.test.ts` — monitor tick: paper bot advances, drawdown event fired when threshold breached, funding flip detected on cached vs current sign mismatch.
- Existing handler tests (`trading-bot-watch.test.ts`, etc.) — extend to assert that event-emission sidecar fires when `apiKey.managedByAi = true`.

**Test doubles**

- Mock Inngest event sender to capture `inngest.send()` calls; assert event names + payload shapes.
- Mock LLM router (`llm.ts`) — already done in existing tests; reuse pattern.
- Mock BingX client — existing pattern in `bingx.service.test.ts`.

**Coverage target:** match current AI PM coverage (~90%+ on `src/lib/ai-pm/**` and `src/services/ai-events.service.ts`). Aim for 230+ total tests after S14 (current main: 202).

**Manual smoke test (post-merge)**

1. Insert paper-mode AI PM config with `maxDrawdownPct = 5`.
2. Wait one `ai-pm-monitor` tick (5 minutes) — confirm `paper_bots.pnlUsdt` updates.
3. Force drawdown by manually updating a `paper_bots.pnlUsdt` row to `-10% of capitalUsdt`.
4. Within 5 minutes, confirm: `ai_events` row with `event_type = 'EVENT_DRAWDOWN'`, status `PROCESSED`, linked `ai_decisions` row with `triggered_by = 'EVENT_DRAWDOWN'`.
5. Send chat message via `POST /api/ai-pm/chat`. Confirm event row + decision row + assistant reply persisted.
6. Re-fire same event within 5 minutes; second `ai_events` row marked `THROTTLED`.

## 12. Open items deferred to plan

- Exact API contract for `POST /api/ai-pm/chat` (auth, rate-limit, response shape). Plan should define this; S14 spec only requires that the route emits `ai-pm/event.chat`.
- Whether `runChatDecision` reuses `runDecision` with a new prompt template or is a new wrapper. Plan should evaluate after reading current `decision.ts`. Either choice is acceptable; tests prove correctness.
- Whether paper simulator lives in S14 or already exists from S5/S10. Plan must verify by reading `src/lib/ai-pm/executor.ts` and `src/lib/ai-pm/__tests__`. If exists, S14 wires emission only; if not, S14 ships minimal version.

## 13. Branch and rollout

- Branch: `feat/ai-pm-monitor`
- Migration: `drizzle/0012_*.sql` (additive)
- Feature flag: none required — new tables and new functions are opt-in via existing `aiPmConfigs.enabled`.
- Deploy order: merge → run migration on Supabase → Inngest rsync (per `feedback_inngest_resync` memory) → confirm `ai-pm-monitor` + `ai-pm-event-handler` registered in Inngest dashboard.
