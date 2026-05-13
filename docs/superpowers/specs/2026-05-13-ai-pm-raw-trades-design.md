# AI Portfolio Manager — Session 18: Raw Trade Tools

**Date:** 2026-05-13
**Status:** Approved
**Branch:** `feat/ai-pm-raw-trades`
**Predecessors:** S0–S17 (cron, settings, activity feed, monitor, chat UI, agentic tools, streaming)

## Goal

Expand the AI Portfolio Manager's tool surface so the agent can place direct futures orders (market, limit, stop, take-profit, trailing-stop), manage open positions, cancel orders, and inspect the live balance / position state — without having to wrap every action into a "bot". Same audit + guardrail patterns as the existing 8 tools; reuses the BingX HMAC-signed client and the validate/execute pipeline.

## Non-Goals (v1)

- Paper-mode simulation for raw trades. Paper-mode tools refuse with `EXECUTION_FAILED: paper-mode raw orders not supported v1`.
- Spot trading. Scope is BingX USDT-M perpetual swap only.
- Position margin adjustments (`/openApi/swap/v2/trade/positionMargin`).
- TWAP / iceberg orders.
- Copy-trade endpoints.
- Idempotency / dedup of repeated tool calls. AI may double-submit; user-side trust + audit row are the guard.

## Tools (10 new)

### Reads — 4 tools (no decision row, status='EXECUTED', `decisionId=null`)

| Tool | Args | Result |
|------|------|--------|
| `read_balance` | – | `{availableUsdt, equityUsdt, marginUsedUsdt, unrealizedPnlUsdt}` |
| `read_positions` | `{symbol?: string}` | array of `{symbol, side, qty, entryPrice, markPrice, unrealizedPnlUsdt, leverage, liquidationPrice}` |
| `read_open_orders` | `{symbol?: string}` | array of `{orderId, symbol, side, type, quantity, price, stopPrice, status, createdAt}` |
| (read_portfolio / read_signals / read_decisions stay from S16) | – | – |

### Place — 5 tools

All accept `symbol`, `side: BUY | SELL`, `capitalUsdt`, `leverage`, plus type-specific fields. AI does NOT supply `quantity`; the executor converts `capitalUsdt × leverage / lastPrice` → exchange-required quantity using existing `toQuantityPrecision`.

| Tool | Args | BingX equivalent |
|------|------|------------------|
| `place_market_order` | `{symbol, side, capitalUsdt, leverage, stopLossPercent?, takeProfitPercent?}` | `POST /openApi/swap/v2/trade/order` `type=MARKET` (+ attached `stopLoss`/`takeProfit` sub-objects) |
| `place_limit_order` | `{symbol, side, price, capitalUsdt, leverage, timeInForce?: 'GTC'\|'IOC'\|'FOK'\|'PostOnly'}` | `type=LIMIT` |
| `place_stop_market` | `{symbol, side, stopPrice, capitalUsdt, leverage}` | `type=STOP_MARKET` |
| `place_take_profit` | `{symbol, side, stopPrice, capitalUsdt, leverage}` | `type=TAKE_PROFIT_MARKET` |
| `place_trailing_stop` | `{symbol, side, capitalUsdt, leverage, callbackRate}` (callbackRate as decimal, e.g. `0.05` = 5%) | `type=TRAILING_STOP_MARKET` |

**`positionSide` rule:** `BUY → LONG`, `SELL → SHORT` (hedge-mode default). Existing app already uses hedge mode for AI-managed bots.

### Manage — 3 tools

| Tool | Args | Effect |
|------|------|--------|
| `close_position` | `{symbol, side?: LONG\|SHORT, percent?: 1..100}` | If `side` and `percent` omitted → close all positions for that symbol via `POST /openApi/swap/v2/trade/closeAllPositions`. Else build a reduce-only MARKET order on the inverse side. |
| `cancel_order` | `{orderId, symbol}` | `DELETE /openApi/swap/v2/trade/order` |
| `cancel_all_orders` | `{symbol?: string}` | `DELETE /openApi/swap/v2/trade/allOpenOrders` (filterable by symbol) |

## Schema migration

```sql
-- Extend ai_action_type enum with 8 new variants.
ALTER TYPE ai_action_type ADD VALUE IF NOT EXISTS 'PLACE_MARKET_ORDER';
ALTER TYPE ai_action_type ADD VALUE IF NOT EXISTS 'PLACE_LIMIT_ORDER';
ALTER TYPE ai_action_type ADD VALUE IF NOT EXISTS 'PLACE_STOP_ORDER';
ALTER TYPE ai_action_type ADD VALUE IF NOT EXISTS 'PLACE_TAKE_PROFIT';
ALTER TYPE ai_action_type ADD VALUE IF NOT EXISTS 'PLACE_TRAILING_STOP';
ALTER TYPE ai_action_type ADD VALUE IF NOT EXISTS 'CLOSE_POSITION';
ALTER TYPE ai_action_type ADD VALUE IF NOT EXISTS 'CANCEL_ORDER';
ALTER TYPE ai_action_type ADD VALUE IF NOT EXISTS 'CANCEL_ALL_ORDERS';

-- Store BingX-returned orderId for traceability.
ALTER TABLE ai_decisions ADD COLUMN result_order_id text;
```

