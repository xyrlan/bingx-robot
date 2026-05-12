# AI Portfolio Manager — Session 16b: Complete Chat Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out S16 deferred work — wire `bingxClient` through the chat pipeline, implement the `adjust_params` and `reallocate_capital` executor cases (paper + real mode), add the two corresponding chat tools, and extend guardrails to bound the new mutations.

**Architecture:** Six tasks. Guardrails first (foundation). Then executor cases. Then chat tools (consume executor). Then pipeline wiring. Then PR. All reuse existing patterns; no schema migration. Drizzle `db.transaction()` for atomic reallocate.

**Tech Stack:** Drizzle ORM, vitest, zod, BingX client.

**Spec:** `docs/superpowers/specs/2026-05-12-ai-pm-chat-tools-finish-design.md`
**Branch:** `feat/ai-pm-chat-tools-finish` (already created; spec committed at `8279c38`).

---

## File Manifest

**Modified:**
- `src/lib/ai-pm/guardrails.ts` (+ `__tests__/guardrails.test.ts`)
- `src/lib/ai-pm/executor.ts` (+ `__tests__/executor.test.ts`)
- `src/lib/ai-pm/chat-tools.ts` (+ `__tests__/chat-tools.test.ts`)
- `src/lib/ai-pm/chat-pipeline.ts` (+ `__tests__/chat-pipeline.test.ts`)
- `src/inngest/functions/ai-pm-event-handler.ts` (+ `__tests__/ai-pm-event-handler.test.ts` if it exists)

**No new files. No schema migration.**

---

## Task 1: Extend guardrails with `maxLeverage` + new action checks

**Files:**
- Modify: `src/lib/ai-pm/guardrails.ts`
- Modify: `src/lib/ai-pm/__tests__/guardrails.test.ts`

Add `maxLeverage` to `GuardrailConfig`. Add `'LEVERAGE_CAP'` to `GuardrailReason`. Extend `adjust_params` case to check leverage cap + capital cap + strategy allowlist (when those params are present). `reallocate_capital` check stays minimal (botId presence — total capital conserved).

- [ ] **Step 1: Write failing tests**

Append to `src/lib/ai-pm/__tests__/guardrails.test.ts`:

```ts
import { runGuardrails } from '@/lib/ai-pm/guardrails';

const baseCfg = {
  maxCapitalUsdt: 1000,
  maxConcurrentBots: 5,
  maxLeverage: 5,
  allowedStrategies: ['DCA', 'TRAILING_STOP', 'DCA_SPOT', 'SMA_CROSSOVER'] as const,
  killSwitch: false,
};

const baseState = {
  runningBots: [
    { id: 'bot-1', symbol: 'BTC-USDT', strategy: 'DCA' as const, capitalUsdt: 100, leverage: 2, status: 'RUNNING' as const },
    { id: 'bot-2', symbol: 'ETH-USDT', strategy: 'DCA' as const, capitalUsdt: 200, leverage: 3, status: 'RUNNING' as const },
  ],
  capitalUsedUsdt: 300,
  bingxApiKeyId: 'key-1',
};

describe('runGuardrails — adjust_params', () => {
  it('rejects when bot not running', () => {
    const got = runGuardrails({
      action: { type: 'adjust_params', botId: 'bot-X', params: { capitalUsdt: 200 }, reasoning: 'r' },
      config: { ...baseCfg, allowedStrategies: [...baseCfg.allowedStrategies] },
      portfolioState: baseState,
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe('UNKNOWN_BOT_ID');
  });

  it('rejects when new leverage exceeds maxLeverage', () => {
    const got = runGuardrails({
      action: { type: 'adjust_params', botId: 'bot-1', params: { leverage: 10 }, reasoning: 'r' },
      config: { ...baseCfg, allowedStrategies: [...baseCfg.allowedStrategies] },
      portfolioState: baseState,
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe('LEVERAGE_CAP');
  });

  it('rejects when new capital pushes total over maxCapitalUsdt', () => {
    const got = runGuardrails({
      action: { type: 'adjust_params', botId: 'bot-1', params: { capitalUsdt: 950 }, reasoning: 'r' },
      // currently bot-1 uses 100 + bot-2 200 = 300; after: 950 + 200 = 1150 > 1000
      config: { ...baseCfg, allowedStrategies: [...baseCfg.allowedStrategies] },
      portfolioState: baseState,
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe('CAPITAL_CAP');
  });

  it('rejects when new strategy is not allowed', () => {
    const got = runGuardrails({
      action: { type: 'adjust_params', botId: 'bot-1', params: { strategy: 'NOT_A_STRATEGY' as never }, reasoning: 'r' },
      config: { ...baseCfg, allowedStrategies: ['DCA'] },
      portfolioState: baseState,
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe('STRATEGY_NOT_ALLOWED');
  });

  it('accepts well-bounded adjust', () => {
    const got = runGuardrails({
      action: { type: 'adjust_params', botId: 'bot-1', params: { capitalUsdt: 150, leverage: 3 }, reasoning: 'r' },
      config: { ...baseCfg, allowedStrategies: [...baseCfg.allowedStrategies] },
      portfolioState: baseState,
    });
    expect(got.ok).toBe(true);
  });
});

describe('runGuardrails — reallocate_capital', () => {
  it('rejects when one of the bots is not running', () => {
    const got = runGuardrails({
      action: { type: 'reallocate_capital', fromBotId: 'bot-1', toBotId: 'bot-X', amountUsdt: 50, reasoning: 'r' },
      config: { ...baseCfg, allowedStrategies: [...baseCfg.allowedStrategies] },
      portfolioState: baseState,
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe('UNKNOWN_BOT_ID');
  });

  it('rejects when from === to', () => {
    const got = runGuardrails({
      action: { type: 'reallocate_capital', fromBotId: 'bot-1', toBotId: 'bot-1', amountUsdt: 50, reasoning: 'r' },
      config: { ...baseCfg, allowedStrategies: [...baseCfg.allowedStrategies] },
      portfolioState: baseState,
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe('UNKNOWN_BOT_ID');
  });

  it('accepts when both bots are running and from !== to', () => {
    const got = runGuardrails({
      action: { type: 'reallocate_capital', fromBotId: 'bot-1', toBotId: 'bot-2', amountUsdt: 50, reasoning: 'r' },
      config: { ...baseCfg, allowedStrategies: [...baseCfg.allowedStrategies] },
      portfolioState: baseState,
    });
    expect(got.ok).toBe(true);
  });
});
```

