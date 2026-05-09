# AI Portfolio Manager — Session 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the foundation for the AI Portfolio Manager. Add `@anthropic-ai/sdk`. Add `managed_by_ai` flag to `bingx_api_keys`. Re-enable the four non-grid Inngest crons but scope each to bots whose API key has `managed_by_ai = true`. Manual users keep current behavior; AI-managed subaccounts get the strategies back.

**Architecture:** Add a single boolean column at the API-key level (`bingx_api_keys.managed_by_ai`). Add one new service helper (`getRunningAiBots`) that returns running bots whose API key carries that flag, scoped to the bot type. Each cron now calls the helper instead of filtering in memory. The four cron functions are re-registered in `src/app/api/inngest/route.ts` and `src/worker.ts`. No AI logic in this session — purely plumbing so later sessions can build on a sane base.

**Tech Stack:** TypeScript · Drizzle ORM · PostgreSQL · Inngest · Vitest · Bun

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `package.json` / `bun.lock` | Modify | Adds the `@anthropic-ai/sdk` dependency |
| `src/db/schema.ts` | Modify | Adds `managedByAi` boolean to `bingxApiKeys` |
| `drizzle/0009_<random>.sql` | Create (generated) | Drizzle migration adding the new column |
| `src/services/bingx.service.ts` | Modify | Adds `getRunningAiBots(botType)` helper |
| `src/services/bots/__tests__/get-running-ai-bots.test.ts` | Create | Vitest coverage for the helper |
| `src/inngest/functions/dca-bot-watch.ts` | Modify | Uses `getRunningAiBots('DCA')` |
| `src/inngest/functions/dca-spot-bot-watch.ts` | Modify | Uses `getRunningAiBots('DCA_SPOT')` |
| `src/inngest/functions/trailing-stop-watch.ts` | Modify | Uses `getRunningAiBots('TRAILING_STOP')` |
| `src/inngest/functions/sma-crossover-watch.ts` | Modify | Uses `getRunningAiBots('SMA_CROSSOVER')` |
| `src/app/api/inngest/route.ts` | Modify | Re-imports and re-registers the four functions |
| `src/worker.ts` | Modify | Same re-registration on the Inngest worker |

---

## Task 1: Install `@anthropic-ai/sdk`

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`

- [ ] **Step 1: Install the package**

Run: `bun add @anthropic-ai/sdk`

Expected output: package added; `bun.lock` updated.

- [ ] **Step 2: Verify the dependency resolves**

Run: `bun -e 'import("@anthropic-ai/sdk").then(m => console.log(typeof m.default))'`

Expected output: `function`

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: add @anthropic-ai/sdk dependency for AI Portfolio Manager"
```

---

## Task 2: Add `managedByAi` column to `bingxApiKeys`

**Files:**
- Modify: `src/db/schema.ts` (the `bingxApiKeys` table definition)

- [ ] **Step 1: Edit the schema**

Open `src/db/schema.ts`. Find the `bingxApiKeys` declaration. Replace it with:

```ts
export const bingxApiKeys = pgTable('bingx_api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  label: text('label').notNull().default('Main'),
  apiKey: text('api_key').notNull(),
  secretKeyEncrypted: text('secret_key_encrypted').notNull(),
  managedByAi: boolean('managed_by_ai').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('bingx_api_keys_user_id_idx').on(table.userId),
  index('bingx_api_keys_managed_by_ai_idx').on(table.managedByAi),
]);
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`

Expected output: a new file under `drizzle/` named `0009_<adjective>_<noun>.sql` containing `ALTER TABLE "bingx_api_keys" ADD COLUMN "managed_by_ai" boolean NOT NULL DEFAULT false;` plus a `CREATE INDEX` for the new index.

- [ ] **Step 3: Inspect the generated SQL**

Read the newly created `drizzle/0009_*.sql`. Confirm it only contains:
- `ALTER TABLE "bingx_api_keys" ADD COLUMN "managed_by_ai" boolean DEFAULT false NOT NULL;`
- `CREATE INDEX "bingx_api_keys_managed_by_ai_idx" ON "bingx_api_keys" USING btree ("managed_by_ai");`

