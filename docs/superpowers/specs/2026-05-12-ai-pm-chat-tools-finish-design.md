# AI Portfolio Manager — Session 16b: Complete Chat Agent

**Date:** 2026-05-12
**Status:** Approved
**Branch:** `feat/ai-pm-chat-tools-finish`
**Predecessors:** S0–S16 (cron pipeline, settings, activity feed, event monitor, chat UI, chat tool-use)

## Goal

Close out the deferred pieces of S16 so the AI Portfolio Manager chat agent is end-to-end complete:

1. Wire `bingxClient` through the chat pipeline so real-mode tools (currently silently rejected when no client available) can run.
2. Implement the two executor stubs: `adjust_params` and `reallocate_capital`. Both support paper and real mode.
3. Add the two corresponding chat tools (`adjust_params`, `reallocate_capital`). The agent now has eight tools (six from S16 + two new).
4. Extend `runGuardrails()` so the new mutations are bounded by `maxCapitalUsdt` and `maxLeverage`.

## Non-Goals (v1)

- Order-cancellation orchestration during strategy change. The bot watcher (`trading-bot-watch.ts`) already cancels pending entry orders when bot status flips to STOPPED; we rely on that.
- Partial-fill reconciliation when reducing capital on a real-mode bot — the watcher already partial-closes excess positions at the next tick.
- Rollback when stop+recreate (strategy change) fails between stop and recreate. We log + return `EXECUTION_FAILED`; the old bot stays STOPPED and the user can retry. Acceptable trade-off documented in the executor.
- Schema migrations. All work uses existing columns.

## `adjust_params` semantics

Action shape (from `decision.prompt.ts`):

```ts
type AdjustParamsAction = {
  type: 'adjust_params';
  botId: string;
  params: Record<string, unknown>;
  reasoning: string;
};
```

The chat-tool layer narrows `params` via zod into a typed sub-object. At the executor layer we treat `action.params` as already-validated.

Allowed mutations in the chat-tool schema (`AdjustParamsArgs`):

```ts
{
  botId: uuid,
  params: {
    capitalUsdt?: number positive,
    leverage?: integer 1..20,
    strategy?: 'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER',
    config?: Record<string, unknown>
  }.refine(at-least-one-set),
  reasoning: string 1..500
}
```

### Paper-mode executor branch

Bot located by `(paper_bots.id = botId, paper_bots.userId = userId)`.
- `capitalUsdt` → update `paper_bots.capitalUsdt`.
- `leverage`, `strategy`, `config` → merge into `paper_bots.params` jsonb (also write `strategy` into the dedicated column when present).
- Single UPDATE; no exchange calls.

### Real-mode executor branch

Bot located by `(trading_bots.id = botId, trading_bots.userId = userId, trading_bots.apiKeyId = ctx.bingxApiKeyId)`.

- **Direct fields** (`capitalUsdt` → `positionSizeUsdt`, `leverage`, `config`):
  1. UPDATE row.
  2. If `leverage` changed AND `bingxClient` available, call `setLeverage(client, symbol, leverage)` (try/catch; warn on reject; leverage stays at last-accepted value on exchange).
- **`strategy` change** (stop + recreate flow):
  1. UPDATE `trading_bots.status = 'STOPPED'` on the old row (watcher cancels pending orders next tick).
  2. INSERT new `trading_bots` row carrying over: symbol, apiKeyId, **new** botType (strategy), positionSizeUsdt (post-adjust if also changed), leverage (post-adjust if also changed), takeProfitPercentage, gridCount, priceMin, priceMax. `status = 'RUNNING'`.
  3. Return new `botId` in `payload.newBotId`.
  4. If step 2 throws → return `EXECUTION_FAILED` with `reason: 'recreate_failed'`. Old bot remains STOPPED. Logged as warn.

### Return shape

```ts
{
  status: 'EXECUTED' | 'EXECUTION_FAILED',
  decisionId: string,
  realBotId?: string,
  paperBotId?: string,
  newBotId?: string,          // populated only on strategy-change recreate
  reason?: string,
}
```

## `reallocate_capital` semantics

Action shape:

```ts
{
  type: 'reallocate_capital';
  fromBotId: string;
  toBotId: string;
  amountUsdt: number;  // > 0
  reasoning: string;
};
```

### Pre-checks (in executor)

1. `fromBotId !== toBotId` (zod refine handles this earlier; defensive re-check).
2. Both bots belong to user.
3. Both bots are in the same mode (both real, or both paper) → cross-mode rejection.
4. For real-mode: both bots share `apiKeyId` (same subconta).
5. `fromBot.capital >= amountUsdt` → otherwise `EXECUTION_FAILED` with `reason: 'insufficient_capital'`.

### Effect

Drizzle transaction (`db.transaction(async tx => { ... })`):
- Decrement `fromBot.capital` by amount.
- Increment `toBot.capital` by amount.

Real-mode commits to `trading_bots.positionSizeUsdt`. Paper-mode commits to `paper_bots.capitalUsdt`. **No exchange calls.** The bot watcher partial-closes / opens at next cron tick using new sizes.

### Return shape

```ts
{
  status: 'EXECUTED' | 'EXECUTION_FAILED',
  decisionId: string,
  reason?: string,
  payload?: {
    fromBotId, toBotId, amount,
    fromCapitalBefore, fromCapitalAfter,
    toCapitalBefore, toCapitalAfter,
  }
}
```

