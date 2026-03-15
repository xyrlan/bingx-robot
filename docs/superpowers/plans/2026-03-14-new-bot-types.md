# New Bot Types Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three new bot types: DCA Bot (buy at intervals), Grid Short Bot (grid trading for shorts), and Trailing Stop Bot (follow price up, sell on reversal).

**Architecture:** Add a `botType` enum to `tradingBots` table. Create per-type service modules under `src/services/bots/`. Each bot type has its own config fields (stored as JSONB `config` column), its own Inngest cron handler, and its own UI config form. The existing grid long bot becomes `GRID_LONG` type. A bot type registry pattern routes cron processing to the correct handler.

**Tech Stack:** Drizzle ORM, Inngest cron functions, BingX API, React + HeroUI v3

**Dependency:** Requires Plan 1 (UI/UX) and Plan 2 (Subaccounts) to be completed first.

---

## File Structure

### New Files
- `src/services/bots/types.ts` — Shared bot types, config interfaces, registry
- `src/services/bots/grid-long.service.ts` — Extract existing grid long logic
- `src/services/bots/grid-short.service.ts` — Grid short bot logic
- `src/services/bots/dca.service.ts` — DCA bot logic
- `src/services/bots/trailing-stop.service.ts` — Trailing stop bot logic
- `src/inngest/functions/dca-bot-watch.ts` — DCA cron handler
- `src/inngest/functions/trailing-stop-watch.ts` — Trailing stop cron handler
- `src/components/trading/bot-type-selector.tsx` — Bot type selector tabs/cards
- `src/components/trading/dca-config-form.tsx` — DCA bot config form
- `src/components/trading/grid-short-config-form.tsx` — Grid short config form
- `src/components/trading/trailing-stop-config-form.tsx` — Trailing stop config form

### Modified Files
- `src/db/schema.ts` — Add `botType` enum, `config` JSONB column to tradingBots (import `jsonb` from `drizzle-orm/pg-core`)
- `src/services/bingx.service.ts` — Fix `getOpenPositions` to support short positions, extract grid-long specifics, keep shared helpers
- `src/inngest/functions/trading-bot-watch.ts` — Route by botType, handle grid-short
- `src/inngest/client.ts` — Register new functions
- `src/worker.ts` — Register new Inngest functions
- `src/app/api/inngest/route.ts` — Register new functions for non-Connect mode
- `src/app/api/bingx/bot/start/route.ts` — Accept botType + type-specific config
- `src/components/trading/bot-config-form.tsx` — Become a container with type selector
- `src/components/trading/bots-list.tsx` — Show bot type badge, type-specific details

---

## Chunk 1: Schema & Type System

### Task 1: Add Bot Type Enum and Config Column

**Files:**
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Add botType enum**

```typescript
export const botTypeEnum = pgEnum('bot_type', [
  'GRID_LONG',
  'GRID_SHORT',
  'DCA',
  'TRAILING_STOP',
]);
```

- [ ] **Step 2: Add botType and config columns to tradingBots**

```typescript
botType: botTypeEnum('bot_type').notNull().default('GRID_LONG'),
config: jsonb('config').$type<Record<string, unknown>>(),
```

Note: Import `jsonb` from `drizzle-orm/pg-core`.

The `config` column stores type-specific parameters as JSON:
- **GRID_LONG / GRID_SHORT**: uses existing columns (priceMin, priceMax, gridCount, etc.)
- **DCA**: `{ intervalMinutes: number, totalOrders: number, orderSizeUsdt: number }`
- **TRAILING_STOP**: `{ activationPricePct: number, trailingPct: number, positionSizeUsdt: number }`

- [ ] **Step 3: Generate and run migration**

Run: `npm run db:generate`
Run: `npm run db:migrate`

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat: add botType enum and config JSONB column to trading bots"
```

### Task 2: Create Bot Types Module

**Files:**
- Create: `src/services/bots/types.ts`

- [ ] **Step 1: Define type-specific config interfaces**

```typescript
export type BotType = 'GRID_LONG' | 'GRID_SHORT' | 'DCA' | 'TRAILING_STOP';

export type GridConfig = {
  // Uses existing tradingBots columns (priceMin, priceMax, gridCount, etc.)
};

export type DCAConfig = {
  intervalMinutes: number;    // e.g., 60 = buy every hour
  totalOrders: number;        // max number of buys
  orderSizeUsdt: number;      // USDT per buy
  ordersPlaced: number;       // tracking: how many placed so far
  side: 'BUY' | 'SELL';      // DCA direction
};

export type TrailingStopConfig = {
  activationPricePct: number; // % above entry to activate trailing
  trailingPct: number;        // trailing distance %
  positionSizeUsdt: number;   // initial position size
  highestPrice: number;       // tracking: highest seen price
  isActivated: boolean;       // tracking: has trailing activated
  entryOrderId: string | null;
};

export type BotConfig = GridConfig | DCAConfig | TrailingStopConfig;