If anything else is in the file, stop and ask before proceeding — that means the schema diff captured unintended changes.

- [ ] **Step 4: Apply the migration**

Run: `npm run db:migrate`

Expected output: `[✓] Applied migration 0009_<name>`.

- [ ] **Step 5: Verify the column exists**

Run:
```bash
psql "$DIRECT_URL" -c "\d bingx_api_keys" | grep managed_by_ai
```

Expected output (one line): `managed_by_ai | boolean | not null default false`

If `psql` is not available locally, run instead:
```bash
bun -e "import('./src/db').then(async ({ db }) => { const r = await db.execute('SELECT column_name, data_type, column_default FROM information_schema.columns WHERE table_name = \\'bingx_api_keys\\' AND column_name = \\'managed_by_ai\\''); console.log(r.rows); })"
```

Expected output: one row with `column_name: 'managed_by_ai'`, `data_type: 'boolean'`, `column_default: 'false'`.

- [ ] **Step 6: Lint + type-check**

Run: `npm run lint`

Expected output: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts drizzle/0009_*.sql drizzle/meta
git commit -m "feat(schema): add managed_by_ai flag to bingx_api_keys"
```

---

## Task 3: Add `getRunningAiBots` helper

This helper returns running bots whose API key has `managed_by_ai = true`, optionally filtered by `botType`. Used by all four scoped crons.

**Files:**
- Create: `src/services/bots/__tests__/get-running-ai-bots.test.ts`
- Modify: `src/services/bingx.service.ts`

- [ ] **Step 1: Write the failing test**

Create `src/services/bots/__tests__/get-running-ai-bots.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { db } from '@/db';
import { bingxApiKeys, tradingBots, users } from '@/db/schema';
import { getRunningAiBots } from '@/services/bingx.service';
import { eq } from 'drizzle-orm';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';

async function ensureTestUser() {
  await db.insert(users).values({
    id: TEST_USER_ID,
    email: 'session0-test@example.com',
  }).onConflictDoNothing();
}

async function createKey(label: string, managedByAi: boolean) {
  const [row] = await db.insert(bingxApiKeys).values({
    userId: TEST_USER_ID,
    label,
    apiKey: 'test',
    secretKeyEncrypted: 'test',
    managedByAi,
  }).returning();
  return row;
}

async function createBot(apiKeyId: string, botType: 'DCA' | 'TRAILING_STOP', status: 'RUNNING' | 'STOPPED' = 'RUNNING') {
  const [row] = await db.insert(tradingBots).values({
    userId: TEST_USER_ID,
    apiKeyId,
    symbol: 'BTC-USDT',
    botType,
    priceMin: '50000',
    priceMax: '60000',
    positionSizeUsdt: '10',
    takeProfitPercentage: '1',
    gridCount: 1,
    leverage: 1,
    status,
  }).returning();
  return row;
}

