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
    if (llm.error.kind === 'SCHEMA_REJECTED') {
      return { ok: false, error: { kind: 'SCHEMA_REJECTED', issues: llm.error.issues } };
    }
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
