# SMA Crossover Bot — ADX Filter + ATR Trailing Stop

## Context

The SMA Crossover bot (implemented in the prior spec) uses fixed-percentage trailing stops and has no filter for ranging markets. This leads to:
1. False signals in sideways/choppy markets where SMA 3 whipsaws across SMA 20
2. Trailing stops that don't adapt to current volatility — too tight in volatile periods, too loose in calm ones

This spec adds two improvements:
- **ADX (Average Directional Index)** as an entry filter — blocks new trades when the market isn't trending
- **ATR (Average True Range) trailing stop** — replaces fixed-percentage trailing with volatility-adaptive distances

---

## 1. ADX Filter

### Calculation

ADX uses a standard 3-step process from OHLC data:

1. **True Range (TR)**: `max(high - low, |high - prevClose|, |low - prevClose|)`
2. **Directional Movement**: `+DM` and `-DM` (positive/negative directional movement)
3. **Smoothed averages**: ATR, +DI, -DI over `adxPeriod` candles
4. **DX** = `|+DI - -DI| / (+DI + -DI) * 100`
5. **ADX** = smoothed average of DX over `adxPeriod`

Standard period: **14**.

### Behavior

- ADX >= `adxThreshold` (default 25): market is trending, signals allowed
- ADX < `adxThreshold`: market is ranging, **new entries blocked**
- **Positions already open are NOT affected** by low ADX — trailing stop and close-on-crossover continue to operate normally
- When a signal is blocked by ADX, log it but take no action

### Integration Point

In the cron function, after `detectSignal()` returns a valid signal, add an ADX gate:

```
if (signal && !state.position) {
  if (adx < config.adxThreshold) {
    logger.info("Signal blocked by ADX filter");
    continue;
  }
  // ... place entry
}
```

Same gate applies before opening a reverse position in close-and-reverse logic.

---

## 2. ATR Trailing Stop

### Calculation

ATR = Smoothed average of True Range over `atrPeriod` candles (default: 14).

The same TR calculation used for ADX feeds ATR, so both indicators share the True Range computation.

### Replaces Fixed Percentages

| Old Field | New Field | Default | Meaning |
|---|---|---|---|
| `activationPct` (%) | `activationAtrMult` | 3 | Trailing activates when profit >= 3 * ATR |
| `trailingPct` (%) | `trailingAtrMult` | 1 | Trail distance = 1 * ATR from highest/lowest |
| `initialStopPct` (%) | `initialStopAtrMult` | 2 | Initial stop = 2 * ATR from entry |

### Example

BTC-USDT, 4H candles, ATR(14) = $500:
- **Entry at $60,000 LONG**
- Initial stop: $60,000 - (2 * $500) = **$59,000**
- Trailing activates when price reaches: $60,000 + (3 * $500) = **$61,500**
- Once activated, trail follows at: highest - (1 * $500)
  - If highest = $62,000, stop is at **$61,500**
  - If highest moves to $63,000, stop moves to **$62,500**

### ATR Persistence

ATR is calculated fresh on each cron tick from klines OHLC data. The calculated ATR value is stored in `SMASymbolState.lastAtr` so the trailing stop logic has a reference value. This field is updated every tick.

---

## Type Changes

### `SMAConfig` — replace percentage fields with ATR/ADX fields

```typescript
type SMAConfig = {
  symbols: string[];
  timeframe: string;
  fastPeriod: number;
  mediumPeriod: number;
  trendPeriod: number;
  // NEW: ADX filter
  adxPeriod: number;           // default: 14
  adxThreshold: number;        // default: 25
  // NEW: ATR trailing (replaces activationPct, trailingPct, initialStopPct)
  atrPeriod: number;           // default: 14
  activationAtrMult: number;   // default: 3
  trailingAtrMult: number;     // default: 1
  initialStopAtrMult: number;  // default: 2
  positionSizeUsdt: number;
  leverage: number;
  marginType: string;
  symbolStates: Record<string, SMASymbolState>;
};
```

### `SMASymbolState` — add lastAtr

```typescript
type SMASymbolState = {
  // ... existing fields ...
  lastAtr: number | null;      // ATR from last cron tick
};
```

### Fields Removed from `SMAConfig`

- `activationPct` — replaced by `activationAtrMult`
- `trailingPct` — replaced by `trailingAtrMult`
- `initialStopPct` — replaced by `initialStopAtrMult`

---

## Service Layer Changes

### New pure functions in `sma-crossover.service.ts`