NOTE: existing `guardrails.test.ts` test file already has top-level `import`s for `describe/it/expect`, and pre-existing tests probably use a different `baseCfg` shape (without `maxLeverage`). The plan task 1 also touches those existing tests — search for any `config:` blocks that omit `maxLeverage` and add `maxLeverage: 5` so they keep typechecking after Step 3 below.

- [ ] **Step 2: Run tests — they fail**

```bash
npx vitest run src/lib/ai-pm/__tests__/guardrails.test.ts
```
Expected: new tests fail (missing `LEVERAGE_CAP`, undefined behavior on `adjust_params` extended checks). Existing tests may fail too with `maxLeverage` typed as required — fix in Step 3.

- [ ] **Step 3: Update `src/lib/ai-pm/guardrails.ts`**

Replace entire file:

```ts
import type { ProposedAction } from '@/lib/ai-pm/decision.prompt';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';

export interface GuardrailConfig {
  maxCapitalUsdt: number;
  maxConcurrentBots: number;
  maxLeverage: number;
  allowedStrategies: Array<'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER'>;
  killSwitch: boolean;
}

export type GuardrailReason =
  | 'KILL_SWITCH'
  | 'CAPITAL_CAP'
  | 'CONCURRENT_CAP'
  | 'LEVERAGE_CAP'
  | 'STRATEGY_NOT_ALLOWED'
  | 'UNKNOWN_BOT_ID';

export type GuardrailResult =
  | { ok: true }
  | { ok: false; reason: GuardrailReason; message: string };

export function runGuardrails(input: {
  action: ProposedAction;
  config: GuardrailConfig;
  portfolioState: PortfolioState;
}): GuardrailResult {
  const { action, config, portfolioState } = input;

  if (config.killSwitch) {
    return { ok: false, reason: 'KILL_SWITCH', message: 'Kill switch is engaged' };
  }

  const runningBotIds = new Set(portfolioState.runningBots.map((b) => b.id));

  switch (action.type) {
    case 'no_action':
      return { ok: true };

    case 'create_bot': {
      if (!config.allowedStrategies.includes(action.strategy)) {
        return { ok: false, reason: 'STRATEGY_NOT_ALLOWED', message: `Strategy ${action.strategy} not in allowedStrategies` };
      }
      if (portfolioState.runningBots.length >= config.maxConcurrentBots) {
        return { ok: false, reason: 'CONCURRENT_CAP', message: `Active bots (${portfolioState.runningBots.length}) at cap (${config.maxConcurrentBots})` };
      }
      if (portfolioState.capitalUsedUsdt + action.capitalUsdt > config.maxCapitalUsdt) {
        return { ok: false, reason: 'CAPITAL_CAP', message: `Capital used + new ${action.capitalUsdt} exceeds cap ${config.maxCapitalUsdt}` };
      }
      if (action.leverage > config.maxLeverage) {
        return { ok: false, reason: 'LEVERAGE_CAP', message: `Leverage ${action.leverage} exceeds cap ${config.maxLeverage}` };
      }
      return { ok: true };
    }

    case 'stop_bot':
      if (!runningBotIds.has(action.botId)) {
        return { ok: false, reason: 'UNKNOWN_BOT_ID', message: `Bot ${action.botId} not running` };
      }
      return { ok: true };

    case 'adjust_params': {
      if (!runningBotIds.has(action.botId)) {
        return { ok: false, reason: 'UNKNOWN_BOT_ID', message: `Bot ${action.botId} not running` };
      }
      const p = action.params as {
        capitalUsdt?: number;
        leverage?: number;
        strategy?: string;
      };
      if (typeof p.leverage === 'number' && p.leverage > config.maxLeverage) {
        return { ok: false, reason: 'LEVERAGE_CAP', message: `Leverage ${p.leverage} exceeds cap ${config.maxLeverage}` };
      }
      if (typeof p.strategy === 'string' && !config.allowedStrategies.includes(p.strategy as GuardrailConfig['allowedStrategies'][number])) {
        return { ok: false, reason: 'STRATEGY_NOT_ALLOWED', message: `Strategy ${p.strategy} not in allowedStrategies` };
      }
      if (typeof p.capitalUsdt === 'number') {
        const current = portfolioState.runningBots.find((b) => b.id === action.botId)?.capitalUsdt ?? 0;
        const delta = p.capitalUsdt - current;
        if (portfolioState.capitalUsedUsdt + delta > config.maxCapitalUsdt) {
          return { ok: false, reason: 'CAPITAL_CAP', message: `New capital pushes total over cap ${config.maxCapitalUsdt}` };
        }
      }
      return { ok: true };
    }

    case 'reallocate_capital':
      if (action.fromBotId === action.toBotId) {
        return { ok: false, reason: 'UNKNOWN_BOT_ID', message: `fromBotId and toBotId must differ` };
      }
      if (!runningBotIds.has(action.fromBotId) || !runningBotIds.has(action.toBotId)) {
        return { ok: false, reason: 'UNKNOWN_BOT_ID', message: `Bot id(s) not running` };
      }
      return { ok: true };
  }
}
```

- [ ] **Step 4: Fix any pre-existing tests that omit `maxLeverage`**

Search for fixtures missing the new field:

```bash
grep -rn "maxConcurrentBots:" src/lib/ai-pm/__tests__/ | head -20
```