describe('getRunningAiBots', () => {
  beforeAll(async () => {
    await ensureTestUser();
  });

  afterEach(async () => {
    await db.delete(tradingBots).where(eq(tradingBots.userId, TEST_USER_ID));
    await db.delete(bingxApiKeys).where(eq(bingxApiKeys.userId, TEST_USER_ID));
  });

  it('returns only bots whose API key has managed_by_ai = true', async () => {
    const aiKey = await createKey('AI', true);
    const manualKey = await createKey('Manual', false);
    const aiBot = await createBot(aiKey.id, 'DCA');
    await createBot(manualKey.id, 'DCA');

    const result = await getRunningAiBots();

    const ids = result.map(b => b.id);
    expect(ids).toContain(aiBot.id);
    expect(result.every(b => b.apiKeyId === aiKey.id)).toBe(true);
  });

  it('filters by botType when provided', async () => {
    const aiKey = await createKey('AI', true);
    const dcaBot = await createBot(aiKey.id, 'DCA');
    await createBot(aiKey.id, 'TRAILING_STOP');

    const result = await getRunningAiBots('DCA');

    expect(result.length).toBe(1);
    expect(result[0].id).toBe(dcaBot.id);
  });

  it('skips bots that are STOPPED', async () => {
    const aiKey = await createKey('AI', true);
    await createBot(aiKey.id, 'DCA', 'STOPPED');

    const result = await getRunningAiBots('DCA');

    expect(result).toEqual([]);
  });

  it('skips bots whose apiKeyId is null', async () => {
    await db.insert(tradingBots).values({
      userId: TEST_USER_ID,
      apiKeyId: null,
      symbol: 'BTC-USDT',
      botType: 'DCA',
      priceMin: '50000',
      priceMax: '60000',
      positionSizeUsdt: '10',
      takeProfitPercentage: '1',
      gridCount: 1,
      leverage: 1,
      status: 'RUNNING',
    });

    const result = await getRunningAiBots('DCA');

    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/services/bots/__tests__/get-running-ai-bots.test.ts`

Expected: at least one failure with message mentioning that `getRunningAiBots` is not exported (or undefined).

- [ ] **Step 3: Implement the helper**

Open `src/services/bingx.service.ts`. Just below the existing `getRunningBots` function (the one that ends at line ~160), insert:

```ts
export async function getRunningAiBots(botType?: TradingBot['botType']): Promise<TradingBot[]> {
  const rows = await db
    .select({ bot: tradingBots })
    .from(tradingBots)
    .innerJoin(bingxApiKeys, eq(tradingBots.apiKeyId, bingxApiKeys.id))
    .where(
      and(
        eq(tradingBots.status, 'RUNNING'),
        eq(bingxApiKeys.managedByAi, true),
        botType ? eq(tradingBots.botType, botType) : undefined,
      ),
    );
  return rows.map(r => r.bot);
}
```

If `bingxApiKeys` or `and` is not yet imported in this file, also add them. Confirm the existing imports at the top of the file include both:

```ts
import { eq, and, desc, isNull, sql } from 'drizzle-orm';
import { bingxApiKeys, tradingBots, gridLevels, botTrades } from '@/db/schema';
```

If either is missing, add it. Both should already be present.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- src/services/bots/__tests__/get-running-ai-bots.test.ts`

Expected: 4 tests passing.

- [ ] **Step 5: Run the full test suite**

Run: `npm run test`

Expected: previously-green tests still green, no new failures.

- [ ] **Step 6: Lint**

Run: `npm run lint`

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/services/bingx.service.ts src/services/bots/__tests__/get-running-ai-bots.test.ts
git commit -m "feat(bingx): add getRunningAiBots helper scoped to managed_by_ai keys"
```

---

## Task 4: Scope `dca-bot-watch` to AI-managed keys

**Files:**
- Modify: `src/inngest/functions/dca-bot-watch.ts`

- [ ] **Step 1: Replace the bot fetch step**

In `src/inngest/functions/dca-bot-watch.ts`, replace lines 26–29:

```ts
    const bots = await step.run('fetch-dca-bots', async () => {
      const allRunning = await getRunningBots();
      return allRunning.filter((b) => b.botType === 'DCA');
    });
```

with:

```ts
    const bots = await step.run('fetch-dca-bots', async () => {
      return getRunningAiBots('DCA');
    });
```

- [ ] **Step 2: Update the import**

In `src/inngest/functions/dca-bot-watch.ts`, change the import line (currently around line 3):

```ts
import {
  getRunningBots,
  getBotById,
  setBotStatus,
  getContractInfo,
  getCurrentPrice,
  recordTrade,
} from '@/services/bingx.service';
```

to:

```ts
import {
  getRunningAiBots,
  getBotById,
  setBotStatus,
  getContractInfo,
  getCurrentPrice,
  recordTrade,
} from '@/services/bingx.service';
```

- [ ] **Step 3: Lint + type-check**

Run: `npm run lint`

Expected: no errors. If TypeScript flags `getRunningBots` not used elsewhere in the file, that import was correctly removed.

- [ ] **Step 4: Commit**

```bash
git add src/inngest/functions/dca-bot-watch.ts
git commit -m "feat(inngest): scope dca-bot-watch to AI-managed bots"
```

---

## Task 5: Scope `dca-spot-bot-watch` to AI-managed keys

**Files:**
- Modify: `src/inngest/functions/dca-spot-bot-watch.ts`

- [ ] **Step 1: Replace the bot fetch step**

In `src/inngest/functions/dca-spot-bot-watch.ts`, replace lines 24–27:

```ts
    const bots = await step.run('fetch-dca-spot-bots', async () => {
      const allRunning = await getRunningBots();
      return allRunning.filter((b) => b.botType === 'DCA_SPOT');
    });
```

with:

```ts
    const bots = await step.run('fetch-dca-spot-bots', async () => {
      return getRunningAiBots('DCA_SPOT');
    });
```

- [ ] **Step 2: Update the import**

Change the import block at the top:

```ts
import {
  getRunningBots,
  getBotById,
  setBotStatus,
} from '@/services/bingx.service';
```

to:

```ts
import {
  getRunningAiBots,
  getBotById,
  setBotStatus,
} from '@/services/bingx.service';
```

- [ ] **Step 3: Lint**

Run: `npm run lint`

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/inngest/functions/dca-spot-bot-watch.ts
git commit -m "feat(inngest): scope dca-spot-bot-watch to AI-managed bots"
```

---

## Task 6: Scope `trailing-stop-watch` to AI-managed keys

**Files:**
- Modify: `src/inngest/functions/trailing-stop-watch.ts`

- [ ] **Step 1: Replace the bot fetch step**

In `src/inngest/functions/trailing-stop-watch.ts`, replace lines 31–34:

```ts
    const bots = await step.run('fetch-trailing-bots', async () => {
      const allRunning = await getRunningBots();
      return allRunning.filter((b) => b.botType === 'TRAILING_STOP');
    });
```

with:

```ts
    const bots = await step.run('fetch-trailing-bots', async () => {
      return getRunningAiBots('TRAILING_STOP');
    });
```

- [ ] **Step 2: Update the import**

Change the import block at the top:

```ts
import {
  getRunningBots,
  getBotById,
  setBotStatus,
  getContractInfo,
  getCurrentPrice,
  getOpenPositions,
  recordTrade,
} from '@/services/bingx.service';
```

to:

```ts
import {
  getRunningAiBots,
  getBotById,
  setBotStatus,
  getContractInfo,
  getCurrentPrice,
  getOpenPositions,
  recordTrade,
} from '@/services/bingx.service';
```

- [ ] **Step 3: Lint**

Run: `npm run lint`

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/inngest/functions/trailing-stop-watch.ts
git commit -m "feat(inngest): scope trailing-stop-watch to AI-managed bots"
```

---

## Task 7: Scope `sma-crossover-watch` to AI-managed keys

**Files:**
- Modify: `src/inngest/functions/sma-crossover-watch.ts`

- [ ] **Step 1: Find the equivalent fetch step**

Open `src/inngest/functions/sma-crossover-watch.ts`. Locate the first call to `getRunningBots()` inside the function body. Confirm it filters by `botType === 'SMA_CROSSOVER'`.

- [ ] **Step 2: Replace the call**

Replace the block that calls `getRunningBots()` and filters in memory with a single call:

```ts
    const bots = await step.run('fetch-sma-bots', async () => {
      return getRunningAiBots('SMA_CROSSOVER');
    });
```

Adjust the step name (`'fetch-sma-bots'`) only if a different identifier was previously used in the file — keep the original step name to preserve Inngest history.

- [ ] **Step 3: Update the import**

Replace `getRunningBots` with `getRunningAiBots` in the import block at the top of the file.

- [ ] **Step 4: Lint**

Run: `npm run lint`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/inngest/functions/sma-crossover-watch.ts
git commit -m "feat(inngest): scope sma-crossover-watch to AI-managed bots"
```

---

## Task 8: Re-register the four functions in the Next.js Inngest route

**Files:**
- Modify: `src/app/api/inngest/route.ts`

- [ ] **Step 1: Replace the file contents**

Open `src/app/api/inngest/route.ts`. Replace the entire file with:

```ts
import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { tradingBotWatch } from "@/inngest/functions/trading-bot-watch";
import { dcaBotWatch } from "@/inngest/functions/dca-bot-watch";
import { trailingStopWatch } from "@/inngest/functions/trailing-stop-watch";
import { dcaSpotBotWatch } from "@/inngest/functions/dca-spot-bot-watch";
import { smaCrossoverWatch } from "@/inngest/functions/sma-crossover-watch";

const functions = [
  tradingBotWatch,
  dcaBotWatch,
  trailingStopWatch,
  dcaSpotBotWatch,
  smaCrossoverWatch,
];

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions,
});
```

- [ ] **Step 2: Lint**

Run: `npm run lint`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/inngest/route.ts
git commit -m "feat(inngest): re-register non-grid crons (scoped to AI-managed)"
```

---

## Task 9: Re-register the four functions in the Inngest Connect worker

**Files:**
- Modify: `src/worker.ts`

- [ ] **Step 1: Edit the imports**

Open `src/worker.ts`. Replace the existing import block (currently with the four DCA/SMA/Trailing imports commented out) with:

```ts
import { tradingBotWatch } from '@/inngest/functions/trading-bot-watch';
import { dcaBotWatch } from '@/inngest/functions/dca-bot-watch';
import { trailingStopWatch } from '@/inngest/functions/trailing-stop-watch';
import { dcaSpotBotWatch } from '@/inngest/functions/dca-spot-bot-watch';
import { smaCrossoverWatch } from '@/inngest/functions/sma-crossover-watch';
```

Also remove the explanatory comment "Temporarily disabled to reduce Inngest executions — only Grid Long is in use." since it no longer applies.

- [ ] **Step 2: Edit the registration**

Find the `connect(...)` call. Replace the `functions: [tradingBotWatch]` array with:

```ts
        functions: [
          tradingBotWatch,
          dcaBotWatch,
          trailingStopWatch,
          dcaSpotBotWatch,
          smaCrossoverWatch,
        ],
```

- [ ] **Step 3: Lint**

Run: `npm run lint`

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/worker.ts
git commit -m "feat(worker): re-register non-grid crons (scoped to AI-managed)"
```

---

## Task 10: End-to-end smoke test on a dev DB

This is a manual verification step. The goal is to confirm that a bot under a `managed_by_ai = true` key is processed and that a bot under `managed_by_ai = false` is ignored.

**Files:** none modified. Pure verification.

- [ ] **Step 1: Start the local Inngest dev server**

In one terminal:

```bash
npm run dev
```

In another:

```bash
npm run inngest
```

Expected: Inngest dev UI is reachable at `http://localhost:8288`.

- [ ] **Step 2: Confirm the four scoped functions appear**

Open `http://localhost:8288/functions`. Confirm all five functions are listed:
- `trading-bot-watch`
- `dca-bot-watch`
- `dca-spot-bot-watch`
- `trailing-stop-watch`
- `sma-crossover-watch`

If any are missing, the registration in Task 8 or Task 9 was not applied.

- [ ] **Step 3: Insert two API keys with opposite flags**

Run:

```bash
bun -e "
import { db } from './src/db';
import { bingxApiKeys, users } from './src/db/schema';
import { encryptSecret } from './src/lib/bingx/encryption';

const userId = (await db.query.users.findFirst())?.id;
if (!userId) throw new Error('seed at least one user first');

await db.insert(bingxApiKeys).values([
  { userId, label: 'AI-test', apiKey: 'aikey', secretKeyEncrypted: encryptSecret('aisecret'), managedByAi: true },
  { userId, label: 'Manual-test', apiKey: 'manualkey', secretKeyEncrypted: encryptSecret('manualsecret'), managedByAi: false },
]);

console.log('seeded');
"
```

Expected: prints `seeded`.

- [ ] **Step 4: Trigger `dca-bot-watch` once and inspect logs**

In the Inngest dev UI, find `dca-bot-watch` and click "Invoke". Pass empty body `{}`.

Expected: function returns `{ processed: 0 }` (no DCA bot exists yet under the AI key, so nothing to process). The job log should NOT show any error from `getRunningAiBots`.

- [ ] **Step 5: Insert a fake DCA bot under the AI-test key, invoke again**

```bash
bun -e "
import { db } from './src/db';
import { bingxApiKeys, tradingBots } from './src/db/schema';
import { eq } from 'drizzle-orm';

const aiKey = await db.query.bingxApiKeys.findFirst({ where: eq(bingxApiKeys.label, 'AI-test') });
if (!aiKey) throw new Error('seed AI-test key first');

await db.insert(tradingBots).values({
  userId: aiKey.userId,
  apiKeyId: aiKey.id,
  symbol: 'BTC-USDT',
  botType: 'DCA',
  priceMin: '50000',
  priceMax: '60000',
  positionSizeUsdt: '10',
  takeProfitPercentage: '1',
  gridCount: 1,
  leverage: 1,
  status: 'RUNNING',
});

console.log('seeded');
"
```

Then re-invoke `dca-bot-watch` from the Inngest UI.

Expected: function attempts to fetch contract info for the test key. The job log should show `bots.length === 1`. The call WILL fail when calling BingX (the AI-test key isn't real); that is fine — the only thing under test is whether the bot was *picked up* by `getRunningAiBots`. Look for the log line that proves the fetch step returned the bot.

If the bot is NOT picked up, the `managed_by_ai` filter is wrong.

- [ ] **Step 6: Cleanup**

```bash
bun -e "
import { db } from './src/db';
import { bingxApiKeys, tradingBots } from './src/db/schema';
import { eq, inArray } from 'drizzle-orm';

const labels = ['AI-test', 'Manual-test'];
const keys = await db.query.bingxApiKeys.findMany({ where: inArray(bingxApiKeys.label, labels) });
const ids = keys.map(k => k.id);

await db.delete(tradingBots).where(inArray(tradingBots.apiKeyId, ids));
await db.delete(bingxApiKeys).where(inArray(bingxApiKeys.id, ids));

console.log('cleaned');
"
```

Expected: prints `cleaned`.

- [ ] **Step 7: No commit needed — manual verification only**

If all of the above passed, Session 0 is complete.

---

## Self-Review

- **Spec coverage**: Session 0 in the spec lists `package.json` dep, `bingxApiKeys.managedByAi`, drizzle migration, four cron filter changes, two registrations. All covered by Tasks 1–9. Manual smoke covered by Task 10.
- **Placeholder scan**: No "TBD", "implement later", or vague "handle errors" steps. Every code block is concrete.
- **Type consistency**: `getRunningAiBots(botType?)` signature is consistent across Task 3 (definition) and Tasks 4–7 (callers). The `botType` parameter type is `TradingBot['botType']`, which matches the existing column union in `botTypeEnum`.
- **Naming**: `managed_by_ai` (DB column) ↔ `managedByAi` (Drizzle property) ↔ `managed_by_ai_idx` (index). Consistent.

---

## Done Criteria for Session 0

Before declaring Session 0 done, confirm all of the following:

1. `bun.lock` lists `@anthropic-ai/sdk`.
2. `bingx_api_keys.managed_by_ai` exists, defaults `false`, has the index.
3. `npm run test` passes including the new `getRunningAiBots` tests.
4. `npm run lint` passes.
5. All five Inngest functions show up in the Inngest dev UI.
6. Manual smoke (Task 10) shows `dca-bot-watch` picks up bots under AI-managed keys and ignores bots under manual keys.
