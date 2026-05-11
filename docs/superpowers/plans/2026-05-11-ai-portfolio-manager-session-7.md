# AI Portfolio Manager — Session 7 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Signal layer. Given allowed symbols, fetch klines + compute indicators (S4), build prompt, call Haiku (S6), validate Zod schema, persist `aiSignals` rows. Returns ranked candidate list.

**Architecture:** Pure orchestration. No cron, no auth, no decryption — caller passes already-decrypted Anthropic API key + BingX client + db handle. Pure function shape (besides DB writes for `aiSignals`). Deterministic given fixed inputs + recorded Haiku response. Schema rejection short-circuits: zero writes, error returned.

**Tech Stack:** TypeScript · Drizzle · Zod · Vitest · Bun · S4 indicators · S6 LLM router

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/lib/ai-pm/signal.prompt.ts` | Create | System + user prompt templates. Zod schema for Haiku response. Indicator-snapshot helper. |
| `src/lib/ai-pm/signal.ts` | Create | Public `runSignal(params)`. Wires klines → indicators → prompt → Haiku → schema → DB writes. |
| `src/lib/ai-pm/__tests__/signal.test.ts` | Create | Vitest with cassette Haiku responses. Determinism, schema-rejection, DB-write paths. |

---

## Public Surface

```ts
// signal.prompt.ts
export const REGIME_VALUES = ['range', 'trend_up', 'trend_down', 'volatile'] as const;
export type Regime = (typeof REGIME_VALUES)[number];

export const SignalResponseSchema: z.ZodType<{
  candidates: Array<{
    symbol: string;
    regime: Regime;
    score: number;          // 0-100
    reason: string;         // short rationale
  }>;
}>;

export interface IndicatorSnapshot {
  symbol: string;
  lastClose: number;
  sma20: number | null;
  sma50: number | null;
  rsi14: number | null;
  atr14: number | null;
  bollingerWidth: number | null;  // (upper - lower) / middle, null if any band null
}

export function buildIndicatorSnapshot(symbol: string, candles: Kline[]): IndicatorSnapshot;
export function buildSystemPrompt(): string;
export function buildUserPrompt(snapshots: IndicatorSnapshot[]): string;
```

```ts
// signal.ts
export interface SignalCandidate {
  symbol: string;
  regime: Regime;
  score: number;
  reason: string;
}

export interface SignalResult {
  candidates: SignalCandidate[];   // top-5 by score (sorted desc)
  signalIds: string[];             // aiSignals.id values, parallel to candidates
  usage: LlmUsage;
}

export type SignalError =
  | { kind: 'NO_MARKET_DATA'; symbol: string }
  | { kind: 'LLM_ERROR'; cause: LlmError }
  | { kind: 'SCHEMA_REJECTED'; issues: unknown };

export type SignalOutcome =
  | { ok: true; result: SignalResult }
  | { ok: false; error: SignalError };

export interface RunSignalParams {
  userId: string;
  allowedSymbols: string[];
  anthropicApiKey: string;
  bingxClient: BingxClient;
  db: typeof import('@/db').db;
  interval?: string;       // default '1h'
  candleLimit?: number;    // default 100
  factory?: AnthropicFactory;  // for tests
  klinesFetcher?: typeof fetchKlines;  // for tests
}

export function runSignal(params: RunSignalParams): Promise<SignalOutcome>;
```

**Key contracts:**

1. **Top-5 cap.** Even if Haiku returns more, only first 5 (after sorting by score desc) are persisted and returned.
2. **Schema rejection = zero writes.** Drizzle insert wrapped after Zod parse. On any non-`ok` path, no rows committed.
3. **`indicatorsSnapshot` JSONB.** Persists the full snapshot per candidate (for audit + Decision layer to consume).
4. **Symbol filtering.** If Haiku returns a symbol not in `allowedSymbols`, that candidate is dropped (logged, not errored).

---

## Task 1: Prompt module + Zod schema

**Files:**
- Create: `src/lib/ai-pm/signal.prompt.ts`

- [ ] **Step 1: Write the file**

```ts
import { z } from 'zod';
import {
  sma,
  rsi,
  atr,
  bollinger,
  type Candle,
  type CloseCandle,
} from '@/lib/ai-pm/indicators';
import type { Kline } from '@/services/bingx.service';

