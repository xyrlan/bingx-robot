# AI Portfolio Manager — Design Spec

**Date:** 2026-05-08
**Status:** Approved (brainstorming complete, awaiting implementation plan)

## Overview

Add an autonomous AI Portfolio Manager (PM) that operates above the existing six bot strategies (GRID_LONG, GRID_SHORT, DCA, DCA_SPOT, TRAILING_STOP, SMA_CROSSOVER). The AI selects symbols, picks strategies, allocates capital across multiple bots, monitors performance, and adjusts or shuts down bots autonomously per user. Users opt in per account, choose a profile (Conservative/Balanced/Aggressive) and tune guardrails (max capital, max drawdown, allowed symbols/strategies, leverage cap, max concurrent bots). Hard guardrails plus a deterministic backtest validate every decision before execution. Activity feed, analyst dashboard, and a conversational chat surface what the AI is doing and why.

## Goals

- Move the product from "user configures bots manually" to "AI runs portfolio for me, within my limits."
- Multi-tenant: each user opts in independently and configures their own guardrails.
- Auditable: every AI decision (proposed, rejected, executed) is persisted with full reasoning, signal snapshot, backtest result, and cost.
- Cost-controlled: multi-model routing keeps LLM spend low; per-user monthly budget cap with auto kill switch.
- Reuses existing bot services without rewrite.

## Non-Goals

- Cross-user signal sharing or social trading. Each user's AI is isolated.
- Live ML model training. The AI uses LLMs plus deterministic indicators; no ML pipeline.
- New bot strategies. AI only orchestrates the six existing strategies.
- Replacing manual bot creation. Manual mode keeps working alongside AI mode.

## Decisions Captured (from brainstorming)

| Dimension | Choice |
|---|---|
| AI role | Fully autonomous |
| Scope | Portfolio manager (above existing bots) |
| Capital model | Multi-tenant, per-user opt-in |
| Inputs | OHLCV + technical indicators + funding rate + open interest + bot performance history |
| Decision frequency | Hybrid (cron 30min + event-driven) |
| AI actions | Create bot / stop bot / adjust params / reallocate capital — all four |
| User control | Two-tier: profile + custom guardrails |
| Validation | Hard guardrails + deterministic backtest |
| UX surface | Activity feed + analyst dashboard + chat (full) |
| LLM stack | Multi-model: Haiku 4.5 / Sonnet 4.6 / Opus 4.7 routed by tactic |

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
- **LLM:** Vercel AI SDK v6 + AI Gateway. Models: `anthropic/claude-haiku-4-5`, `anthropic/claude-sonnet-4-6`, `anthropic/claude-opus-4-7`.
- **Runtime:** Inngest functions (`ai-pm-tick`, `ai-pm-monitor`, `ai-pm-execute-decision`) on existing Connect worker.
- **Persistence:** Postgres via Drizzle. Five new tables.
- **Backtest engine:** pure TypeScript module in `src/lib/backtest/`.
- **UI:** Next.js App Router pages under `src/app/dashboard/ai-pm/`, components in `src/components/ai-pm/`. HeroUI v3 + Tailwind, next-intl for i18n.

## Components

### Signal Layer — `src/lib/ai-pm/signal.ts`
- **Input:** whitelisted symbols, recent OHLCV, funding rate, open interest.
- **Pre-processing (deterministic):** RSI, ATR, Bollinger, simple MA crossovers calculated in code before LLM call.
- **Model:** Haiku 4.5 (cheap, frequent).
- **Output schema (Zod):**
  ```ts
  { candidates: Array<{ symbol: string; regime: 'range'|'trend_up'|'trend_down'|'chop'; score: number; reason: string }> }
  ```
- Top 5 candidates passed to Decision layer per tick.

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
1. **Hard guardrails (deterministic code):** rejects if max capital exceeded, current drawdown > limit, symbol outside whitelist, leverage > profile, concurrent bots > limit.
2. **Backtest (deterministic code):** simulates the proposed strategy on the last 30 days of OHLCV. Rejects if simulated P&L < 0 or simulated drawdown > 2× user limit.
3. **Opus reviewer (rare):** invoked only if action allocates > 30% of total capital OR is the first time on a symbol. Opus reads reasoning + backtest, vetoes or approves.

### Execution Layer — `src/lib/ai-pm/executor.ts`
No LLM. Maps validated tool calls 1:1 to existing services:
- `create_bot` → reuses `src/services/bots/*.service.ts`.
- `stop_bot` → existing stop endpoint.
- `adjust_bot_params` → **NEW**: requires adding dynamic reconfig support to `bingx.service.ts` (current bots are immutable after start).
- `reallocate_capital` → **NEW**: stop + recreate with new capital, or hot-reconfig where supported.

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
- `fetchHistorical(symbol, days)` — pulls k-lines via existing BingX client.
- `simulateGrid(params, candles)`, `simulateDCA(...)`, etc — one simulator per strategy. Mirrors execution logic of real services.
- `metrics(trades)` — P&L, max drawdown, simplified Sharpe, win rate.
- Cache via `backtest_runs` table keyed on `(symbol, strategy, paramsHash, windowDays)`.