Drizzle schema mirrors the enum + adds `resultOrderId: text('result_order_id')` on `aiDecisions`. No new tables; BingX is the source of truth for orders and positions.

## ProposedAction extensions (`decision.prompt.ts`)

The discriminated union `ActionSchema` adds 8 variants, each with the corresponding fields. The chat-tool layer narrows args via its own zod schemas (which can be tighter than `ActionSchema` if needed); the executor accepts `ProposedAction` as today.

## bingx-orders.service.ts (new)

Thin layer over the existing `BingxClient` that exposes:

```ts
async function placeFuturesOrder(client: BingxClient, params: {
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  type: 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET' | 'TRAILING_STOP_MARKET';
  quantity: string;
  price?: string;
  stopPrice?: string;
  timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'PostOnly';
  priceRate?: string;
  reduceOnly?: boolean;
  stopLoss?: { type: 'STOP_MARKET'; stopPrice: string };
  takeProfit?: { type: 'TAKE_PROFIT_MARKET'; stopPrice: string };
}): Promise<{ orderId: string; status: string; avgPrice?: string }>;

async function cancelFuturesOrder(client: BingxClient, symbol: string, orderId: string): Promise<void>;
async function cancelAllFuturesOrders(client: BingxClient, symbol?: string): Promise<{ canceledCount: number }>;
async function closeAllPositions(client: BingxClient, symbol: string): Promise<{ closedCount: number }>;
async function listFuturesPositions(client: BingxClient, symbol?: string): Promise<FuturesPosition[]>;
async function listFuturesOpenOrders(client: BingxClient, symbol?: string): Promise<FuturesOpenOrder[]>;
async function getFuturesBalance(client: BingxClient): Promise<FuturesBalance>;
```

Each function does HMAC signing via the existing client + parses BingX JSON (`json-bigint` for orderIds). Errors propagate as the existing `BingxApiError` / `BingxAuthError` / `BingxInsufficientBalanceError` types so executor branches can map them to `EXECUTION_FAILED` reasons.

## Quantity computation

For all `place_*` tools, executor pre-computes:

```ts
const lastPrice = await getLastPrice(client, symbol);
const contractInfo = await getContractInfo(symbol);  // existing 10-min cache
const rawQty = (capitalUsdt * leverage) / lastPrice;
const quantity = toQuantityPrecision(rawQty, contractInfo);  // rounds UP
```

If `quantity` is below the BingX minimum notional, executor returns `EXECUTION_FAILED: below_min_notional`.

## Chat-tool layer (chat-tools.ts)

`ALL_TOOL_DEFINITIONS` extends by 10 entries. `ToolName` union extends. Each tool has a zod schema + a dispatcher case + a handler function. Mutating handlers route through `validate()` → `execute()`. Reads bypass validate, call the bingx-orders service directly, return `decisionId: null`.

Kill-switch refusal applies to all mutating tools (the existing `killSwitchRefusal` helper). Read tools always work — observability under kill switch is desirable.

## Executor (`executor.ts`) extensions

8 new case branches matching the action types. Each:

1. Asserts `params.bingxClient` non-null (else `EXECUTION_FAILED: missing_bingx_client`).
2. Computes quantity if applicable.
3. Calls the matching `bingx-orders.service` function.
4. Captures `orderId` on success → returned as `resultOrderId`.
5. Wraps in try/catch; BingX errors → `EXECUTION_FAILED` with `reason: err.code || err.message`.

`close_position`:
- If `side` and `percent` are omitted → call `closeAllPositions(symbol)`.
- Else: query `listFuturesPositions(symbol)` to get current qty for that side, compute `closeQty = qty * percent/100`, place a reduce-only MARKET order on the inverse side.

Real-mode is the only supported path; paper-mode returns `EXECUTION_FAILED` early in each branch.

## Guardrails extensions (`guardrails.ts`)

`GuardrailReason` gets no new variants; existing reasons cover the new actions.