export const REGIME_VALUES = ['range', 'trend_up', 'trend_down', 'volatile'] as const;
export type Regime = (typeof REGIME_VALUES)[number];

export const SignalResponseSchema = z.object({
  candidates: z.array(
    z.object({
      symbol: z.string().min(1),
      regime: z.enum(REGIME_VALUES),
      score: z.number().min(0).max(100),
      reason: z.string().min(1).max(500),
    }),
  ),
});

export type SignalResponse = z.infer<typeof SignalResponseSchema>;

export interface IndicatorSnapshot {
  symbol: string;
  lastClose: number;
  sma20: number | null;
  sma50: number | null;
  rsi14: number | null;
  atr14: number | null;
  bollingerWidth: number | null;
}

export function buildIndicatorSnapshot(symbol: string, candles: Kline[]): IndicatorSnapshot {
  const closeCandles: CloseCandle[] = candles.map((k) => ({ close: k.close }));
  const fullCandles: Candle[] = candles.map((k) => ({ high: k.high, low: k.low, close: k.close }));
  const lastClose = candles.length > 0 ? candles[candles.length - 1].close : 0;
  const bb = bollinger(closeCandles, 20, 2);
  const bollingerWidth =
    bb && bb.middle !== 0 ? (bb.upper - bb.lower) / bb.middle : null;

  return {
    symbol,
    lastClose,
    sma20: sma(closeCandles, 20),
    sma50: sma(closeCandles, 50),
    rsi14: rsi(closeCandles, 14),
    atr14: atr(fullCandles, 14),
    bollingerWidth,
  };
}

export function buildSystemPrompt(): string {
  return [
    'You are a quantitative analyst for a crypto futures portfolio.',
    'Given indicator snapshots for several symbols, return up to 5 candidates ranked by opportunity.',
    '',
    'Regime values:',
    '- "range": price oscillating, low directional bias (good for grid/DCA)',
    '- "trend_up": sustained upward move (good for trailing-stop long)',
    '- "trend_down": sustained downward move (avoid or short)',
    '- "volatile": high ATR, no clear direction (reduce risk)',
    '',
    'Score is 0-100: 100 = highest conviction trading opportunity, 0 = avoid.',
    'Reason: one sentence, plain English, no markdown.',
    '',
    'Return JSON only, no preamble. Schema:',
    '{"candidates":[{"symbol":"BTC-USDT","regime":"range","score":75,"reason":"..."}]}',
  ].join('\n');
}

export function buildUserPrompt(snapshots: IndicatorSnapshot[]): string {
  const rows = snapshots
    .map((s) => {
      const fmt = (n: number | null) => (n === null ? 'n/a' : n.toFixed(4));
      return [
        `symbol=${s.symbol}`,
        `last=${s.lastClose.toFixed(4)}`,
        `sma20=${fmt(s.sma20)}`,
        `sma50=${fmt(s.sma50)}`,
        `rsi14=${fmt(s.rsi14)}`,
        `atr14=${fmt(s.atr14)}`,
        `bbWidth=${fmt(s.bollingerWidth)}`,
      ].join(' ');
    })
    .join('\n');

  return `Indicator snapshots (1h candles, latest 100):\n${rows}\n\nReturn top-5 candidates as JSON.`;
}
```

- [ ] **Step 2: Lint** — `bunx eslint src/lib/ai-pm/signal.prompt.ts` clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/ai-pm/signal.prompt.ts
git commit -m "feat(ai-pm): signal prompt templates and response schema"
```

---

## Task 2: Signal runner + tests (TDD)