## Database Schema (Drizzle additions)

```ts
export const aiPmModeEnum = pgEnum('ai_pm_mode', ['CONSERVATIVE', 'BALANCED', 'AGGRESSIVE', 'CUSTOM']);
export const aiDecisionStatusEnum = pgEnum('ai_decision_status', [
  'PROPOSED', 'REJECTED_GUARDRAIL', 'REJECTED_BACKTEST', 'REJECTED_REVIEWER', 'EXECUTED', 'EXECUTION_FAILED'
]);
export const aiActionTypeEnum = pgEnum('ai_action_type', [
  'CREATE_BOT', 'STOP_BOT', 'ADJUST_PARAMS', 'REALLOCATE_CAPITAL', 'NO_ACTION'
]);

export const aiPmConfigs = pgTable('ai_pm_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
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
}, (t) => [uniqueIndex('ai_pm_configs_user_idx').on(t.userId)]);

export const aiDecisions = pgTable('ai_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  triggeredBy: text('triggered_by').notNull(),
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

`paper_bots` table (Phase 1 paper-trading harness) is provisional; final shape decided during implementation.

## UX

### Settings — `/dashboard/ai-pm/settings`
- Step 1: profile selection card (Conservative/Balanced/Aggressive) with guardrail preview.
- Step 2: "Customize" toggle reveals editable form (max capital, max drawdown, max leverage, allowed symbols multi-select, allowed strategies, max concurrent bots, monthly LLM budget).
- Global enabled toggle.
- Red Kill Switch button (stops all AI bots, disables AI).
- LLM budget gauge with current month consumption.

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
- `src/components/ai-pm/` — `ActivityFeed`, `GuardrailForm`, `AnalystDashboard`, `ChatPanel`, `KillSwitch`.
- next-intl keys under `ai_pm.*`.
- Server Components by default; Client Components only for chat and forms.

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

## Phasing

### Phase 0 — Foundation (1–2 weeks)
- Drizzle migrations for the 5 core tables (`aiPmConfigs`, `aiDecisions`, `aiSignals`, `backtestRuns`, `aiChatMessages`).
- Backtest engine MVP: GRID_LONG and DCA only. Other strategies deferred.
- Settings page + `aiPmConfigs` CRUD.
- No AI yet — infrastructure only.
- `paper_bots` table designed and migrated alongside Phase 1 paper-trading harness, not in Phase 0.

### Phase 1 — MVP AI (2–3 weeks)
- Signal layer (Haiku) + 30 min cron.
- Decision layer (Sonnet) with restricted tool use: `create_bot` + `no_action` only.
- Validation: hard guardrails + backtest for GRID/DCA.
- Executor: create only. stop/adjust/realloc deferred.
- Activity feed (basic).
- **Ship criterion:** runs in paper mode for 7 days with zero guardrail violations.

### Phase 2 — Full actions (1–2 weeks)
- Add `stop_bot` and `reallocate_capital` to Decision tool set.
- Implement `adjust_bot_params` (requires hot-reconfig in services).
- Monitor layer event-driven.
- Opus reviewer for large actions.

### Phase 3 — Full UX (1–2 weeks)
- Analyst dashboard (thesis, watchlist, performance comparison).
- Chat (Vercel AI SDK `useChat`).
- Regime heatmap.
- Cost tracking dashboard.

### Phase 4 — Hardening (1 week)
- Backtest for SMA_CROSSOVER, TRAILING_STOP, GRID_SHORT, DCA_SPOT.
- Property tests: backtest vs real execution.
- Multi-tenant load test (10+ opt-in users).
- Full alerts and observability.

**Total estimate:** 7–10 weeks for V1. Functional MVP at ~5 weeks.

**Risk gate between phases:** advance only when paper-mode shows positive results with guardrails respected.

## Open Questions / Deferred

- Hot-reconfig support in `bingx.service.ts` (Phase 2): may require breaking change to bot lifecycle. Decide approach during Phase 2 plan.
- `paper_bots` table final shape — defined during Phase 0 implementation.
- LLM cost ceiling per user (default value for `monthlyLlmBudgetUsd`) — set during Phase 1 based on observed paper-mode usage.
- Whether Opus reviewer threshold (currently "30% capital or first-time symbol") should be user-tunable or system-wide. Defaults system-wide for MVP, possibly user-tunable later.
