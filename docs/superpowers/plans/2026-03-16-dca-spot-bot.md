# DCA Spot Bot Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `DCA_SPOT` bot type that places DCA market orders on the BingX **spot** account instead of perpetual futures.

**Architecture:** New bot type `DCA_SPOT` with dedicated spot service (`dca-spot.service.ts`) that calls BingX spot endpoints (`/openApi/spot/v1/trade/order`), a dedicated Inngest cron function, and a UI config form. Reuses the existing `DCAConfig` type since the config shape is identical — only the execution layer changes (spot vs swap endpoints). The existing BingX client (`createBingxClient`) is reused since HMAC signing works the same for spot endpoints — we just need to add a `postForm` method for `application/x-www-form-urlencoded` POST.

**Tech Stack:** Next.js 16, Drizzle ORM, Inngest, BingX Spot API (`/openApi/spot/v1/`), HeroUI

---

## Key Differences: Spot vs Futures DCA

| Aspect | DCA (Futures) | DCA_SPOT (Spot) |
|--------|--------------|-----------------|
| Order endpoint | `/openApi/swap/v2/trade/order` | `/openApi/spot/v1/trade/order` |
| Order params | `quantity`, `positionSide` | `quoteOrderQty` (USDT amount) |
| Balance endpoint | `/openApi/swap/v2/user/balance` | `/openApi/spot/v1/account/balance` |
| Price endpoint | `/openApi/swap/v2/quote/price` | `/openApi/spot/v2/ticker/price` |
| Symbol info | `/openApi/swap/v2/quote/contracts` | `/openApi/spot/v1/common/symbols` |
| Leverage | Yes (1-125x) | No (always 1x) |
| Position tracking | Open positions via API | Asset balance in spot account |
| POST Content-Type | JSON / query params | `application/x-www-form-urlencoded` |
| Stop behavior | Cancel entry orders | Nothing to cancel (market orders are instant) |

## File Structure

### New Files
- `src/services/bots/dca-spot.service.ts` — Spot DCA order placement, spot price, spot balance helpers
- `src/inngest/functions/dca-spot-bot-watch.ts` — Cron job for spot DCA bots
- `src/components/trading/dca-spot-config-form.tsx` — UI form for creating DCA Spot bots

### Modified Files
- `src/db/schema.ts` — Add `DCA_SPOT` to `botTypeEnum`
- `src/services/bots/types.ts` — Add `DCA_SPOT` to `BotType` union, labels
- `src/lib/bingx/client.ts` — Add `postForm` method for `application/x-www-form-urlencoded` POST
- `src/app/api/bingx/bot/start/route.ts` — Handle `DCA_SPOT` creation
- `src/app/api/bingx/bot/stop/route.ts` — Handle `DCA_SPOT` stop (no orders to cancel)
- `src/app/api/bingx/bot/route.ts` — Handle `DCA_SPOT` in bot details
- `src/app/api/bingx/balance/route.ts` — Add `?account=spot` query param support
- `src/worker.ts` — Register `dcaSpotBotWatch` function
- `src/app/api/inngest/route.ts` — Register `dcaSpotBotWatch` function
- `src/components/trading/bot-type-selector.tsx` — Add `DCA_SPOT` option + import form
- `src/components/trading/bots-list.tsx` — Add `DCA_SPOT` styling + progress display

### DB Migration
- Add `DCA_SPOT` value to `bot_type` PostgreSQL enum

---

## Chunk 1: Database & Types

### Task 1: Add DCA_SPOT to DB enum

**Files:**
- Modify: `src/db/schema.ts:23-28`

- [ ] **Step 1: Update botTypeEnum in schema**

In `src/db/schema.ts`, add `'DCA_SPOT'` to the `botTypeEnum` array:

```typescript
export const botTypeEnum = pgEnum('bot_type', [
  'GRID_LONG',
  'GRID_SHORT',
  'DCA',
  'TRAILING_STOP',
  'DCA_SPOT',
]);
```

- [ ] **Step 2: Generate and run migration**

```bash
npm run db:generate
npm run db:push
```

Expected: Migration adds `DCA_SPOT` to `bot_type` enum in PostgreSQL.

