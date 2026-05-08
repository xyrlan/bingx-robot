# AI Portfolio Manager — Design Spec

**Date:** 2026-05-08
**Status:** Revised post-review (R1) — ready for implementation plan

## Overview

Add an autonomous AI Portfolio Manager (PM) that operates a **dedicated AI-managed BingX subaccount per user**. The AI selects symbols, picks strategies (DCA, DCA_SPOT, TRAILING_STOP, SMA_CROSSOVER — see Strategy Scope), allocates capital, monitors performance, and adjusts or shuts down bots autonomously. The AI does NOT manage bots created manually by the user; isolation is enforced via `apiKeyId` (one BingX API key row = one subaccount). Users opt in per account, choose a profile (Conservative/Balanced/Aggressive), tune guardrails (max capital, max drawdown, allowed symbols/strategies, leverage cap, max concurrent bots), and supply their own Anthropic API key (BYOK). Hard guardrails plus a deterministic backtest validate every decision before execution. Activity feed, analyst dashboard, and a conversational chat surface what the AI is doing and why.

## Strategy Scope (R1)

**MVP strategies** (where AI can add real value via timing + symbol selection): `DCA`, `DCA_SPOT`, `TRAILING_STOP`, `SMA_CROSSOVER`.

**Excluded from MVP:** `GRID_LONG`, `GRID_SHORT`. Rationale: grids are pre-defined ranges with fixed entry/TP orders. Once range is set, there is little room for ongoing AI decision-making — the cron just maintains the order book. AI orchestration adds complexity without clear edge. Grids stay as manual-only product. Future revisit: AI could pick range/grid count at creation, but execution is hands-off.

**Inngest cost note:** Currently `chore/disable-non-grid-long-crons` keeps DCA/DCA_SPOT/TRAILING_STOP/SMA_CROSSOVER crons disabled to reduce executions. Re-enabling globally is rejected. Instead, those crons are re-enabled **scoped to AI-managed subaccount only** (filter by `apiKeyId IN (SELECT id FROM bingx_api_keys WHERE managed_by_ai = true)`). Manual users on those strategies remain disabled until product decision changes.

## Goals

- Move the product from "user configures bots manually" to "AI runs a dedicated subaccount for me, within my limits."
- Multi-tenant: each user opts in independently and configures their own guardrails + their own AI subaccount API key.
- Auditable: every AI decision (proposed, rejected, executed) is persisted with full reasoning, signal snapshot, backtest result, and cost.
- Cost-controlled: multi-model routing keeps LLM spend low; per-user monthly budget cap with auto kill switch. **BYOK** — user supplies Anthropic API key, billed to their own Anthropic account.
- Reuses existing bot services without rewrite.

## Non-Goals

- Cross-user signal sharing or social trading. Each user's AI is isolated.
- Live ML model training. The AI uses LLMs plus deterministic indicators; no ML pipeline.
- AI managing manually-created bots. Manual bots and AI bots are partitioned by `apiKeyId`.
- AI on grid strategies in MVP (see Strategy Scope).
- Platform-paid LLM tokens in MVP. BYOK only.
- Using Claude consumer subscription as API source — claude.ai Max/Team subscriptions do NOT grant API access; Anthropic Console API key is required.

## Decisions Captured (from brainstorming + R1 review)

| Dimension | Choice |
|---|---|
| AI role | Fully autonomous |
| Scope | Portfolio manager over a dedicated AI-managed BingX subaccount |
| Capital model | Multi-tenant, per-user opt-in. Capital limit applies to AI subaccount only |
| Strategies (MVP) | DCA, DCA_SPOT, TRAILING_STOP, SMA_CROSSOVER (no grids) |
| Inputs | OHLCV (1h candles, 30 days for backtest) + RSI/ATR/Bollinger + funding rate + open interest + AI bot performance history |
| Decision frequency | Hybrid (cron 30min + event-driven monitor) |
| AI actions | Create bot / stop bot / adjust params / reallocate capital |
| User control | Two-tier: profile + custom guardrails |
| Validation | Hard guardrails + deterministic backtest (1h candles, 30d window) |
| Opus reviewer threshold | **Cumulative** — invoked when (current AI capital allocated + proposed action capital) > 30% of `maxCapitalUsdt`, OR first-time symbol |
| UX surface | Activity feed + analyst dashboard + chat (full) |
| LLM stack | Multi-model via Anthropic SDK direct: Haiku 4.5 / Sonnet 4.6 / Opus 4.7 routed by tactic |
| LLM billing | BYOK — user provides Anthropic API key, encrypted via `ENCRYPTION_KEY` (same path as BingX secrets) |

## Architecture

```
                    ┌─────────────────────────────────┐
                    │   AI Portfolio Manager (per user)│
                    └─────────────────────────────────┘
                                    │
  ┌─────────────────┬───────────────┼───────────────┬─────────────────┐
  │                 │               │               │                 │
  ▼                 ▼               ▼               ▼                 ▼
┌────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐      ┌──────────┐
│ Signal │ →  │ Decision │ →  │Validation│ →  │Execution │      │ Monitor  │
│(Haiku) │    │(Sonnet)  │    │(code+Opus│    │ (code)   │      │(events,  │
│cron 30m│    │on-demand │    │ rare)    │    │          │      │ Haiku)   │
└────────┘    └──────────┘    └──────────┘    └──────────┘      └──────────┘
     │              │              │                │                 │
     └──────────────┴──────────────┴────────────────┴─────────────────┘
                                    │
                                    ▼
                       ┌─────────────────────────┐
                       │ Audit log + Activity feed│
                       │ (DB: ai_decisions table) │
                       └─────────────────────────┘
                                    │
                                    ▼
                       ┌─────────────────────────┐
                       │  UI: feed + analyst      │
                       │  dashboard + chat        │
                       └─────────────────────────┘
```

### Decision flow (normal cron)
1. Inngest cron `ai-pm-tick` fires every 30 min for each user with `aiPmConfigs.enabled=true`.
2. Signal layer scans whitelisted symbols, returns top-5 candidates with regime classification.
3. Decision layer (Sonnet) consumes candidates plus portfolio state, emits structured tool calls.
4. Validation runs hard guardrails first, then backtest, then optional Opus review for large actions.
5. Execution layer maps validated tool calls to existing bot services.
6. Every step writes to `ai_decisions` (audit, even on rejection).

