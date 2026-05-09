# AI Portfolio Manager — Session 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the six new tables (`aiPmConfigs`, `aiDecisions`, `aiSignals`, `backtestRuns`, `aiChatMessages`, `paperBots`) plus four new enums (`aiPmModeEnum`, `aiDecisionStatusEnum`, `aiActionTypeEnum`, `aiTriggerSourceEnum`) to `src/db/schema.ts`. Generate and apply the Drizzle migration. Define relations for the new tables. No service or UI code yet — schema only.

**Architecture:** All six tables hang off `users`. `aiPmConfigs` references `bingxApiKeys` (the AI-managed subaccount). `aiDecisions` references `tradingBots` (when an AI decision results in a real bot creation). `aiChatMessages` references `aiDecisions` (link a chat exchange back to the decision it explains). `paperBots` references `aiDecisions` (link a simulated bot back to the decision that proposed it). Enum types capture finite domain values for AI mode, decision status, action type, and trigger source.

**Tech Stack:** Drizzle ORM · PostgreSQL · drizzle-kit · Vitest · Bun

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/db/schema.ts` | Modify | Append four enums, six tables, and matching relation declarations |
| `drizzle/0010_<random>.sql` | Create (generated) | Drizzle migration for the AI tables + enums |
| `drizzle/meta/0010_snapshot.json` | Create (generated) | Drizzle snapshot |
| `drizzle/meta/_journal.json` | Modify (generated) | Drizzle journal entry |
| `src/db/__tests__/ai-schema.test.ts` | Create | Vitest integration test exercising insert/select on each new table |

The schema test mirrors the spec's data model and acts as a smoke check for the migration. It also catches FK or constraint mistakes during the migration design.

---

## Task 1: Append enums to `src/db/schema.ts`

**Files:**
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Locate enum block**

Open `src/db/schema.ts`. Find the existing `pgEnum` block (around line 21-32). The current block defines `userRoleEnum`, `botStatusEnum`, `botTypeEnum`. We append four more enums in the same section so all enum types live together.

- [ ] **Step 2: Append the new enums**

After the existing `botTypeEnum` declaration, add:

```ts
export const aiPmModeEnum = pgEnum('ai_pm_mode', [
  'CONSERVATIVE',
  'BALANCED',
  'AGGRESSIVE',
  'CUSTOM',
]);

export const aiDecisionStatusEnum = pgEnum('ai_decision_status', [
  'PROPOSED',
  'REJECTED_GUARDRAIL',
  'REJECTED_BACKTEST',
  'REJECTED_REVIEWER',
  'EXECUTED',
  'EXECUTION_FAILED',
]);

export const aiActionTypeEnum = pgEnum('ai_action_type', [
  'CREATE_BOT',
  'STOP_BOT',
  'ADJUST_PARAMS',
  'REALLOCATE_CAPITAL',
  'NO_ACTION',
]);

export const aiTriggerSourceEnum = pgEnum('ai_trigger_source', [
  'CRON_TICK',
  'EVENT_DRAWDOWN',
  'EVENT_FUNDING_FLIP',
  'EVENT_FILL',
  'EVENT_ERROR',
  'CHAT',
]);
```

- [ ] **Step 3: Lint**

Run: `bunx eslint src/db/schema.ts`

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts
git commit -m "feat(schema): add AI Portfolio Manager enums"
```

---

## Task 2: Append six tables to `src/db/schema.ts`

**Files:**
- Modify: `src/db/schema.ts`

The order matters because of FK references. Insert in this order: `aiPmConfigs` → `aiDecisions` → `paperBots` → `aiSignals` → `backtestRuns` → `aiChatMessages`. Each table appended after the existing `botTrades` declaration (the last table block).

- [ ] **Step 1: Append `aiPmConfigs`**

After the existing `botTrades` table block, add:

