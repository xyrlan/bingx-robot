# AI Portfolio Manager — Session 18: Raw Trade Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 10 new agent tools (4 reads + 5 places + 3 manages) so the AI Portfolio Manager can place arbitrary BingX perpetual swap orders, manage positions, and inspect balance/positions/open orders — without wrapping every action into a bot.

**Architecture:** Reuses S16's chat-pipeline + validate/execute pipeline. New `bingx-orders.service.ts` wraps the existing HMAC-signed `BingxClient` with order/position/balance endpoints. Schema extends `ai_action_type` enum (8 variants) + adds `result_order_id` on `ai_decisions`. No new tables; BingX is the source of truth for orders + positions.

**Tech Stack:** Drizzle ORM (Postgres), `@anthropic-ai/sdk`, BingX OpenAPI v2 swap endpoints, zod, vitest.

**Spec:** `docs/superpowers/specs/2026-05-13-ai-pm-raw-trades-design.md`
**Branch:** `feat/ai-pm-raw-trades` (already created; spec committed at `48babb5`).

---

## File Manifest

**New:**
- `src/services/bingx-orders.service.ts`
- `src/services/__tests__/bingx-orders.service.test.ts`
- One Drizzle migration file

**Modified:**
- `src/db/schema.ts` (enum + `result_order_id`)
- `src/lib/ai-pm/decision.prompt.ts` (`ActionSchema` discriminated-union variants)
- `src/lib/ai-pm/guardrails.ts` (accept the new action types in the switch)
- `src/lib/ai-pm/__tests__/guardrails.test.ts` (extend)
- `src/lib/ai-pm/executor.ts` (8 new action cases + result_order_id passthrough)
- `src/lib/ai-pm/__tests__/executor.test.ts` (extend)
- `src/lib/ai-pm/validation.ts` (forward result_order_id from execute into persistDecision)
- `src/lib/ai-pm/chat-tools.ts` (10 tool defs + dispatcher cases + handlers)
- `src/lib/ai-pm/__tests__/chat-tools.test.ts` (extend)

---

## Task 1: Schema migration — enum + `result_order_id`

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/lib/ai-pm/validation.ts`
- Generated: `drizzle/NNNN_*.sql`

Extend the `aiActionTypeEnum` with 8 new variants and add `resultOrderId: text('result_order_id')` to `aiDecisions`. Thread `resultOrderId` through `validate`/`persistDecision` so `execute()` can return it and the decision row records it.

- [ ] **Step 1: Update `src/db/schema.ts` enum and aiDecisions table**

Find:
```ts
export const aiActionTypeEnum = pgEnum('ai_action_type', [
  'CREATE_BOT',
  'STOP_BOT',
  'ADJUST_PARAMS',
  'REALLOCATE_CAPITAL',
  'NO_ACTION',
]);
```

Replace with:
```ts
export const aiActionTypeEnum = pgEnum('ai_action_type', [
  'CREATE_BOT',
  'STOP_BOT',
  'ADJUST_PARAMS',
  'REALLOCATE_CAPITAL',
  'NO_ACTION',
  'PLACE_MARKET_ORDER',
  'PLACE_LIMIT_ORDER',
  'PLACE_STOP_ORDER',
  'PLACE_TAKE_PROFIT',
  'PLACE_TRAILING_STOP',
  'CLOSE_POSITION',
  'CANCEL_ORDER',
  'CANCEL_ALL_ORDERS',
]);
```

Find the `aiDecisions` table definition (around line 260). Inside the columns object, after `costUsd: ...` add:
```ts
  resultOrderId: text('result_order_id'),
```

- [ ] **Step 2: Generate + apply migration**

```bash
cd /Users/xyrlan/github/bingx-robot
TEST_DATABASE_ALLOW_PROD=1 npm run db:generate
```

Expected: new file `drizzle/0015_*.sql` with 8 `ALTER TYPE ai_action_type ADD VALUE` statements and one `ALTER TABLE "ai_decisions" ADD COLUMN "result_order_id" text`. (Drizzle's diff tool emits each enum addition as its own statement.)

```bash
npm run db:migrate
```
Expected: success.

- [ ] **Step 3: Thread `resultOrderId` through validate**

In `src/lib/ai-pm/validation.ts`, find the `persistDecision` function. Inside `.values([{...}])`, after the existing `costUsd: ...,` line add:
```ts
      resultOrderId: params.resultOrderId ?? null,
```

Add a field to `ValidateParams` interface (top of file):
```ts
  resultOrderId?: string | null;
```

- [ ] **Step 4: Allow executor to update result_order_id post-execute**

Add a helper in `src/lib/ai-pm/executor.ts` (near the top, before `execute()`):
```ts
async function setResultOrderId(
  database: typeof Db,
  decisionId: string,
  orderId: string,
): Promise<void> {
  await database
    .update(aiDecisions)
    .set({ resultOrderId: orderId })
    .where(eq(aiDecisions.id, decisionId));
}
```

Add `import { aiDecisions } from '@/db/schema';` if not already imported. Add `import { eq } from 'drizzle-orm';` if not already imported.

Export this helper from the module so executor branches in later tasks can update the decision row after BingX returns an orderId.

- [ ] **Step 5: Type-check + commit**

```bash
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -iE "schema\.ts|validation\.ts|executor\.ts|aiActionType|resultOrderId" | head -10
```
Expected: no new errors related to the changed files.

```bash
git add src/db/schema.ts src/lib/ai-pm/validation.ts src/lib/ai-pm/executor.ts drizzle/
git commit -m "feat(ai-pm): extend ai_action_type enum + result_order_id column"
```

---

## Task 2: `bingx-orders.service.ts` — typed wrappers over BingxClient

**Files:**
- Create: `src/services/bingx-orders.service.ts`
- Create: `src/services/__tests__/bingx-orders.service.test.ts`

Adds typed wrappers for: place order, cancel one order, cancel all orders, close all positions for a symbol, list positions, list open orders, get balance. Each wrapper takes `BingxClient` (already HMAC-signed) and calls the matching BingX path. Returns shape-narrowed types so callers don't deal with raw API responses.

- [ ] **Step 1: Write failing tests**

```ts
// src/services/__tests__/bingx-orders.service.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  placeFuturesOrder,
  cancelFuturesOrder,
  cancelAllFuturesOrders,
  closeAllPositions,
  listFuturesPositions,
  listFuturesOpenOrders,
  getFuturesBalance,
} from '@/services/bingx-orders.service';
import type { BingxClient } from '@/lib/bingx/client';