export const BOT_TYPE_LABELS: Record<BotType, string> = {
  GRID_LONG: 'Grid Long',
  GRID_SHORT: 'Grid Short',
  DCA: 'DCA',
  TRAILING_STOP: 'Trailing Stop',
};
```

- [ ] **Step 2: Commit**

```bash
git add src/services/bots/types.ts
git commit -m "feat: define bot type config interfaces"
```

## Chunk 2: Grid Short Bot

### Task 3: Fix getOpenPositions for Short Positions

**Files:**
- Modify: `src/services/bingx.service.ts`

**CRITICAL BUG:** The existing `getOpenPositions` function (line 362-364) filters positions with `positionAmt > 0`. On BingX, SHORT positions typically have **negative** `positionAmt`. This means Grid Short and Trailing Stop bots will find NO short positions. Fix this before implementing short bot logic.

- [ ] **Step 1: Update the position amount filter**

In `getOpenPositions` (around line 362), change:

```typescript
.filter((p) => {
  const amt = Number(p?.positionAmt ?? p?.position ?? 0);
  return amt > 0;
})
```

To:

```typescript
.filter((p) => {
  const amt = Number(p?.positionAmt ?? p?.position ?? 0);
  return Math.abs(amt) > 0;
})
```

Also update the `positionAmt` mapping to use absolute value:

```typescript
positionAmt: Math.abs(Number(p?.positionAmt ?? p?.position ?? 0)),
```

This ensures short positions (negative amt) are included and the amt is always positive for downstream calculations.

- [ ] **Step 2: Update createGridLevels to accept positionSide parameter**

The existing `createGridLevels` (line 148) hardcodes `positionSide: 'LONG'`. Add a parameter:

```typescript
export async function createGridLevels(
  botId: string,
  priceMin: string,
  priceMax: string,
  gridCount: number,
  options?: { onConflictDoNothing?: boolean; positionSide?: string }
): Promise<GridLevel[]> {
  // ...
  const inserts = levels.map((priceLevel) => ({
    botId,
    priceLevel: String(priceLevel),
    positionSide: options?.positionSide ?? 'LONG',
  }));
  // ...
}
```

- [ ] **Step 3: Commit**

```bash
git add src/services/bingx.service.ts
git commit -m "fix: support short positions in getOpenPositions and createGridLevels"
```

### Task 4: Create Grid Short Service

**Files:**
- Create: `src/services/bots/grid-short.service.ts`

- [ ] **Step 1: Create grid short entry order function**

The grid short bot mirrors grid long but:
- Entry orders are **SELL** (SHORT) instead of **BUY** (LONG)
- Price above current → LIMIT (sits in book above market)
- Price below current → TRIGGER_LIMIT (avoids sweeping book downward)
- Take profit is calculated as: `priceLevel * (1 - takeProfitPct)` (price goes DOWN for profit)
- TP side is **BUY** to close short

```typescript
import type { BingxClient } from '@/lib/bingx/client';
import { toPrecision, toQuantityPrecision, toSafeIdString } from '@/services/bingx.service';

export type PlaceGridShortEntryParams = {
  client: BingxClient;
  symbol: string;
  priceLevel: number;
  quantity: number;
  takeProfitPct: number;
  pricePrecision: number;
  quantityPrecision: number;
  currentPrice: number | null;
};

export async function placeGridShortEntryOrder(params: PlaceGridShortEntryParams): Promise<string | null> {
  const {
    client, symbol, priceLevel, quantity, takeProfitPct,
    pricePrecision, quantityPrecision, currentPrice,
  } = params;

  const priceStr = toPrecision(priceLevel, pricePrecision);
  const quantityStr = toQuantityPrecision(quantity, quantityPrecision);

  // SHORT: priceLevel > currentPrice → LIMIT (above market, sits in book)
  //        priceLevel < currentPrice → TRIGGER_LIMIT (below market, avoids sweep)
  const useTriggerLimit = currentPrice != null && priceLevel < currentPrice;
  const orderType = useTriggerLimit ? 'TRIGGER_LIMIT' : 'LIMIT';

  const orderPayload: Record<string, unknown> = {
    symbol,
    side: 'SELL',
    type: orderType,
    quantity: parseFloat(quantityStr),
    price: parseFloat(priceStr),
    positionSide: 'SHORT',
    timeInForce: 'GTC',
    workingType: 'MARK_PRICE',
  };

  if (useTriggerLimit) {
    orderPayload.stopPrice = parseFloat(priceStr);
  }

  // TP for short: price must go DOWN
  const tpStopPrice = priceLevel * (1 - takeProfitPct);
  const tpStopPriceStr = toPrecision(tpStopPrice, pricePrecision);
  const tpPrice = parseFloat(tpStopPriceStr);
  if (tpPrice > 0) {
    orderPayload.takeProfit = JSON.stringify({
      type: 'TAKE_PROFIT_MARKET',
      stopPrice: tpPrice,
      price: tpPrice,
      workingType: 'MARK_PRICE',
    });
  }

  try {
    const result = (await client.post('/openApi/swap/v2/trade/order', orderPayload, true)) as {
      orderId?: string | number;
      order?: { orderId?: string | number };
    };
    const raw = result?.orderId ?? result?.order?.orderId;
    return raw != null ? (toSafeIdString(raw) ?? null) : null;
  } catch (err) {
    throw err;
  }
}