```typescript
// Calculate True Range for a single candle
function calcTR(high: number, low: number, prevClose: number): number

// Calculate ATR (Average True Range)
function calculateATR(klines: Kline[], period: number): number | null

// Calculate ADX (Average Directional Index)
function calculateADX(klines: Kline[], period: number): number | null
```

### Modified function: `checkSMATrailingStop`

Replace percentage-based parameters with ATR-based:

```typescript
function checkSMATrailingStop(
  state: SMASymbolState,
  currentPrice: number,
  config: Pick<SMAConfig, 'activationAtrMult' | 'trailingAtrMult' | 'initialStopAtrMult'>,
  atr: number  // NEW: current ATR value
): { action, updatedHighest, updatedLowest, newStopPrice }
```

Stop calculations change from:
- `entryPrice * (1 - initialStopPct / 100)` → `entryPrice - (initialStopAtrMult * atr)`
- `entryPrice * (1 + activationPct / 100)` → `entryPrice + (activationAtrMult * atr)`
- `highest * (1 - trailingPct / 100)` → `highest - (trailingAtrMult * atr)`

---

## Validation Schema Changes

### `smaConfigSchema` in `bot-schemas.ts`

Replace:
```typescript
activationPct → activationAtrMult: z.number().min(0.5).max(10).default(3)
trailingPct   → trailingAtrMult:   z.number().min(0.1).max(5).default(1)
initialStopPct → initialStopAtrMult: z.number().min(0.5).max(10).default(2)
```

Add:
```typescript
adxPeriod:    z.number().int().min(5).max(50).default(14)
adxThreshold: z.number().min(10).max(50).default(25)
atrPeriod:    z.number().int().min(5).max(50).default(14)
```

---

## Cron Changes

### Updated flow in `sma-crossover-watch.ts`

```
For each symbol:
  1. Fetch klines (OHLC) — already fetched, no change
  2. Calculate SMA 3, 20, 150 from closes — no change
  3. NEW: Calculate ATR(atrPeriod) from klines OHLC
  4. NEW: Calculate ADX(adxPeriod) from klines OHLC
  5. Detect crossover — no change
  6. NEW: If signal present but ADX < threshold → block entry, log
  7. For trailing stop: use ATR * multipliers instead of fixed %
  8. Save lastAtr to symbolState
```

---

## UI Changes

### `sma-crossover-config-form.tsx`

**"Trailing Stop" section → renamed to "ATR Trailing Stop"**

Replace 3 percentage fields with:
- ATR Period (default: 14)
- Activation (ATR x, default: 3)
- Trail Distance (ATR x, default: 1)
- Initial Stop (ATR x, default: 2)

**New section: "ADX Filter"**
- ADX Period (default: 14)
- ADX Threshold (default: 25)

### `bots-list.tsx`

Update SMA info line to show ADX threshold:
```
SMA 3/20/150 • 4h • ADX>25 • 3 symbols • 1 active
```

---

## Files to Modify

| File | Change |
|------|--------|
| `src/services/bots/types.ts` | Replace % fields with ATR/ADX fields in SMAConfig, add lastAtr to SMASymbolState |
| `src/services/bots/sma-crossover.service.ts` | Add `calculateATR()`, `calculateADX()`, update `checkSMATrailingStop()` |
| `src/inngest/functions/sma-crossover-watch.ts` | Add ADX gate, pass ATR to trailing, store lastAtr |
| `src/lib/validations/bot-schemas.ts` | Replace % fields with ATR/ADX multiplier fields |
| `src/app/api/bingx/bot/start/route.ts` | No change needed (uses smaConfigSchema, auto-picks up new fields) |
| `src/components/trading/sma-crossover-config-form.tsx` | Replace % inputs with ATR multiplier inputs, add ADX section |
| `src/components/trading/bots-list.tsx` | Update SMA info display |

---

## Backward Compatibility

Existing SMA_CROSSOVER bots in the database have the old `activationPct/trailingPct/initialStopPct` fields. Options:
- The cron should handle both formats gracefully: if old fields are present and new fields are missing, treat them as defaults
- Or: since this is a new feature (just shipped), reset existing bots

Since SMA_CROSSOVER was just added and likely has no production bots yet, we can simply replace the fields. No migration needed.

---

## Verification

1. `npm run build` — no type errors
2. Verify `calculateATR()` and `calculateADX()` with known test data
3. UI form renders with new fields, old fields gone
4. Create bot, verify config JSONB has ADX/ATR fields
5. Trigger cron — verify ADX is calculated and logged
6. Verify signal is blocked when ADX < threshold
7. Verify trailing stop uses ATR-based distances