```ts
// ==========================================
// 6. AI PORTFOLIO MANAGER
// ==========================================

/**
 * Per-user AI portfolio manager configuration.
 * One row per user. Points to a dedicated AI-managed BingX subaccount key.
 * Stores guardrails, profile, kill switch, and BYOK Anthropic API key.
 */
export const aiPmConfigs = pgTable('ai_pm_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  bingxApiKeyId: uuid('bingx_api_key_id')
    .notNull()
    .references(() => bingxApiKeys.id, { onDelete: 'cascade' }),
  anthropicApiKeyEncrypted: text('anthropic_api_key_encrypted').notNull(),
  enabled: boolean('enabled').default(false).notNull(),
  mode: aiPmModeEnum('mode').default('BALANCED').notNull(),
  maxCapitalUsdt: decimal('max_capital_usdt', { precision: 20, scale: 8 }),
  maxDrawdownPct: decimal('max_drawdown_pct', { precision: 5, scale: 2 }),
  maxLeverage: integer('max_leverage'),
  allowedSymbols: jsonb('allowed_symbols').$type<string[]>(),
  allowedStrategies: jsonb('allowed_strategies').$type<string[]>(),
  maxConcurrentBots: integer('max_concurrent_bots').default(5),
  monthlyLlmBudgetUsd: decimal('monthly_llm_budget_usd', { precision: 10, scale: 2 }),
  killSwitch: boolean('kill_switch').default(false).notNull(),
  paperMode: boolean('paper_mode').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('ai_pm_configs_user_idx').on(table.userId),
  uniqueIndex('ai_pm_configs_apikey_idx').on(table.bingxApiKeyId),
]);
```

- [ ] **Step 2: Append `aiDecisions`**

```ts
/**
 * Audit log of every AI decision proposed, rejected, or executed.
 * Insert-only; updates restricted to defined status transitions enforced at the service layer.
 */
export const aiDecisions = pgTable('ai_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  triggeredBy: aiTriggerSourceEnum('triggered_by').notNull(),
  triggerDetail: text('trigger_detail'),
  actionType: aiActionTypeEnum('action_type').notNull(),
  status: aiDecisionStatusEnum('status').notNull(),
  symbol: text('symbol'),
  strategy: botTypeEnum('strategy'),
  params: jsonb('params'),
  reasoning: text('reasoning'),
  signalSnapshot: jsonb('signal_snapshot'),
  backtestRunId: uuid('backtest_run_id'),
  rejectionReason: text('rejection_reason'),
  modelUsed: text('model_used'),
  tokensInput: integer('tokens_input'),
  tokensOutput: integer('tokens_output'),
  costUsd: decimal('cost_usd', { precision: 10, scale: 6 }),
  resultBotId: uuid('result_bot_id').references(() => tradingBots.id, { onDelete: 'set null' }),
  executedAt: timestamp('executed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('ai_decisions_user_created_idx').on(table.userId, table.createdAt),
  index('ai_decisions_status_idx').on(table.status),
]);
```

`backtestRunId` is a plain `uuid` (no FK) here because the migration creates `aiDecisions` before `backtestRuns`. The FK constraint is added in a follow-up step in Task 4 once `backtestRuns` exists. (Drizzle generates a single migration so order matters at table-creation level — references resolve at the SQL level after both tables exist.)

Actually Drizzle handles forward references fine at the SQL generation level: it emits `CREATE TABLE` statements in the order needed, and the FK constraint goes in either inline (if target exists) or as a deferred `ALTER TABLE` later in the same file. So we **can** declare `backtestRunId` with `.references(() => backtestRuns.id, { onDelete: 'set null' })` directly. **Do that** — let Drizzle resolve the order.

Replace the `backtestRunId` line in `aiDecisions` with the proper reference:

```ts
  backtestRunId: uuid('backtest_run_id').references(() => backtestRuns.id, { onDelete: 'set null' }),
```

This keeps the FK explicit and lets Drizzle handle migration ordering.

- [ ] **Step 3: Append `paperBots`**

```ts
/**
 * Simulated bots used when aiPmConfigs.paperMode = true.
 * Executor writes here instead of creating real BingX bots.
 * Trades are simulated by feeding live OHLCV through the same pure-core simulators that backtest uses.
 */
export const paperBots = pgTable('paper_bots', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  decisionId: uuid('decision_id').references(() => aiDecisions.id, { onDelete: 'set null' }),
  symbol: text('symbol').notNull(),
  strategy: botTypeEnum('strategy').notNull(),
  params: jsonb('params').notNull(),
  capitalUsdt: decimal('capital_usdt', { precision: 20, scale: 8 }).notNull(),
  status: botStatusEnum('status').notNull().default('STOPPED'),
  pnlUsdt: decimal('pnl_usdt', { precision: 20, scale: 8 }).default('0'),
  trades: jsonb('trades').$type<unknown[]>(),
  startedAt: timestamp('started_at'),
  stoppedAt: timestamp('stopped_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('paper_bots_user_status_idx').on(table.userId, table.status),
]);
```

- [ ] **Step 4: Append `aiSignals`**

