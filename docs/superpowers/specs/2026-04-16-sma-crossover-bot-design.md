# SMA Crossover Bot — Design Spec

## Context

The existing bingx-robot supports grid, DCA, and trailing stop bots for BingX perpetual futures. This spec adds a new **SMA Crossover** bot type that enters trades based on Simple Moving Average crossovers, confirmed by a longer-term trend filter, and exits via a configurable trailing stop.

**Problem**: The current bot types are either passive (grid/DCA) or single-entry (trailing stop). There is no trend-following strategy that enters and exits based on technical indicator signals.

**Goal**: A bot that automatically trades multiple symbols using SMA 3/20/150 crossover signals on 4-hour candles, managing positions with a trailing stop and close-and-reverse logic.

---

## Strategy Logic

### Indicators
- **SMA 3** (fast): Short-term price average
- **SMA 20** (medium): Medium-term price average
- **SMA 150** (trend): Long-term trend filter

### Trend Filter (SMA 150)
- Price **above** SMA 150 = **uptrend** (only LONG trades allowed)
- Price **below** SMA 150 = **downtrend** (only SHORT trades allowed)

### Entry Signals (candle close only)
- **LONG**: SMA 3 crosses above SMA 20 **AND** close price > SMA 150
- **SHORT**: SMA 3 crosses below SMA 20 **AND** close price < SMA 150

Crossover detection compares the current and previous closed candles. The in-progress candle is excluded to avoid false signals from wicks.

### Exit Logic — Trailing Stop
1. **Initial stop loss**: Placed at `initialStopPct%` against the position on entry
2. **Activation**: When unrealized profit reaches `activationPct%`, trailing starts
3. **Trailing**: Stop follows price at `trailingPct%` distance from highest (LONG) or lowest (SHORT) point
4. **Exchange-level**: A `STOP_MARKET` order sits on the exchange, updated each cron tick

### Close and Reverse
When an opposite crossover signal appears:
1. Close the current position (market order)
2. Cancel any existing stop orders
3. If the SMA 150 trend confirms the new direction → open new position
4. If trend does NOT confirm → just close, no new entry

Example: Bot is LONG, SMA 3 crosses below SMA 20, but price is still above SMA 150 → close LONG only (no SHORT). If price has also dropped below SMA 150 → close LONG and open SHORT.

---

## Architecture

### Approach
Config JSONB (Approach A) — all per-symbol state stored in the existing `tradingBots.config` column. No new tables or migrations beyond adding the enum value.

### New Bot Type
Add `SMA_CROSSOVER` to `botTypeEnum` in `src/db/schema.ts`. Requires a Drizzle migration to alter the PostgreSQL enum.

### Config Type

```typescript
// src/services/bots/types.ts

type SMASymbolState = {
  position: 'LONG' | 'SHORT' | null;
  entryPrice: number | null;
  entryOrderId: string | null;
  stopOrderId: string | null;
  highestPrice: number | null;     // trailing tracking (LONG)
  lowestPrice: number | null;      // trailing tracking (SHORT)
  trailingActivated: boolean;
  lastSignal: 'LONG' | 'SHORT' | null;
  lastSignalAt: number | null;     // unix ms
};

type SMAConfig = {
  symbols: string[];               // ["BTC-USDT", "ETH-USDT"]
  timeframe: string;               // "4h"
  fastPeriod: number;              // default: 3
  mediumPeriod: number;            // default: 20
  trendPeriod: number;             // default: 150
  activationPct: number;           // default: 1.5
  trailingPct: number;             // default: 0.5
  initialStopPct: number;          // default: 1.5
  positionSizeUsdt: number;        // per symbol
  leverage: number;
  marginType: string;              // 'ISOLATED' | 'CROSSED' | 'SEPARATE_ISOLATED'
  symbolStates: Record<string, SMASymbolState>;
};
```

The `tradingBots.symbol` field stores the first symbol from the list (for display compatibility). Multi-symbol tracking lives in `config.symbols` and `config.symbolStates`.

---

## New Klines API Function

The codebase has no kline/candlestick fetching. Add to `src/services/bingx.service.ts`:

```typescript
export async function getKlines(
  client: BingxClient,
  symbol: string,
  interval: string,  // "1m", "5m", "15m", "1h", "4h", "1d"
  limit: number       // max 1440 per BingX docs
): Promise<{ open: number; high: number; low: number; close: number; time: number }[]>
```

**Endpoint**: `GET /openApi/swap/v3/quote/klines`
**Params**: `symbol`, `interval`, `limit`
**Returns**: Array of OHLCV data

For SMA 150 on 4H candles, fetch `limit=200` (provides enough history with margin).

---

## Service Layer

### New file: `src/services/bots/sma-crossover.service.ts`

**Pure functions (no API calls):**

