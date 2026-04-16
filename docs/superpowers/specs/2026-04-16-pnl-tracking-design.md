# Bot P&L Tracking via Database

## Context

The current P&L display relies on BingX's `/openApi/swap/v2/user/income` API endpoint, which has severe limitations:
- Returns at most ~100 items per page with unreliable pagination for old data
- Does not distinguish between bots operating on the same symbol
- Historical retention appears limited (bot with 900+ trades over 43 days shows $1.96 instead of actual realized P&L)

This makes the realized P&L display useless for any bot that has been running for more than a few days.

**Solution**: Record every trade (entry and exit) in a local `botTrades` table. The realized P&L becomes `SUM(realizedPnl)` from this table — accurate, instant, and independent of BingX API limitations.

---

## Database Schema

### New table: `botTrades`

```
botTrades
  id            uuid        PK, default gen_random_uuid()
  botId         uuid        FK → tradingBots.id, CASCADE DELETE
  symbol        text        NOT NULL
  side          text        NOT NULL  -- 'LONG' | 'SHORT'
  type          text        NOT NULL  -- 'ENTRY' | 'EXIT_TP' | 'EXIT_TRAILING' | 'EXIT_SIGNAL' | 'EXIT_MANUAL'
  price         decimal(18,8) NOT NULL  -- estimated execution price
  quantity      decimal(18,8) NOT NULL
  realizedPnl   decimal(18,8) NOT NULL DEFAULT 0  -- USDT P&L (0 for entries, calculated for exits)
  orderId       text        NULLABLE  -- BingX order ID if available
  createdAt     timestamp   DEFAULT now()
```

**Indexes**:
- `bot_trades_bot_id_idx` on (botId)
- `bot_trades_bot_id_type_idx` on (botId, type) — for fast P&L aggregation

**Trade types**:
- `ENTRY` — position opened (realizedPnl = 0)
- `EXIT_TP` — take-profit filled (grid bots)
- `EXIT_TRAILING` — trailing stop triggered
- `EXIT_SIGNAL` — closed by opposite signal (SMA crossover)
- `EXIT_MANUAL` — closed by user stopping bot (future use)

---

## Service Layer

### New function: `recordTrade()`

Location: `src/services/bingx.service.ts`

```typescript
export async function recordTrade(params: {
  botId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  type: 'ENTRY' | 'EXIT_TP' | 'EXIT_TRAILING' | 'EXIT_SIGNAL' | 'EXIT_MANUAL';
  price: number;
  quantity: number;
  realizedPnl?: number;
  orderId?: string | null;
}): Promise<void>
```

Inserts a row into `botTrades`. For EXIT types, `realizedPnl` is calculated by the caller:
- LONG exit: `(exitPrice - entryPrice) × quantity`
- SHORT exit: `(entryPrice - exitPrice) × quantity`

### New function: `getBotRealizedPnl()`

```typescript
export async function getBotRealizedPnl(botId: string): Promise<number>
```

Returns `SUM(realizedPnl)` from `botTrades` WHERE `botId = botId`. Fast DB query, no API calls.

---

## Cron Hook Points

### 1. Grid Bot (`trading-bot-watch.ts`)

**Grid TP fill detection** — when a position at a grid level disappears (TP executed):

The grid cron already detects this scenario: it checks if `level.tpOrderId` exists but the position is gone. At this point:
- Entry price = `level.priceLevel` (the grid level price)
- Exit price = TP stop price = `priceLevel × (1 ± takeProfitPct)` depending on LONG/SHORT
- Quantity = `positionSizeUsdt / priceLevel` (from bot config)

**Hook**: After detecting TP fill (position gone + TP orderId gone), record both ENTRY and EXIT_TP trades.

The grid cron currently resets `orderId` and `tpOrderId` to null when replacing them. We add trade recording BEFORE the reset.

**Important**: To avoid duplicate recording on subsequent cron ticks, check if a trade with the same `orderId` already exists before inserting.

### 2. Trailing Stop (`trailing-stop-watch.ts`)

**Entry**: After `placeEntryMarketOrder()` returns orderId (line 67-75).
- Record ENTRY with `price=currentPrice`, `quantity=positionSizeUsdt/currentPrice`

**Exit**: After `closePosition()` (line 110).
- Record EXIT_TRAILING with `price=currentPrice`, `realizedPnl=(currentPrice - entryPrice) × quantity`
- Entry price available from `position.entryPrice` (line 105)

### 3. SMA Crossover (`sma-crossover-watch.ts`)

**Entry**: After `placeEntryOrder()` succeeds (lines 153-159).
- Record ENTRY with `price=currentPrice`, side from signal

**Exit — trailing stop**: After `closePositionMarket()` in trailing stop path (lines 279-281).
- Record EXIT_TRAILING with `price=currentPrice`, calculate P&L from `state.entryPrice`

**Exit — opposite signal**: After `closePositionMarket()` in close-and-reverse path (lines 207-211).
- Record EXIT_SIGNAL with `price=currentPrice`, calculate P&L from `state.entryPrice`

### 4. DCA (`dca-bot-watch.ts`)

**Entry**: After `placeDCAOrder()` succeeds (line 60).
- Record ENTRY with `price=currentPrice`, `quantity=orderSizeUsdt/currentPrice`
- DCA accumulates entries over time — the realized P&L comes when positions are manually closed (not tracked by cron)

---

## P&L Display Changes

### `getBotsDetailsBatched()` — use DB instead of API

Replace the `getIncome()` call with `getBotRealizedPnl(botId)`:
- No API calls for realized P&L
- Works for all bot types
- Works for stopped bots (data persists in DB)
- Instant (single SQL query)

### `getBotDetails()` — same change

Replace `getIncome()` with `getBotRealizedPnl()`.

### Stopped bots in `route.ts`

Stopped bots can now show realized P&L from the DB without any API calls. The page loads instantly.

---

## Duplicate Prevention

Each trade recording should check for existing records to avoid duplicates on cron re-runs:
- For grid bots: check by `(botId, orderId, type)` — the orderId is unique per order
- For other bots: the cron places the order and records the trade in the same execution, so duplicates are unlikely. But as safety, check by `(botId, orderId, type)` when orderId is available.

---

## Files to Modify

| File | Change |
|---|---|
| `src/db/schema.ts` | Add `botTrades` table |
| `src/services/bingx.service.ts` | Add `recordTrade()`, `getBotRealizedPnl()`. Update `getBotsDetailsBatched()` and `getBotDetails()` to use DB P&L |
| `src/inngest/functions/trading-bot-watch.ts` | Record ENTRY + EXIT_TP when grid TP fills |
| `src/inngest/functions/trailing-stop-watch.ts` | Record ENTRY + EXIT_TRAILING |
| `src/inngest/functions/sma-crossover-watch.ts` | Record ENTRY + EXIT_TRAILING + EXIT_SIGNAL |
| `src/inngest/functions/dca-bot-watch.ts` | Record ENTRY |
| `src/app/api/bingx/bot/route.ts` | Stopped bots use DB P&L |

---

## Verification

1. `npm run db:generate` + `npm run db:migrate` — botTrades table created
2. `npm run build` — no type errors
3. Start a grid bot → verify ENTRY recorded when position opens
4. Wait for TP fill → verify EXIT_TP recorded with correct P&L
5. Check bot list → realized P&L matches sum of EXIT trades
6. Stop bot → P&L still shows from DB
7. Check stopped bots → P&L loads instantly (no API delay)