```ts
/**
 * Signal layer output cache. One row per (user, symbol, tick).
 * Used by analyst dashboard watchlist and by Decision layer to read recent context.
 */
export const aiSignals = pgTable('ai_signals', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  symbol: text('symbol').notNull(),
  regime: text('regime').notNull(),
  score: integer('score').notNull(),
  reason: text('reason'),
  indicatorsSnapshot: jsonb('indicators_snapshot'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('ai_signals_user_symbol_idx').on(table.userId, table.symbol, table.createdAt),
]);
```

- [ ] **Step 5: Append `backtestRuns`**

```ts
/**
 * Cached backtest results, deduplicated by (symbol, strategy, paramsHash, windowDays).
 * Same input always returns the same row — backtest is deterministic.
 */
export const backtestRuns = pgTable('backtest_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  symbol: text('symbol').notNull(),
  strategy: botTypeEnum('strategy').notNull(),
  paramsHash: text('params_hash').notNull(),
  params: jsonb('params').notNull(),
  windowDays: integer('window_days').notNull(),
  pnlPct: decimal('pnl_pct', { precision: 10, scale: 4 }),
  maxDrawdownPct: decimal('max_drawdown_pct', { precision: 10, scale: 4 }),
  sharpeApprox: decimal('sharpe_approx', { precision: 10, scale: 4 }),
  winRatePct: decimal('win_rate_pct', { precision: 5, scale: 2 }),
  totalTrades: integer('total_trades'),
  metricsJson: jsonb('metrics_json'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('backtest_runs_dedup_idx').on(table.symbol, table.strategy, table.paramsHash, table.windowDays),
]);
```

- [ ] **Step 6: Append `aiChatMessages`**

```ts
/**
 * Persistent chat history for the AI Portfolio Manager conversational UI.
 * decisionId optionally links a tool-call message to the decision it produced.
 */
export const aiChatMessages = pgTable('ai_chat_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  content: text('content'),
  toolCalls: jsonb('tool_calls'),
  decisionId: uuid('decision_id').references(() => aiDecisions.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('ai_chat_user_created_idx').on(table.userId, table.createdAt),
]);
```

- [ ] **Step 7: Lint**

Run: `bunx eslint src/db/schema.ts`

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts
git commit -m "feat(schema): add AI Portfolio Manager tables"
```

---

## Task 3: Append relations for new tables

**Files:**
- Modify: `src/db/schema.ts`

The existing schema declares relations for `users`, `profiles`, `bingxApiKeys`, `tradingBots`, `gridLevels`, `botTrades`. New tables get matching relations so Drizzle's typed-query API works.

- [ ] **Step 1: Append relations**

After the existing relations block (likely ending with `botTradesRelations`), add:

```ts
export const aiPmConfigsRelations = relations(aiPmConfigs, ({ one }) => ({
  user: one(users, {
    fields: [aiPmConfigs.userId],
    references: [users.id],
  }),
  bingxApiKey: one(bingxApiKeys, {
    fields: [aiPmConfigs.bingxApiKeyId],
    references: [bingxApiKeys.id],
  }),
}));

export const aiDecisionsRelations = relations(aiDecisions, ({ one, many }) => ({
  user: one(users, {
    fields: [aiDecisions.userId],
    references: [users.id],
  }),
  resultBot: one(tradingBots, {
    fields: [aiDecisions.resultBotId],
    references: [tradingBots.id],
  }),
  backtestRun: one(backtestRuns, {
    fields: [aiDecisions.backtestRunId],
    references: [backtestRuns.id],
  }),
  chatMessages: many(aiChatMessages),
  paperBots: many(paperBots),
}));

export const paperBotsRelations = relations(paperBots, ({ one }) => ({
  user: one(users, {
    fields: [paperBots.userId],
    references: [users.id],
  }),
  decision: one(aiDecisions, {
    fields: [paperBots.decisionId],
    references: [aiDecisions.id],
  }),
}));

export const aiSignalsRelations = relations(aiSignals, ({ one }) => ({
  user: one(users, {
    fields: [aiSignals.userId],
    references: [users.id],
  }),
}));

export const backtestRunsRelations = relations(backtestRuns, ({ many }) => ({
  decisions: many(aiDecisions),
}));

export const aiChatMessagesRelations = relations(aiChatMessages, ({ one }) => ({
  user: one(users, {
    fields: [aiChatMessages.userId],
    references: [users.id],
  }),
  decision: one(aiDecisions, {
    fields: [aiChatMessages.decisionId],
    references: [aiDecisions.id],
  }),
}));
```

- [ ] **Step 2: Lint**

Run: `bunx eslint src/db/schema.ts`

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/db/schema.ts
git commit -m "feat(schema): add Drizzle relations for AI Portfolio Manager tables"
```