**Files:**
- Create: `src/lib/ai-pm/signal.ts`
- Create: `src/lib/ai-pm/__tests__/signal.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/lib/ai-pm/__tests__/signal.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { runSignal } from '@/lib/ai-pm/signal';
import type { AnthropicFactory } from '@/lib/ai-pm/llm';
import type { Kline } from '@/services/bingx.service';

function fakeBingxClient(): any {
  return { __fake: true };
}

function fakeKlines(seed: number, length = 100): Kline[] {
  const out: Kline[] = [];
  let price = 100 + seed;
  for (let i = 0; i < length; i++) {
    const open = price;
    const close = price * (1 + Math.sin(i / 5) * 0.01);
    out.push({
      open,
      high: Math.max(open, close) * 1.005,
      low: Math.min(open, close) * 0.995,
      close,
      time: i * 3_600_000,
    });
    price = close;
  }
  return out;
}

function fakeFactory(response: string | { error: Error }): AnthropicFactory {
  return () => ({
    messages: {
      create: async () => {
        if (typeof response !== 'string') throw response.error;
        return {
          id: 'msg_1',
          model: 'claude-haiku-4-5',
          role: 'assistant',
          content: [{ type: 'text', text: response }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          type: 'message',
          usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        };
      },
    },
  });
}

interface FakeDbState {
  inserted: Array<{ id: string; userId: string; symbol: string; regime: string; score: number; reason: string | null; indicatorsSnapshot: unknown }>;
}

function fakeDb(state: FakeDbState): any {
  return {
    insert: () => ({
      values: (rows: any[]) => ({
        returning: async () => {
          const out = rows.map((r, i) => ({ ...r, id: `signal-${state.inserted.length + i}` }));
          state.inserted.push(...out);
          return out;
        },
      }),
    }),
  };
}

const klinesFetcherFor = (data: Record<string, Kline[]>) =>
  async (_c: any, symbol: string) => data[symbol] ?? [];

const userId = '00000000-0000-0000-0000-000000000001';

describe('runSignal', () => {
  let dbState: FakeDbState;
  beforeEach(() => {
    dbState = { inserted: [] };
  });

  it('parses Haiku response, persists top-5 candidates, returns usage', async () => {
    const haiku = JSON.stringify({
      candidates: [
        { symbol: 'BTC-USDT', regime: 'range', score: 80, reason: 'tight bands' },
        { symbol: 'ETH-USDT', regime: 'trend_up', score: 70, reason: 'higher highs' },
      ],
    });
    const result = await runSignal({
      userId,
      allowedSymbols: ['BTC-USDT', 'ETH-USDT'],
      anthropicApiKey: 'sk-ant',
      bingxClient: fakeBingxClient(),
      db: fakeDb(dbState),
      factory: fakeFactory(haiku),
      klinesFetcher: klinesFetcherFor({
        'BTC-USDT': fakeKlines(0),
        'ETH-USDT': fakeKlines(50),
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.result.candidates).toHaveLength(2);
    expect(result.result.candidates[0].symbol).toBe('BTC-USDT');
    expect(result.result.signalIds).toHaveLength(2);
    expect(dbState.inserted).toHaveLength(2);
    expect(result.result.usage.inputTokens).toBe(500);
  });

  it('sorts by score desc and caps at 5', async () => {
    const cands = Array.from({ length: 8 }, (_, i) => ({
      symbol: `SYM${i}-USDT`,
      regime: 'range',
      score: 10 + i * 10,
      reason: 'r',
    }));
    const haiku = JSON.stringify({ candidates: cands });
    const klines: Record<string, Kline[]> = {};
    const allowed: string[] = [];
    for (let i = 0; i < 8; i++) {
      klines[`SYM${i}-USDT`] = fakeKlines(i);
      allowed.push(`SYM${i}-USDT`);
    }

    const result = await runSignal({
      userId,
      allowedSymbols: allowed,
      anthropicApiKey: 'sk-ant',
      bingxClient: fakeBingxClient(),
      db: fakeDb(dbState),
      factory: fakeFactory(haiku),
      klinesFetcher: klinesFetcherFor(klines),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.result.candidates).toHaveLength(5);
    expect(result.result.candidates[0].score).toBe(80);
    expect(result.result.candidates[4].score).toBe(40);
    expect(dbState.inserted).toHaveLength(5);
  });

  it('drops candidates whose symbol is not in allowedSymbols', async () => {
    const haiku = JSON.stringify({
      candidates: [
        { symbol: 'BTC-USDT', regime: 'range', score: 80, reason: 'r' },
        { symbol: 'DOGE-USDT', regime: 'trend_up', score: 70, reason: 'r' },
      ],
    });
    const result = await runSignal({
      userId,
      allowedSymbols: ['BTC-USDT'],
      anthropicApiKey: 'sk-ant',
      bingxClient: fakeBingxClient(),
      db: fakeDb(dbState),
      factory: fakeFactory(haiku),
      klinesFetcher: klinesFetcherFor({ 'BTC-USDT': fakeKlines(0) }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.result.candidates.map((c) => c.symbol)).toEqual(['BTC-USDT']);
    expect(dbState.inserted).toHaveLength(1);
  });

  it('returns SCHEMA_REJECTED with zero DB writes when Haiku response is malformed', async () => {
    const haiku = JSON.stringify({ candidates: [{ symbol: 'BTC-USDT', regime: 'invalid', score: 80 }] });
    const result = await runSignal({
      userId,
      allowedSymbols: ['BTC-USDT'],
      anthropicApiKey: 'sk-ant',
      bingxClient: fakeBingxClient(),
      db: fakeDb(dbState),
      factory: fakeFactory(haiku),
      klinesFetcher: klinesFetcherFor({ 'BTC-USDT': fakeKlines(0) }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.kind).toBe('SCHEMA_REJECTED');
    expect(dbState.inserted).toHaveLength(0);
  });

  it('returns LLM_ERROR with zero DB writes when SDK throws', async () => {
    const result = await runSignal({
      userId,
      allowedSymbols: ['BTC-USDT'],
      anthropicApiKey: 'sk-ant',
      bingxClient: fakeBingxClient(),
      db: fakeDb(dbState),
      factory: fakeFactory({ error: new Error('500 server error') }),
      klinesFetcher: klinesFetcherFor({ 'BTC-USDT': fakeKlines(0) }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.kind).toBe('LLM_ERROR');
    expect(dbState.inserted).toHaveLength(0);
  });

  it('returns NO_MARKET_DATA when klines fetch returns empty for all symbols', async () => {
    const result = await runSignal({
      userId,
      allowedSymbols: ['BTC-USDT'],
      anthropicApiKey: 'sk-ant',
      bingxClient: fakeBingxClient(),
      db: fakeDb(dbState),
      factory: fakeFactory('{"candidates":[]}'),
      klinesFetcher: klinesFetcherFor({}),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.kind).toBe('NO_MARKET_DATA');
    expect(dbState.inserted).toHaveLength(0);
  });

  it('writes indicatorsSnapshot JSONB with each row', async () => {
    const haiku = JSON.stringify({
      candidates: [{ symbol: 'BTC-USDT', regime: 'range', score: 80, reason: 'r' }],
    });
    await runSignal({
      userId,
      allowedSymbols: ['BTC-USDT'],
      anthropicApiKey: 'sk-ant',
      bingxClient: fakeBingxClient(),
      db: fakeDb(dbState),
      factory: fakeFactory(haiku),
      klinesFetcher: klinesFetcherFor({ 'BTC-USDT': fakeKlines(0) }),
    });

    expect(dbState.inserted[0].indicatorsSnapshot).toMatchObject({ symbol: 'BTC-USDT' });
    expect(dbState.inserted[0].indicatorsSnapshot).toHaveProperty('rsi14');
  });
});
```