function mockClient(overrides: Partial<BingxClient>): BingxClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
    postForm: vi.fn(),
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('bingx-orders.service', () => {
  describe('placeFuturesOrder', () => {
    it('POSTs to /openApi/swap/v2/trade/order and returns orderId+status', async () => {
      const post = vi.fn().mockResolvedValue({
        order: { orderId: '12345', status: 'FILLED', avgPrice: '50000.5' },
      });
      const client = mockClient({ post });

      const got = await placeFuturesOrder(client, {
        symbol: 'BTC-USDT',
        side: 'BUY',
        positionSide: 'LONG',
        type: 'MARKET',
        quantity: '0.001',
      });

      expect(post).toHaveBeenCalledWith('/openApi/swap/v2/trade/order', expect.objectContaining({
        symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG', type: 'MARKET', quantity: '0.001',
      }));
      expect(got).toEqual({ orderId: '12345', status: 'FILLED', avgPrice: '50000.5' });
    });

    it('forwards stopLoss + takeProfit sub-objects as JSON strings', async () => {
      const post = vi.fn().mockResolvedValue({ order: { orderId: '1', status: 'NEW' } });
      const client = mockClient({ post });

      await placeFuturesOrder(client, {
        symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG', type: 'MARKET', quantity: '0.01',
        stopLoss: { type: 'STOP_MARKET', stopPrice: '49000' },
        takeProfit: { type: 'TAKE_PROFIT_MARKET', stopPrice: '52000' },
      });

      const body = post.mock.calls[0][1] as Record<string, unknown>;
      expect(body.stopLoss).toBe(JSON.stringify({ type: 'STOP_MARKET', stopPrice: '49000' }));
      expect(body.takeProfit).toBe(JSON.stringify({ type: 'TAKE_PROFIT_MARKET', stopPrice: '52000' }));
    });
  });

  describe('cancelFuturesOrder', () => {
    it('DELETEs /openApi/swap/v2/trade/order with symbol + orderId', async () => {
      const del = vi.fn().mockResolvedValue({ orderId: '12345' });
      const client = mockClient({ delete: del });
      await cancelFuturesOrder(client, 'BTC-USDT', '12345');
      expect(del).toHaveBeenCalledWith('/openApi/swap/v2/trade/order', { symbol: 'BTC-USDT', orderId: '12345' });
    });
  });

  describe('cancelAllFuturesOrders', () => {
    it('DELETEs /openApi/swap/v2/trade/allOpenOrders and returns canceledCount', async () => {
      const del = vi.fn().mockResolvedValue({ success: [{ orderId: '1' }, { orderId: '2' }] });
      const client = mockClient({ delete: del });
      const got = await cancelAllFuturesOrders(client, 'BTC-USDT');
      expect(del).toHaveBeenCalledWith('/openApi/swap/v2/trade/allOpenOrders', { symbol: 'BTC-USDT' });
      expect(got.canceledCount).toBe(2);
    });

    it('omits symbol when not provided', async () => {
      const del = vi.fn().mockResolvedValue({ success: [] });
      const client = mockClient({ delete: del });
      await cancelAllFuturesOrders(client);
      expect(del).toHaveBeenCalledWith('/openApi/swap/v2/trade/allOpenOrders', {});
    });
  });

  describe('closeAllPositions', () => {
    it('POSTs /openApi/swap/v2/trade/closeAllPositions with symbol', async () => {
      const post = vi.fn().mockResolvedValue({ success: [1, 2] });
      const client = mockClient({ post });
      const got = await closeAllPositions(client, 'BTC-USDT');
      expect(post).toHaveBeenCalledWith('/openApi/swap/v2/trade/closeAllPositions', { symbol: 'BTC-USDT' });
      expect(got.closedCount).toBe(2);
    });
  });

  describe('listFuturesPositions', () => {
    it('GETs /openApi/swap/v2/user/positions and maps fields', async () => {
      const get = vi.fn().mockResolvedValue([
        { symbol: 'BTC-USDT', positionSide: 'LONG', positionAmt: '0.5', avgPrice: '50000', markPrice: '51000', unrealizedProfit: '500', leverage: '5', liquidationPrice: '45000' },
      ]);
      const client = mockClient({ get });
      const got = await listFuturesPositions(client);
      expect(get).toHaveBeenCalledWith('/openApi/swap/v2/user/positions', {});
      expect(got).toHaveLength(1);
      expect(got[0]).toEqual({
        symbol: 'BTC-USDT', side: 'LONG', qty: '0.5', entryPrice: '50000',
        markPrice: '51000', unrealizedPnlUsdt: '500', leverage: 5, liquidationPrice: '45000',
      });
    });

    it('filters by symbol when provided', async () => {
      const get = vi.fn().mockResolvedValue([]);
      const client = mockClient({ get });
      await listFuturesPositions(client, 'ETH-USDT');
      expect(get).toHaveBeenCalledWith('/openApi/swap/v2/user/positions', { symbol: 'ETH-USDT' });
    });
  });

  describe('listFuturesOpenOrders', () => {
    it('GETs /openApi/swap/v2/trade/openOrders and maps fields', async () => {
      const get = vi.fn().mockResolvedValue({
        orders: [
          { orderId: '7', symbol: 'BTC-USDT', side: 'BUY', type: 'LIMIT', origQty: '0.01', price: '49000', stopPrice: '0', status: 'NEW', time: 1700000000000 },
        ],
      });
      const client = mockClient({ get });
      const got = await listFuturesOpenOrders(client);
      expect(get).toHaveBeenCalledWith('/openApi/swap/v2/trade/openOrders', {});
      expect(got).toHaveLength(1);
      expect(got[0].orderId).toBe('7');
      expect(got[0].symbol).toBe('BTC-USDT');
    });
  });

  describe('getFuturesBalance', () => {
    it('GETs /openApi/swap/v3/user/balance and returns USDT row', async () => {
      const get = vi.fn().mockResolvedValue([
        { asset: 'USDT', balance: '1000.5', equity: '1010', availableMargin: '900', unrealizedProfit: '9.5', usedMargin: '100' },
        { asset: 'BTC', balance: '0.5' },
      ]);
      const client = mockClient({ get });
      const got = await getFuturesBalance(client);
      expect(got).toEqual({
        availableUsdt: '900', equityUsdt: '1010', marginUsedUsdt: '100', unrealizedPnlUsdt: '9.5',
      });
    });
  });
});
```

- [ ] **Step 2: Run — fails**

```bash
npx vitest run src/services/__tests__/bingx-orders.service.test.ts
```
Expected: 11 failing (module not found).

- [ ] **Step 3: Implement `src/services/bingx-orders.service.ts`**

```ts
import type { BingxClient } from '@/lib/bingx/client';

export interface PlaceOrderParams {
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
}

export interface PlaceOrderResult {
  orderId: string;
  status: string;
  avgPrice?: string;
}

export async function placeFuturesOrder(
  client: BingxClient,
  params: PlaceOrderParams,
): Promise<PlaceOrderResult> {
  const body: Record<string, unknown> = {
    symbol: params.symbol,
    side: params.side,
    positionSide: params.positionSide,
    type: params.type,
    quantity: params.quantity,
  };
  if (params.price !== undefined) body.price = params.price;
  if (params.stopPrice !== undefined) body.stopPrice = params.stopPrice;
  if (params.timeInForce !== undefined) body.timeInForce = params.timeInForce;
  if (params.priceRate !== undefined) body.priceRate = params.priceRate;
  if (params.reduceOnly !== undefined) body.reduceOnly = String(params.reduceOnly);
  if (params.stopLoss !== undefined) body.stopLoss = JSON.stringify(params.stopLoss);
  if (params.takeProfit !== undefined) body.takeProfit = JSON.stringify(params.takeProfit);

  const res = await client.post<{ order: { orderId: string; status: string; avgPrice?: string } }>(
    '/openApi/swap/v2/trade/order',
    body,
  );
  return {
    orderId: String(res.order.orderId),
    status: res.order.status,
    avgPrice: res.order.avgPrice,
  };
}

export async function cancelFuturesOrder(
  client: BingxClient,
  symbol: string,
  orderId: string,
): Promise<void> {
  await client.delete('/openApi/swap/v2/trade/order', { symbol, orderId });
}

export interface CancelAllResult { canceledCount: number; }

export async function cancelAllFuturesOrders(
  client: BingxClient,
  symbol?: string,
): Promise<CancelAllResult> {
  const params: Record<string, string> = {};
  if (symbol) params.symbol = symbol;
  const res = await client.delete<{ success?: Array<{ orderId: string }> }>(
    '/openApi/swap/v2/trade/allOpenOrders',
    params,
  );
  return { canceledCount: res.success?.length ?? 0 };
}

export interface CloseAllResult { closedCount: number; }