## `bingxClient` wiring

### Call-site change in `ai-pm-event-handler.ts`

Load `bingxClient` **before** branching on chat vs scoped pipeline:

```ts
const client = await loadBingx(config.bingxApiKeyId);
if (params.eventName === 'ai-pm/event.chat') {
  // ... pass client to runChat
}
// (existing non-chat path uses client downstream — already wired)
```

`client` may be `null` if no BingX key — chat-pipeline still runs but mutating real-mode tools return `EXECUTION_FAILED: missing_bingx_client`. Paper-mode tools unaffected.

### `runChatPipeline` accepts `bingxClient`

```ts
interface RunChatPipelineParams {
  // ... existing fields
  bingxClient?: BingxClient | null;
}
```

Forwarded into `ToolExecContext.bingxClient`. Already declared optional on the context type from S16.

### Executor branches use `ctx.bingxClient`

- `adjust_params` real-mode leverage call: skipped if `!bingxClient`. Warns; row still updated so next cron tick may reconcile.
- `create_bot` already routes via `validate()` → backtest → `bingxClient` already required (existing behavior unchanged).

## Guardrails extensions (`src/lib/ai-pm/guardrails.ts`)

Extend `GuardrailConfig` to include `maxLeverage: number` (currently absent — picked up in T3 of plan). Then:

- **`adjust_params`**:
  - `runningBotIds.has(botId)` (existing).
  - If `params.leverage > config.maxLeverage` → `STRATEGY_NOT_ALLOWED` (or new `LEVERAGE_CAP`).
  - If `params.capitalUsdt` adjusts the bot beyond `maxCapitalUsdt` (sum of all running + delta), → `CAPITAL_CAP`.
  - If `params.strategy` not in `allowedStrategies` → `STRATEGY_NOT_ALLOWED`.
- **`reallocate_capital`**:
  - `runningBotIds.has(fromBotId)` AND `runningBotIds.has(toBotId)` (existing).
  - Total capital after move unchanged → no `CAPITAL_CAP` check needed.
  - `fromBotId !== toBotId` (in case zod refine bypassed).

Add `'LEVERAGE_CAP'` to `GuardrailReason` union.

## Tests

| File | What |
|------|------|
| `src/lib/ai-pm/__tests__/executor.test.ts` (extend) | adjust_params paper happy path; real-mode capital+leverage with mocked setLeverage; real-mode strategy change (stop + recreate, mocked createBot returning new row); recreate failure surfaces `EXECUTION_FAILED`; reallocate paper happy path; reallocate real happy path; insufficient capital path; cross-mode rejection. |
| `src/lib/ai-pm/__tests__/guardrails.test.ts` (extend) | leverage cap on adjust; capital cap on adjust; reallocate happy path; reallocate unknown botId. |
| `src/lib/ai-pm/__tests__/chat-tools.test.ts` (extend) | adjust_params dispatches; reallocate_capital dispatches. Reuse existing mocked validateFn/executeFn pattern. |
| `src/lib/ai-pm/__tests__/chat-pipeline.test.ts` (extend) | bingxClient threaded through ToolExecContext when provided. |
| `src/inngest/functions/__tests__/ai-pm-event-handler.test.ts` (extend) | client loaded before chat branch + passed to runChat. |

Targets: ~85% backend coverage on new code. No UI changes — no UI tests needed.

## File manifest

**Modified:**
- `src/lib/ai-pm/executor.ts` — impl 2 cases (paper + real branches each)
- `src/lib/ai-pm/guardrails.ts` — extend for new action types + leverage cap; add `maxLeverage` to config
- `src/lib/ai-pm/chat-tools.ts` — add `AdjustParamsArgs`, `ReallocateCapitalArgs`, 2 dispatcher cases, 2 ToolDefinitions
- `src/lib/ai-pm/chat-pipeline.ts` — accept `bingxClient`, forward into `ToolExecContext`
- `src/lib/ai-pm/validation.ts` — pass new guardrail field (maxLeverage) from `guardrailConfig()` helper
- `src/inngest/functions/ai-pm-event-handler.ts` — load `bingxClient` before chat branch, pass to runChat
- `src/services/bingx.service.ts` — extract reusable `setLeverage(client, symbol, leverage)` helper if currently inline (verify; otherwise no-op)
- All affected test files

**No new files. No schema migration.**

## Risks

- **Strategy-change rollback gap**: if `stopBot` succeeds but `createBot` fails, user has a stopped bot with no replacement. Mitigation: clear `EXECUTION_FAILED` summary mentions both botId. Future S16c could wrap in saga / try-rollback.
- **Cron race**: AI PM watcher could tick during a real-mode adjust. Acceptable: per-tick reads are atomic, last-write-wins.
- **Reallocate transaction**: paper_bots + trading_bots use the same Postgres transaction. If commit fails, both rows untouched. Network/exchange calls are skipped (watcher handles next tick).
- **Cross-mode reallocate** (one bot real, one paper): rejected at executor. Chat-tool schema can't enforce since modes aren't visible from arg alone.
- **maxLeverage was never previously in GuardrailConfig** — adding it now means existing test fixtures may need updating. Plan covers this.
