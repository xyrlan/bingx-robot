import { describe, it, expect, beforeEach } from 'vitest';
import { runSignal } from '@/lib/ai-pm/signal';
import type { AnthropicFactory } from '@/lib/ai-pm/llm';
import type { Kline } from '@/services/bingx.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeDb(state: FakeDbState): any {
  return {
    insert: () => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