- [ ] **Step 2: Run failing tests** — module not found.

- [ ] **Step 3: Implement the signal runner**

Create `src/lib/ai-pm/signal.ts`:

```ts
import { fetchKlines } from '@/lib/bingx/market-data';
import type { BingxClient } from '@/lib/bingx/client';
import type { Kline } from '@/services/bingx.service';
import {
  buildIndicatorSnapshot,
  buildSystemPrompt,
  buildUserPrompt,
  SignalResponseSchema,
  type IndicatorSnapshot,
  type Regime,
} from '@/lib/ai-pm/signal.prompt';
import { callHaiku, type AnthropicFactory, type LlmError, type LlmUsage } from '@/lib/ai-pm/llm';
import { aiSignals } from '@/db/schema';
import type { db as Db } from '@/db';

export interface SignalCandidate {
  symbol: string;
  regime: Regime;
  score: number;
  reason: string;
}

export interface SignalResult {
  candidates: SignalCandidate[];
  signalIds: string[];
  usage: LlmUsage;
}

export type SignalError =
  | { kind: 'NO_MARKET_DATA'; symbol: string }
  | { kind: 'LLM_ERROR'; cause: LlmError }
  | { kind: 'SCHEMA_REJECTED'; issues: unknown };

export type SignalOutcome =
  | { ok: true; result: SignalResult }
  | { ok: false; error: SignalError };

export interface RunSignalParams {
  userId: string;
  allowedSymbols: string[];
  anthropicApiKey: string;
  bingxClient: BingxClient;
  db: typeof Db;
  interval?: string;
  candleLimit?: number;
  factory?: AnthropicFactory;
  klinesFetcher?: (client: BingxClient, symbol: string, interval: string, limit: number) => Promise<Kline[]>;
}

const TOP_N = 5;

export async function runSignal(params: RunSignalParams): Promise<SignalOutcome> {
  const interval = params.interval ?? '1h';
  const candleLimit = params.candleLimit ?? 100;
  const fetcher = params.klinesFetcher ?? fetchKlines;

  const snapshots: IndicatorSnapshot[] = [];
  let haveAnyData = false;
  for (const symbol of params.allowedSymbols) {
    const candles = await fetcher(params.bingxClient, symbol, interval, candleLimit);
    if (candles.length === 0) continue;
    haveAnyData = true;
    snapshots.push(buildIndicatorSnapshot(symbol, candles));
  }

  if (!haveAnyData) {
    return { ok: false, error: { kind: 'NO_MARKET_DATA', symbol: params.allowedSymbols[0] ?? '' } };
  }

  const llm = await callHaiku({
    apiKey: params.anthropicApiKey,
    systemPrompt: buildSystemPrompt(),
    userPrompt: buildUserPrompt(snapshots),
    schema: SignalResponseSchema,
    factory: params.factory,
  });

  if (!llm.ok) {
    return { ok: false, error: { kind: 'LLM_ERROR', cause: llm.error } };
  }

  const allowed = new Set(params.allowedSymbols);
  const filtered = llm.data.candidates.filter((c) => allowed.has(c.symbol));
  const ranked = [...filtered].sort((a, b) => b.score - a.score).slice(0, TOP_N);

  if (ranked.length === 0) {
    return {
      ok: true,
      result: { candidates: [], signalIds: [], usage: llm.usage },
    };
  }

  const snapshotsBySymbol = new Map(snapshots.map((s) => [s.symbol, s]));
  const rows = ranked.map((c) => ({
    userId: params.userId,
    symbol: c.symbol,
    regime: c.regime,
    score: c.score,
    reason: c.reason,
    indicatorsSnapshot: snapshotsBySymbol.get(c.symbol) ?? null,
  }));

  const inserted = await params.db.insert(aiSignals).values(rows).returning();
  const signalIds = inserted.map((r) => r.id);

  return {
    ok: true,
    result: {
      candidates: ranked,
      signalIds,
      usage: llm.usage,
    },
  };
}
```