---

## Task 4: Generate the migration

**Files:**
- Create: `drizzle/0010_<adjective>_<noun>.sql` (Drizzle picks the suffix)
- Create: `drizzle/meta/0010_snapshot.json`
- Modify: `drizzle/meta/_journal.json`

- [ ] **Step 1: Generate**

Run: `bun run db:generate`

Expected: a new `drizzle/0010_*.sql` file is created. The generator should output statements approximately in this order:
1. `CREATE TYPE "ai_pm_mode" AS ENUM (...)`
2. `CREATE TYPE "ai_decision_status" AS ENUM (...)`
3. `CREATE TYPE "ai_action_type" AS ENUM (...)`
4. `CREATE TYPE "ai_trigger_source" AS ENUM (...)`
5. `CREATE TABLE "ai_pm_configs" (...)`
6. `CREATE TABLE "ai_decisions" (...)` (with FKs to users + bingx_api_keys + trading_bots; backtestRunId FK pending)
7. `CREATE TABLE "paper_bots" (...)`
8. `CREATE TABLE "ai_signals" (...)`
9. `CREATE TABLE "backtest_runs" (...)`
10. `CREATE TABLE "ai_chat_messages" (...)`
11. Followed by `ALTER TABLE` statements for any forward-reference FKs and `CREATE INDEX` statements

- [ ] **Step 2: Inspect the generated SQL**

Read `drizzle/0010_*.sql`. Verify:
- All four `CREATE TYPE` enums match the enum value lists from Task 1
- All six `CREATE TABLE` statements exist
- FK constraints reference `users(id)`, `bingx_api_keys(id)`, `trading_bots(id)`, `ai_decisions(id)`, `backtest_runs(id)` correctly
- `ON DELETE CASCADE` on user-FK rows (cleanup on user delete)
- `ON DELETE SET NULL` on `aiDecisions.resultBotId`, `aiDecisions.backtestRunId`, `paperBots.decisionId`, `aiChatMessages.decisionId`
- All listed indexes are created (`ai_pm_configs_user_idx` UNIQUE, `ai_pm_configs_apikey_idx` UNIQUE, `ai_decisions_user_created_idx`, `ai_decisions_status_idx`, `paper_bots_user_status_idx`, `ai_signals_user_symbol_idx`, `backtest_runs_dedup_idx` UNIQUE, `ai_chat_user_created_idx`)
- No unintended changes to existing tables

If anything is off, STOP and report DONE_WITH_CONCERNS — do NOT apply.

- [ ] **Step 3: Commit the generated migration files**

```bash
git add drizzle/0010_*.sql drizzle/meta/0010_snapshot.json drizzle/meta/_journal.json
git commit -m "feat(schema): generate migration 0010 for AI Portfolio Manager"
```

---

## Task 5: Apply the migration

**Files:** none modified.

- [ ] **Step 1: Apply**

Run: `bun run db:migrate`

Expected: `[✓] Applied migration 0010_<name>`. Drizzle reads `.env.local` (configured in Session 0), pointing at the dev Supabase DB.

If migration fails, do NOT roll back manually. Report BLOCKED with the exact error.

- [ ] **Step 2: Verify enums**

Run:

```bash
bun -e "
import { config } from 'dotenv';
config({ path: '.env.local' });
import postgres from 'postgres';
const sql = postgres(process.env.DIRECT_URL);
const r = await sql\`SELECT typname FROM pg_type WHERE typname IN ('ai_pm_mode','ai_decision_status','ai_action_type','ai_trigger_source') ORDER BY typname\`;
console.log(r);
await sql.end();
"
```

Expected: 4 rows, one per enum.

- [ ] **Step 3: Verify tables**

```bash
bun -e "
import { config } from 'dotenv';
config({ path: '.env.local' });
import postgres from 'postgres';
const sql = postgres(process.env.DIRECT_URL);
const r = await sql\`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('ai_pm_configs','ai_decisions','ai_signals','backtest_runs','ai_chat_messages','paper_bots') ORDER BY table_name\`;
console.log(r);
await sql.end();
"
```

Expected: 6 rows, one per table.

- [ ] **Step 4: Verify foreign-key constraints**