export async function closeAllPositions(
  client: BingxClient,
  symbol: string,
): Promise<CloseAllResult> {
  const res = await client.post<{ success?: unknown[] }>(
    '/openApi/swap/v2/trade/closeAllPositions',
    { symbol },
  );
  return { closedCount: res.success?.length ?? 0 };
}

export interface FuturesPosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  qty: string;
  entryPrice: string;
  markPrice: string;
  unrealizedPnlUsdt: string;
  leverage: number;
  liquidationPrice: string;
}

export async function listFuturesPositions(
  client: BingxClient,
  symbol?: string,
): Promise<FuturesPosition[]> {
  const params: Record<string, string> = {};
  if (symbol) params.symbol = symbol;
  const res = await client.get<Array<{
    symbol: string; positionSide: 'LONG' | 'SHORT'; positionAmt: string;
    avgPrice: string; markPrice: string; unrealizedProfit: string;
    leverage: string; liquidationPrice: string;
  }>>('/openApi/swap/v2/user/positions', params);
  return res.map((p) => ({
    symbol: p.symbol,
    side: p.positionSide,
    qty: p.positionAmt,
    entryPrice: p.avgPrice,
    markPrice: p.markPrice,
    unrealizedPnlUsdt: p.unrealizedProfit,
    leverage: Number(p.leverage),
    liquidationPrice: p.liquidationPrice,
  }));
}

export interface FuturesOpenOrder {
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: string;
  quantity: string;
  price: string;
  stopPrice: string;
  status: string;
  createdAt: string;
}

export async function listFuturesOpenOrders(
  client: BingxClient,
  symbol?: string,
): Promise<FuturesOpenOrder[]> {
  const params: Record<string, string> = {};
  if (symbol) params.symbol = symbol;
  const res = await client.get<{ orders: Array<{
    orderId: string; symbol: string; side: 'BUY' | 'SELL'; type: string;
    origQty: string; price: string; stopPrice: string; status: string; time: number;
  }>; }>('/openApi/swap/v2/trade/openOrders', params);
  return (res.orders ?? []).map((o) => ({
    orderId: String(o.orderId),
    symbol: o.symbol,
    side: o.side,
    type: o.type,
    quantity: o.origQty,
    price: o.price,
    stopPrice: o.stopPrice,
    status: o.status,
    createdAt: new Date(o.time).toISOString(),
  }));
}

export interface FuturesBalance {
  availableUsdt: string;
  equityUsdt: string;
  marginUsedUsdt: string;
  unrealizedPnlUsdt: string;
}

export async function getFuturesBalance(client: BingxClient): Promise<FuturesBalance> {
  const res = await client.get<Array<{
    asset: string; balance?: string; equity?: string; availableMargin?: string;
    unrealizedProfit?: string; usedMargin?: string;
  }>>('/openApi/swap/v3/user/balance', {});
  const usdt = res.find((r) => r.asset === 'USDT');
  return {
    availableUsdt: usdt?.availableMargin ?? '0',
    equityUsdt: usdt?.equity ?? '0',
    marginUsedUsdt: usdt?.usedMargin ?? '0',
    unrealizedPnlUsdt: usdt?.unrealizedProfit ?? '0',
  };
}
```

- [ ] **Step 4: Tests pass**

```bash
npx vitest run src/services/__tests__/bingx-orders.service.test.ts
```
Expected: 11/11 green.

- [ ] **Step 5: Commit**

```bash
git add src/services/bingx-orders.service.ts src/services/__tests__/bingx-orders.service.test.ts
git commit -m "feat(ai-pm): bingx-orders service wrappers (orders/positions/balance)"
```

---

## Task 3: ProposedAction extensions + guardrails

**Files:**
- Modify: `src/lib/ai-pm/decision.prompt.ts`
- Modify: `src/lib/ai-pm/guardrails.ts`
- Modify: `src/lib/ai-pm/__tests__/guardrails.test.ts`

Add 8 new variants to the `ActionSchema` discriminated union and route each through guardrails (same `KILL_SWITCH` / `CAPITAL_CAP` / `LEVERAGE_CAP` / `STRATEGY_NOT_ALLOWED` reasons; symbol allowlist applies to all place actions).

- [ ] **Step 1: Add zod schemas to `decision.prompt.ts`**

Append after the existing `NoActionSchema` (around line 43):

```ts
const SideSchema = z.enum(['BUY', 'SELL']);
const PositionSideSchema = z.enum(['LONG', 'SHORT']);

export const PlaceMarketOrderActionSchema = z.object({
  type: z.literal('place_market_order'),
  symbol: z.string().min(1),
  side: SideSchema,
  positionSide: PositionSideSchema,
  capitalUsdt: z.number().positive(),
  leverage: z.number().int().min(1).max(20),
  stopLossPercent: z.number().positive().lt(100).optional(),
  takeProfitPercent: z.number().positive().lt(500).optional(),
  reasoning: ReasoningSchema,
});

export const PlaceLimitOrderActionSchema = z.object({
  type: z.literal('place_limit_order'),
  symbol: z.string().min(1),
  side: SideSchema,
  positionSide: PositionSideSchema,
  price: z.number().positive(),
  capitalUsdt: z.number().positive(),
  leverage: z.number().int().min(1).max(20),
  timeInForce: z.enum(['GTC', 'IOC', 'FOK', 'PostOnly']).optional(),
  reasoning: ReasoningSchema,
});

export const PlaceStopOrderActionSchema = z.object({
  type: z.literal('place_stop_order'),
  symbol: z.string().min(1),
  side: SideSchema,
  positionSide: PositionSideSchema,
  stopPrice: z.number().positive(),
  capitalUsdt: z.number().positive(),
  leverage: z.number().int().min(1).max(20),
  reasoning: ReasoningSchema,
});

export const PlaceTakeProfitActionSchema = z.object({
  type: z.literal('place_take_profit'),
  symbol: z.string().min(1),
  side: SideSchema,
  positionSide: PositionSideSchema,
  stopPrice: z.number().positive(),
  capitalUsdt: z.number().positive(),
  leverage: z.number().int().min(1).max(20),
  reasoning: ReasoningSchema,
});

export const PlaceTrailingStopActionSchema = z.object({
  type: z.literal('place_trailing_stop'),
  symbol: z.string().min(1),
  side: SideSchema,
  positionSide: PositionSideSchema,
  capitalUsdt: z.number().positive(),
  leverage: z.number().int().min(1).max(20),
  callbackRate: z.number().positive().max(1),
  reasoning: ReasoningSchema,
});

export const ClosePositionActionSchema = z.object({
  type: z.literal('close_position'),
  symbol: z.string().min(1),
  side: PositionSideSchema.optional(),
  percent: z.number().int().min(1).max(100).optional(),
  reasoning: ReasoningSchema,
});

export const CancelOrderActionSchema = z.object({
  type: z.literal('cancel_order'),
  symbol: z.string().min(1),
  orderId: z.string().min(1),
  reasoning: ReasoningSchema,
});