- [ ] **Step 4: Run tests** — expect 7/7 pass for `signal.test.ts`.

- [ ] **Step 5: Run full suite** — expect 93 + 7 = 100.

- [ ] **Step 6: Lint** — `bunx eslint src/lib/ai-pm/signal.ts src/lib/ai-pm/__tests__/signal.test.ts` clean.

- [ ] **Step 7: Build** — `bun run build` clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/ai-pm/signal.ts src/lib/ai-pm/__tests__/signal.test.ts
git commit -m "feat(ai-pm): signal runner with Haiku + indicator snapshots"
```

---

## Self-Review

- **Spec coverage:** S7 spec asks for `runSignal(userId, allowedSymbols): SignalResult`. Plan widens signature to inject `bingxClient`, `db`, `anthropicApiKey` (keeps runner pure — caller in S11 cron wires deps). All other spec items covered.
- **Cassette LLM fixtures:** Tests use `fakeFactory` with literal JSON strings — recorded responses.
- **Determinism:** Given fixed klines + recorded Haiku response, output is deterministic (top-N sort is stable for distinct scores; reason text is verbatim from cassette).
- **Schema rejection = zero writes:** Implementation calls `callHaiku` (which Zod-validates) before any DB write. Schema rejection returns early.
- **Symbol filtering:** Haiku responses outside `allowedSymbols` are silently dropped per spec ambiguity — design doc implies trust boundary.

## Done Criteria

1. `buildIndicatorSnapshot`, `buildSystemPrompt`, `buildUserPrompt`, `SignalResponseSchema`, `REGIME_VALUES` exported from `signal.prompt.ts`.
2. `runSignal`, `SignalResult`, `SignalError`, `SignalOutcome`, `SignalCandidate`, `RunSignalParams` exported from `signal.ts`.
3. 7 tests pass: happy path + persistence, top-5 cap + sort, allowed-symbol filter, SCHEMA_REJECTED, LLM_ERROR, NO_MARKET_DATA, indicatorsSnapshot JSONB write.
4. Full suite passes (100 tests).
5. Lint + build clean.