```typescript
// Calculate Simple Moving Average from close prices
function calculateSMA(closes: number[], period: number): number | null

// Detect crossover between two consecutive candle data points
// Returns signal only if trend (SMA 150) confirms
function detectSignal(params: {
  closes: number[];
  fastPeriod: number;
  mediumPeriod: number;
  trendPeriod: number;
}): 'LONG' | 'SHORT' | null

// Check trailing stop logic (reuse pattern from trailing-stop.service.ts)
function checkSMATrailingStop(
  state: SMASymbolState,
  currentPrice: number,
  config: Pick<SMAConfig, 'activationPct' | 'trailingPct' | 'initialStopPct'>
): { action: 'HOLD' | 'ACTIVATE' | 'CLOSE'; updatedHighest: number; updatedLowest: number }
```

**API-calling functions:**

```typescript
// Place market entry order (LONG or SHORT)
async function placeEntryOrder(
  client: BingxClient,
  symbol: string,
  side: 'LONG' | 'SHORT',
  positionSizeUsdt: number,
  currentPrice: number,
  quantityPrecision: number
): Promise<string | null>

// Place STOP_MARKET order for stop loss
async function placeStopOrder(
  client: BingxClient,
  symbol: string,
  positionSide: 'LONG' | 'SHORT',
  stopPrice: number,
  quantity: number,
  pricePrecision: number
): Promise<string | null>

// Close existing position at market
async function closePositionMarket(
  client: BingxClient,
  symbol: string,
  positionSide: 'LONG' | 'SHORT',
  quantity: number,
  quantityPrecision: number
): Promise<string | null>

// Cancel an existing stop order
async function cancelStopOrder(
  client: BingxClient,
  symbol: string,
  orderId: string
): Promise<void>
```

These follow the existing patterns in `trailing-stop.service.ts` and `dca.service.ts`.

---

## Inngest Cron Function

### New file: `src/inngest/functions/sma-crossover-watch.ts`