```bash
bun -e "
import { config } from 'dotenv';
config({ path: '.env.local' });
import postgres from 'postgres';
const sql = postgres(process.env.DIRECT_URL);
const r = await sql\`
  SELECT tc.table_name, tc.constraint_name, ccu.table_name AS references_table
  FROM information_schema.table_constraints tc
  JOIN information_schema.constraint_column_usage ccu
    ON tc.constraint_name = ccu.constraint_name
  WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_name IN ('ai_pm_configs','ai_decisions','ai_signals','backtest_runs','ai_chat_messages','paper_bots')
  ORDER BY tc.table_name, tc.constraint_name
\`;
console.log(r);
await sql.end();
"
```

Expected: rows for each FK including `ai_pm_configs → users`, `ai_pm_configs → bingx_api_keys`, `ai_decisions → users`, `ai_decisions → trading_bots`, `ai_decisions → backtest_runs`, `paper_bots → users`, `paper_bots → ai_decisions`, `ai_signals → users`, `ai_chat_messages → users`, `ai_chat_messages → ai_decisions`.

If any expected FK is missing, STOP and report DONE_WITH_CONCERNS.

- [ ] **Step 5: No commit needed for verification**

Verification passing means the migration was correctly designed AND applied. Move on.

---

## Task 6: Schema integration test

**Files:**
- Create: `src/db/__tests__/ai-schema.test.ts`

A small smoke test that inserts and selects from each new table to catch schema bugs early. Future sessions add real service tests; this one just verifies the structure is usable.

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/db';
import {
  users, bingxApiKeys, aiPmConfigs, aiDecisions, paperBots,
  aiSignals, backtestRuns, aiChatMessages,
} from '@/db/schema';
import { eq } from 'drizzle-orm';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000010';

async function ensureTestUser() {
  await db.insert(users).values({
    id: TEST_USER_ID,
    email: 'session1-test@example.com',
  }).onConflictDoNothing();
}

async function cleanup() {
  await db.delete(aiChatMessages).where(eq(aiChatMessages.userId, TEST_USER_ID));
  await db.delete(paperBots).where(eq(paperBots.userId, TEST_USER_ID));
  await db.delete(aiDecisions).where(eq(aiDecisions.userId, TEST_USER_ID));
  await db.delete(aiSignals).where(eq(aiSignals.userId, TEST_USER_ID));
  await db.delete(aiPmConfigs).where(eq(aiPmConfigs.userId, TEST_USER_ID));
  await db.delete(bingxApiKeys).where(eq(bingxApiKeys.userId, TEST_USER_ID));
}