export async function placeShortTakeProfitOrder(
  client: BingxClient,
  symbol: string,
  quantity: number,
  stopPrice: number,
  pricePrecision: number,
  positionId?: string | number,
): Promise<string | null> {
  try {
    const stopPriceStr = toPrecision(stopPrice, pricePrecision);
    const positionIdStr = toSafeIdString(positionId);
    const orderPayload: Record<string, unknown> = {
      symbol,
      side: 'BUY', // BUY to close short
      type: 'TAKE_PROFIT_MARKET',
      positionSide: 'SHORT',
      stopPrice: parseFloat(stopPriceStr),
      workingType: 'MARK_PRICE',
    };
    if (positionIdStr != null) {
      orderPayload.positionId = positionIdStr;
      orderPayload.closePosition = 'true';
    } else {
      orderPayload.quantity = parseFloat(toPrecision(quantity, 8));
    }
    const result = (await client.post('/openApi/swap/v2/trade/order', orderPayload, true)) as {
      orderId?: string | number;
      order?: { orderId?: string | number };
    };
    const rawOrderId = result?.orderId ?? result?.order?.orderId;
    return rawOrderId != null ? toSafeIdString(rawOrderId) ?? null : null;
  } catch (err) {
    console.error('[BingX] placeShortTakeProfitOrder failed:', err);
    return null;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/bots/grid-short.service.ts
git commit -m "feat: add grid short bot service with entry and TP order placement"
```

### Task 5: Update Trading Bot Watch for Grid Short

**Files:**
- Modify: `src/inngest/functions/trading-bot-watch.ts`

- [ ] **Step 1: Add bot type routing in the cron handler**

In the setup step, include `botType` in the returned data. In the process-levels step, branch logic based on bot type:

```typescript
// In setup return:
botType: freshBot.botType ?? 'GRID_LONG',
positionSide: (freshBot.botType === 'GRID_SHORT') ? 'SHORT' : 'LONG',

// In process-levels, when placing entry orders:
if (botType === 'GRID_SHORT') {
  // Use placeGridShortEntryOrder instead of placeGridEntryOrder
  // TP calculation: priceLevel * (1 - takeProfitPct)
  // Position matching: side === 'SHORT'
} else {
  // Existing GRID_LONG logic
}
```

Key differences for GRID_SHORT in the cron:
- Filter positions by `side === 'SHORT'` instead of `LONG`
- Entry orders are `SELL` not `BUY`
- TP stop price: `priceLevel * (1 - takeProfitPct)` (lower, not higher)
- TP side check: `stopPrice >= currentPrice` skip condition (reversed from long)
- Use `placeShortTakeProfitOrder` for TP placement

- [ ] **Step 2: Commit**

```bash
git add src/inngest/functions/trading-bot-watch.ts
git commit -m "feat: add grid short bot type routing in trading bot watch cron"
```

### Task 6: Create Grid Short Config Form

**Files:**
- Create: `src/components/trading/grid-short-config-form.tsx`

- [ ] **Step 1: Create the form component**

Same structure as `bot-config-form.tsx` but:
- Title: "Grid Short Bot"
- Description explaining short grid strategy
- Same fields: symbol, priceMin, priceMax, gridCount, positionSizeUsdt, takeProfitPercentage
- Passes `botType: 'GRID_SHORT'` in the API call

```tsx
// Nearly identical to BotConfigForm but with:
// - botType: 'GRID_SHORT' in submission payload
// - Different description text explaining shorts
// - Same form fields (grid parameters are identical)
```

- [ ] **Step 2: Commit**

```bash
git add src/components/trading/grid-short-config-form.tsx
git commit -m "feat: add grid short bot configuration form"
```

## Chunk 3: DCA Bot

### Task 7: Create DCA Bot Service

**Files:**
- Create: `src/services/bots/dca.service.ts`

- [ ] **Step 1: Create DCA order placement function**

DCA bot places a single market buy order at each interval:

```typescript
import type { BingxClient } from '@/lib/bingx/client';
import { toQuantityPrecision, toSafeIdString } from '@/services/bingx.service';
import type { DCAConfig } from './types';

export async function placeDCAOrder(
  client: BingxClient,
  symbol: string,
  config: DCAConfig,
  currentPrice: number,
  quantityPrecision: number,
): Promise<string | null> {
  const quantity = config.orderSizeUsdt / currentPrice;
  const quantityStr = toQuantityPrecision(quantity, quantityPrecision);
  const side = config.side === 'SELL' ? 'SELL' : 'BUY';
  const positionSide = side === 'BUY' ? 'LONG' : 'SHORT';

  const orderPayload: Record<string, unknown> = {
    symbol,
    side,
    type: 'MARKET',
    quantity: parseFloat(quantityStr),
    positionSide,
  };

  try {
    const result = (await client.post('/openApi/swap/v2/trade/order', orderPayload, true)) as {
      orderId?: string | number;
      order?: { orderId?: string | number };
    };
    const raw = result?.orderId ?? result?.order?.orderId;
    return raw != null ? (toSafeIdString(raw) ?? null) : null;
  } catch (err) {
    console.error('[DCA] Order placement failed:', err);
    return null;
  }
}

export function shouldPlaceDCAOrder(
  config: DCAConfig,
  botCreatedAt: Date,
): boolean {
  if (config.ordersPlaced >= config.totalOrders) return false;

  const elapsed = Date.now() - botCreatedAt.getTime();
  const expectedOrders = Math.floor(elapsed / (config.intervalMinutes * 60 * 1000)) + 1;
  return config.ordersPlaced < expectedOrders;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/bots/dca.service.ts
git commit -m "feat: add DCA bot service with market order placement"
```

### Task 8: Create DCA Inngest Handler

**Files:**
- Create: `src/inngest/functions/dca-bot-watch.ts`

- [ ] **Step 1: Create the DCA cron function**

```typescript
import { inngest } from '@/inngest/client';
import {
  getRunningBots,
  getBotById,
  setBotStatus,
  getContractInfo,
  getCurrentPrice,
} from '@/services/bingx.service';
import { getBingxClientByApiKeyId, getBingxClient } from '@/services/bingx.service';
import { placeDCAOrder, shouldPlaceDCAOrder } from '@/services/bots/dca.service';
import type { DCAConfig } from '@/services/bots/types';
import { db } from '@/db';
import { tradingBots } from '@/db/schema';
import { eq } from 'drizzle-orm';

export const dcaBotWatch = inngest.createFunction(
  {
    id: 'dca-bot-watch',
    name: 'DCA Bot Watch',
    retries: 3,
    concurrency: { limit: 1 },
  },
  { cron: '*/5 * * * *' },
  async ({ step, logger }) => {
    const bots = await step.run('fetch-dca-bots', async () => {
      const allRunning = await getRunningBots();
      return allRunning.filter((b) => b.botType === 'DCA');
    });

    if (bots.length === 0) return { processed: 0 };

    let processed = 0;

    for (const bot of bots) {
      await step.run(`process-dca-${bot.id}`, async () => {
        const freshBot = await getBotById(bot.id, bot.userId);
        if (!freshBot || freshBot.status !== 'RUNNING') return;

        const config = freshBot.config as DCAConfig;
        if (!config) return;

        if (!shouldPlaceDCAOrder(config, freshBot.createdAt)) return;

        const client = freshBot.apiKeyId
          ? await getBingxClientByApiKeyId(freshBot.apiKeyId)
          : await getBingxClient(freshBot.userId);
        if (!client) {
          await setBotStatus(bot.id, bot.userId, 'STOPPED');
          return;
        }

        const symbol = String(freshBot.symbol).trim().toUpperCase();
        const contractInfo = await getContractInfo(client, symbol);
        const quantityPrecision = contractInfo?.quantityPrecision ?? 4;
        const currentPrice = await getCurrentPrice(client, symbol);
        if (!currentPrice) return;

        const orderId = await placeDCAOrder(client, symbol, config, currentPrice, quantityPrecision);
        if (orderId) {
          // Update ordersPlaced counter in config
          const updatedConfig = { ...config, ordersPlaced: config.ordersPlaced + 1 };
          await db
            .update(tradingBots)
            .set({ config: updatedConfig, updatedAt: new Date() })
            .where(eq(tradingBots.id, bot.id));

          // Auto-stop if all orders placed
          if (updatedConfig.ordersPlaced >= updatedConfig.totalOrders) {
            await setBotStatus(bot.id, bot.userId, 'STOPPED');
            logger.info(`DCA bot ${bot.id} completed all ${updatedConfig.totalOrders} orders`);
          }
          processed++;
        }
      });
    }

    return { processed };
  }
);
```

**Note on apiKeyId:** The handler uses `getBingxClientByApiKeyId` which is added in Plan 2 (Subaccounts). If implementing without Plan 2, use `getBingxClient(bot.userId)` as the only path. The `freshBot.apiKeyId` fallback handles this.

- [ ] **Step 2: Register in Inngest client and worker**

Add `dcaBotWatch` to the functions array in `src/worker.ts`:

```typescript
import { dcaBotWatch } from '@/inngest/functions/dca-bot-watch';
// In the connect() call:
functions: [tradingBotWatch, dcaBotWatch],
```

- [ ] **Step 3: Commit**

```bash
git add src/inngest/functions/dca-bot-watch.ts src/worker.ts
git commit -m "feat: add DCA bot Inngest cron handler"
```

### Task 9: Create DCA Config Form

**Files:**
- Create: `src/components/trading/dca-config-form.tsx`

- [ ] **Step 1: Create the DCA form**

```tsx
'use client';

import { useState } from 'react';
import { Card, Button, TextField, Input, Label, Select, ListBox, toast } from '@heroui/react';
import { Spinner } from '@heroui/react';
import { useActiveAccount } from '@/contexts/active-account';

export function DCAConfigForm() {
  const { activeAccountId } = useActiveAccount();
  const [loading, setLoading] = useState(false);
  const [symbol, setSymbol] = useState('BTC-USDT');
  const [intervalMinutes, setIntervalMinutes] = useState('60');
  const [totalOrders, setTotalOrders] = useState('10');
  const [orderSizeUsdt, setOrderSizeUsdt] = useState('10');
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');

  const handleSubmit = async () => {
    if (!activeAccountId) return;
    setLoading(true);
    try {
      const res = await fetch('/api/bingx/bot/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          botType: 'DCA',
          apiKeyId: activeAccountId,
          config: {
            intervalMinutes: Number(intervalMinutes),
            totalOrders: Number(totalOrders),
            orderSizeUsdt: Number(orderSizeUsdt),
            ordersPlaced: 0,
            side,
          },
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success('DCA bot started');
    } catch (err) {
      toast.danger(err instanceof Error ? err.message : 'Failed to start bot');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <Card.Content className="p-6 space-y-4">
        <h3 className="text-lg font-semibold">DCA Bot</h3>
        <p className="text-sm text-muted">
          Dollar Cost Average — places market orders at fixed intervals.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <TextField>
            <Label>Symbol</Label>
            <Input value={symbol} onChange={(e) => setSymbol(e.target.value)} />
          </TextField>
          <TextField>
            <Label>Interval (minutes)</Label>
            <Input
              type="number"
              value={intervalMinutes}
              onChange={(e) => setIntervalMinutes(e.target.value)}
              min={5}
            />
          </TextField>
          <TextField>
            <Label>Total Orders</Label>
            <Input
              type="number"
              value={totalOrders}
              onChange={(e) => setTotalOrders(e.target.value)}
              min={1}
              max={1000}
            />
          </TextField>
          <TextField>
            <Label>Order Size (USDT)</Label>
            <Input
              type="number"
              value={orderSizeUsdt}
              onChange={(e) => setOrderSizeUsdt(e.target.value)}
              min={5}
            />
          </TextField>
        </div>
        <Button
          variant="primary"
          className="w-full"
          isDisabled={loading || !activeAccountId}
          onPress={handleSubmit}
        >
          {loading ? <Spinner size="sm" /> : 'Start DCA Bot'}
        </Button>
      </Card.Content>
    </Card>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/trading/dca-config-form.tsx
git commit -m "feat: add DCA bot configuration form component"
```

## Chunk 4: Trailing Stop Bot

### Task 10: Create Trailing Stop Service

**Files:**
- Create: `src/services/bots/trailing-stop.service.ts`

- [ ] **Step 1: Create trailing stop logic**

```typescript
import type { BingxClient } from '@/lib/bingx/client';
import { toPrecision, toQuantityPrecision, toSafeIdString } from '@/services/bingx.service';
import type { TrailingStopConfig } from './types';

/**
 * Trailing Stop Bot Logic:
 * 1. Places initial MARKET BUY order to open a LONG position
 * 2. Monitors price: tracks highest price seen
 * 3. When price drops by trailingPct% from highest → places MARKET SELL to close
 *
 * Activation: trailing only activates after price rises activationPricePct% above entry
 */

export async function placeEntryMarketOrder(
  client: BingxClient,
  symbol: string,
  positionSizeUsdt: number,
  currentPrice: number,
  quantityPrecision: number,
): Promise<string | null> {
  const quantity = positionSizeUsdt / currentPrice;
  const quantityStr = toQuantityPrecision(quantity, quantityPrecision);

  const orderPayload: Record<string, unknown> = {
    symbol,
    side: 'BUY',
    type: 'MARKET',
    quantity: parseFloat(quantityStr),
    positionSide: 'LONG',
  };

  try {
    const result = (await client.post('/openApi/swap/v2/trade/order', orderPayload, true)) as {
      orderId?: string | number;
      order?: { orderId?: string | number };
    };
    const raw = result?.orderId ?? result?.order?.orderId;
    return raw != null ? (toSafeIdString(raw) ?? null) : null;
  } catch (err) {
    console.error('[TrailingStop] Entry order failed:', err);
    return null;
  }
}

export async function closePosition(
  client: BingxClient,
  symbol: string,
  quantity: number,
  quantityPrecision: number,
): Promise<string | null> {
  const quantityStr = toPrecision(quantity, quantityPrecision);

  const orderPayload: Record<string, unknown> = {
    symbol,
    side: 'SELL',
    type: 'MARKET',
    quantity: parseFloat(quantityStr),
    positionSide: 'LONG',
  };

  try {
    const result = (await client.post('/openApi/swap/v2/trade/order', orderPayload, true)) as {
      orderId?: string | number;
      order?: { orderId?: string | number };
    };
    const raw = result?.orderId ?? result?.order?.orderId;
    return raw != null ? (toSafeIdString(raw) ?? null) : null;
  } catch (err) {
    console.error('[TrailingStop] Close position failed:', err);
    return null;
  }
}

export function checkTrailingStop(
  config: TrailingStopConfig,
  currentPrice: number,
  entryPrice: number,
): { action: 'HOLD' | 'ACTIVATE' | 'CLOSE'; updatedHighest: number } {
  const highest = Math.max(config.highestPrice || entryPrice, currentPrice);

  if (!config.isActivated) {
    const activationPrice = entryPrice * (1 + config.activationPricePct / 100);
    if (currentPrice >= activationPrice) {
      return { action: 'ACTIVATE', updatedHighest: highest };
    }
    return { action: 'HOLD', updatedHighest: highest };
  }

  // Trailing is active: check if price dropped enough from highest
  const trailPrice = highest * (1 - config.trailingPct / 100);
  if (currentPrice <= trailPrice) {
    return { action: 'CLOSE', updatedHighest: highest };
  }

  return { action: 'HOLD', updatedHighest: highest };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/bots/trailing-stop.service.ts
git commit -m "feat: add trailing stop bot service with activation and close logic"
```

### Task 11: Create Trailing Stop Inngest Handler

**Files:**
- Create: `src/inngest/functions/trailing-stop-watch.ts`

- [ ] **Step 1: Create the trailing stop cron function**

```typescript
import { inngest } from '@/inngest/client';
import {
  getRunningBots,
  getBotById,
  setBotStatus,
  getContractInfo,
  getCurrentPrice,
  getOpenPositions,
} from '@/services/bingx.service';
import { getBingxClientByApiKeyId, getBingxClient } from '@/services/bingx.service';
import {
  placeEntryMarketOrder,
  closePosition,
  checkTrailingStop,
} from '@/services/bots/trailing-stop.service';
import type { TrailingStopConfig } from '@/services/bots/types';
import { db } from '@/db';
import { tradingBots } from '@/db/schema';
import { eq } from 'drizzle-orm';

export const trailingStopWatch = inngest.createFunction(
  {
    id: 'trailing-stop-watch',
    name: 'Trailing Stop Watch',
    retries: 3,
    concurrency: { limit: 1 },
  },
  { cron: '*/1 * * * *' }, // Every 1 minute for tighter trailing
  async ({ step, logger }) => {
    const bots = await step.run('fetch-trailing-bots', async () => {
      const allRunning = await getRunningBots();
      return allRunning.filter((b) => b.botType === 'TRAILING_STOP');
    });

    if (bots.length === 0) return { processed: 0 };

    let processed = 0;

    for (const bot of bots) {
      await step.run(`process-trailing-${bot.id}`, async () => {
        const freshBot = await getBotById(bot.id, bot.userId);
        if (!freshBot || freshBot.status !== 'RUNNING') return;

        const config = freshBot.config as TrailingStopConfig;
        if (!config) return;

        const client = freshBot.apiKeyId
          ? await getBingxClientByApiKeyId(freshBot.apiKeyId)
          : await getBingxClient(freshBot.userId);
        if (!client) {
          await setBotStatus(bot.id, bot.userId, 'STOPPED');
          return;
        }

        const symbol = String(freshBot.symbol).trim().toUpperCase();
        const contractInfo = await getContractInfo(client, symbol);
        const quantityPrecision = contractInfo?.quantityPrecision ?? 4;
        const currentPrice = await getCurrentPrice(client, symbol);
        if (!currentPrice) return;

        // Step 1: If no entry order placed yet, place market buy
        if (!config.entryOrderId) {
          const orderId = await placeEntryMarketOrder(
            client, symbol, config.positionSizeUsdt, currentPrice, quantityPrecision
          );
          if (orderId) {
            const updatedConfig: TrailingStopConfig = {
              ...config,
              entryOrderId: orderId,
              highestPrice: currentPrice,
            };
            await db
              .update(tradingBots)
              .set({ config: updatedConfig, updatedAt: new Date() })
              .where(eq(tradingBots.id, bot.id));
            processed++;
          }
          return;
        }

        // Step 2: Check positions
        const positions = await getOpenPositions(client, symbol);
        const longPositions = positions.filter(
          (p) => p.positionSide.toUpperCase() === 'LONG' && p.positionAmt > 0
        );

        if (longPositions.length === 0) {
          // Position closed externally or never opened
          logger.info(`Trailing stop bot ${bot.id}: no position found, stopping`);
          await setBotStatus(bot.id, bot.userId, 'STOPPED');
          return;
        }

        const position = longPositions[0];
        const { action, updatedHighest } = checkTrailingStop(config, currentPrice, position.entryPrice);

        if (action === 'CLOSE') {
          logger.info(`Trailing stop triggered for bot ${bot.id} at ${currentPrice} (highest: ${updatedHighest})`);
          await closePosition(client, symbol, position.positionAmt, quantityPrecision);
          await setBotStatus(bot.id, bot.userId, 'STOPPED');
          processed++;
          return;
        }

        // Update config with latest highest price and activation status
        const updatedConfig: TrailingStopConfig = {
          ...config,
          highestPrice: updatedHighest,
          isActivated: action === 'ACTIVATE' ? true : config.isActivated,
        };

        if (
          updatedConfig.highestPrice !== config.highestPrice ||
          updatedConfig.isActivated !== config.isActivated
        ) {
          await db
            .update(tradingBots)
            .set({ config: updatedConfig, updatedAt: new Date() })
            .where(eq(tradingBots.id, bot.id));
        }
      });
    }

    return { processed };
  }
);
```

**Note on apiKeyId:** Same as DCA — uses `getBingxClientByApiKeyId` from Plan 2. Falls back to `getBingxClient(bot.userId)` for pre-subaccount bots.

**Note on 1-minute cron:** The trailing stop runs every 1 minute for tighter tracking. For very tight trailing percentages (e.g. 1%), a sudden price drop between checks could blow past the stop. Document this limitation in the UI description. Consider WebSocket price feeds as a future enhancement.

- [ ] **Step 2: Register in worker**

Add `trailingStopWatch` to the functions array in `src/worker.ts`:

```typescript
import { trailingStopWatch } from '@/inngest/functions/trailing-stop-watch';
// In the connect() call:
functions: [tradingBotWatch, dcaBotWatch, trailingStopWatch],
```

- [ ] **Step 3: Commit**

```bash
git add src/inngest/functions/trailing-stop-watch.ts src/worker.ts
git commit -m "feat: add trailing stop bot Inngest cron handler (1-minute interval)"
```

### Task 12: Create Trailing Stop Config Form

**Files:**
- Create: `src/components/trading/trailing-stop-config-form.tsx`

- [ ] **Step 1: Create the form**

```tsx
'use client';

import { useState } from 'react';
import { Card, Button, TextField, Input, Label, toast, Spinner } from '@heroui/react';
import { useActiveAccount } from '@/contexts/active-account';

export function TrailingStopConfigForm() {
  const { activeAccountId } = useActiveAccount();
  const [loading, setLoading] = useState(false);
  const [symbol, setSymbol] = useState('BTC-USDT');
  const [positionSizeUsdt, setPositionSizeUsdt] = useState('50');
  const [activationPricePct, setActivationPricePct] = useState('2');
  const [trailingPct, setTrailingPct] = useState('1');

  const handleSubmit = async () => {
    if (!activeAccountId) return;
    setLoading(true);
    try {
      const res = await fetch('/api/bingx/bot/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          botType: 'TRAILING_STOP',
          apiKeyId: activeAccountId,
          config: {
            positionSizeUsdt: Number(positionSizeUsdt),
            activationPricePct: Number(activationPricePct),
            trailingPct: Number(trailingPct),
            highestPrice: 0,
            isActivated: false,
            entryOrderId: null,
          },
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success('Trailing Stop bot started');
    } catch (err) {
      toast.danger(err instanceof Error ? err.message : 'Failed to start bot');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <Card.Content className="p-6 space-y-4">
        <h3 className="text-lg font-semibold">Trailing Stop Bot</h3>
        <p className="text-sm text-muted">
          Opens a position, then follows price up. Closes when price drops by the trailing percentage from the highest point.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <TextField>
            <Label>Symbol</Label>
            <Input value={symbol} onChange={(e) => setSymbol(e.target.value)} />
          </TextField>
          <TextField>
            <Label>Position Size (USDT)</Label>
            <Input
              type="number"
              value={positionSizeUsdt}
              onChange={(e) => setPositionSizeUsdt(e.target.value)}
              min={5}
            />
          </TextField>
          <TextField>
            <Label>Activation (%)</Label>
            <Input
              type="number"
              value={activationPricePct}
              onChange={(e) => setActivationPricePct(e.target.value)}
              min={0.1}
              step={0.1}
            />
          </TextField>
          <TextField>
            <Label>Trailing Distance (%)</Label>
            <Input
              type="number"
              value={trailingPct}
              onChange={(e) => setTrailingPct(e.target.value)}
              min={0.1}
              step={0.1}
            />
          </TextField>
        </div>
        <Button
          variant="primary"
          className="w-full"
          isDisabled={loading || !activeAccountId}
          onPress={handleSubmit}
        >
          {loading ? <Spinner size="sm" /> : 'Start Trailing Stop Bot'}
        </Button>
      </Card.Content>
    </Card>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/trading/trailing-stop-config-form.tsx
git commit -m "feat: add trailing stop bot configuration form"
```

## Chunk 5: Bot Type Selector & Integration

### Task 13: Create Bot Type Selector

**Files:**
- Create: `src/components/trading/bot-type-selector.tsx`

- [ ] **Step 1: Create tabbed bot type selector**

```tsx
'use client';

import { useState } from 'react';
import { Card } from '@heroui/react';
import { BotConfigForm } from './bot-config-form';
import { DCAConfigForm } from './dca-config-form';
import { GridShortConfigForm } from './grid-short-config-form';
import { TrailingStopConfigForm } from './trailing-stop-config-form';
import type { BotType } from '@/services/bots/types';

const botTypes: { key: BotType; label: string; description: string }[] = [
  { key: 'GRID_LONG', label: 'Grid Long', description: 'Buy low, sell high in a range' },
  { key: 'GRID_SHORT', label: 'Grid Short', description: 'Short high, cover low in a range' },
  { key: 'DCA', label: 'DCA', description: 'Buy at regular intervals' },
  { key: 'TRAILING_STOP', label: 'Trailing Stop', description: 'Follow price, sell on reversal' },
];

export function BotTypeSelector() {
  const [selected, setSelected] = useState<BotType>('GRID_LONG');

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {botTypes.map((type) => (
          <button
            key={type.key}
            onClick={() => setSelected(type.key)}
            className={`p-3 rounded-lg border text-left transition-colors ${
              selected === type.key
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-default-200 hover:border-default-300 text-muted'
            }`}
          >
            <p className="text-sm font-medium">{type.label}</p>
            <p className="text-xs mt-1 opacity-70">{type.description}</p>
          </button>
        ))}
      </div>

      {selected === 'GRID_LONG' && <BotConfigForm />}
      {selected === 'GRID_SHORT' && <GridShortConfigForm />}
      {selected === 'DCA' && <DCAConfigForm />}
      {selected === 'TRAILING_STOP' && <TrailingStopConfigForm />}
    </div>
  );
}
```

- [ ] **Step 2: Update bots page to use BotTypeSelector**

In `src/app/(dashboard)/dashboard/bots/page.tsx` (created in Plan 1, Task 6), replace `<BotConfigForm />` with `<BotTypeSelector />`.

**Dependency:** This file is created by Plan 1 (UI/UX Overhaul). If Plan 1 hasn't been executed yet, update the current dashboard page at `src/app/(dashboard)/dashboard/page.tsx` instead.

- [ ] **Step 3: Commit**

```bash
git add src/components/trading/bot-type-selector.tsx src/app/(dashboard)/dashboard/bots/page.tsx
git commit -m "feat: add bot type selector with tabbed interface on bots page"
```

### Task 14: Update Bots List for Multiple Types

**Files:**
- Modify: `src/components/trading/bots-list.tsx`

- [ ] **Step 1: Add bot type badge to each bot item**

Add a small badge next to the bot symbol showing the bot type:

```tsx
// In the bot item header, after the symbol:
<span className={`text-xs px-2 py-0.5 rounded-full ${
  bot.botType === 'GRID_LONG' ? 'bg-success/10 text-success' :
  bot.botType === 'GRID_SHORT' ? 'bg-danger/10 text-danger' :
  bot.botType === 'DCA' ? 'bg-accent/10 text-accent' :
  'bg-warning/10 text-warning'
}`}>
  {BOT_TYPE_LABELS[bot.botType] ?? 'Grid Long'}
</span>
```

- [ ] **Step 2: Show type-specific details**

For DCA bots: show ordersPlaced / totalOrders progress.
For Trailing Stop bots: show activation status, highest price, trailing distance.

- [ ] **Step 3: Commit**

```bash
git add src/components/trading/bots-list.tsx
git commit -m "feat: show bot type badges and type-specific details in bots list"
```

### Task 15: Update Bot Start API Route

**Files:**
- Modify: `src/app/api/bingx/bot/start/route.ts`

- [ ] **Step 1: Accept botType and config in the request body**

```typescript
const { symbol, botType, apiKeyId, config, ...gridParams } = await req.json();

// For grid bots, use existing flow
// For DCA and trailing stop, create bot with config JSONB
if (botType === 'DCA' || botType === 'TRAILING_STOP') {
  const [bot] = await db.insert(tradingBots).values({
    userId,
    symbol,
    botType,
    apiKeyId,
    config,
    priceMin: '0',
    priceMax: '0',
    gridCount: 0,
    status: 'RUNNING',
  }).returning();
  return NextResponse.json(bot);
}

// Existing grid bot flow with botType: botType ?? 'GRID_LONG'
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/bingx/bot/start/route.ts
git commit -m "feat: update bot start API to accept botType and config"
```

### Task 16: Register New Functions in Inngest Serve Route

**Files:**
- Modify: `src/app/api/inngest/route.ts`

- [ ] **Step 1: Register new cron functions for non-Connect mode**

The existing `src/app/api/inngest/route.ts` only registers `tradingBotWatch`. New functions must be registered here too for non-Connect deployments (when `INNGEST_USE_CONNECT !== '1'`):

```typescript
import { dcaBotWatch } from '@/inngest/functions/dca-bot-watch';
import { trailingStopWatch } from '@/inngest/functions/trailing-stop-watch';

const functions = process.env.INNGEST_USE_CONNECT === '1'
  ? []
  : [tradingBotWatch, dcaBotWatch, trailingStopWatch];
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/inngest/route.ts
git commit -m "feat: register DCA and trailing stop functions in Inngest serve route"
```

### Task 17: Final Build & Lint

- [ ] **Step 1: Run full build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "fix: resolve any remaining build/lint issues from new bot types"
```