### Event flow (emergency)
- Inngest events `bot.drawdown.spike`, `bot.position.filled` (large fills), `market.funding.flip`, `bot.error.repeated`.
- Monitor layer (Haiku, cheap) classifies into `ignore`, `escalate_to_decision`, or `emergency_stop`.

### Stack
- **LLM:** Anthropic SDK direct (`@anthropic-ai/sdk`). Models: `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-7`. Prompt caching enabled. (Vercel AI SDK rejected to avoid extra abstraction; we already encrypt secrets and want full control over caching + cost tracking.)
- **Runtime:** Inngest functions (`ai-pm-tick`, `ai-pm-monitor`, `ai-pm-execute-decision`) on existing Connect worker. Each new function MUST be registered in BOTH `src/app/api/inngest/route.ts` AND `src/worker.ts`.
- **Persistence:** Postgres via Drizzle. Six new tables (5 core + `paper_bots`).
- **Backtest engine:** pure TypeScript module in `src/lib/backtest/`. Mirrors pure simulation functions extracted from existing services (see Pure-core refactor in Sessions).
- **Subaccount isolation:** new boolean column `bingxApiKeys.managedByAi`. AI never reads/writes bots whose `apiKeyId.managedByAi=false`. Cron filters apply at query level.
- **UI:** Next.js App Router pages under `src/app/dashboard/ai-pm/`, components in `src/components/ai-pm/`. HeroUI v3 + Tailwind. next-intl keys under `AiPm.*` (PascalCase to match existing convention).

## Components

### Signal Layer — `src/lib/ai-pm/signal.ts`
- **Input:** user's whitelisted symbols, recent 1h OHLCV (last 200 candles), funding rate, open interest. Market data fetched via shared `src/lib/bingx/market-data.ts` (extracted in Phase 0 — used by both Signal and Backtest).
- **Pre-processing (deterministic, no LLM):** RSI(14), ATR(14), Bollinger(20,2), MA20/50/200 crossover state, funding-rate trend.
- **Model:** Haiku 4.5 (cheap, frequent).
- **Output schema (Zod):**
  ```ts
  { candidates: Array<{ symbol: string; regime: 'range'|'trend_up'|'trend_down'|'chop'; score: number; reason: string }> }
  ```
- Top 5 candidates passed to Decision layer per tick.
- Note: AI MVP focuses on non-grid strategies, so "range" regime maps to DCA recommendations, "trend_up/down" maps to TRAILING_STOP or SMA_CROSSOVER, "chop" → no action.

### Decision Layer — `src/lib/ai-pm/decision.ts`
- **Input:** Signal candidates + portfolio state (active bots, P&L, capital used) + user profile/guardrails.
- **Model:** Sonnet 4.6 with prompt caching enabled (system + guardrails are stable; only state + signals vary).
- **Tool use schema:**
  ```ts
  tools: { create_bot, stop_bot, adjust_bot_params, reallocate_capital, no_action }
  ```
- **Output:** array of tool calls + reasoning text. Reasoning persisted in `ai_decisions.reasoning`.