**Schedule**: `2 * * * *` (every hour at :02, lightweight — skips immediately if no candle closed for the bot's timeframe)

The cron runs hourly to support multiple timeframes (1h, 4h, 1d). On each tick, it checks whether a new candle has closed for each bot's configured timeframe:
- **1h**: processes every hour
- **4h**: processes only at 00:02, 04:02, 08:02, 12:02, 16:02, 20:02 UTC
- **1d**: processes only at 00:02 UTC

If no candle closed → early return, no API calls.

**Concurrency**: `{ limit: 1 }` (same pattern as other watch functions)

**Flow per execution:**

```
1. Fetch all RUNNING bots where botType === 'SMA_CROSSOVER'
2. For each bot:
   a. Check if a new candle closed for this bot's timeframe — if not, skip
   b. Get BingX client (via apiKeyId or userId)
   c. For each symbol in config.symbols:
      i.   Fetch klines (200 candles, interval from config.timeframe)
      ii.  Extract close prices from closed candles
      iii. Calculate SMA 3, SMA 20, SMA 150
      iv.  Detect signal (crossover + trend confirmation)
      v.   Get current state from config.symbolStates[symbol]
      
      CASE: Signal detected, no position
        → Ensure margin type & leverage (once per symbol, uses existing ensureMarginTypeAndLeverage)
        → Place MARKET entry order
        → Place STOP_MARKET at initialStopPct
        → Update symbolState
      
      CASE: Opposite signal detected, has position
        → Cancel existing stop order
        → Close position at market
        → If trend confirms new direction: open reverse position + new stop
        → Update symbolState
      
      CASE: In position, no new signal
        → Check trailing stop (update highest/lowest)
        → If trailing moved: cancel old stop, place new stop at updated level
        → Update symbolState
      
      CASE: No signal, no position
        → No action
      
   d. Save updated config (symbolStates) to DB
3. Return { processed: count }
```

**Rate limiting**: 400ms delay between API calls per symbol (same pattern as grid bot). Fetch contract info with 10-min cache (existing `getContractInfo()`).

---

## Validation Schema

### Update: `src/lib/validations/bot-schemas.ts`

```typescript
import { z } from 'zod';

export const smaConfigSchema = z.object({
  symbols: z.array(z.string().min(1)).min(1).max(20),
  timeframe: z.enum(['1h', '4h', '1d']).default('4h'),
  fastPeriod: z.number().int().min(2).max(50).default(3),
  mediumPeriod: z.number().int().min(5).max(100).default(20),
  trendPeriod: z.number().int().min(50).max(500).default(150),
  activationPct: z.number().min(0.1).max(50).default(1.5),
  trailingPct: z.number().min(0.1).max(20).default(0.5),
  initialStopPct: z.number().min(0.1).max(20).default(1.5),
  positionSizeUsdt: z.number().min(1),
  leverage: z.number().int().min(1).max(125).default(1),
  marginType: z.enum(['ISOLATED', 'CROSSED', 'SEPARATE_ISOLATED']).default('SEPARATE_ISOLATED'),
});
```

**Validation rules:**
- `fastPeriod < mediumPeriod < trendPeriod` (enforced via `.refine()`)
- `symbols` must not contain duplicates
- At least 1 symbol required

---

## API Route

### Update: `src/app/api/bingx/bot/start/route.ts`

Add a new branch for `botType === 'SMA_CROSSOVER'`:
1. Validate config with `smaConfigSchema`
2. Initialize `symbolStates` as empty `{}` for each symbol
3. Set `tradingBots.symbol` to first symbol in list
4. Set `priceMin`/`priceMax` to `'0'` (not used, follows DCA pattern)
5. Store full config in `tradingBots.config`
6. Set bot status to RUNNING
7. Send Inngest event `trading/bot.start`

---

## UI Components

### New file: `src/components/trading/sma-crossover-config-form.tsx`

Form fields:
- **Symbols**: Multi-select with available perpetual futures pairs
- **Timeframe**: Dropdown — 1h, **4h** (default), 1d
- **SMA Periods**: 3 number inputs — Fast (3), Medium (20), Trend (150)
- **Trailing Stop**: 3 number inputs — Activation % (1.5), Trail % (0.5), Initial Stop % (1.5)
- **Position Size (USDT)**: Number input — per symbol
- **Leverage**: Slider 1-125
- **Margin Type**: Dropdown

Uses existing `useActiveAccount` hook and `/api/bingx/balance` for balance check.

### Update: `src/components/trading/bot-type-selector.tsx`

Add entry to `botTypes` array:
```typescript
{ key: 'SMA_CROSSOVER', label: 'SMA Crossover', description: 'Trade SMA 3/20/150 crossovers' }
```

Add conditional render:
```typescript
{selected === 'SMA_CROSSOVER' && <SMACrossoverConfigForm />}
```

### Update: `src/components/trading/bots-list.tsx`

Add badge color for `SMA_CROSSOVER` (e.g., blue/indigo). Display per-symbol position info for SMA bots.

---

## Files to Modify

| File | Action | What Changes |
|------|--------|-------------|
| `src/db/schema.ts:24-30` | Edit | Add `'SMA_CROSSOVER'` to `botTypeEnum` |
| `src/services/bots/types.ts` | Edit | Add `SMAConfig`, `SMASymbolState`, update `BotType` union, `BOT_TYPE_LABELS`, `BotConfig` |
| `src/services/bingx.service.ts` | Edit | Add `getKlines()` function |
| `src/services/bots/sma-crossover.service.ts` | **Create** | SMA calculation, signal detection, order functions |
| `src/inngest/functions/sma-crossover-watch.ts` | **Create** | Cron job |
| `src/inngest/index.ts` (or equivalent registration) | Edit | Register new cron function |
| `src/lib/validations/bot-schemas.ts` | Edit | Add `smaConfigSchema` |
| `src/app/api/bingx/bot/start/route.ts` | Edit | Add `SMA_CROSSOVER` handler |
| `src/components/trading/sma-crossover-config-form.tsx` | **Create** | Config form UI |
| `src/components/trading/bot-type-selector.tsx` | Edit | Add SMA_CROSSOVER option + import |
| `src/components/trading/bots-list.tsx` | Edit | Badge + SMA-specific display |

---

## Verification Plan

1. **Schema migration**: Run `npm run db:generate` and `npm run db:migrate` — verify `SMA_CROSSOVER` enum value exists
2. **Klines function**: Call `getKlines(client, 'BTC-USDT', '4h', 200)` manually and verify response shape
3. **SMA calculation**: Unit test `calculateSMA()` with known data — verify against manual calculation
4. **Signal detection**: Unit test `detectSignal()` with crafted close arrays that produce known crossovers
5. **UI form**: Start dev server (`npm run dev`), navigate to /dashboard/bots, select SMA Crossover, verify form renders with all fields and validates correctly
6. **Bot creation**: Submit form, verify bot row in DB with correct config JSONB structure
7. **Cron execution**: Start Inngest dev server (`npm run inngest`), trigger the sma-crossover-watch function manually, verify it:
   - Fetches klines
   - Calculates SMAs
   - Detects (or doesn't detect) signals correctly
   - Places orders when signal present
   - Updates symbolStates in config
8. **Trailing stop**: With an open position, verify stop order is placed and updated on subsequent ticks
9. **Close and reverse**: Verify that opposite signal closes position and opens reverse (when trend confirms)
10. **Bot stop**: Stop bot via UI, verify status changes to STOPPED, no further cron processing