For each fixture object that constructs a `GuardrailConfig` and lacks `maxLeverage`, add `maxLeverage: 20` (a safely high value that won't trip existing tests).

Also check call sites in non-test code:
```bash
grep -rn "GuardrailConfig\|maxCapitalUsdt:\|allowedStrategies:" src/ --include='*.ts' | grep -v __tests__ | head -20
```

In `src/lib/ai-pm/chat-tools.ts`, the `guardrailConfig()` helper (line ~164) does NOT include `maxLeverage`. Add it:

In that function's return object, add a line:
```ts
maxLeverage: cfg.maxLeverage ?? 20,
```

Adjacent to the existing `maxCapitalUsdt:` / `maxConcurrentBots:` lines.

In `src/lib/ai-pm/validation.ts`, look for any place that constructs `GuardrailConfig` — `runGuardrails({ ..., config: <here> })`. The validate function takes `config: GuardrailConfig & { reviewerThresholdPct: number }`, so the field needs to flow through wherever callers build that object. Search and add as needed.

- [ ] **Step 5: Tests pass**

```bash
npx vitest run src/lib/ai-pm/__tests__/guardrails.test.ts
npx vitest run src/lib/ai-pm/__tests__/chat-tools.test.ts
```
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ai-pm/guardrails.ts src/lib/ai-pm/__tests__/guardrails.test.ts src/lib/ai-pm/chat-tools.ts
git commit -m "feat(ai-pm): extend guardrails with maxLeverage + adjust/reallocate checks"
```

---

## Task 2: Implement `adjust_params` executor

**Files:**
- Modify: `src/lib/ai-pm/executor.ts`
- Modify: `src/lib/ai-pm/__tests__/executor.test.ts`

Replace the `NOT_IMPLEMENTED` stub with both paper and real branches. Real branch handles direct-field updates and the strategy-change stop+recreate flow.

- [ ] **Step 1: Append failing tests**

Read existing `src/lib/ai-pm/__tests__/executor.test.ts` to understand the `fakeDb` pattern. Append a new `describe` block:

```ts
describe('execute — adjust_params', () => {
  it('paper mode: updates capitalUsdt + params jsonb', async () => {
    const updateMock = vi.fn().mockReturnValue({
      set: (vals: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => [{ id: 'paper-1', capitalUsdt: vals.capitalUsdt ?? '0' }],
        }),
      }),
    });
    const findMock = vi.fn().mockResolvedValue({
      id: 'paper-1', userId, capitalUsdt: '100', params: { leverage: 2 }, strategy: 'DCA',
    });
    const fakePaperDb = {
      query: { paperBots: { findFirst: findMock } },
      update: updateMock,
    };

    const action: ProposedAction = {
      type: 'adjust_params',
      botId: 'paper-1',
      params: { capitalUsdt: 150, leverage: 3 },
      reasoning: 'rebalance',
    };

    const got = await execute({
      userId, decisionId, action,
      config: { bingxApiKeyId: apiKeyId, paperMode: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: fakePaperDb as any,
    });

    expect(got.status).toBe('EXECUTED');
    expect(got.paperBotId).toBe('paper-1');
    expect(updateMock).toHaveBeenCalled();
  });

  it('real mode: direct-field update + optional setLeverage', async () => {
    const updateRes: { id: string; positionSizeUsdt: string; leverage: number; status: 'RUNNING' | 'STOPPED' } = {
      id: botId, positionSizeUsdt: '150', leverage: 3, status: 'RUNNING',
    };
    const updateMock = vi.fn().mockReturnValue({
      set: () => ({ where: () => ({ returning: async () => [updateRes] }) }),
    });
    const findMock = vi.fn().mockResolvedValue({
      id: botId, userId, apiKeyId, botType: 'DCA', symbol: 'BTC-USDT', positionSizeUsdt: '100', leverage: 2, status: 'RUNNING',
    });
    const setLeverageMock = vi.fn().mockResolvedValue(undefined);

    const action: ProposedAction = {
      type: 'adjust_params',
      botId,
      params: { capitalUsdt: 150, leverage: 3 },
      reasoning: 'r',
    };

    const got = await execute({
      userId, decisionId, action,
      config: { bingxApiKeyId: apiKeyId, paperMode: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { query: { tradingBots: { findFirst: findMock } }, update: updateMock } as any,
      setLeverageFn: setLeverageMock,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bingxClient: { fake: true } as any,
    });

    expect(got.status).toBe('EXECUTED');
    expect(got.realBotId).toBe(botId);
    expect(setLeverageMock).toHaveBeenCalledWith(expect.anything(), 'BTC-USDT', 3);
  });

  it('real mode: setLeverage throws → still EXECUTED (warned)', async () => {
    const updateMock = vi.fn().mockReturnValue({
      set: () => ({ where: () => ({ returning: async () => [{ id: botId, leverage: 3 }] }) }),
    });
    const findMock = vi.fn().mockResolvedValue({
      id: botId, userId, apiKeyId, botType: 'DCA', symbol: 'BTC-USDT', positionSizeUsdt: '100', leverage: 2, status: 'RUNNING',
    });
    const setLeverageMock = vi.fn().mockRejectedValue(new Error('exchange rejected'));

    const action: ProposedAction = {
      type: 'adjust_params', botId, params: { leverage: 3 }, reasoning: 'r',
    };

    const got = await execute({
      userId, decisionId, action,
      config: { bingxApiKeyId: apiKeyId, paperMode: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { query: { tradingBots: { findFirst: findMock } }, update: updateMock } as any,
      setLeverageFn: setLeverageMock,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bingxClient: {} as any,
    });

    expect(got.status).toBe('EXECUTED');
    // No throw, no failure status
  });

  it('real mode: strategy change → stops + recreates, returns newBotId', async () => {
    const updateMock = vi.fn().mockReturnValue({
      set: () => ({ where: () => ({ returning: async () => [{ id: botId, status: 'STOPPED' }] }) }),
    });
    const findMock = vi.fn().mockResolvedValue({
      id: botId, userId, apiKeyId, botType: 'DCA', symbol: 'BTC-USDT', positionSizeUsdt: '100', leverage: 2, takeProfitPercentage: '1', gridCount: 1, priceMin: '0', priceMax: '0', status: 'RUNNING',
    });
    const createBotMock = vi.fn().mockResolvedValue({ id: 'new-bot-1' });

    const action: ProposedAction = {
      type: 'adjust_params', botId, params: { strategy: 'SMA_CROSSOVER' }, reasoning: 'r',
    };

    const got = await execute({
      userId, decisionId, action,
      config: { bingxApiKeyId: apiKeyId, paperMode: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { query: { tradingBots: { findFirst: findMock } }, update: updateMock } as any,
      createBotFn: createBotMock,
    });

    expect(got.status).toBe('EXECUTED');
    expect(got.realBotId).toBe(botId);
    expect(got.newBotId).toBe('new-bot-1');
    expect(createBotMock).toHaveBeenCalled();
    expect(createBotMock.mock.calls[0][1].botType).toBe('SMA_CROSSOVER');
  });

  it('real mode: recreate fails → EXECUTION_FAILED, old bot stays STOPPED', async () => {
    const updateMock = vi.fn().mockReturnValue({
      set: () => ({ where: () => ({ returning: async () => [{ id: botId, status: 'STOPPED' }] }) }),
    });
    const findMock = vi.fn().mockResolvedValue({
      id: botId, userId, apiKeyId, botType: 'DCA', symbol: 'BTC-USDT', positionSizeUsdt: '100', leverage: 2, takeProfitPercentage: '1', gridCount: 1, priceMin: '0', priceMax: '0', status: 'RUNNING',
    });
    const createBotMock = vi.fn().mockRejectedValue(new Error('boom'));

    const action: ProposedAction = {
      type: 'adjust_params', botId, params: { strategy: 'SMA_CROSSOVER' }, reasoning: 'r',
    };

    const got = await execute({
      userId, decisionId, action,
      config: { bingxApiKeyId: apiKeyId, paperMode: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { query: { tradingBots: { findFirst: findMock } }, update: updateMock } as any,
      createBotFn: createBotMock,
    });

    expect(got.status).toBe('EXECUTION_FAILED');
    expect(got.reason).toMatch(/recreate_failed/);
  });

  it('bot not found → EXECUTION_FAILED', async () => {
    const action: ProposedAction = {
      type: 'adjust_params', botId, params: { capitalUsdt: 200 }, reasoning: 'r',
    };
    const got = await execute({
      userId, decisionId, action,
      config: { bingxApiKeyId: apiKeyId, paperMode: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { query: { tradingBots: { findFirst: async () => null } } } as any,
    });
    expect(got.status).toBe('EXECUTION_FAILED');
    expect(got.reason).toMatch(/not found/i);
  });
});
```

- [ ] **Step 2: Tests fail**

```bash
npx vitest run src/lib/ai-pm/__tests__/executor.test.ts
```
Expected: 6 new failing (`NOT_IMPLEMENTED` returns).

- [ ] **Step 3: Implement `adjust_params` case in `src/lib/ai-pm/executor.ts`**

Read the current file. Add new imports at top:

```ts
import { paperBots } from '@/db/schema';
```

Extend the `ExecuteParams` interface to support new optional injection points:

```ts
export interface ExecuteParams {
  userId: string;
  decisionId: string;
  action: ProposedAction;
  config: ExecutorConfig;
  db: typeof Db;
  createBotFn?: typeof defaultCreateBot;
  createPaperBotFn?: typeof defaultCreatePaperBot;
  setLeverageFn?: (client: unknown, symbol: string, leverage: number) => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bingxClient?: any;
}
```

Replace the `case 'adjust_params':` body with:

```ts
    case 'adjust_params': {
      if (config.paperMode) {
        const row = await params.db.query.paperBots.findFirst({
          where: and(eq(paperBots.id, action.botId), eq(paperBots.userId, userId)),
        });
        if (!row) {
          return { status: 'EXECUTION_FAILED', decisionId, reason: `Paper bot ${action.botId} not found` };
        }
        const p = action.params as { capitalUsdt?: number; leverage?: number; strategy?: 'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER'; config?: Record<string, unknown> };
        const updateValues: Record<string, unknown> = {};
        if (typeof p.capitalUsdt === 'number') updateValues.capitalUsdt = String(p.capitalUsdt);
        if (p.strategy) updateValues.strategy = p.strategy;
        if (p.leverage !== undefined || p.config !== undefined) {
          const merged = { ...(row.params as Record<string, unknown> | null ?? {}) };
          if (p.leverage !== undefined) merged.leverage = p.leverage;
          if (p.config !== undefined) Object.assign(merged, p.config);
          updateValues.params = merged;
        }
        await params.db.update(paperBots).set(updateValues).where(and(eq(paperBots.id, action.botId), eq(paperBots.userId, userId))).returning();
        return { status: 'EXECUTED', decisionId, paperBotId: row.id };
      }

      const row = await params.db.query.tradingBots.findFirst({
        where: and(eq(tradingBots.id, action.botId), eq(tradingBots.userId, userId)),
      });
      if (!row) {
        return { status: 'EXECUTION_FAILED', decisionId, reason: `Bot ${action.botId} not found` };
      }
      if (row.apiKeyId !== config.bingxApiKeyId) {
        return { status: 'EXECUTION_FAILED', decisionId, reason: `Bot apiKeyId mismatch — not in AI subaccount scope` };
      }

      const p = action.params as { capitalUsdt?: number; leverage?: number; strategy?: 'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER'; config?: Record<string, unknown> };

      // Strategy change → stop + recreate
      if (p.strategy && p.strategy !== row.botType) {
        await params.db
          .update(tradingBots)
          .set({ status: 'STOPPED' })
          .where(and(eq(tradingBots.id, action.botId), eq(tradingBots.userId, userId)))
          .returning();

        const createBot = params.createBotFn ?? defaultCreateBot;
        try {
          const newBot = await createBot(userId, {
            symbol: row.symbol,
            botType: p.strategy,
            positionSizeUsdt: typeof p.capitalUsdt === 'number' ? String(p.capitalUsdt) : row.positionSizeUsdt,
            takeProfitPercentage: row.takeProfitPercentage,
            gridCount: row.gridCount,
            leverage: typeof p.leverage === 'number' ? p.leverage : row.leverage,
            apiKeyId: config.bingxApiKeyId,
            priceMin: row.priceMin,
            priceMax: row.priceMax,
            config: (p.config ?? {}) as Record<string, unknown>,
          });
          return { status: 'EXECUTED', decisionId, realBotId: row.id, newBotId: newBot.id };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { status: 'EXECUTION_FAILED', decisionId, reason: `recreate_failed: ${msg}` };
        }
      }

      // Direct-field update
      const updateValues: Record<string, unknown> = {};
      if (typeof p.capitalUsdt === 'number') updateValues.positionSizeUsdt = String(p.capitalUsdt);
      if (typeof p.leverage === 'number') updateValues.leverage = p.leverage;
      if (p.config !== undefined) updateValues.config = { ...(row.config ?? {}), ...p.config };

      if (Object.keys(updateValues).length === 0) {
        return { status: 'EXECUTED', decisionId, realBotId: row.id };
      }

      await params.db
        .update(tradingBots)
        .set(updateValues)
        .where(and(eq(tradingBots.id, action.botId), eq(tradingBots.userId, userId)))
        .returning();

      if (typeof p.leverage === 'number' && params.bingxClient && params.setLeverageFn) {
        try {
          await params.setLeverageFn(params.bingxClient, row.symbol, p.leverage);
        } catch {
          // warn-not-throw; leverage stays at exchange-side last-accepted
        }
      }

      return { status: 'EXECUTED', decisionId, realBotId: row.id };
    }
```

Update `ExecutionResult` interface to include `newBotId?: string`:
```ts
export interface ExecutionResult {
  status: ExecutionStatus;
  decisionId: string;
  realBotId?: string;
  paperBotId?: string;
  newBotId?: string;
  reason?: string;
}
```

- [ ] **Step 4: Tests pass**

```bash
npx vitest run src/lib/ai-pm/__tests__/executor.test.ts
```
Expected: all green (existing + 6 new).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai-pm/executor.ts src/lib/ai-pm/__tests__/executor.test.ts
git commit -m "feat(ai-pm): implement adjust_params executor (paper + real)"
```

---

## Task 3: Implement `reallocate_capital` executor

**Files:**
- Modify: `src/lib/ai-pm/executor.ts`
- Modify: `src/lib/ai-pm/__tests__/executor.test.ts`

Drizzle transaction; updates fromBot and toBot capital atomically.

- [ ] **Step 1: Append failing tests**

```ts
describe('execute — reallocate_capital', () => {
  it('paper mode: atomic update of both bots', async () => {
    const updateMock = vi.fn().mockReturnValue({
      set: () => ({ where: () => ({ returning: async () => [{}] }) }),
    });
    const transactionMock = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = { update: updateMock };
      return cb(tx);
    });

    const fromRow = { id: 'paper-from', userId, capitalUsdt: '200' };
    const toRow = { id: 'paper-to', userId, capitalUsdt: '100' };

    const fakePaperDb = {
      query: {
        paperBots: {
          findFirst: vi.fn()
            .mockResolvedValueOnce(fromRow)
            .mockResolvedValueOnce(toRow),
        },
      },
      transaction: transactionMock,
    };

    const action: ProposedAction = {
      type: 'reallocate_capital',
      fromBotId: 'paper-from',
      toBotId: 'paper-to',
      amountUsdt: 50,
      reasoning: 'rebalance',
    };

    const got = await execute({
      userId, decisionId, action,
      config: { bingxApiKeyId: apiKeyId, paperMode: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: fakePaperDb as any,
    });

    expect(got.status).toBe('EXECUTED');
    expect(transactionMock).toHaveBeenCalledOnce();
    expect(updateMock).toHaveBeenCalledTimes(2);
  });

  it('insufficient capital → EXECUTION_FAILED', async () => {
    const fromRow = { id: 'paper-from', userId, capitalUsdt: '40' };
    const toRow = { id: 'paper-to', userId, capitalUsdt: '100' };
    const fakePaperDb = {
      query: {
        paperBots: {
          findFirst: vi.fn().mockResolvedValueOnce(fromRow).mockResolvedValueOnce(toRow),
        },
      },
      transaction: vi.fn(),
    };

    const action: ProposedAction = {
      type: 'reallocate_capital', fromBotId: 'paper-from', toBotId: 'paper-to', amountUsdt: 50, reasoning: 'r',
    };

    const got = await execute({
      userId, decisionId, action,
      config: { bingxApiKeyId: apiKeyId, paperMode: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: fakePaperDb as any,
    });

    expect(got.status).toBe('EXECUTION_FAILED');
    expect(got.reason).toMatch(/insufficient_capital/);
    expect(fakePaperDb.transaction).not.toHaveBeenCalled();
  });

  it('real mode: atomic update of trading_bots positionSizeUsdt', async () => {
    const updateMock = vi.fn().mockReturnValue({
      set: () => ({ where: () => ({ returning: async () => [{}] }) }),
    });
    const transactionMock = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = { update: updateMock };
      return cb(tx);
    });

    const fromRow = { id: 'real-from', userId, apiKeyId, positionSizeUsdt: '200', status: 'RUNNING' };
    const toRow = { id: 'real-to', userId, apiKeyId, positionSizeUsdt: '100', status: 'RUNNING' };

    const fakeRealDb = {
      query: {
        tradingBots: {
          findFirst: vi.fn().mockResolvedValueOnce(fromRow).mockResolvedValueOnce(toRow),
        },
      },
      transaction: transactionMock,
    };

    const action: ProposedAction = {
      type: 'reallocate_capital', fromBotId: 'real-from', toBotId: 'real-to', amountUsdt: 50, reasoning: 'r',
    };

    const got = await execute({
      userId, decisionId, action,
      config: { bingxApiKeyId: apiKeyId, paperMode: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: fakeRealDb as any,
    });

    expect(got.status).toBe('EXECUTED');
    expect(transactionMock).toHaveBeenCalledOnce();
    expect(updateMock).toHaveBeenCalledTimes(2);
  });

  it('real mode: apiKeyId mismatch → EXECUTION_FAILED', async () => {
    const fromRow = { id: 'real-from', userId, apiKeyId: otherApiKeyId, positionSizeUsdt: '200' };
    const fakeRealDb = {
      query: {
        tradingBots: { findFirst: vi.fn().mockResolvedValue(fromRow) },
      },
      transaction: vi.fn(),
    };

    const action: ProposedAction = {
      type: 'reallocate_capital', fromBotId: 'real-from', toBotId: 'real-to', amountUsdt: 50, reasoning: 'r',
    };

    const got = await execute({
      userId, decisionId, action,
      config: { bingxApiKeyId: apiKeyId, paperMode: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: fakeRealDb as any,
    });

    expect(got.status).toBe('EXECUTION_FAILED');
    expect(got.reason).toMatch(/apiKeyId mismatch/i);
  });

  it('fromBotId === toBotId → EXECUTION_FAILED', async () => {
    const action: ProposedAction = {
      type: 'reallocate_capital', fromBotId: 'x', toBotId: 'x', amountUsdt: 50, reasoning: 'r',
    };
    const got = await execute({
      userId, decisionId, action,
      config: { bingxApiKeyId: apiKeyId, paperMode: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
    });
    expect(got.status).toBe('EXECUTION_FAILED');
    expect(got.reason).toMatch(/same bot/i);
  });
});
```

- [ ] **Step 2: Tests fail**

```bash
npx vitest run src/lib/ai-pm/__tests__/executor.test.ts
```
Expected: 5 new failing.

- [ ] **Step 3: Implement `reallocate_capital` case in `src/lib/ai-pm/executor.ts`**

Replace the existing `case 'reallocate_capital':` body with:

```ts
    case 'reallocate_capital': {
      if (action.fromBotId === action.toBotId) {
        return { status: 'EXECUTION_FAILED', decisionId, reason: 'same bot for from and to' };
      }

      if (config.paperMode) {
        const fromRow = await params.db.query.paperBots.findFirst({
          where: and(eq(paperBots.id, action.fromBotId), eq(paperBots.userId, userId)),
        });
        const toRow = await params.db.query.paperBots.findFirst({
          where: and(eq(paperBots.id, action.toBotId), eq(paperBots.userId, userId)),
        });
        if (!fromRow || !toRow) {
          return { status: 'EXECUTION_FAILED', decisionId, reason: 'one or both paper bots not found' };
        }
        const fromCap = Number(fromRow.capitalUsdt);
        if (fromCap < action.amountUsdt) {
          return { status: 'EXECUTION_FAILED', decisionId, reason: `insufficient_capital: ${fromCap} < ${action.amountUsdt}` };
        }
        const toCap = Number(toRow.capitalUsdt);
        await params.db.transaction(async (tx) => {
          await tx.update(paperBots).set({ capitalUsdt: String(fromCap - action.amountUsdt) }).where(and(eq(paperBots.id, action.fromBotId), eq(paperBots.userId, userId))).returning();
          await tx.update(paperBots).set({ capitalUsdt: String(toCap + action.amountUsdt) }).where(and(eq(paperBots.id, action.toBotId), eq(paperBots.userId, userId))).returning();
        });
        return { status: 'EXECUTED', decisionId, paperBotId: fromRow.id };
      }

      const fromRow = await params.db.query.tradingBots.findFirst({
        where: and(eq(tradingBots.id, action.fromBotId), eq(tradingBots.userId, userId)),
      });
      const toRow = await params.db.query.tradingBots.findFirst({
        where: and(eq(tradingBots.id, action.toBotId), eq(tradingBots.userId, userId)),
      });
      if (!fromRow || !toRow) {
        return { status: 'EXECUTION_FAILED', decisionId, reason: 'one or both bots not found' };
      }
      if (fromRow.apiKeyId !== config.bingxApiKeyId || toRow.apiKeyId !== config.bingxApiKeyId) {
        return { status: 'EXECUTION_FAILED', decisionId, reason: `Bot apiKeyId mismatch — not in AI subaccount scope` };
      }
      const fromCap = Number(fromRow.positionSizeUsdt);
      if (fromCap < action.amountUsdt) {
        return { status: 'EXECUTION_FAILED', decisionId, reason: `insufficient_capital: ${fromCap} < ${action.amountUsdt}` };
      }
      const toCap = Number(toRow.positionSizeUsdt);
      await params.db.transaction(async (tx) => {
        await tx.update(tradingBots).set({ positionSizeUsdt: String(fromCap - action.amountUsdt) }).where(and(eq(tradingBots.id, action.fromBotId), eq(tradingBots.userId, userId))).returning();
        await tx.update(tradingBots).set({ positionSizeUsdt: String(toCap + action.amountUsdt) }).where(and(eq(tradingBots.id, action.toBotId), eq(tradingBots.userId, userId))).returning();
      });
      return { status: 'EXECUTED', decisionId, realBotId: fromRow.id };
    }
```

- [ ] **Step 4: Tests pass**

```bash
npx vitest run src/lib/ai-pm/__tests__/executor.test.ts
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai-pm/executor.ts src/lib/ai-pm/__tests__/executor.test.ts
git commit -m "feat(ai-pm): implement reallocate_capital executor (paper + real)"
```

---

## Task 4: Add adjust_params + reallocate_capital chat tools

**Files:**
- Modify: `src/lib/ai-pm/chat-tools.ts`
- Modify: `src/lib/ai-pm/__tests__/chat-tools.test.ts`

Two new zod schemas, two new entries in `ALL_TOOL_DEFINITIONS`, two new dispatcher cases that route through validate + execute.

- [ ] **Step 1: Append failing tests**

In `src/lib/ai-pm/__tests__/chat-tools.test.ts`, extend the existing dispatcher list assertion. Find:

```ts
it('exports ALL_TOOL_DEFINITIONS with 6 tools', () => {
  expect(ALL_TOOL_DEFINITIONS.map(t => t.name).sort()).toEqual(
    ['create_bot', 'pause_kill_switch', 'read_decisions', 'read_portfolio', 'read_signals', 'stop_bot'].sort(),
  );
});
```

Replace with:

```ts
it('exports ALL_TOOL_DEFINITIONS with 8 tools', () => {
  expect(ALL_TOOL_DEFINITIONS.map(t => t.name).sort()).toEqual(
    ['adjust_params', 'create_bot', 'pause_kill_switch', 'read_decisions', 'read_portfolio', 'read_signals', 'reallocate_capital', 'stop_bot'].sort(),
  );
});
```

Append two new test cases:

```ts
it('adjust_params dispatches through validate+execute', async () => {
  const validateFn = vi.fn().mockResolvedValue({ status: 'PROPOSED', decisionId: 'dec-adj' });
  const executeFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: 'dec-adj', realBotId: 'bot-1' });
  const ctx = makeCtx({ validateFn, executeFn });
  const got = await executeTool('adjust_params', {
    botId: '11111111-2222-4333-8444-555555555555',
    params: { capitalUsdt: 200, leverage: 3 },
    reasoning: 'tighten',
  }, ctx);
  expect(validateFn).toHaveBeenCalledOnce();
  expect(executeFn).toHaveBeenCalledOnce();
  expect(got.status).toBe('EXECUTED');
  expect(got.decisionId).toBe('dec-adj');
});

it('reallocate_capital dispatches through validate+execute', async () => {
  const validateFn = vi.fn().mockResolvedValue({ status: 'PROPOSED', decisionId: 'dec-re' });
  const executeFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: 'dec-re' });
  const ctx = makeCtx({ validateFn, executeFn });
  const got = await executeTool('reallocate_capital', {
    fromBotId: '11111111-2222-4333-8444-555555555555',
    toBotId: '22222222-2222-4333-8444-555555555555',
    amountUsdt: 50,
    reasoning: 'move',
  }, ctx);
  expect(validateFn).toHaveBeenCalledOnce();
  expect(executeFn).toHaveBeenCalledOnce();
  expect(got.status).toBe('EXECUTED');
});

it('mutating adjust/reallocate also refuse on kill switch', async () => {
  const validateFn = vi.fn();
  const ctx = makeCtx({
    validateFn,
    config: { ...makeCtx().config, killSwitch: true },
  });
  const got = await executeTool('adjust_params', {
    botId: '11111111-2222-4333-8444-555555555555',
    params: { capitalUsdt: 200 },
    reasoning: 'r',
  }, ctx);
  expect(validateFn).not.toHaveBeenCalled();
  expect(got.status).toBe('EXECUTION_FAILED');
  expect(got.summary).toMatch(/kill switch/i);
});
```

- [ ] **Step 2: Tests fail**

```bash
npx vitest run src/lib/ai-pm/__tests__/chat-tools.test.ts
```
Expected: 3 new failing.

- [ ] **Step 3: Add schemas + dispatcher cases in `src/lib/ai-pm/chat-tools.ts`**

After the existing `PauseKillSwitchArgs` schema, add:

```ts
export const AdjustParamsArgs = z.object({
  botId: z.string().uuid(),
  params: z.object({
    capitalUsdt: z.number().positive().optional(),
    leverage: z.number().int().min(1).max(20).optional(),
    strategy: z.enum(['DCA', 'TRAILING_STOP', 'DCA_SPOT', 'SMA_CROSSOVER']).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  }).refine((p) => p.capitalUsdt !== undefined || p.leverage !== undefined || p.strategy !== undefined || p.config !== undefined, {
    message: 'At least one of capitalUsdt / leverage / strategy / config must be set',
  }),
  reasoning: z.string().min(1).max(500),
});

export const ReallocateCapitalArgs = z.object({
  fromBotId: z.string().uuid(),
  toBotId: z.string().uuid(),
  amountUsdt: z.number().positive(),
  reasoning: z.string().min(1).max(500),
}).refine((v) => v.fromBotId !== v.toBotId, { message: 'fromBotId and toBotId must differ' });
```

Update `ToolName`:
```ts
export type ToolName =
  | 'read_portfolio'
  | 'read_signals'
  | 'read_decisions'
  | 'create_bot'
  | 'stop_bot'
  | 'adjust_params'
  | 'reallocate_capital'
  | 'pause_kill_switch';
```

Append to `ALL_TOOL_DEFINITIONS`:

```ts
  { name: 'adjust_params', description: 'Adjusts a running bot config (capital, leverage, strategy, or strategy-specific config). Mutating; goes through validate+execute.', schema: AdjustParamsArgs },
  { name: 'reallocate_capital', description: 'Moves capital between two running bots in the same subaccount.', schema: ReallocateCapitalArgs },
```

Update `executeTool` switch:

```ts
    case 'adjust_params': return adjustParamsTool(AdjustParamsArgs.parse(args), ctx);
    case 'reallocate_capital': return reallocateCapitalTool(ReallocateCapitalArgs.parse(args), ctx);
```

Add the two handler functions at the bottom of the file (after `pauseKillSwitchTool`):

```ts
async function adjustParamsTool(args: z.infer<typeof AdjustParamsArgs>, ctx: ToolExecContext): Promise<ToolExecResult> {
  if (ctx.config.killSwitch) return killSwitchRefusal(ctx);
  const action: ProposedAction = { type: 'adjust_params', botId: args.botId, params: args.params as Record<string, unknown>, reasoning: args.reasoning };
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
      summary: `adjust_params rejected: ${validation.reason ?? validation.status}`,
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
        ? exec.newBotId
          ? `adjust_params ${args.botId.slice(0,8)} strategy change → new bot ${exec.newBotId.slice(0,8)}`
          : `adjust_params ${args.botId.slice(0,8)} executed`
        : `adjust_params failed: ${exec.reason ?? 'unknown'}`,
      payload: exec,
    };
  } catch (err) {
    return {
      status: 'EXECUTION_FAILED',
      decisionId: validation.decisionId,
      summary: `adjust_params threw: ${err instanceof Error ? err.message : String(err)}`,
      payload: null,
    };
  }
}

async function reallocateCapitalTool(args: z.infer<typeof ReallocateCapitalArgs>, ctx: ToolExecContext): Promise<ToolExecResult> {
  if (ctx.config.killSwitch) return killSwitchRefusal(ctx);
  const action: ProposedAction = { type: 'reallocate_capital', fromBotId: args.fromBotId, toBotId: args.toBotId, amountUsdt: args.amountUsdt, reasoning: args.reasoning };
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
      summary: `reallocate_capital rejected: ${validation.reason ?? validation.status}`,
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
    });
    return {
      status: exec.status,
      decisionId: exec.decisionId,
      summary: exec.status === 'EXECUTED'
        ? `reallocate_capital $${args.amountUsdt} ${args.fromBotId.slice(0,8)} → ${args.toBotId.slice(0,8)}`
        : `reallocate_capital failed: ${exec.reason ?? 'unknown'}`,
      payload: exec,
    };
  } catch (err) {
    return {
      status: 'EXECUTION_FAILED',
      decisionId: validation.decisionId,
      summary: `reallocate_capital threw: ${err instanceof Error ? err.message : String(err)}`,
      payload: null,
    };
  }
}
```

- [ ] **Step 4: Tests pass**

```bash
npx vitest run src/lib/ai-pm/__tests__/chat-tools.test.ts
```
Expected: all green (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai-pm/chat-tools.ts src/lib/ai-pm/__tests__/chat-tools.test.ts
git commit -m "feat(ai-pm): add adjust_params + reallocate_capital chat tools"
```

---

## Task 5: Wire `bingxClient` through chat pipeline

**Files:**
- Modify: `src/lib/ai-pm/chat-pipeline.ts`
- Modify: `src/lib/ai-pm/__tests__/chat-pipeline.test.ts`
- Modify: `src/inngest/functions/ai-pm-event-handler.ts`

`runChatPipeline` accepts optional `bingxClient`; forwards into `ToolExecContext`. Event handler loads the client before the chat branch.

- [ ] **Step 1: Append failing test**

Add to `src/lib/ai-pm/__tests__/chat-pipeline.test.ts`:

```ts
it('forwards bingxClient into ToolExecContext when provided', async () => {
  const runToolLoopFn = vi.fn().mockImplementation(async ({ ctx }) => {
    expect(ctx.bingxClient).toBeTruthy();
    expect((ctx.bingxClient as { tag: string }).tag).toBe('fake-client');
    return {
      assistantText: 'ok',
      toolCallEntries: [],
      cumulativeUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, model: 'claude-sonnet-4-6' },
    };
  });

  await runChatPipeline({
    payload: { configId: CONFIG_ID, userMessage: 'x', symbol: null, chatMessageId: 'src-bx', emittedAt: new Date().toISOString() },
    aiEventId: 'evt',
    config: baseConfig,
    portfolioState: { runningBots: [], capitalUsedUsdt: 0, bingxApiKeyId: API_KEY_ID },
    db,
    loadChatHistoryFn: async () => [],
    isKillSwitchActive: async () => false,
    runToolLoopFn,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bingxClient: { tag: 'fake-client' } as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  expect(runToolLoopFn).toHaveBeenCalled();
});
```

- [ ] **Step 2: Test fails**

```bash
npx vitest run src/lib/ai-pm/__tests__/chat-pipeline.test.ts
```
Expected: TS or runtime — `bingxClient` not on params.

- [ ] **Step 3: Modify `src/lib/ai-pm/chat-pipeline.ts`**

Add to `RunChatPipelineParams`:

```ts
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bingxClient?: any;
```

Pass into `ToolExecContext`:

```ts
const ctx: ToolExecContext = {
  userId: params.config.userId,
  configId: params.config.id,
  chatMessageId: placeholder.id,
  portfolioState: params.portfolioState,
  config: params.config,
  db: params.db,
  bingxClient: params.bingxClient ?? undefined,
};
```

- [ ] **Step 4: Modify event handler `src/inngest/functions/ai-pm-event-handler.ts`**

Read the existing handler (around line 100). Find the chat branch:

```ts
if (params.eventName === 'ai-pm/event.chat') {
  const portfolioState = await loadPortfolio({...});
  const result = await runChat({
    payload: params.data as ChatPayload,
    aiEventId,
    config,
    portfolioState,
    db: params.db,
    loadChatHistoryFn: ...,
    isKillSwitchActive: ...,
    logger: params.logger,
  });
```

Replace with:

```ts
if (params.eventName === 'ai-pm/event.chat') {
  const client = await loadBingx(config.bingxApiKeyId);
  const portfolioState = await loadPortfolio({
    userId: config.userId,
    bingxApiKeyId: config.bingxApiKeyId,
    db: params.db,
  });
  const result = await runChat({
    payload: params.data as ChatPayload,
    aiEventId,
    config,
    portfolioState,
    db: params.db,
    loadChatHistoryFn: async (userId, limit) => loadChatHistory(params.db, userId, limit),
    isKillSwitchActive: async () => {
      const fresh = await loadConfig(config.id);
      return Boolean(fresh?.killSwitch);
    },
    bingxClient: client,
    logger: params.logger,
  });
  await markEvent({ db: params.db, aiEventId, status: 'PROCESSED', decisionId: result.decisionId });
  return { aiEventId, status: 'PROCESSED', decisionId: result.decisionId };
}
```

(Note: the existing chat branch already does most of this; we're only adding the `loadBingx` call earlier and passing `bingxClient: client`.)

- [ ] **Step 5: Tests pass + integration sanity**

```bash
npx vitest run src/lib/ai-pm/__tests__/chat-pipeline.test.ts
npx vitest run src/inngest/functions/__tests__/ai-pm-event-handler.test.ts 2>&1 | tail -5
```
Expected: chat-pipeline 4/4 green. Event-handler tests still green if they exist.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ai-pm/chat-pipeline.ts src/lib/ai-pm/__tests__/chat-pipeline.test.ts src/inngest/functions/ai-pm-event-handler.ts
git commit -m "feat(ai-pm): forward bingxClient into chat ToolExecContext"
```

---

## Task 6: Final integration check + PR

**Files:** none (verification + push only).

- [ ] **Step 1: Full suite**

```bash
cd /Users/xyrlan/github/bingx-robot
npx vitest run 2>&1 | tail -10
npm run build 2>&1 | tail -15
```
Expected: 0 failing tests; build clean.

- [ ] **Step 2: Open PR**

```bash
git push -u origin feat/ai-pm-chat-tools-finish
gh pr create --title "feat(ai-pm): Session 16b — complete chat agent" --body "$(cat <<'EOF'
## Summary
- Wires bingxClient through chat pipeline (event handler → runChatPipeline → ToolExecContext)
- Implements `adjust_params` executor (paper + real; strategy change = stop+recreate)
- Implements `reallocate_capital` executor (paper + real; Drizzle transaction)
- Adds the two corresponding chat tools (8 tools total)
- Extends guardrails with maxLeverage + new action-type checks

## Test plan
- [ ] vitest green
- [ ] build green
- [ ] Manual: chat asks 'reduce BTC bot capital by 50' → adjust_params executes, activity feed shows row
- [ ] Manual: chat asks 'move $50 from bot A to bot B' → reallocate_capital, both positions updated next cron tick
- [ ] Manual: chat asks 'switch BTC bot to TRAILING_STOP' → old bot STOPPED, new bot RUNNING

## Out of scope
- Strategy-change rollback if recreate fails (logged, manual retry)
- Order cancellation explicit step (relies on bot watcher next tick)
- adjust on grid-only fields (takeProfit/gridCount) — AI PM strategies don't use them

Spec: \`docs/superpowers/specs/2026-05-12-ai-pm-chat-tools-finish-design.md\`
Plan: \`docs/superpowers/plans/2026-05-12-ai-portfolio-manager-session-16b.md\`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- maxLeverage on GuardrailConfig + LEVERAGE_CAP reason — Task 1 ✓
- adjust_params + reallocate_capital guardrail checks — Task 1 ✓
- adjust_params executor paper + real + strategy change — Task 2 ✓
- reallocate_capital executor paper + real + atomicity — Task 3 ✓
- New chat tools registered + dispatched — Task 4 ✓
- Kill-switch refusal for new mutating tools — Task 4 ✓
- bingxClient on RunChatPipelineParams + handler wiring — Task 5 ✓
- All tests at executor/guardrail/chat-tool/chat-pipeline layers — Tasks 1-5 ✓

**Placeholder scan:** none — every step has concrete code. Two intentional notes flag work that Task 1 cascades into (existing test fixtures get a new field; `guardrailConfig` helper needs the new field passed through).

**Type consistency:**
- `ExecutionResult.newBotId` introduced in Task 2, used in Task 4 (`exec.newBotId`).
- `GuardrailConfig.maxLeverage` introduced in Task 1, consumed in `guardrailConfig()` helper in `chat-tools.ts` (same task).
- `AdjustParamsArgs` / `ReallocateCapitalArgs` introduced in Task 4. The `ProposedAction` shapes they map to are pre-existing in `decision.prompt.ts`.
- `RunChatPipelineParams.bingxClient` introduced in Task 5; `ToolExecContext.bingxClient` already exists from S16.

**Known gaps:**
- BingX `setLeverage` API call: Task 2 uses an injected `setLeverageFn` so executor stays unit-testable. Production wiring will need a thin wrapper (`bingx.service.ts` already exposes leverage logic inline — extracting a top-level export is fine but not strictly required since real-mode adjust path passes the function through `ExecuteParams.setLeverageFn` from the chat-tool layer; if no caller injects it, leverage on real-mode is silently skipped — acceptable v1).