export const CancelAllOrdersActionSchema = z.object({
  type: z.literal('cancel_all_orders'),
  symbol: z.string().min(1).optional(),
  reasoning: ReasoningSchema,
});
```

Then update `ActionSchema`:
```ts
export const ActionSchema = z.discriminatedUnion('type', [
  CreateBotActionSchema,
  StopBotActionSchema,
  AdjustParamsActionSchema,
  ReallocateCapitalActionSchema,
  NoActionSchema,
  PlaceMarketOrderActionSchema,
  PlaceLimitOrderActionSchema,
  PlaceStopOrderActionSchema,
  PlaceTakeProfitActionSchema,
  PlaceTrailingStopActionSchema,
  ClosePositionActionSchema,
  CancelOrderActionSchema,
  CancelAllOrdersActionSchema,
]);
```

`ProposedAction` (the inferred type) auto-extends.

- [ ] **Step 2: Extend `ACTION_TYPE_MAP` in `validation.ts`**

Find the `ACTION_TYPE_MAP` constant. Replace with:
```ts
const ACTION_TYPE_MAP: Record<ProposedAction['type'], 'CREATE_BOT' | 'STOP_BOT' | 'ADJUST_PARAMS' | 'REALLOCATE_CAPITAL' | 'NO_ACTION' | 'PLACE_MARKET_ORDER' | 'PLACE_LIMIT_ORDER' | 'PLACE_STOP_ORDER' | 'PLACE_TAKE_PROFIT' | 'PLACE_TRAILING_STOP' | 'CLOSE_POSITION' | 'CANCEL_ORDER' | 'CANCEL_ALL_ORDERS'> = {
  create_bot: 'CREATE_BOT',
  stop_bot: 'STOP_BOT',
  adjust_params: 'ADJUST_PARAMS',
  reallocate_capital: 'REALLOCATE_CAPITAL',
  no_action: 'NO_ACTION',
  place_market_order: 'PLACE_MARKET_ORDER',
  place_limit_order: 'PLACE_LIMIT_ORDER',
  place_stop_order: 'PLACE_STOP_ORDER',
  place_take_profit: 'PLACE_TAKE_PROFIT',
  place_trailing_stop: 'PLACE_TRAILING_STOP',
  close_position: 'CLOSE_POSITION',
  cancel_order: 'CANCEL_ORDER',
  cancel_all_orders: 'CANCEL_ALL_ORDERS',
};
```

- [ ] **Step 3: Add guardrail tests**

Append to `src/lib/ai-pm/__tests__/guardrails.test.ts`:

```ts
describe('runGuardrails — raw trades', () => {
  it('rejects place_market_order when leverage exceeds cap', () => {
    const got = runGuardrails({
      action: { type: 'place_market_order', symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG', capitalUsdt: 100, leverage: 25, reasoning: 'r' },
      config: { ...baseCfg, allowedStrategies: [...baseCfg.allowedStrategies] },
      portfolioState: baseState,
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe('LEVERAGE_CAP');
  });

  it('rejects place_market_order when capital pushes total over cap', () => {
    const got = runGuardrails({
      action: { type: 'place_market_order', symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG', capitalUsdt: 800, leverage: 2, reasoning: 'r' },
      config: { ...baseCfg, allowedStrategies: [...baseCfg.allowedStrategies] },
      portfolioState: baseState,
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe('CAPITAL_CAP');
  });

  it('rejects place_market_order when symbol not in allowedSymbols (when allowedSymbols is non-empty)', () => {
    const got = runGuardrails({
      action: { type: 'place_market_order', symbol: 'DOGE-USDT', side: 'BUY', positionSide: 'LONG', capitalUsdt: 50, leverage: 2, reasoning: 'r' },
      config: { ...baseCfg, allowedStrategies: [...baseCfg.allowedStrategies], allowedSymbols: ['BTC-USDT', 'ETH-USDT'] },
      portfolioState: baseState,
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe('STRATEGY_NOT_ALLOWED');
  });

  it('accepts close_position regardless of leverage/capital (defensive)', () => {
    const got = runGuardrails({
      action: { type: 'close_position', symbol: 'BTC-USDT', reasoning: 'r' },
      config: { ...baseCfg, allowedStrategies: [...baseCfg.allowedStrategies] },
      portfolioState: baseState,
    });
    expect(got.ok).toBe(true);
  });

  it('rejects cancel_order when kill switch is engaged', () => {
    const got = runGuardrails({
      action: { type: 'cancel_order', symbol: 'BTC-USDT', orderId: '7', reasoning: 'r' },
      config: { ...baseCfg, allowedStrategies: [...baseCfg.allowedStrategies], killSwitch: true },
      portfolioState: baseState,
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe('KILL_SWITCH');
  });
});
```

`GuardrailConfig` needs to accept `allowedSymbols?: string[]`. Check the current shape — if it's not there, add it:
```ts
export interface GuardrailConfig {
  maxCapitalUsdt: number;
  maxConcurrentBots: number;
  maxLeverage: number;
  allowedStrategies: Array<'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER'>;
  allowedSymbols?: string[];
  killSwitch: boolean;
}
```

- [ ] **Step 4: Run guardrails tests — fail**

```bash
npx vitest run src/lib/ai-pm/__tests__/guardrails.test.ts
```
Expected: 5 new failing.

- [ ] **Step 5: Extend `runGuardrails` switch in `src/lib/ai-pm/guardrails.ts`**

Add cases (after the existing `case 'reallocate_capital':`):

```ts
    case 'place_market_order':
    case 'place_limit_order':
    case 'place_stop_order':
    case 'place_take_profit':
    case 'place_trailing_stop': {
      if (action.leverage > config.maxLeverage) {
        return { ok: false, reason: 'LEVERAGE_CAP', message: `Leverage ${action.leverage} exceeds cap ${config.maxLeverage}` };
      }
      if (portfolioState.capitalUsedUsdt + action.capitalUsdt > config.maxCapitalUsdt) {
        return { ok: false, reason: 'CAPITAL_CAP', message: `Capital used + new ${action.capitalUsdt} exceeds cap ${config.maxCapitalUsdt}` };
      }
      if (config.allowedSymbols && config.allowedSymbols.length > 0 && !config.allowedSymbols.includes(action.symbol)) {
        return { ok: false, reason: 'STRATEGY_NOT_ALLOWED', message: `Symbol ${action.symbol} not in allowedSymbols` };
      }
      return { ok: true };
    }

    case 'close_position':
    case 'cancel_order':
    case 'cancel_all_orders':
      return { ok: true };
```

Also update `guardrailConfig` helper in `chat-tools.ts` (preview only — Task 6 will touch this file too) to forward `allowedSymbols`:
```ts
allowedSymbols: cfg.allowedSymbols ?? undefined,
```

- [ ] **Step 6: Run tests, commit**

```bash
npx vitest run src/lib/ai-pm/__tests__/guardrails.test.ts
```
Expected: all green.

```bash
git add src/lib/ai-pm/decision.prompt.ts src/lib/ai-pm/validation.ts src/lib/ai-pm/guardrails.ts src/lib/ai-pm/__tests__/guardrails.test.ts
git commit -m "feat(ai-pm): ProposedAction variants + guardrails for raw trade actions"
```

---

## Task 4: Executor — 8 new action cases

**Files:**
- Modify: `src/lib/ai-pm/executor.ts`
- Modify: `src/lib/ai-pm/__tests__/executor.test.ts`

Adds switch cases for the 8 new mutating actions. Each:
1. Refuses paper mode (`EXECUTION_FAILED: paper-mode raw orders not supported v1`).
2. Asserts `params.bingxClient` is set (else `EXECUTION_FAILED: missing_bingx_client`).
3. For place actions: computes `quantity` from `capitalUsdt × leverage / lastPrice`, calls the matching `bingx-orders.service` function.
4. On success, writes `result_order_id` back to the decision row.
5. Maps BingX errors to `EXECUTION_FAILED` with a reason string.

- [ ] **Step 1: Append failing tests for `place_market_order`**

```ts
// in src/lib/ai-pm/__tests__/executor.test.ts
describe('execute — place_market_order', () => {
  it('paper mode is refused', async () => {
    const got = await execute({
      userId, decisionId,
      action: { type: 'place_market_order', symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG', capitalUsdt: 100, leverage: 5, reasoning: 'r' },
      config: { bingxApiKeyId: apiKeyId, paperMode: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
    });
    expect(got.status).toBe('EXECUTION_FAILED');
    expect(got.reason).toMatch(/paper-mode/i);
  });

  it('real mode without bingxClient fails', async () => {
    const got = await execute({
      userId, decisionId,
      action: { type: 'place_market_order', symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG', capitalUsdt: 100, leverage: 5, reasoning: 'r' },
      config: { bingxApiKeyId: apiKeyId, paperMode: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
    });
    expect(got.status).toBe('EXECUTION_FAILED');
    expect(got.reason).toMatch(/missing_bingx_client/);
  });

  it('happy path returns realOrderId and updates decision row', async () => {
    const updateMock = vi.fn().mockReturnValue({ set: () => ({ where: () => ({ returning: async () => [{}] }) }) });
    const placeFn = vi.fn().mockResolvedValue({ orderId: 'abc-123', status: 'FILLED', avgPrice: '50000' });
    const getLastPriceFn = vi.fn().mockResolvedValue('50000');
    const getContractInfoFn = vi.fn().mockResolvedValue({ quantityPrecision: 4, minNotional: '1' });

    const got = await execute({
      userId, decisionId,
      action: { type: 'place_market_order', symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG', capitalUsdt: 100, leverage: 5, reasoning: 'r' },
      config: { bingxApiKeyId: apiKeyId, paperMode: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { update: updateMock } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bingxClient: {} as any,
      placeOrderFn: placeFn,
      getLastPriceFn,
      getContractInfoFn,
    });
    expect(got.status).toBe('EXECUTED');
    expect(got.resultOrderId).toBe('abc-123');
    expect(placeFn).toHaveBeenCalledOnce();
    const placeArgs = placeFn.mock.calls[0][1] as { quantity: string };
    expect(placeArgs.quantity).toMatch(/^0\.\d+$/);
  });

  it('forwards stopLoss / takeProfit when provided', async () => {
    const placeFn = vi.fn().mockResolvedValue({ orderId: '1', status: 'FILLED' });
    const updateMock = vi.fn().mockReturnValue({ set: () => ({ where: () => ({ returning: async () => [{}] }) }) });
    await execute({
      userId, decisionId,
      action: { type: 'place_market_order', symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG', capitalUsdt: 100, leverage: 5, stopLossPercent: 2, takeProfitPercent: 5, reasoning: 'r' },
      config: { bingxApiKeyId: apiKeyId, paperMode: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { update: updateMock } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bingxClient: {} as any,
      placeOrderFn: placeFn,
      getLastPriceFn: vi.fn().mockResolvedValue('50000'),
      getContractInfoFn: vi.fn().mockResolvedValue({ quantityPrecision: 4, minNotional: '1' }),
    });
    const args = placeFn.mock.calls[0][1] as { stopLoss?: { stopPrice: string }; takeProfit?: { stopPrice: string } };
    expect(args.stopLoss?.stopPrice).toBe('49000');
    expect(args.takeProfit?.stopPrice).toBe('52500');
  });

  it('BingX error → EXECUTION_FAILED with reason', async () => {
    const placeFn = vi.fn().mockRejectedValue(new Error('Insufficient balance'));
    const got = await execute({
      userId, decisionId,
      action: { type: 'place_market_order', symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG', capitalUsdt: 100, leverage: 5, reasoning: 'r' },
      config: { bingxApiKeyId: apiKeyId, paperMode: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { update: vi.fn().mockReturnValue({ set: () => ({ where: () => ({ returning: async () => [{}] }) }) }) } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bingxClient: {} as any,
      placeOrderFn: placeFn,
      getLastPriceFn: vi.fn().mockResolvedValue('50000'),
      getContractInfoFn: vi.fn().mockResolvedValue({ quantityPrecision: 4, minNotional: '1' }),
    });
    expect(got.status).toBe('EXECUTION_FAILED');
    expect(got.reason).toMatch(/insufficient/i);
  });
});
```

- [ ] **Step 2: Extend `ExecuteParams` + executor switch**

In `src/lib/ai-pm/executor.ts`:

Add new injection points to `ExecuteParams`:
```ts
  placeOrderFn?: typeof defaultPlaceFuturesOrder;
  cancelOrderFn?: typeof defaultCancelFuturesOrder;
  cancelAllOrdersFn?: typeof defaultCancelAllFuturesOrders;
  closeAllPositionsFn?: typeof defaultCloseAllPositions;
  listPositionsFn?: typeof defaultListFuturesPositions;
  getLastPriceFn?: (client: unknown, symbol: string) => Promise<string>;
  getContractInfoFn?: (symbol: string) => Promise<{ quantityPrecision: number; minNotional: string }>;
```

(`defaultX` = the matching import from `bingx-orders.service`. Add the imports.)

Add `resultOrderId?: string` to `ExecutionResult`.

Add a helper for quantity computation:
```ts
function computeQuantity(
  capitalUsdt: number,
  leverage: number,
  lastPrice: string,
  precision: number,
): string {
  const rawQty = (capitalUsdt * leverage) / Number(lastPrice);
  const factor = Math.pow(10, precision);
  // toQuantityPrecision rounds UP to satisfy min-notional
  return (Math.ceil(rawQty * factor) / factor).toFixed(precision);
}
```

Add the cases to the executor switch (before `case 'adjust_params':`). One example (`place_market_order`) shown — the others follow the same shape, just different `placeFuturesOrder` parameters:

```ts
    case 'place_market_order': {
      if (config.paperMode) {
        return { status: 'EXECUTION_FAILED', decisionId, reason: 'paper-mode raw orders not supported v1' };
      }
      if (!params.bingxClient) {
        return { status: 'EXECUTION_FAILED', decisionId, reason: 'missing_bingx_client' };
      }
      const placeFn = params.placeOrderFn ?? defaultPlaceFuturesOrder;
      const getLastPriceFn = params.getLastPriceFn ?? defaultGetLastPrice;
      const getContractInfoFn = params.getContractInfoFn ?? defaultGetContractInfo;

      try {
        const [lastPrice, contract] = await Promise.all([
          getLastPriceFn(params.bingxClient, action.symbol),
          getContractInfoFn(action.symbol),
        ]);
        const quantity = computeQuantity(action.capitalUsdt, action.leverage, lastPrice, contract.quantityPrecision);

        const orderParams: PlaceOrderParams = {
          symbol: action.symbol,
          side: action.side,
          positionSide: action.positionSide,
          type: 'MARKET',
          quantity,
        };
        if (action.stopLossPercent !== undefined) {
          const entry = Number(lastPrice);
          const slPrice = action.side === 'BUY'
            ? entry * (1 - action.stopLossPercent / 100)
            : entry * (1 + action.stopLossPercent / 100);
          orderParams.stopLoss = { type: 'STOP_MARKET', stopPrice: String(Math.round(slPrice)) };
        }
        if (action.takeProfitPercent !== undefined) {
          const entry = Number(lastPrice);
          const tpPrice = action.side === 'BUY'
            ? entry * (1 + action.takeProfitPercent / 100)
            : entry * (1 - action.takeProfitPercent / 100);
          orderParams.takeProfit = { type: 'TAKE_PROFIT_MARKET', stopPrice: String(Math.round(tpPrice)) };
        }

        const res = await placeFn(params.bingxClient, orderParams);
        await setResultOrderId(params.db, decisionId, res.orderId);
        return { status: 'EXECUTED', decisionId, resultOrderId: res.orderId };
      } catch (err) {
        return {
          status: 'EXECUTION_FAILED',
          decisionId,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }
```

Add similar branches for `place_limit_order`, `place_stop_order`, `place_take_profit`, `place_trailing_stop`, `close_position`, `cancel_order`, `cancel_all_orders`. For each:

- `place_limit_order`: `type: 'LIMIT'`, `price: String(action.price)`, optional `timeInForce`.
- `place_stop_order`: `type: 'STOP_MARKET'`, `stopPrice: String(action.stopPrice)`.
- `place_take_profit`: `type: 'TAKE_PROFIT_MARKET'`, `stopPrice: String(action.stopPrice)`.
- `place_trailing_stop`: `type: 'TRAILING_STOP_MARKET'`, `priceRate: String(action.callbackRate)`.
- `close_position`: if `side` and `percent` set, call `listFuturesPositions(client, action.symbol)`, find the position with matching side, compute `closeQty = Number(qty) * percent / 100`, place a reduce-only MARKET on the inverse side. Otherwise call `closeAllPositions(client, action.symbol)`.
- `cancel_order`: call `cancelFuturesOrder(client, action.symbol, action.orderId)`. Returns no result_order_id; status='EXECUTED', no resultOrderId field.
- `cancel_all_orders`: call `cancelAllFuturesOrders(client, action.symbol)`. Status='EXECUTED'.

(See spec § "Executor (executor.ts) extensions" for the full mapping table.)

Use a small `getLastPrice` helper from `bingx.service` if it exists, otherwise from `bingx/market-data` — verify the existing util and import accordingly. If neither exists, write a one-line helper:

```ts
async function defaultGetLastPrice(client: BingxClient, symbol: string): Promise<string> {
  const res = await client.get<{ price: string }>('/openApi/swap/v2/quote/price', { symbol });
  return res.price;
}
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/lib/ai-pm/__tests__/executor.test.ts
```
Expected: all green (existing + new 5 for place_market_order).

- [ ] **Step 4: Commit**

```bash
git add src/lib/ai-pm/executor.ts src/lib/ai-pm/__tests__/executor.test.ts
git commit -m "feat(ai-pm): executor branches for 8 raw trade actions"
```

---

## Task 5: Chat-tools — read tools (3)

**Files:**
- Modify: `src/lib/ai-pm/chat-tools.ts`
- Modify: `src/lib/ai-pm/__tests__/chat-tools.test.ts`

`read_balance`, `read_positions`, `read_open_orders`. These do NOT go through validate/execute — they call `bingx-orders.service` directly from the tool handler. Status='EXECUTED', `decisionId: null`. Paper mode refusal applies (no real balance).

- [ ] **Step 1: Append failing tests**

```ts
// in src/lib/ai-pm/__tests__/chat-tools.test.ts
it('ALL_TOOL_DEFINITIONS now contains 18 tools', () => {
  expect(ALL_TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual([
    'adjust_params', 'cancel_all_orders', 'cancel_order', 'close_position', 'create_bot',
    'pause_kill_switch', 'place_limit_order', 'place_market_order', 'place_stop_order',
    'place_take_profit', 'place_trailing_stop', 'read_balance', 'read_decisions',
    'read_open_orders', 'read_portfolio', 'read_positions', 'read_signals',
    'reallocate_capital', 'stop_bot',
  ].sort());
});

it('read_balance returns balance from getFuturesBalanceFn', async () => {
  const getFuturesBalanceFn = vi.fn().mockResolvedValue({
    availableUsdt: '900', equityUsdt: '1000', marginUsedUsdt: '100', unrealizedPnlUsdt: '0',
  });
  const ctx = makeCtx({ getFuturesBalanceFn, bingxClient: {} });
  const got = await executeTool('read_balance', {}, ctx);
  expect(got.status).toBe('EXECUTED');
  expect(got.decisionId).toBeNull();
  expect(got.summary).toMatch(/\$900/);
});

it('read_positions returns positions from listFuturesPositionsFn', async () => {
  const listFuturesPositionsFn = vi.fn().mockResolvedValue([
    { symbol: 'BTC-USDT', side: 'LONG', qty: '0.1', entryPrice: '50000', markPrice: '51000', unrealizedPnlUsdt: '100', leverage: 5, liquidationPrice: '45000' },
  ]);
  const ctx = makeCtx({ listFuturesPositionsFn, bingxClient: {} });
  const got = await executeTool('read_positions', {}, ctx);
  expect(got.status).toBe('EXECUTED');
  expect((got.payload as unknown[]).length).toBe(1);
});

it('read_open_orders returns from listFuturesOpenOrdersFn', async () => {
  const listFuturesOpenOrdersFn = vi.fn().mockResolvedValue([
    { orderId: '1', symbol: 'BTC-USDT', side: 'BUY', type: 'LIMIT', quantity: '0.01', price: '49000', stopPrice: '0', status: 'NEW', createdAt: '2026-05-13T00:00:00Z' },
  ]);
  const ctx = makeCtx({ listFuturesOpenOrdersFn, bingxClient: {} });
  const got = await executeTool('read_open_orders', {}, ctx);
  expect(got.status).toBe('EXECUTED');
  expect((got.payload as unknown[]).length).toBe(1);
});

it('read_balance refuses when bingxClient is missing', async () => {
  const ctx = makeCtx({ bingxClient: undefined });
  const got = await executeTool('read_balance', {}, ctx);
  expect(got.status).toBe('EXECUTION_FAILED');
  expect(got.summary).toMatch(/bingx/i);
});
```

Also extend `ToolExecContext` mock helper `makeCtx` to accept the new injection points (`getFuturesBalanceFn`, `listFuturesPositionsFn`, `listFuturesOpenOrdersFn`).

- [ ] **Step 2: Implement in `chat-tools.ts`**

Add schemas:
```ts
export const ReadBalanceArgs = z.object({});
export const ReadPositionsArgs = z.object({ symbol: z.string().min(1).optional() });
export const ReadOpenOrdersArgs = z.object({ symbol: z.string().min(1).optional() });
```

Extend `ToolName`:
```ts
| 'read_balance' | 'read_positions' | 'read_open_orders'
```

Extend `ToolExecContext`:
```ts
getFuturesBalanceFn?: typeof getFuturesBalance;
listFuturesPositionsFn?: typeof listFuturesPositions;
listFuturesOpenOrdersFn?: typeof listFuturesOpenOrders;
```

Append to `ALL_TOOL_DEFINITIONS`:
```ts
{ name: 'read_balance', description: 'Read futures account balance, equity, margin, and unrealized P&L.', schema: ReadBalanceArgs },
{ name: 'read_positions', description: 'List current open futures positions.', schema: ReadPositionsArgs },
{ name: 'read_open_orders', description: 'List pending (not yet filled) futures orders.', schema: ReadOpenOrdersArgs },
```

Add dispatcher cases:
```ts
case 'read_balance': return readBalanceTool(ReadBalanceArgs.parse(args), ctx);
case 'read_positions': return readPositionsTool(ReadPositionsArgs.parse(args), ctx);
case 'read_open_orders': return readOpenOrdersTool(ReadOpenOrdersArgs.parse(args), ctx);
```

Add handler functions:
```ts
async function readBalanceTool(_args: z.infer<typeof ReadBalanceArgs>, ctx: ToolExecContext): Promise<ToolExecResult> {
  if (!ctx.bingxClient) {
    return { status: 'EXECUTION_FAILED', decisionId: null, summary: 'bingxClient unavailable', payload: null };
  }
  const fn = ctx.getFuturesBalanceFn ?? getFuturesBalance;
  try {
    const bal = await fn(ctx.bingxClient);
    return {
      status: 'EXECUTED',
      decisionId: null,
      summary: `$${Number(bal.availableUsdt).toFixed(2)} available, $${Number(bal.equityUsdt).toFixed(2)} equity, $${Number(bal.marginUsedUsdt).toFixed(2)} margin used`,
      payload: bal,
    };
  } catch (err) {
    return { status: 'EXECUTION_FAILED', decisionId: null, summary: `read_balance failed: ${err instanceof Error ? err.message : String(err)}`, payload: null };
  }
}

async function readPositionsTool(args: z.infer<typeof ReadPositionsArgs>, ctx: ToolExecContext): Promise<ToolExecResult> {
  if (!ctx.bingxClient) {
    return { status: 'EXECUTION_FAILED', decisionId: null, summary: 'bingxClient unavailable', payload: null };
  }
  const fn = ctx.listFuturesPositionsFn ?? listFuturesPositions;
  try {
    const positions = await fn(ctx.bingxClient, args.symbol);
    return {
      status: 'EXECUTED',
      decisionId: null,
      summary: `${positions.length} position${positions.length === 1 ? '' : 's'} open`,
      payload: positions,
    };
  } catch (err) {
    return { status: 'EXECUTION_FAILED', decisionId: null, summary: `read_positions failed: ${err instanceof Error ? err.message : String(err)}`, payload: null };
  }
}

async function readOpenOrdersTool(args: z.infer<typeof ReadOpenOrdersArgs>, ctx: ToolExecContext): Promise<ToolExecResult> {
  if (!ctx.bingxClient) {
    return { status: 'EXECUTION_FAILED', decisionId: null, summary: 'bingxClient unavailable', payload: null };
  }
  const fn = ctx.listFuturesOpenOrdersFn ?? listFuturesOpenOrders;
  try {
    const orders = await fn(ctx.bingxClient, args.symbol);
    return {
      status: 'EXECUTED',
      decisionId: null,
      summary: `${orders.length} open order${orders.length === 1 ? '' : 's'}`,
      payload: orders,
    };
  } catch (err) {
    return { status: 'EXECUTION_FAILED', decisionId: null, summary: `read_open_orders failed: ${err instanceof Error ? err.message : String(err)}`, payload: null };
  }
}
```

Add imports at top:
```ts
import { getFuturesBalance, listFuturesPositions, listFuturesOpenOrders } from '@/services/bingx-orders.service';
```

- [ ] **Step 3: Tests pass + commit**

```bash
npx vitest run src/lib/ai-pm/__tests__/chat-tools.test.ts
```
Expected: all green.

```bash
git add src/lib/ai-pm/chat-tools.ts src/lib/ai-pm/__tests__/chat-tools.test.ts
git commit -m "feat(ai-pm): chat tools — read_balance, read_positions, read_open_orders"
```

---

## Task 6: Chat-tools — 5 place + 3 manage handlers

**Files:**
- Modify: `src/lib/ai-pm/chat-tools.ts`
- Modify: `src/lib/ai-pm/__tests__/chat-tools.test.ts`

Adds tool schemas + dispatcher cases + handler functions for `place_market_order`, `place_limit_order`, `place_stop_order`, `place_take_profit`, `place_trailing_stop`, `close_position`, `cancel_order`, `cancel_all_orders`. All mutating handlers route through validate+execute with `triggeredBy: 'CHAT'`, `chatMessageId: ctx.chatMessageId`. All refuse on kill switch.

- [ ] **Step 1: Add zod schemas**

```ts
const SymbolSchema = z.string().regex(/^[A-Z0-9]+-[A-Z]+$/);
const SideSchema = z.enum(['BUY', 'SELL']);
const PositionSideSchema = z.enum(['LONG', 'SHORT']);

export const PlaceMarketOrderArgs = z.object({
  symbol: SymbolSchema,
  side: SideSchema,
  positionSide: PositionSideSchema,
  capitalUsdt: z.number().positive(),
  leverage: z.number().int().min(1).max(20),
  stopLossPercent: z.number().positive().lt(100).optional(),
  takeProfitPercent: z.number().positive().lt(500).optional(),
  reasoning: z.string().min(1).max(500),
});

export const PlaceLimitOrderArgs = z.object({
  symbol: SymbolSchema,
  side: SideSchema,
  positionSide: PositionSideSchema,
  price: z.number().positive(),
  capitalUsdt: z.number().positive(),
  leverage: z.number().int().min(1).max(20),
  timeInForce: z.enum(['GTC', 'IOC', 'FOK', 'PostOnly']).optional(),
  reasoning: z.string().min(1).max(500),
});

export const PlaceStopOrderArgs = z.object({
  symbol: SymbolSchema,
  side: SideSchema,
  positionSide: PositionSideSchema,
  stopPrice: z.number().positive(),
  capitalUsdt: z.number().positive(),
  leverage: z.number().int().min(1).max(20),
  reasoning: z.string().min(1).max(500),
});

export const PlaceTakeProfitArgs = z.object({
  symbol: SymbolSchema,
  side: SideSchema,
  positionSide: PositionSideSchema,
  stopPrice: z.number().positive(),
  capitalUsdt: z.number().positive(),
  leverage: z.number().int().min(1).max(20),
  reasoning: z.string().min(1).max(500),
});

export const PlaceTrailingStopArgs = z.object({
  symbol: SymbolSchema,
  side: SideSchema,
  positionSide: PositionSideSchema,
  capitalUsdt: z.number().positive(),
  leverage: z.number().int().min(1).max(20),
  callbackRate: z.number().positive().max(1),
  reasoning: z.string().min(1).max(500),
});

export const ClosePositionArgs = z.object({
  symbol: SymbolSchema,
  side: PositionSideSchema.optional(),
  percent: z.number().int().min(1).max(100).optional(),
  reasoning: z.string().min(1).max(500),
});

export const CancelOrderArgs = z.object({
  symbol: SymbolSchema,
  orderId: z.string().min(1),
  reasoning: z.string().min(1).max(500),
});

export const CancelAllOrdersArgs = z.object({
  symbol: SymbolSchema.optional(),
  reasoning: z.string().min(1).max(500),
});
```

- [ ] **Step 2: Extend `ToolName`, `ALL_TOOL_DEFINITIONS`, dispatcher**

`ToolName` adds 8 entries (the action.type values).

`ALL_TOOL_DEFINITIONS` appends 8 entries; pick descriptive `description` strings.

`executeTool` switch adds 8 cases, each routing to a handler.

- [ ] **Step 3: Add handler functions**

Each follows the same pattern as `createBotTool`. Example for `place_market_order`:

```ts
async function placeMarketOrderTool(args: z.infer<typeof PlaceMarketOrderArgs>, ctx: ToolExecContext): Promise<ToolExecResult> {
  if (ctx.config.killSwitch) return killSwitchRefusal(ctx);
  const action: ProposedAction = {
    type: 'place_market_order',
    symbol: args.symbol, side: args.side, positionSide: args.positionSide,
    capitalUsdt: args.capitalUsdt, leverage: args.leverage,
    stopLossPercent: args.stopLossPercent, takeProfitPercent: args.takeProfitPercent,
    reasoning: args.reasoning,
  };
  const validateFn = ctx.validateFn ?? defaultValidate;
  const executeFn = ctx.executeFn ?? defaultExecute;

  const validation = await validateFn({
    userId: ctx.userId,
    action,
    config: guardrailConfig(ctx.config),
    portfolioState: ctx.portfolioState,
    anthropicApiKey: ctx.config.anthropicApiKey,
    bingxClient: ctx.bingxClient,
    db: ctx.db,
    triggeredBy: 'CHAT',
    chatMessageId: ctx.chatMessageId,
  });

  if (validation.status !== 'PROPOSED') {
    return {
      status: validation.status,
      decisionId: validation.decisionId,
      summary: `place_market_order rejected: ${validation.reason ?? validation.status}`,
      payload: { decisionId: validation.decisionId, reason: validation.reason },
    };
  }

  try {
    const exec = await executeFn({
      userId: ctx.userId,
      decisionId: validation.decisionId,
      action,
      config: { bingxApiKeyId: ctx.config.bingxApiKeyId, paperMode: ctx.config.paperMode },
      db: ctx.db,
      bingxClient: ctx.bingxClient,
    });
    return {
      status: exec.status,
      decisionId: exec.decisionId,
      summary: exec.status === 'EXECUTED'
        ? `${args.side} ${args.symbol} $${args.capitalUsdt} ×${args.leverage} → order ${(exec.resultOrderId ?? '?').slice(0,8)}`
        : `place_market_order failed: ${exec.reason ?? 'unknown'}`,
      payload: exec,
    };
  } catch (err) {
    return {
      status: 'EXECUTION_FAILED',
      decisionId: validation.decisionId,
      summary: `place_market_order threw: ${err instanceof Error ? err.message : String(err)}`,
      payload: null,
    };
  }
}
```

Repeat the same pattern for the other 7 mutating tools, swapping in the matching `ActionSchema['type']` literal and adapting the summary text.

- [ ] **Step 4: Tests for each new tool**

Add a small test per tool (mock `validateFn` returning `PROPOSED`, mock `executeFn` returning `EXECUTED` with appropriate `resultOrderId` if applicable). Reuse the existing test helpers.

```ts
it('place_market_order dispatches and surfaces resultOrderId in summary', async () => {
  const validateFn = vi.fn().mockResolvedValue({ status: 'PROPOSED', decisionId: 'd1' });
  const executeFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: 'd1', resultOrderId: 'abc12345' });
  const ctx = makeCtx({ validateFn, executeFn });
  const got = await executeTool('place_market_order', {
    symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG',
    capitalUsdt: 100, leverage: 5, reasoning: 'test',
  }, ctx);
  expect(got.status).toBe('EXECUTED');
  expect(got.summary).toMatch(/abc12345/);
});
```

(One similar test per tool — 8 tests total. Keep short.)

- [ ] **Step 5: Update the "tool count" assertion test**

The existing test from Task 5 expected 18 tools (10 from earlier + 3 new reads). Update to **19** total (10 from earlier + 3 reads + 8 from this task — that's 21 actually).

Recount: S16 starts with 8 tools (read_portfolio, read_signals, read_decisions, create_bot, stop_bot, pause_kill_switch + adjust_params, reallocate_capital from S16b). Then Task 5 adds 3 reads (read_balance, read_positions, read_open_orders) → 11. This task adds 8 → 19. Update assertion to expect **19 tools**.

```ts
it('ALL_TOOL_DEFINITIONS now contains 19 tools', () => {
  expect(ALL_TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual([
    'adjust_params', 'cancel_all_orders', 'cancel_order', 'close_position', 'create_bot',
    'pause_kill_switch', 'place_limit_order', 'place_market_order', 'place_stop_order',
    'place_take_profit', 'place_trailing_stop', 'read_balance', 'read_decisions',
    'read_open_orders', 'read_portfolio', 'read_positions', 'read_signals',
    'reallocate_capital', 'stop_bot',
  ].sort());
});
```

- [ ] **Step 6: Tests pass + commit**

```bash
npx vitest run src/lib/ai-pm/__tests__/chat-tools.test.ts
```
Expected: all green.

```bash
git add src/lib/ai-pm/chat-tools.ts src/lib/ai-pm/__tests__/chat-tools.test.ts
git commit -m "feat(ai-pm): chat tools — place/cancel/close raw trade handlers"
```

---

## Task 7: Final integration + PR

**Files:** none (verification only).

- [ ] **Step 1: Full suite + build**

```bash
npx vitest run 2>&1 | tail -10
npm run build 2>&1 | tail -10
```
Expected: 0 failing tests; build succeeds.

- [ ] **Step 2: Manual smoke (paper-mode-safe parts only)**

Run `npm run dev` + `npm run inngest`. Open `/dashboard/ai-pm/chat`. In a config with paper-mode OFF (real-mode subaccount), send:

1. "What's my BingX balance?" → assistant should call `read_balance`, surface available + equity numbers.
2. "Show me current open positions." → `read_positions` call, list rendered.
3. "Place a small BTC long, $10 at 2x leverage." → assistant likely calls `read_balance` then `place_market_order(BTC-USDT, BUY, LONG, 10, 2)`. Verify order appears in BingX UI.
4. "Close that position." → `close_position(BTC-USDT)`. Verify position closes.
5. Toggle kill switch in settings, retry "place a BTC long" → assistant refuses with kill switch message.

If you only have a paper-mode config, the place/close/cancel tools will surface "paper-mode raw orders not supported v1" — that's expected; just verify the error reaches the UI.

- [ ] **Step 3: Push + PR**

```bash
git push -u origin feat/ai-pm-raw-trades
gh pr create --title "feat(ai-pm): Session 18 — raw trade tools" --body "$(cat <<'EOF'
## Summary
- 10 new agent tools: 4 reads (balance, positions, open orders, [portfolio already exists]) + 5 places (market, limit, stop, take_profit, trailing) + 3 manages (close, cancel one, cancel all)
- Schema extension: 8 new ai_action_type variants + result_order_id column on ai_decisions
- New service: bingx-orders.service.ts wraps the existing BingxClient with typed order/position/balance endpoints
- Real-mode only v1 — paper-mode raw trades return EXECUTION_FAILED with a clear message

## Out of scope (deferred)
- Paper-mode raw trade simulation
- Spot, copy trade, TWAP, position margin endpoints
- Activity feed subaccount filter (separate session)

## Test plan
- [ ] vitest green
- [ ] build green
- [ ] Manual: read_balance / read_positions surface live numbers from a test BingX subaccount
- [ ] Manual: place_market_order opens a tiny long, close_position closes it
- [ ] Manual: kill switch blocks all mutating tools

Spec: \`docs/superpowers/specs/2026-05-13-ai-pm-raw-trades-design.md\`
Plan: \`docs/superpowers/plans/2026-05-13-ai-portfolio-manager-session-18.md\`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- 10 tools — Tasks 5+6 ✓
- ai_action_type enum extension + result_order_id — Task 1 ✓
- bingx-orders.service wrappers — Task 2 ✓
- ProposedAction variants — Task 3 ✓
- Guardrails — Task 3 ✓
- Executor branches (8) — Task 4 ✓
- Chat tool dispatchers — Tasks 5+6 ✓
- Kill switch refusal for mutators — Task 6 ✓
- Read tools bypass validate — Task 5 ✓
- Manual smoke + PR — Task 7 ✓

**Placeholder scan:** None. Each task has executable code blocks; the executor task (T4) shows one full case branch as the canonical template + a table mapping the remaining 7 to their parameters.

**Type consistency:**
- `PlaceOrderParams` is the input type for `bingx-orders.service.placeFuturesOrder` (T2), used in T4 executor.
- `FuturesPosition`, `FuturesOpenOrder`, `FuturesBalance` (T2) are returned to chat tools in T5.
- `ProposedAction` (T3) is consumed by executor (T4) and chat tools (T6).
- `result_order_id` column (T1) + `resultOrderId?` field on `ExecutionResult` (T4) + summary surfaces it (T6).

**Known gaps:**
- `getLastPrice` may already exist in `bingx.service.ts` or `market-data.ts`. T4 specifies a fallback inline implementation; the implementer should grep first and reuse if a helper exists.
- `getContractInfo` is already used by `bingx.service.ts:createBot`. T4 reuses it via injection.
- Activity feed filter by subaccount (S18b candidate) is NOT in scope; deferred per user discussion.