### Validation Layer — `src/lib/ai-pm/validation.ts`
Three sequential checks:
1. **Hard guardrails (deterministic code):** rejects if max capital exceeded (sum of `capitalUsdt` across AI's running bots + proposed > `maxCapitalUsdt`), current AI subaccount drawdown > `maxDrawdownPct`, symbol outside `allowedSymbols`, strategy outside `allowedStrategies`, leverage > `maxLeverage`, concurrent AI bots > `maxConcurrentBots`.
2. **Backtest (deterministic code):** simulates the proposed strategy on the last 30 days of 1h OHLCV (~720 candles). Rejects if simulated P&L < 0 or simulated max drawdown > 2× `maxDrawdownPct`.
3. **Opus reviewer (rare):** invoked when **(currently allocated AI capital + proposed capital) > 30% of `maxCapitalUsdt`** OR symbol has no prior AI decision. Opus reads reasoning + backtest summary, returns `approve` or `veto` with rationale persisted in `ai_decisions.reasoning`.

### Execution Layer — `src/lib/ai-pm/executor.ts`
No LLM. Adapter with explicit `BotType → handler` map:

```ts
const handlers: Record<BotType, BotHandler> = {
  GRID_LONG:     null, // excluded from MVP (Strategy Scope)
  GRID_SHORT:    null, // excluded from MVP
  DCA:           require('@/services/bots/dca.service'),
  DCA_SPOT:      require('@/services/bots/dca-spot.service'),
  TRAILING_STOP: require('@/services/bots/trailing-stop.service'),
  SMA_CROSSOVER: require('@/services/bots/sma-crossover.service'),
};
```

All tool calls run with `apiKeyId` of the user's AI subaccount, never `userId` alone.

- `create_bot` → handler.createBot(params, aiApiKeyId).
- `stop_bot` → handler.stopBot(botId, aiApiKeyId). Validates `bot.apiKeyId === aiApiKeyId` before stopping (defensive).
- `adjust_bot_params` → **NEW**: requires adding dynamic reconfig support per strategy. MVP fallback: stop + recreate with new params (acceptable for non-grid strategies).
- `reallocate_capital` → **NEW**: stop + recreate with new `positionSizeUsdt`. Same fallback as adjust.

### Monitor Layer — `src/inngest/functions/ai-pm-monitor.ts`
Event-driven:
- `bot.drawdown.spike` (emitted from `trading-bot-watch.ts` when DD > X%).
- `bot.position.filled` (large fill detected).
- `market.funding.flip` (Signal detects funding sign change).
- `bot.error.repeated` (3 consecutive API errors).

Monitor (Haiku) classifies: `ignore`, `escalate_to_decision`, `emergency_stop` (kill direct, no LLM extra).

### Cron orchestrator — `src/inngest/functions/ai-pm-tick.ts`
Runs every 30 min per opt-in user:
1. Load `aiPmConfigs` + portfolio state.
2. Signal → Decision → Validation → Execution sequentially.
3. Persist `ai_decisions` at each step (also on rejection).
4. Inngest concurrency: 1 per user, max 3 users in parallel.

### Backtest engine — `src/lib/backtest/`
Pure TypeScript module (no LLM):
- Uses `src/lib/bingx/market-data.ts` (extracted in Phase 0) for OHLCV. Default window: 1h candles, 30 days (720 candles).
- `simulateDCA(params, candles)`, `simulateTrailingStop(...)`, `simulateSmaCrossover(...)` — MVP simulators. Each imports the **pure-core** simulation function from the corresponding service (see Pure-core refactor in Sessions). No code duplication; same function is used by real cron and backtest, just with different input source (live API vs historical candles).
- `metrics(trades)` — P&L, max drawdown, simplified Sharpe, win rate.
- Cache via `backtest_runs` table keyed on `(symbol, strategy, paramsHash, windowDays)`.
- Drift sanity check: weekly job runs backtest on past 7d → compares to actual AI bot performance in same window. Drift > 10% → alert + flagged in observability.

## Database Schema (Drizzle additions)

```ts
export const aiPmModeEnum = pgEnum('ai_pm_mode', ['CONSERVATIVE', 'BALANCED', 'AGGRESSIVE', 'CUSTOM']);
export const aiDecisionStatusEnum = pgEnum('ai_decision_status', [
  'PROPOSED', 'REJECTED_GUARDRAIL', 'REJECTED_BACKTEST', 'REJECTED_REVIEWER', 'EXECUTED', 'EXECUTION_FAILED'
]);
export const aiActionTypeEnum = pgEnum('ai_action_type', [
  'CREATE_BOT', 'STOP_BOT', 'ADJUST_PARAMS', 'REALLOCATE_CAPITAL', 'NO_ACTION'
]);
export const aiTriggerSourceEnum = pgEnum('ai_trigger_source', [
  'CRON_TICK', 'EVENT_DRAWDOWN', 'EVENT_FUNDING_FLIP', 'EVENT_FILL', 'EVENT_ERROR', 'CHAT'
]);

// Existing bingxApiKeys table gains a column (migration in Phase 0):
//   ALTER TABLE bingx_api_keys ADD COLUMN managed_by_ai BOOLEAN NOT NULL DEFAULT FALSE;
// One AI subaccount key per user is the convention; uniqueness enforced at app layer.

export const aiPmConfigs = pgTable('ai_pm_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  bingxApiKeyId: uuid('bingx_api_key_id')
    .notNull()
    .references(() => bingxApiKeys.id, { onDelete: 'cascade' }),
  anthropicApiKeyEncrypted: text('anthropic_api_key_encrypted').notNull(),
  enabled: boolean('enabled').default(false).notNull(),
  mode: aiPmModeEnum('mode').default('BALANCED').notNull(),
  maxCapitalUsdt: decimal('max_capital_usdt', { precision: 20, scale: 8 }),
  maxDrawdownPct: decimal('max_drawdown_pct', { precision: 5, scale: 2 }),
  maxLeverage: integer('max_leverage'),
  allowedSymbols: jsonb('allowed_symbols').$type<string[]>(),
  allowedStrategies: jsonb('allowed_strategies').$type<string[]>(),
  maxConcurrentBots: integer('max_concurrent_bots').default(5),
  monthlyLlmBudgetUsd: decimal('monthly_llm_budget_usd', { precision: 10, scale: 2 }),
  killSwitch: boolean('kill_switch').default(false).notNull(),
  paperMode: boolean('paper_mode').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('ai_pm_configs_user_idx').on(t.userId),
  uniqueIndex('ai_pm_configs_apikey_idx').on(t.bingxApiKeyId),
]);

export const aiDecisions = pgTable('ai_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  triggeredBy: aiTriggerSourceEnum('triggered_by').notNull(),
  triggerDetail: text('trigger_detail'),  // optional payload (e.g., bot id for events)
  actionType: aiActionTypeEnum('action_type').notNull(),
  status: aiDecisionStatusEnum('status').notNull(),
  symbol: text('symbol'),
  strategy: botTypeEnum('strategy'),
  params: jsonb('params'),
  reasoning: text('reasoning'),
  signalSnapshot: jsonb('signal_snapshot'),
  backtestRunId: uuid('backtest_run_id'),
  rejectionReason: text('rejection_reason'),
  modelUsed: text('model_used'),
  tokensInput: integer('tokens_input'),
  tokensOutput: integer('tokens_output'),
  costUsd: decimal('cost_usd', { precision: 10, scale: 6 }),
  resultBotId: uuid('result_bot_id').references(() => tradingBots.id, { onDelete: 'set null' }),
  executedAt: timestamp('executed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('ai_decisions_user_created_idx').on(t.userId, t.createdAt),
  index('ai_decisions_status_idx').on(t.status),
]);

export const aiSignals = pgTable('ai_signals', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  symbol: text('symbol').notNull(),
  regime: text('regime').notNull(),
  score: integer('score').notNull(),
  reason: text('reason'),
  indicatorsSnapshot: jsonb('indicators_snapshot'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [index('ai_signals_user_symbol_idx').on(t.userId, t.symbol, t.createdAt)]);

export const backtestRuns = pgTable('backtest_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  symbol: text('symbol').notNull(),
  strategy: botTypeEnum('strategy').notNull(),
  paramsHash: text('params_hash').notNull(),
  params: jsonb('params').notNull(),
  windowDays: integer('window_days').notNull(),
  pnlPct: decimal('pnl_pct', { precision: 10, scale: 4 }),
  maxDrawdownPct: decimal('max_drawdown_pct', { precision: 10, scale: 4 }),
  sharpeApprox: decimal('sharpe_approx', { precision: 10, scale: 4 }),
  winRatePct: decimal('win_rate_pct', { precision: 5, scale: 2 }),
  totalTrades: integer('total_trades'),
  metricsJson: jsonb('metrics_json'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('backtest_runs_dedup_idx').on(t.symbol, t.strategy, t.paramsHash, t.windowDays),
]);

export const aiChatMessages = pgTable('ai_chat_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  content: text('content'),
  toolCalls: jsonb('tool_calls'),
  decisionId: uuid('decision_id').references(() => aiDecisions.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [index('ai_chat_user_created_idx').on(t.userId, t.createdAt)]);
```

### `paper_bots` table (Phase 0)

```ts
export const paperBots = pgTable('paper_bots', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  decisionId: uuid('decision_id').references(() => aiDecisions.id, { onDelete: 'set null' }),
  symbol: text('symbol').notNull(),
  strategy: botTypeEnum('strategy').notNull(),
  params: jsonb('params').notNull(),
  capitalUsdt: decimal('capital_usdt', { precision: 20, scale: 8 }).notNull(),
  status: botStatusEnum('status').notNull().default('STOPPED'),
  pnlUsdt: decimal('pnl_usdt', { precision: 20, scale: 8 }).default('0'),
  trades: jsonb('trades').$type<unknown[]>(),  // simulated fills
  startedAt: timestamp('started_at'),
  stoppedAt: timestamp('stopped_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [index('paper_bots_user_status_idx').on(t.userId, t.status)]);
```

Used when `aiPmConfigs.paperMode=true`. Executor writes paper rows and simulates fills via the same pure-core simulation functions used by Backtest, fed by live OHLCV stream every cron tick.

## UX

### Settings — `/dashboard/ai-pm/settings`
- **Subaccount setup** (first-run wizard): user pastes BingX API key + secret for the AI subaccount → encrypted + saved with `managedByAi=true`. Helper text explains: "Create a separate BingX subaccount with isolated balance, then paste those keys here."
- **Anthropic key**: user pastes their Anthropic API key (BYOK) → encrypted via `ENCRYPTION_KEY` (same path as BingX). UI shows a "Test connection" button that calls `client.messages.create` with 1-token sample.
- **Profile** (Conservative/Balanced/Aggressive) card with guardrail preview.
- **Customize** toggle reveals editable form (max capital, max drawdown, max leverage, allowed symbols multi-select limited to BingX symbols, allowed strategies limited to MVP set, max concurrent bots, monthly LLM budget USD).
- **Paper mode** toggle (separate from enabled).
- **Global enabled** toggle.
- **Red Kill Switch** button (see Kill Switch State Machine below).
- **LLM budget gauge** showing current month consumption from `ai_decisions.costUsd` aggregate.

### Activity Feed — `/dashboard/ai-pm`
Reverse-chronological timeline of `ai_decisions`:
- Each entry shows action type, symbol, status icon, one-line reasoning summary, expandable details (full signal snapshot, full reasoning, backtest metrics, params JSON).
- Filters: status, symbol, action type, date range.

### Analyst Dashboard — `/dashboard/ai-pm/analyst`
- "Current thesis" card: Sonnet-generated 24h portfolio outlook, refreshed each tick.
- Watchlist: top 5 candidates from latest Signal run with regime + score + indicators.
- Active AI positions: subset of bots created by AI, live P&L plus original opening reason.
- AI-only performance: equity curve, Sharpe, win rate vs manual bots.
- Regime heatmap of whitelisted symbols (last hour).

### Chat — `/dashboard/ai-pm/chat`
- Conversational with persistent history (`ai_chat_messages`).
- LLM: Sonnet with safe tool use:
  - `query_decisions(filter)` — pull reasoning of past decisions.
  - `force_stop_bot(id)` — user-commanded stop (requires UI confirm).
  - `pause_ai(minutes)` — temporary pause.
  - `add_blocklist(symbol)` — AI avoids that symbol.
- Streaming via Vercel AI SDK `useChat`.

### Code layout
- `src/app/dashboard/ai-pm/` — App Router pages.
- `src/components/ai-pm/` — `ActivityFeed`, `GuardrailForm`, `AnalystDashboard`, `ChatPanel`, `KillSwitch`, `SubaccountSetup`, `AnthropicKeyForm`.
- next-intl keys under `AiPm.*` (PascalCase to match `Auth.*`, `Bots.*` convention).
- Server Components by default; Client Components only for chat, forms, kill switch.

### Kill Switch State Machine
Two-tier user control:
- **Pause** (toggle `enabled=false`): no new ticks, no new actions. Existing bots continue running. Audit log records pause.
- **Kill Switch** (set `killSwitch=true`): cron tick aborts immediately + Executor enqueues `stop_bot` for every bot with `apiKeyId = aiPmConfigs.bingxApiKeyId AND status=RUNNING`. Position handling follows existing "Let it Ride" pattern: cancel entry orders, leave open positions and TPs. UI shows confirm modal: "This will stop all AI bots immediately. Open positions stay open. Continue?"

### Chat Tool Confirmations
**Every** chat tool that mutates state requires UI confirmation modal before execution, regardless of severity:
- `force_stop_bot(id)` → modal "Stop bot X?"
- `pause_ai(minutes)` → modal "Pause AI for N minutes?"
- `add_blocklist(symbol)` → modal "AI will avoid {symbol}. Confirm?"
- `query_decisions(filter)` → no confirm (read-only).
Tool calls authz: chat-issued `botId` is validated against `bingxApiKeys.userId === currentUserId AND bingxApiKeys.managedByAi=true`. Reject otherwise. Rate limit: max 10 mutating chat tool calls per user per hour.

## Error Handling

| Failure | Detection | Response |
|---|---|---|
| LLM timeout / API error | try/catch + 3× exponential retry | Skip tick, log `EXECUTION_FAILED`, alert if 3 consecutive ticks fail |
| LLM hallucination (invalid symbol, absurd params) | Zod schema parse + validation | Reject with `REJECTED_GUARDRAIL`, per-user counter — disable AI if > 5/day |
| Backtest engine error | Wrapped error capture | Decision stays `PROPOSED` but does not advance, audit log only |
| BingX rate limit | Existing 400ms delay + 429 handling | Exponential backoff, reuse existing pattern |
| Bot creation failure post-validation | Service throws | Status `EXECUTION_FAILED`, reasoning preserved, UI alert |
| LLM budget exceeded | Sum of `costUsd` in current month > budget | Auto kill switch + notification |
| Cron stuck / overlapping | Inngest concurrency=1 per user | Inngest manages |
| Drawdown spike between ticks | Monitor event-driven | Emergency stop direct, no extra LLM |
| User pauses mid-tick | `aiPmConfigs.killSwitch=true` checked at each layer | Aborts before execution, audit log |

## Security

- **Tool use isolation:** strict Zod schema on every AI tool call. No freeform input becomes execution.
- **Hard allowlist:** `allowedSymbols` validated in code before invoking bot services. AI cannot bypass via prompt injection.
- **Multi-layer capital cap:** check at (1) Decision prompt context, (2) Validation guardrails, (3) Execution layer.
- **Encryption preserved:** AI uses the existing encrypted `bingxApiKeys` path. No new secret handling.
- **Prompt injection defense:** market signals come from BingX (trusted source). No user input flows directly into Decision prompt. Chat is isolated and has only safe tools.
- **Chat tools require confirmation:** `force_stop_bot` shows UI confirm before executing.
- **Rate limit:** max 1 tick per user per 30 min. Burst protection.
- **Audit immutability:** `ai_decisions` is insert-only. Updates restricted to defined status transitions.

## Observability

- **Structured logs:** every layer emits `userId, decisionId, model, latency, tokens, cost`.
- **Inngest dashboard:** new functions visible automatically.
- **Cost tracking:** materialized view `ai_pm_cost_daily` aggregates `ai_decisions.tokensInput/Output/costUsd`.
- **Metrics API:** `GET /api/ai-pm/metrics` per user — decisions count, exec rate, avg cost, AI-only P&L.
- **Alerts:** Inngest `step.sendEvent` to `ai-pm.alert.*` on 3 consecutive failures, budget at 80%, critical drawdown.

## Testing

### Unit
- **Backtest engine** (`src/lib/backtest/__tests__/`): `simulateGrid`, `simulateDCA`, `simulateTrailingStop`, `metrics`. Deterministic fixtures with known expected P&L.
- **Validation layer** (`src/lib/ai-pm/__tests__/validation.test.ts`): each guardrail rejection path; mocked backtest results.
- **Signal/Decision parsing**: Zod schema rejects malformed LLM output. JSON fixtures replace API calls.
- **Executor**: services mocked; verify correct mapping from tool call to service invocation; failure paths set `EXECUTION_FAILED`.

### Integration
- DB roundtrip on `ai_decisions` insert + feed query.
- Kill-switch mid-tick aborts subsequent steps.
- Concurrency: two simultaneous ticks for the same user — only one executes.

### LLM tests (recorded, not live)
- Cassette fixtures of Haiku/Sonnet/Opus responses for canonical scenarios (range → grid, trending → trailing, chop → no_action, drawdown spike → emergency).
- Replay deterministic in CI. Live LLM smoke test runs manually pre-deploy, outside CI.

### Backtest accuracy
- Periodic sanity check: backtest in past window vs real bot performance in same window. Drift > 10% indicates engine bug.

### Paper trading harness
- `aiPmConfigs.paperMode=true` makes Executor write `ai_decisions.status=EXECUTED` without calling BingX. Virtual bots in `paper_bots` table.
- Used in dev and as Phase 1 ship gate.

## Implementation Sessions

Each session is a single, self-contained PR/branch with one clear objective. Sessions are ordered by dependency. Every session has: **Objective**, **Scope (files)**, **Out of scope**, **Dependencies**, **Done criteria** (testable). An implementing agent reads one session and ships it without needing the rest of the spec — no jumping around, no guessing.

Estimates are rough; gate is "Done criteria met", not time.

---

### Session 0 — Pre-flight: dependencies + scoped cron re-enable
**Objective:** Install deps; re-enable non-grid Inngest crons scoped to AI-managed subaccounts only.

**Scope (files):**
- `package.json` — add `@anthropic-ai/sdk`. Confirm `zod` already present.
- `src/db/schema.ts` — add `managedByAi: boolean('managed_by_ai').notNull().default(false)` to `bingxApiKeys`.
- Drizzle migration for that column.
- `src/inngest/functions/dca-bot-watch.ts`, `dca-spot-bot-watch.ts`, `trailing-stop-watch.ts`, `sma-crossover-watch.ts` — modify each query to filter `WHERE bingx_api_keys.managed_by_ai = true`.
- `src/app/api/inngest/route.ts` and `src/worker.ts` — re-import and register the four crons.

**Out of scope:** any AI code, schema for AI tables, UI changes.

**Dependencies:** none.

**Done criteria:**
- `bun install` succeeds; new dep visible in `bun.lock`.
- `bun run db:migrate` applies cleanly. `bingx_api_keys.managed_by_ai` exists, defaults `false`.
- All existing manual GRID_LONG bots still process (verify in Inngest logs).
- Manually setting `managed_by_ai=true` on a test key + creating a DCA bot under it → cron picks it up. Confirm in logs.
- A DCA bot under `managed_by_ai=false` (the legacy state) is NOT processed.

---

### Session 1 — AI schema migrations
**Objective:** Add the six new tables + enums for the AI Portfolio Manager.

**Scope (files):**
- `src/db/schema.ts` — append: `aiPmModeEnum`, `aiDecisionStatusEnum`, `aiActionTypeEnum`, `aiTriggerSourceEnum`, `aiPmConfigs`, `aiDecisions`, `aiSignals`, `backtestRuns`, `aiChatMessages`, `paperBots`, plus relations.
- Drizzle migration generated and committed.

**Out of scope:** any service code, UI, business logic.

**Dependencies:** Session 0.

**Done criteria:**
- `bun run db:generate` produces a migration. `bun run db:migrate` applies cleanly on a fresh DB and on the current dev DB.
- `npm run lint` passes.
- All FKs and indexes match the spec's Database Schema section verbatim.

---

### Session 2 — Encryption + Anthropic BYOK service
**Objective:** Encrypt/decrypt Anthropic API keys via the existing `ENCRYPTION_KEY` path. Provide a connection-test entry point.

**Scope (files):**
- `src/lib/bingx/encryption.ts` — confirm `encryptSecret`/`decryptSecret` are reusable for arbitrary strings (no BingX-specific assumptions). If they are, no edits; otherwise extract a generic `encryptString`/`decryptString` and have the BingX functions call those.
- New: `src/services/ai-pm-config.service.ts` — `getOrCreateConfig(userId)`, `setAnthropicKey(userId, plaintext)`, `testAnthropicKey(plaintext): { ok: boolean; error?: string }` (calls `client.messages.create` with 1 input token).
- Tests: `src/services/__tests__/ai-pm-config.service.test.ts`.

**Out of scope:** UI, AI routing, anything beyond the BYOK lifecycle.

**Dependencies:** Session 1.

**Done criteria:**
- Round-trip test: encrypt then decrypt returns the original key.
- `testAnthropicKey` returns `ok=true` on a real test key, `ok=false` with descriptive error on an invalid key.
- `aiPmConfigs.anthropicApiKeyEncrypted` row written via service, read back, and decrypted matches the input.

---

### Session 3 — Pure-core refactor of strategy services
**Objective:** Extract the deterministic simulation logic from each MVP-strategy service into pure functions that take `(state, candle) → { newState, orders }`. Real cron and backtest both call the same pure function.

**Scope (files):**
- New: `src/services/bots/<strategy>/core.ts` for each of `dca`, `dca-spot`, `trailing-stop`, `sma-crossover`. Each exports `tick(state, candle) → { newState, intents }` plus initial-state builder.
- Modified: each `src/services/bots/<strategy>.service.ts` — convert real cron loop to call `core.tick` then translate `intents` into BingX API calls + DB writes.
- Tests: `src/services/bots/__tests__/<strategy>-core.test.ts` per strategy with deterministic candle fixtures.

**Out of scope:** GRID_LONG, GRID_SHORT (excluded from MVP). AI code.

**Dependencies:** Session 0.

**Done criteria:**
- All four MVP strategies have a `core.ts` with no IO (no DB, no fetch).
- Each `core.ts` has a unit test with at least 3 fixtures (uptrend, downtrend, flat) and asserted intents.
- Existing real-money behavior unchanged: run a non-grid bot under a test subaccount and observe identical orders before/after refactor.

---

### Session 4 — Shared market data + indicators
**Objective:** Centralize OHLCV fetching and indicator calculations so Signal, Backtest, and Decision all share one source.

**Scope (files):**
- New: `src/lib/bingx/market-data.ts` — `fetchKlines(symbol, interval, limit)`, with in-memory cache (TTL 60s for current candle, infinite for closed candles). Wraps `BingxClient.getKlines`.
- New: `src/lib/ai-pm/indicators.ts` — pure functions: `rsi(candles, period=14)`, `atr(candles, period=14)`, `bollinger(candles, period=20, stdDev=2)`, `sma(candles, period)`, `crossoverState(short, long)`. No allocation in tight loops.
- Tests: `src/lib/ai-pm/__tests__/indicators.test.ts` with known fixtures (e.g., RSI of a flat series → 50; trend up → 70+).

**Out of scope:** LLM, Signal layer, Decision layer.

**Dependencies:** Session 0.

**Done criteria:**
- All indicators have unit tests with assertions against known values.
- `fetchKlines("BTC-USDT", "1h", 720)` returns 720 candles in dev.
- Cache is observable: second call within 60s does not hit BingX (mock the client and assert single call).

---

### Session 5 — Backtest engine
**Objective:** Deterministic backtester for the four MVP strategies. Caches results.

**Scope (files):**
- New: `src/lib/backtest/index.ts` — `runBacktest({ symbol, strategy, params, windowDays = 30 }): Promise<BacktestResult>`.
- New: `src/lib/backtest/simulators/<strategy>.ts` — wraps the pure `core.tick` from Session 3, feeds historical candles, accumulates trades.
- New: `src/lib/backtest/metrics.ts` — `pnlPct`, `maxDrawdownPct`, `sharpeApprox`, `winRatePct`.
- New: `src/lib/backtest/cache.ts` — read/write `backtest_runs` keyed by `(symbol, strategy, paramsHash, windowDays)`.
- Tests: `src/lib/backtest/__tests__/<strategy>.test.ts` per strategy, plus `metrics.test.ts`.

**Out of scope:** AI calls, paper trading.

**Dependencies:** Sessions 3, 4.

**Done criteria:**
- Each strategy produces a numeric P&L for a known fixture and metrics match hand-computed values.
- Cache hit returns the same row without re-running simulation.
- Running a backtest for `DCA BTC-USDT 30d` completes in under 5 seconds locally.

---

### Session 6 — LLM router (Anthropic SDK direct)
**Objective:** Single entry point for AI calls with model routing, BYOK key resolution, prompt caching, cost tracking.

**Scope (files):**
- New: `src/lib/ai-pm/llm.ts` — `getClient(userId): Anthropic` (decrypts BYOK key), `callHaiku(prompt, schema)`, `callSonnet(prompt, tools)`, `callOpus(prompt)`. Each returns `{ data, usage: { inputTokens, outputTokens, costUsd } }`. Cost computed from a constants table.
- New: `src/lib/ai-pm/llm.constants.ts` — model IDs and token prices.
- Tests: `src/lib/ai-pm/__tests__/llm.test.ts` — mocks Anthropic SDK; asserts schema parsing, cost calculation, error paths (timeout, invalid key, schema reject).

**Out of scope:** Signal / Decision specific prompts.

**Dependencies:** Session 2.

**Done criteria:**
- `callHaiku` rejects malformed JSON via Zod and returns `error: 'SCHEMA_REJECTED'`.
- Cost calculation matches manual computation for a known token count.
- `getClient(userId)` throws if user has no encrypted key set.

---

### Session 7 — Signal layer
**Objective:** Implement Signal: pre-process market data, call Haiku, return top-5 candidates.

**Scope (files):**
- New: `src/lib/ai-pm/signal.ts` — `runSignal(userId, allowedSymbols): SignalResult`. Steps: fetch klines (Session 4), compute indicators (Session 4), build prompt, call Haiku (Session 6), parse Zod, persist `aiSignals` rows.
- New: `src/lib/ai-pm/signal.prompt.ts` — system + user prompt templates.
- Tests: `src/lib/ai-pm/__tests__/signal.test.ts` with cassette LLM fixtures (no live API).

**Out of scope:** Decision, validation, execution.

**Dependencies:** Sessions 4, 6.

**Done criteria:**
- Given fixed market data + a recorded Haiku response, `runSignal` produces a deterministic candidate list.
- `aiSignals` rows written for each candidate.
- Schema rejection (malformed Haiku output) results in zero `aiSignals` writes and an error returned.

---

### Session 8 — Decision layer
**Objective:** Sonnet call with tool-use schema, returns proposed actions.

**Scope (files):**
- New: `src/lib/ai-pm/decision.ts` — `runDecision({ userId, candidates, portfolioState, config }): ProposedAction[]`. Uses Anthropic tool use with Zod-validated schemas for `create_bot`, `stop_bot`, `adjust_bot_params`, `reallocate_capital`, `no_action`.
- New: `src/lib/ai-pm/decision.prompt.ts` — system prompt (cached), user-state prompt.
- New: `src/lib/ai-pm/portfolio-state.ts` — `loadPortfolioState(userId, aiApiKeyId)` returns running AI bots, P&L, capital used, drawdown.
- Tests: `src/lib/ai-pm/__tests__/decision.test.ts` with cassette Sonnet responses.

**Out of scope:** Validation, execution, monitor.

**Dependencies:** Sessions 6, 7.

**Done criteria:**
- For a recorded Sonnet response, `runDecision` returns a typed `ProposedAction[]`.
- Tool-call args are Zod-validated; malformed tool args are rejected with explicit error per action (skipped, not aborted).
- Prompt caching enabled: second call within 5min uses cached system block (verified via response usage object).

---

### Session 9 — Validation layer
**Objective:** Three-stage gate: hard guardrails → backtest → optional Opus reviewer.

**Scope (files):**
- New: `src/lib/ai-pm/validation.ts` — `validate(userId, action, config, portfolioState): { ok: boolean; status: AiDecisionStatus; reason?: string; backtestRunId?: string }`.
- New: `src/lib/ai-pm/reviewer.ts` — `reviewWithOpus(action, backtestSummary, reasoning): { approve: boolean; rationale: string }`.
- Tests: `src/lib/ai-pm/__tests__/validation.test.ts` covering each rejection branch.

**Out of scope:** Execution.

**Dependencies:** Sessions 5, 6, 8.

**Done criteria:**
- Capital cap rejection: action that pushes total above `maxCapitalUsdt` is rejected with `REJECTED_GUARDRAIL`.
- Backtest negative P&L → `REJECTED_BACKTEST`.
- Opus reviewer threshold (cumulative > 30% or first-time symbol) is correctly triggered or skipped per fixture.
- All rejection paths persist a row in `ai_decisions` with the corresponding status.

---

### Session 10 — Executor + paper-mode branch
**Objective:** Adapter that maps validated actions to existing bot services or to paper bots, scoped to AI subaccount.

**Scope (files):**
- New: `src/lib/ai-pm/executor.ts` — `execute(userId, action, config): ExecutionResult`. Handler map per `BotType`. If `config.paperMode=true`, writes to `paper_bots` instead of calling real services.
- New: `src/services/paper-bots.service.ts` — CRUD + simulated tick using pure-core simulators (Session 3).
- Tests: `src/lib/ai-pm/__tests__/executor.test.ts` with mocked services.

**Out of scope:** Cron orchestration.

**Dependencies:** Sessions 3, 9.

**Done criteria:**
- Real-mode `create_bot` for `DCA` calls `bots/dca.service.createBot` with `apiKeyId = config.bingxApiKeyId`.
- Paper-mode `create_bot` writes a row in `paper_bots`, no real-service call (assert via mock).
- Stop on a bot whose `apiKeyId` does not match `config.bingxApiKeyId` is rejected with `EXECUTION_FAILED`.

---

### Session 11 — Cron orchestrator (`ai-pm-tick`)
**Objective:** Inngest function that runs the full pipeline per opt-in user every 30 minutes.

**Scope (files):**
- New: `src/inngest/functions/ai-pm-tick.ts` — cron `*/30 * * * *`. For each user with `enabled=true AND killSwitch=false`: load config + state → Signal → Decision → Validation → Execution. Concurrency: 1 per user; max 3 users in parallel. Persist `ai_decisions` at every step.
- Modified: `src/app/api/inngest/route.ts` and `src/worker.ts` — register the new function in BOTH (explicit checklist).
- Tests: `src/inngest/functions/__tests__/ai-pm-tick.test.ts` — exercise tick end-to-end with mocked Signal/Decision/Validation/Executor.

**Out of scope:** Monitor (event-driven), UI.

**Dependencies:** Sessions 7, 8, 9, 10.

**Done criteria:**
- Function visible in Inngest dev UI.
- Manually triggered run on a paper-mode user produces a full chain of `ai_decisions` rows ending in `EXECUTED` or a deterministic rejection reason.
- Kill switch flip mid-run causes the next step to abort with `EXECUTION_FAILED` and rationale.

---

### Session 12 — Settings UI: subaccount + BYOK + profile
**Objective:** End-to-end onboarding so a user can enable AI mode through the dashboard.

**Scope (files):**
- New: `src/app/dashboard/ai-pm/settings/page.tsx`.
- New: `src/components/ai-pm/SubaccountSetup.tsx` — paste BingX API key + secret with `managedByAi=true` flag.
- New: `src/components/ai-pm/AnthropicKeyForm.tsx` — paste, encrypt, "Test" button.
- New: `src/components/ai-pm/GuardrailForm.tsx` — profile cards, customize toggle, all guardrail fields.
- New: `src/components/ai-pm/KillSwitch.tsx` — confirm modal.
- New: `src/app/api/ai-pm/config/route.ts` — POST/GET CRUD on `aiPmConfigs`.
- New: `src/app/api/ai-pm/anthropic-test/route.ts` — POST tests connection.
- New: `messages/{en,pt,zh}.json` — `AiPm.Settings.*` keys.

**Out of scope:** Activity feed, analyst dashboard, chat.

**Dependencies:** Session 2.

**Done criteria:**
- User can configure subaccount + Anthropic key + profile + custom guardrails through the UI; data persists.
- Kill Switch button shows a confirm modal, then sets `killSwitch=true`.
- "Test connection" returns success/failure with a meaningful message.
- All UI strings come from i18n keys (no hardcoded copy).

---

### Session 13 — Activity feed UI
**Objective:** User sees what AI is doing.

**Scope (files):**
- New: `src/app/dashboard/ai-pm/page.tsx` — server component, list of `ai_decisions`.
- New: `src/components/ai-pm/ActivityFeed.tsx` — timeline rendering.
- New: `src/components/ai-pm/DecisionDetail.tsx` — expandable detail with reasoning, signal snapshot, backtest metrics, params JSON.
- New: `src/app/api/ai-pm/decisions/route.ts` — GET with filters: status, symbol, action type, date range, pagination.

**Out of scope:** Charts, analyst dashboard.

**Dependencies:** Session 11 (so there's data).

**Done criteria:**
- Feed renders most-recent-first.
- Clicking an item expands it and shows full detail without a page reload.
- Filters work and update the URL query string.

---

### Session 14 — Monitor (event-driven)
**Objective:** React to drawdown spikes, funding flips, large fills, repeated errors.

**Scope (files):**
- Modified: `src/inngest/functions/dca-bot-watch.ts` (and other strategy crons) — emit `bot.drawdown.spike`, `bot.position.filled`, `bot.error.repeated` events when conditions met.
- New: `src/inngest/functions/ai-pm-monitor.ts` — event listener; runs Haiku to classify (`ignore` / `escalate_to_decision` / `emergency_stop`); on emergency_stop calls Executor stop directly.
- New: `src/lib/ai-pm/monitor.ts` — `classifyEvent(event, context): MonitorAction`.
- Modified: register monitor function in `route.ts` + `worker.ts`.
- Tests: `src/lib/ai-pm/__tests__/monitor.test.ts`.

**Out of scope:** UI for monitor history (covered by feed via `triggeredBy` field).

**Dependencies:** Sessions 6, 10, 11.

**Done criteria:**
- Triggering a synthetic drawdown event in dev fires the monitor function and produces an `ai_decisions` row with `triggeredBy='EVENT_DRAWDOWN'`.
- A funding-flip event escalates to a Decision tick (verify by Inngest event log).
- An emergency_stop classification calls Executor stop on the affected bot (mocked test).

---

### Session 15 — Analyst dashboard
**Objective:** Trader cockpit view: thesis, watchlist, performance, regime heatmap.

**Scope (files):**
- New: `src/app/dashboard/ai-pm/analyst/page.tsx`.
- New: `src/components/ai-pm/ThesisCard.tsx` — Sonnet-generated 24h outlook (cached per tick).
- New: `src/components/ai-pm/Watchlist.tsx` — top-5 from latest `aiSignals`.
- New: `src/components/ai-pm/RegimeHeatmap.tsx` — table of allowedSymbols × regime × score.
- New: `src/components/ai-pm/PerformancePanel.tsx` — equity curve and metrics for AI subaccount.
- New: `src/app/api/ai-pm/thesis/route.ts` — POST, generates and caches thesis.

**Out of scope:** Chat.

**Dependencies:** Sessions 11, 13.

**Done criteria:**
- Thesis updates after each tick; caching prevents regeneration on every page load.
- Watchlist mirrors latest `aiSignals` rows.
- Performance panel matches `botTrades` aggregate for AI subaccount bots.

---

### Session 16 — Chat
**Objective:** Conversational interface with safe tools and confirmation modals.

**Scope (files):**
- New: `src/app/dashboard/ai-pm/chat/page.tsx`.
- New: `src/components/ai-pm/ChatPanel.tsx` — streaming UI with confirmation modal for every mutating tool call.
- New: `src/app/api/ai-pm/chat/route.ts` — server route streams from Anthropic SDK with tool use.
- New: `src/lib/ai-pm/chat-tools.ts` — Zod schemas for `query_decisions`, `force_stop_bot`, `pause_ai`, `add_blocklist`.
- New: rate-limit middleware (max 10 mutating calls/hour per user).

**Out of scope:** Multi-conversation history. Single conversation per user, persisted in `ai_chat_messages`.

**Dependencies:** Session 13 (decisions exist), Session 14 (monitor wired).

**Done criteria:**
- Streaming works (Server-Sent Events or fetch streaming, server-component-friendly).
- `force_stop_bot` requires UI confirm before the tool actually executes.
- Authz: requesting another user's bot returns a structured error and is logged.
- Rate limit blocks the 11th mutating call within an hour.

---

### Session 17 — Cost + observability
**Objective:** Make costs and AI behavior measurable.

**Scope (files):**
- New: SQL migration creating materialized view `ai_pm_cost_daily` + cron refresh.
- New: `src/app/api/ai-pm/metrics/route.ts` — GET per user.
- Modified: `aiPmConfigs.monthlyLlmBudgetUsd` enforced — when crossed, set `killSwitch=true` + emit `ai-pm.alert.budget_exceeded`.
- New: alert emitter helpers — three triggers (3 consecutive failures, budget at 80%, critical drawdown).
- UI: small budget gauge in Settings + Analyst dashboard.

**Out of scope:** External alerting integrations (email/Telegram). Inngest event log is enough for MVP.

**Dependencies:** Sessions 11, 12, 15.

**Done criteria:**
- Materialized view refreshes nightly via Inngest cron.
- Hitting 80% budget emits an alert event (verify in Inngest logs).
- Hitting 100% budget auto-flips the kill switch.

---

### Session 18 — Hardening
**Objective:** Validate the system end-to-end before flipping AI on for real money.

**Scope (files):**
- New: `src/lib/backtest/__tests__/drift.test.ts` — property-style: backtest a past 7d window vs the AI subaccount's actual performance in the same window. Assert drift < 10%.
- New: `src/lib/ai-pm/__tests__/load.test.ts` — simulates 10 users opt-in concurrently; asserts no DB deadlocks and tick duration p95 < 30s.
- New: weekly Inngest cron job that runs the drift check and emits an alert on failure.
- Final security review checklist: tool isolation, hard allowlist, capital cap layered, encryption preserved, prompt-injection paths.

**Dependencies:** All prior sessions.

**Done criteria:**
- Drift test passes on real subaccount data.
- Load test passes locally on a 10-user fixture.
- Weekly drift check is scheduled in Inngest and runs without manual intervention.

---

**Risk gate between sessions:** advance only when Done criteria are met. Sessions 0–11 are mandatory before exposing AI to any user; Sessions 12–13 are the minimum for usable UI; 14–18 are progressive enhancement.

**Total rough estimate:** 8–12 weeks for V1 across all 19 sessions. Pareto: Sessions 0–13 ship a usable MVP at ~7 weeks.

## Open Questions / Deferred

- Hot-reconfig in services (currently MVP uses stop+recreate fallback). Future optimization, not MVP.
- LLM cost default for `monthlyLlmBudgetUsd` — set during Phase 1 based on observed paper-mode usage. Initial seed: $20/month.
- Whether Opus reviewer threshold (30% cumulative + first-time symbol) should be user-tunable or system-wide. Defaults system-wide for MVP.
- Whether to detect grid-style opportunities and recommend the user create one manually (advisory only, AI cannot create grid bots in MVP).
- Concurrency cap: starts at 3 users in parallel; revisit after load testing.