describe('AI Portfolio Manager schema', () => {
  beforeAll(async () => {
    await ensureTestUser();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  it('inserts an aiPmConfigs row and reads it back', async () => {
    const [key] = await db.insert(bingxApiKeys).values({
      userId: TEST_USER_ID,
      label: 'AI subaccount',
      apiKey: 'k', secretKeyEncrypted: 'k',
      managedByAi: true,
    }).returning();

    const [cfg] = await db.insert(aiPmConfigs).values({
      userId: TEST_USER_ID,
      bingxApiKeyId: key.id,
      anthropicApiKeyEncrypted: 'enc',
      mode: 'BALANCED',
      maxCapitalUsdt: '500',
      maxDrawdownPct: '5.00',
      maxLeverage: 5,
      allowedSymbols: ['BTC-USDT', 'ETH-USDT'],
      allowedStrategies: ['DCA', 'TRAILING_STOP'],
    }).returning();

    expect(cfg.userId).toBe(TEST_USER_ID);
    expect(cfg.mode).toBe('BALANCED');
    expect(cfg.allowedSymbols).toEqual(['BTC-USDT', 'ETH-USDT']);
    expect(cfg.enabled).toBe(false);
    expect(cfg.killSwitch).toBe(false);
    expect(cfg.paperMode).toBe(false);
  });

  it('inserts an aiDecisions row with all enum values', async () => {
    const [d] = await db.insert(aiDecisions).values({
      userId: TEST_USER_ID,
      triggeredBy: 'CRON_TICK',
      actionType: 'NO_ACTION',
      status: 'PROPOSED',
    }).returning();

    expect(d.triggeredBy).toBe('CRON_TICK');
    expect(d.actionType).toBe('NO_ACTION');
    expect(d.status).toBe('PROPOSED');
  });

  it('inserts an aiSignals row', async () => {
    const [s] = await db.insert(aiSignals).values({
      userId: TEST_USER_ID,
      symbol: 'BTC-USDT',
      regime: 'range',
      score: 75,
      reason: 'RSI 48, ATR low',
      indicatorsSnapshot: { rsi: 48, atr: 120.5 },
    }).returning();

    expect(s.symbol).toBe('BTC-USDT');
    expect(s.score).toBe(75);
  });

  it('inserts a backtestRuns row and enforces dedup uniqueness', async () => {
    const [b] = await db.insert(backtestRuns).values({
      symbol: 'BTC-USDT',
      strategy: 'DCA',
      paramsHash: 'hash-test-1',
      params: { totalOrders: 5 },
      windowDays: 30,
      pnlPct: '2.30',
      maxDrawdownPct: '1.10',
    }).returning();

    expect(b.strategy).toBe('DCA');

    // Inserting the same (symbol, strategy, paramsHash, windowDays) must fail
    await expect(
      db.insert(backtestRuns).values({
        symbol: 'BTC-USDT',
        strategy: 'DCA',
        paramsHash: 'hash-test-1',
        params: { totalOrders: 5 },
        windowDays: 30,
      })
    ).rejects.toThrow();

    await db.delete(backtestRuns).where(eq(backtestRuns.id, b.id));
  });

  it('inserts a paperBots row tied to a decision', async () => {
    const [d] = await db.insert(aiDecisions).values({
      userId: TEST_USER_ID,
      triggeredBy: 'CRON_TICK',
      actionType: 'CREATE_BOT',
      status: 'EXECUTED',
      strategy: 'DCA',
      symbol: 'BTC-USDT',
    }).returning();

    const [pb] = await db.insert(paperBots).values({
      userId: TEST_USER_ID,
      decisionId: d.id,
      symbol: 'BTC-USDT',
      strategy: 'DCA',
      params: { totalOrders: 5 },
      capitalUsdt: '100',
    }).returning();

    expect(pb.decisionId).toBe(d.id);
    expect(pb.status).toBe('STOPPED');
  });

  it('inserts an aiChatMessages row tied to a decision', async () => {
    const [d] = await db.insert(aiDecisions).values({
      userId: TEST_USER_ID,
      triggeredBy: 'CHAT',
      actionType: 'NO_ACTION',
      status: 'PROPOSED',
    }).returning();

    const [m] = await db.insert(aiChatMessages).values({
      userId: TEST_USER_ID,
      decisionId: d.id,
      role: 'assistant',
      content: 'Let me explain why I did that.',
    }).returning();

    expect(m.decisionId).toBe(d.id);
    expect(m.role).toBe('assistant');
  });
});
```

- [ ] **Step 2: Run**

Run: `bun run test src/db/__tests__/ai-schema.test.ts`

Expected: 6 tests pass.

- [ ] **Step 3: Run full suite**

Run: `bun run test`

Expected: 51 tests pass (45 existing + 6 new). No regressions.

- [ ] **Step 4: Lint**

Run: `bunx eslint src/db/__tests__/ai-schema.test.ts`

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/db/__tests__/ai-schema.test.ts
git commit -m "test(schema): integration coverage for AI Portfolio Manager tables"
```

---

## Self-Review

- **Spec coverage:** Session 1 in the spec lists migrations for the 5 core tables plus `paper_bots`, plus four enums plus relations. All covered by Tasks 1–6.
- **Placeholder scan:** All steps include actual code or commands. No "TBD" / "implement later".
- **Type consistency:** Enum names in Task 1 match references in Task 2 (`aiPmModeEnum`, `aiDecisionStatusEnum`, `aiActionTypeEnum`, `aiTriggerSourceEnum`). Table names in Task 2 match references in Task 3 (relations) and Task 6 (tests).
- **FK direction:** All references use `() =>` arrow form — Drizzle resolves forward references at SQL generation time.
- **No missed indexes:** Each table's index list matches the spec's schema declarations word-for-word.

## Done Criteria for Session 1

1. `src/db/schema.ts` contains 4 new enums + 6 new tables + 6 new relations declarations.
2. `drizzle/0010_*.sql` exists; SQL inspected and contains exactly the expected `CREATE TYPE`, `CREATE TABLE`, `ALTER TABLE`, `CREATE INDEX` statements.
3. `bun run db:migrate` applied the migration cleanly to dev DB.
4. Verification queries confirm all 4 enums + 6 tables + all FKs exist.
5. `bun run test` passes (51+ tests, including the 6 new ai-schema tests).
6. `bunx eslint` clean on `src/db/schema.ts` and the new test file.