- [ ] **Step 3: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat: add DCA_SPOT to bot_type enum"
```

### Task 2: Update TypeScript types

**Files:**
- Modify: `src/services/bots/types.ts`

- [ ] **Step 1: Add DCA_SPOT to BotType and labels**

```typescript
export type BotType = 'GRID_LONG' | 'GRID_SHORT' | 'DCA' | 'TRAILING_STOP' | 'DCA_SPOT';

// DCAConfig is reused as-is for DCA_SPOT — same shape, different execution layer

export const BOT_TYPE_LABELS: Record<BotType, string> = {
  GRID_LONG: 'Grid Long',
  GRID_SHORT: 'Grid Short',
  DCA: 'DCA',
  TRAILING_STOP: 'Trailing Stop',
  DCA_SPOT: 'DCA Spot',
};
```

- [ ] **Step 2: Commit**

```bash
git add src/services/bots/types.ts
git commit -m "feat: add DCA_SPOT to BotType union and labels"
```

---

## Chunk 2: BingX Client & Spot Service

### Task 3: Add postForm method to BingX client

**Files:**
- Modify: `src/lib/bingx/client.ts`

The BingX spot API requires POST with `application/x-www-form-urlencoded` body (unlike swap which accepts JSON or query params). Add a `postForm` method that signs params and sends them as a form-encoded body.

- [ ] **Step 1: Add postForm method to client**

Add this method inside `createBingxClient` return object, after the existing `delete` method:

```typescript
postForm<T = unknown>(
  path: string,
  params?: Record<string, string | number | undefined>
) {
  const paramsToSign = params ?? {};
  const signedParams = signParams(paramsToSign, secretKey.trim(), recvWindow, false);
  const { signature, ...restParams } = signedParams;
  const bodyParts = Object.entries(restParams)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  const body = `${bodyParts}&signature=${encodeURIComponent(signature)}`;

  return (async () => {
    const url = new URL(path.startsWith('http') ? path : `${BASE_URL}${path}`);
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'X-BX-APIKEY': apiKey.trim(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const responseText = await res.text();
    const json = JSONBig({ storeAsString: true }).parse(responseText) as BingxApiResponse<T>;
    if (!res.ok) {
      throw new Error(json.msg || `BingX API error: ${res.status}`);
    }
    if (json.code !== undefined && json.code !== 0) {
      throw new Error(json.msg || `BingX API code ${json.code}`);
    }
    return (json.data ?? json) as T;
  })();
},
```

Also update the `BingxClient` type export — it's already inferred from `ReturnType<typeof createBingxClient>`, so no change needed.

- [ ] **Step 2: Commit**

```bash
git add src/lib/bingx/client.ts
git commit -m "feat: add postForm method to BingX client for spot API"
```

### Task 4: Create DCA Spot service

**Files:**
- Create: `src/services/bots/dca-spot.service.ts`

- [ ] **Step 1: Create the spot DCA service**

```typescript
import type { BingxClient } from '@/lib/bingx/client';
import { toSafeIdString } from '@/services/bingx.service';
import type { DCAConfig } from './types';

/**
 * Place a spot market order using quoteOrderQty (spend X USDT).
 * Uses /openApi/spot/v1/trade/order with x-www-form-urlencoded.
 */
export async function placeSpotDCAOrder(
  client: BingxClient,
  symbol: string,
  config: DCAConfig,
): Promise<string | null> {
  const side = config.side === 'SELL' ? 'SELL' : 'BUY';

  const params: Record<string, string | number> = {
    symbol,
    side,
    type: 'MARKET',
    quoteOrderQty: config.orderSizeUsdt,
  };

  try {
    const result = (await client.postForm('/openApi/spot/v1/trade/order', params)) as {
      orderId?: string | number;
      order?: { orderId?: string | number };
    };
    const raw = result?.orderId ?? result?.order?.orderId;
    return raw != null ? (toSafeIdString(raw) ?? null) : null;
  } catch (err) {
    console.error('[DCA-SPOT] Order placement failed:', err);
    return null;
  }
}

/**
 * Get current spot price for a symbol.
 */
export async function getSpotCurrentPrice(
  client: BingxClient,
  symbol: string,
): Promise<number | null> {
  try {
    const data = (await client.get('/openApi/spot/v2/ticker/price', { symbol })) as
      | Array<{ trades?: Array<{ price?: string }> }>
      | undefined;
    const price = data?.[0]?.trades?.[0]?.price;
    return price ? parseFloat(price) : null;
  } catch (err) {
    console.error('[DCA-SPOT] Failed to get spot price:', err);
    return null;
  }
}

/**
 * Get spot account balance for an asset.
 */
export async function getSpotBalance(
  client: BingxClient,
  asset = 'USDT',
): Promise<{ free: number; locked: number } | null> {
  try {
    const data = (await client.get('/openApi/spot/v1/account/balance')) as {
      balances?: Array<{ asset: string; free: string; locked: string }>;
    };
    const bal = data?.balances?.find(
      (b) => b.asset.toUpperCase() === asset.toUpperCase(),
    );
    if (!bal) return null;
    return {
      free: parseFloat(bal.free),
      locked: parseFloat(bal.locked),
    };
  } catch (err) {
    console.error('[DCA-SPOT] Failed to get spot balance:', err);
    return null;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/bots/dca-spot.service.ts
git commit -m "feat: add DCA spot service with order placement and helpers"
```

---

## Chunk 3: Inngest Cron Function

### Task 5: Create DCA Spot bot watch function

**Files:**
- Create: `src/inngest/functions/dca-spot-bot-watch.ts`
- Modify: `src/worker.ts`
- Modify: `src/app/api/inngest/route.ts`

- [ ] **Step 1: Create the Inngest function**

```typescript
import { inngest } from '@/inngest/client';
import {
  getRunningBots,
  getBotById,
  setBotStatus,
  getBingxClientByApiKeyId,
  getBingxClient,
} from '@/services/bingx.service';
import { placeSpotDCAOrder } from '@/services/bots/dca-spot.service';
import { shouldPlaceDCAOrder } from '@/services/bots/dca.service';
import type { DCAConfig } from '@/services/bots/types';
import { db } from '@/db';
import { tradingBots } from '@/db/schema';
import { eq } from 'drizzle-orm';

export const dcaSpotBotWatch = inngest.createFunction(
  {
    id: 'dca-spot-bot-watch',
    name: 'DCA Spot Bot Watch',
    retries: 3,
    concurrency: { limit: 1 },
  },
  { cron: '*/5 * * * *' },
  async ({ step, logger }) => {
    const bots = await step.run('fetch-dca-spot-bots', async () => {
      const allRunning = await getRunningBots();
      return allRunning.filter((b) => b.botType === 'DCA_SPOT');
    });

    if (bots.length === 0) return { processed: 0 };

    let processed = 0;

    for (const bot of bots) {
      const result = await step.run(`process-dca-spot-${bot.id}`, async () => {
        const freshBot = await getBotById(bot.id, bot.userId);
        if (!freshBot || freshBot.status !== 'RUNNING') return 0;

        const config = freshBot.config as DCAConfig | null;
        if (!config) return 0;

        if (!shouldPlaceDCAOrder(config, freshBot.createdAt)) return 0;

        const client = freshBot.apiKeyId
          ? await getBingxClientByApiKeyId(freshBot.apiKeyId)
          : await getBingxClient(freshBot.userId);
        if (!client) {
          await setBotStatus(bot.id, bot.userId, 'STOPPED');
          return 0;
        }

        const symbol = String(freshBot.symbol).trim().toUpperCase();

        const orderId = await placeSpotDCAOrder(client, symbol, config);
        if (orderId) {
          const updatedConfig: DCAConfig = { ...config, ordersPlaced: config.ordersPlaced + 1 };
          await db
            .update(tradingBots)
            .set({ config: updatedConfig, updatedAt: new Date() })
            .where(eq(tradingBots.id, bot.id));

          if (updatedConfig.ordersPlaced >= updatedConfig.totalOrders) {
            await setBotStatus(bot.id, bot.userId, 'STOPPED');
            logger.info(`DCA Spot bot ${bot.id} completed all ${updatedConfig.totalOrders} orders`);
          }
          return 1;
        }
        return 0;
      });

      processed += result ?? 0;
    }

    return { processed };
  }
);
```

- [ ] **Step 2: Register in worker.ts**

Add import:
```typescript
import { dcaSpotBotWatch } from '@/inngest/functions/dca-spot-bot-watch';
```

Add `dcaSpotBotWatch` to the `functions` array alongside the existing functions.

- [ ] **Step 3: Register in inngest route**

In `src/app/api/inngest/route.ts`, add import:
```typescript
import { dcaSpotBotWatch } from "@/inngest/functions/dca-spot-bot-watch";
```

Update the functions array:
```typescript
const functions = process.env.INNGEST_USE_CONNECT === '1' ? [] : [tradingBotWatch, dcaBotWatch, trailingStopWatch, dcaSpotBotWatch];
```

- [ ] **Step 4: Commit**

```bash
git add src/inngest/functions/dca-spot-bot-watch.ts src/worker.ts src/app/api/inngest/route.ts
git commit -m "feat: add DCA Spot bot watch Inngest cron function"
```

---

## Chunk 4: API Routes

### Task 6: Update bot start route for DCA_SPOT

**Files:**
- Modify: `src/app/api/bingx/bot/start/route.ts`

- [ ] **Step 1: Add DCA_SPOT handling after the DCA block**

After the existing DCA bot creation block (line ~101), add:

```typescript
// --- DCA Spot Bot creation ---
if (botType === 'DCA_SPOT') {
  const dcaConfig = config as { intervalMinutes?: number; totalOrders?: number; orderSizeUsdt?: number; ordersPlaced?: number; side?: string } | undefined;
  if (!dcaConfig || !dcaConfig.intervalMinutes || !dcaConfig.totalOrders || !dcaConfig.orderSizeUsdt) {
    return NextResponse.json(
      { error: 'DCA Spot config requires intervalMinutes, totalOrders, and orderSizeUsdt' },
      { status: 400 }
    );
  }

  const bot = await createBot(user.id, {
    symbol,
    botType: 'DCA_SPOT',
    config: {
      intervalMinutes: dcaConfig.intervalMinutes,
      totalOrders: dcaConfig.totalOrders,
      orderSizeUsdt: dcaConfig.orderSizeUsdt,
      ordersPlaced: dcaConfig.ordersPlaced ?? 0,
      side: dcaConfig.side ?? 'BUY',
    },
    priceMin: '0',
    priceMax: '0',
    positionSizeUsdt: String(dcaConfig.orderSizeUsdt),
    takeProfitPercentage: '0',
    gridCount: 1,
    apiKeyId,
  });
  await setBotStatus(bot.id, user.id, 'RUNNING');

  await inngest.send({
    name: 'trading/bot.start',
    data: { userId: user.id, botId: bot.id },
  });

  return NextResponse.json({ success: true, botId: bot.id });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/bingx/bot/start/route.ts
git commit -m "feat: handle DCA_SPOT bot creation in start route"
```

### Task 7: Update bot stop route for DCA_SPOT

**Files:**
- Modify: `src/app/api/bingx/bot/stop/route.ts`

- [ ] **Step 1: Skip order cancellation for DCA_SPOT**

DCA Spot uses market orders (instant fill), so there are no pending orders to cancel on stop. Wrap the `stopBotAndCancelEntries` call to skip for DCA and DCA_SPOT bots:

Replace the block that calls `stopBotAndCancelEntries` (around line 34-39):

```typescript
if (client && bot.botType !== 'DCA_SPOT' && bot.botType !== 'DCA') {
  try {
    await stopBotAndCancelEntries(client, botId, symbol);
  } catch (cancelErr) {
    console.warn('[BingX] Some orders may already be filled/cancelled:', cancelErr);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/bingx/bot/stop/route.ts
git commit -m "feat: skip order cancellation for DCA/DCA_SPOT bots on stop"
```

### Task 8: Update bot list route for DCA_SPOT details

**Files:**
- Modify: `src/app/api/bingx/bot/route.ts`

- [ ] **Step 1: Handle DCA_SPOT bots in detail fetch**

The current `getBotsDetailsBatched` fetches swap positions/orders. DCA_SPOT bots don't have swap positions, so they should be excluded from swap API calls. Modify the detail fetching:

```typescript
const runningBots = bots.filter((b) => b.status === 'RUNNING' && b.botType !== 'DCA_SPOT');
const dcaSpotBots = bots.filter((b) => b.botType === 'DCA_SPOT');
const stoppedBots = bots.filter((b) => b.status === 'STOPPED' && b.botType !== 'DCA_SPOT');

const enrichedRunning = await getBotsDetailsBatched(user.id, runningBots);
const enrichedDcaSpot = dcaSpotBots.map((bot) => ({
  bot,
  runtime: formatRuntime(bot.createdAt),
  orders: [],
  positions: [],
  unrealizedPnl: 0,
  realizedPnl: 0,
}));
const enrichedStopped = stoppedBots.map((bot) => ({
  bot,
  runtime: formatRuntime(bot.createdAt),
  orders: [],
  positions: [],
  unrealizedPnl: 0,
  realizedPnl: 0,
}));

const botOrder = new Map(bots.map((b, i) => [b.id, i]));
const enriched = [...enrichedRunning, ...enrichedDcaSpot, ...enrichedStopped].sort(
  (a, b) => (botOrder.get(a.bot.id) ?? 0) - (botOrder.get(b.bot.id) ?? 0)
);
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/bingx/bot/route.ts
git commit -m "feat: handle DCA_SPOT bots in bot list detail fetching"
```

### Task 9: Add spot balance support to balance route

**Files:**
- Modify: `src/app/api/bingx/balance/route.ts`

- [ ] **Step 1: Add account query param**

Add support for `?account=spot` to fetch spot balance instead of swap balance:

```typescript
const account = url.searchParams.get('account');

if (account === 'spot') {
  const data = await client.get('/openApi/spot/v1/account/balance');
  return NextResponse.json(data);
}

const data = await client.get('/openApi/swap/v2/user/balance');
return NextResponse.json(data);
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/bingx/balance/route.ts
git commit -m "feat: add spot balance support to balance API route"
```

---

## Chunk 5: UI Components

### Task 10: Create DCA Spot config form

**Files:**
- Create: `src/components/trading/dca-spot-config-form.tsx`

- [ ] **Step 1: Create the form component**

Based on the existing `dca-config-form.tsx`, but sends `botType: 'DCA_SPOT'`:

```tsx
'use client';

import { useState } from 'react';
import { Card, TextField, Input, Label, Button, toast, Spinner } from '@heroui/react';
import { useActiveAccount } from '@/contexts/active-account';

export function DCASpotConfigForm() {
  const { activeAccountId } = useActiveAccount();
  const [loading, setLoading] = useState(false);
  const [symbol, setSymbol] = useState('BTC-USDT');
  const [intervalMinutes, setIntervalMinutes] = useState('60');
  const [totalOrders, setTotalOrders] = useState('10');
  const [orderSizeUsdt, setOrderSizeUsdt] = useState('10');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!activeAccountId) return;
    setLoading(true);
    try {
      const res = await fetch('/api/bingx/bot/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          botType: 'DCA_SPOT',
          apiKeyId: activeAccountId,
          config: {
            intervalMinutes: Number(intervalMinutes),
            totalOrders: Number(totalOrders),
            orderSizeUsdt: Number(orderSizeUsdt),
            ordersPlaced: 0,
            side: 'BUY',
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.danger(data.error ?? 'Failed to start bot');
        return;
      }
      toast.success(`DCA Spot bot started (ID: ${data.botId})`);
    } catch {
      toast.danger('Network error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card variant="default" className="w-full">
      <Card.Content className="p-6">
        <h3 className="text-lg font-semibold mb-4">DCA Spot</h3>
        <p className="text-sm text-default-600 mb-4">
          Dollar Cost Average on the spot market — places market buy orders at fixed intervals.
          Buys actual tokens into your spot wallet (no leverage, no futures).
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <TextField variant="primary" isDisabled={loading}>
              <Label>Symbol</Label>
              <Input
                name="symbol"
                type="text"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                placeholder="BTC-USDT"
              />
            </TextField>
            <TextField variant="primary" isDisabled={loading}>
              <Label>Interval (minutes)</Label>
              <Input
                name="intervalMinutes"
                type="number"
                min={1}
                value={intervalMinutes}
                onChange={(e) => setIntervalMinutes(e.target.value)}
                placeholder="60"
              />
            </TextField>
            <TextField variant="primary" isDisabled={loading}>
              <Label>Total Orders</Label>
              <Input
                name="totalOrders"
                type="number"
                min={1}
                value={totalOrders}
                onChange={(e) => setTotalOrders(e.target.value)}
                placeholder="10"
              />
            </TextField>
            <TextField variant="primary" isDisabled={loading}>
              <Label>Order Size (USDT)</Label>
              <Input
                name="orderSizeUsdt"
                type="number"
                min={1}
                value={orderSizeUsdt}
                onChange={(e) => setOrderSizeUsdt(e.target.value)}
                placeholder="10"
              />
            </TextField>
          </div>
          <div className="text-sm text-default-500">
            Total investment: {(Number(totalOrders) * Number(orderSizeUsdt)) || 0} USDT
          </div>
          <Button
            type="submit"
            variant="primary"
            isDisabled={loading || !activeAccountId}
          >
            {loading ? <Spinner size="sm" /> : 'Start DCA Spot Bot'}
          </Button>
        </form>
      </Card.Content>
    </Card>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/trading/dca-spot-config-form.tsx
git commit -m "feat: add DCA Spot config form component"
```

### Task 11: Update bot type selector

**Files:**
- Modify: `src/components/trading/bot-type-selector.tsx`

- [ ] **Step 1: Add DCA_SPOT to selector**

Add import:
```typescript
import { DCASpotConfigForm } from './dca-spot-config-form';
```

Update `BotType` type:
```typescript
type BotType = 'GRID_LONG' | 'GRID_SHORT' | 'DCA' | 'TRAILING_STOP' | 'DCA_SPOT';
```

Add to `botTypes` array:
```typescript
{ key: 'DCA_SPOT', label: 'DCA Spot', description: 'DCA on spot market (no leverage)' },
```

Add render case:
```typescript
{selected === 'DCA_SPOT' && <DCASpotConfigForm />}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/trading/bot-type-selector.tsx
git commit -m "feat: add DCA_SPOT option to bot type selector"
```

### Task 12: Update bots list display

**Files:**
- Modify: `src/components/trading/bots-list.tsx`

- [ ] **Step 1: Add DCA_SPOT to bot type display**

Update the `botType` type to include `'DCA_SPOT'`:
```typescript
botType?: 'GRID_LONG' | 'GRID_SHORT' | 'DCA' | 'TRAILING_STOP' | 'DCA_SPOT';
```

Add styling for DCA_SPOT badge (use a distinct color):
```typescript
bot.botType === 'DCA_SPOT' ? 'bg-primary/10 text-primary' :
```

Add label mapping:
```typescript
bot.botType === 'DCA_SPOT' ? 'DCA Spot' :
```

Add progress display (reuse DCA progress logic):
```typescript
{bot.botType === 'DCA_SPOT' && bot.config && (
  <span className="text-xs text-muted">
    {(bot.config as Record<string, unknown>).ordersPlaced as number ?? 0}/{(bot.config as Record<string, unknown>).totalOrders as number ?? 0} orders
  </span>
)}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/trading/bots-list.tsx
git commit -m "feat: add DCA_SPOT display to bots list"
```

---

## Chunk 6: Build Verification

### Task 13: Verify build and lint

- [ ] **Step 1: Run lint**

```bash
npm run lint
```

Expected: No errors related to DCA_SPOT changes.

- [ ] **Step 2: Run build**

```bash
npm run build
```

Expected: Build succeeds with no TypeScript errors.

- [ ] **Step 3: Fix any issues found and commit**

```bash
git add -A
git commit -m "fix: resolve any build/lint issues from DCA Spot implementation"
```