| Action | Check |
|--------|-------|
| `PLACE_*` (any) | `killSwitch=false`, `leverage ≤ maxLeverage`, `capitalUsdt ≤ (maxCapitalUsdt - capitalUsedUsdt)`, `symbol ∈ allowedSymbols (if non-empty)` |
| `CLOSE_POSITION` | `killSwitch=false` |
| `CANCEL_ORDER`, `CANCEL_ALL_ORDERS` | `killSwitch=false` |
| `READ_*` | (bypass — read tools don't go through validate) |

`capitalUsedUsdt` already excludes raw orders today (it sums `runningBots`). The check here is an approximation: capital cap is enforced on AI-bot-driven capital + the new raw order. Acceptable v1; tightening to include real-mode open positions in `capitalUsedUsdt` is a follow-up.

## Chat-tool schemas (excerpt)

```ts
export const PlaceMarketOrderArgs = z.object({
  symbol: z.string().regex(/^[A-Z0-9]+-USDT$/),
  side: z.enum(['BUY', 'SELL']),
  capitalUsdt: z.number().positive(),
  leverage: z.number().int().min(1).max(20),
  stopLossPercent: z.number().positive().lt(100).optional(),
  takeProfitPercent: z.number().positive().lt(500).optional(),
  reasoning: z.string().min(1).max(500),
});

export const ClosePositionArgs = z.object({
  symbol: z.string().regex(/^[A-Z0-9]+-USDT$/),
  side: z.enum(['LONG', 'SHORT']).optional(),
  percent: z.number().int().min(1).max(100).optional(),
  reasoning: z.string().min(1).max(500),
});

export const CancelOrderArgs = z.object({
  orderId: z.string().min(1),
  symbol: z.string().regex(/^[A-Z0-9]+-USDT$/),
  reasoning: z.string().min(1).max(500),
});
```

(Full schemas in implementation plan.)

## Files

**New:**
- `src/services/bingx-orders.service.ts`
- `src/services/__tests__/bingx-orders.service.test.ts`
- One Drizzle migration

**Modified:**
- `src/db/schema.ts` (enum extension + resultOrderId column)
- `src/lib/ai-pm/decision.prompt.ts` (ActionSchema variants)
- `src/lib/ai-pm/chat-tools.ts` (10 schemas + dispatcher + 10 handlers)
- `src/lib/ai-pm/__tests__/chat-tools.test.ts` (10 new tests)
- `src/lib/ai-pm/executor.ts` (8 new action cases)
- `src/lib/ai-pm/__tests__/executor.test.ts` (8 new test groups)
- `src/lib/ai-pm/guardrails.ts` (new action types accepted)
- `src/lib/ai-pm/__tests__/guardrails.test.ts` (new cases)

No UI changes (chat already renders tool entries inline; activity feed already lists decisions).

## Tests

- **bingx-orders.service**: mocked HTTP factory (existing test pattern). Happy path per fn + error path (insufficient balance, bad symbol).
- **executor**: per action — happy path, missing client, BingX error, paper-mode refusal.
- **chat-tools**: per tool — dispatch through validate/execute, kill switch refusal for mutators, read tool bypasses validate.
- **guardrails**: capital cap, leverage cap, symbol allowlist apply to place actions.

Target: ~85% on new code.

## i18n

No new copy strings. Tool call entries surface via the existing `toolCallsHeader` block and the summary text in `ToolCallEntry`.

## Risks

- **Hedge mode dependency**: app assumes hedge mode (`positionSide` LONG/SHORT). If the user has the BingX account set to one-way (`BOTH`), all place orders will fail. Mitigation: log a clear error from BingX (`"position side does not match"`), surface in the tool summary so the user can switch their account setting.
- **Quantity precision drift**: if the contract-info cache is stale, the quantity may round to a value the exchange rejects. Existing `toQuantityPrecision` rounds UP to satisfy min-notional; cache TTL 10min. Acceptable.
- **AI double-orders**: the model could call `place_market_order` twice in the same loop turn. No client-side dedup. Each call is its own decision row; the user can audit + close excess via `close_position`.
- **`close_position` with `percent` < 100 needs current qty**: requires an extra `listFuturesPositions` round-trip before placing the reduce-only order. Acceptable latency cost.
- **Activity feed filter by subaccount** still missing (deferred); raw-trade decisions will show in the feed but not filtered by `bingxApiKeyId`.

## Decomposition note

User selected the full bundle, but in the implementation plan we will split into ordered tasks so each can ship independently if a session ends mid-flight. Order:

1. Schema mig + enum + resultOrderId.
2. `bingx-orders.service.ts` wrappers.
3. `place_market_order` (executor + chat tool + tests).
4. Read tools (read_balance, read_positions, read_open_orders).
5. `close_position` + `cancel_order` + `cancel_all_orders`.
6. Remaining place tools (limit, stop_market, take_profit, trailing_stop).
7. Guardrails extension + integration.
8. Final PR.

Each task lands as its own commit; final PR bundles them.
