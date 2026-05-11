# AI Portfolio Manager — Session 12 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** End-to-end onboarding UI. User can: (1) view their BingX subaccounts, (2) enable AI mode per subaccount, (3) paste an Anthropic API key (Test before saving), (4) select a guardrail profile, (5) flip kill switch / paper mode, (6) disable AI per subaccount. Reflects multi-subaccount model from PR #22.

**Architecture:** Pages + components + API routes. Server-side handlers wrap service-layer (S2 + S12 additions). Forms posted via fetch to JSON API. No SSR data loading beyond auth check — components fetch on mount. Tested via Vitest on API routes; components manual-smoke only (no component-test infra in this repo).

**Tech Stack:** Next.js App Router · HeroUI v3 · Tailwind v4 · next-intl · Drizzle · Vitest (API only)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/app/api/ai-pm/config/route.ts` | Create | GET (list per user), POST (create), PATCH (update flags/key), DELETE (by id). |
| `src/app/api/ai-pm/anthropic-test/route.ts` | Create | POST { plaintext } → `testAnthropicApiKey` result. Does NOT persist. |
| `src/app/api/ai-pm/config/__tests__/route.test.ts` | Create | API route happy + auth + validation paths. |
| `src/app/(dashboard)/dashboard/ai-pm/page.tsx` | Create | Page: lists subaccounts, renders one card per. Server component, reads user, hydrates list client-side. |
| `src/components/ai-pm/SubaccountAiCard.tsx` | Create | Per-subaccount card. Shows enabled state + form/buttons. |
| `src/components/ai-pm/AnthropicKeyForm.tsx` | Create | Paste field + "Test" button + "Save" button. |
| `src/components/ai-pm/GuardrailForm.tsx` | Create | Profile cards (CONSERVATIVE / BALANCED / AGGRESSIVE) + custom fields toggle (maxCapitalUsdt, maxConcurrentBots, allowedSymbols CSV). |
| `src/components/ai-pm/KillSwitch.tsx` | Create | Toggle button + confirm modal. Calls PATCH. |
| `src/components/ai-pm/PaperModeToggle.tsx` | Create | Switch. PATCH on flip. |
| `messages/en.json` `messages/pt.json` `messages/zh.json` | Modify | Add `AiPm.Settings.*` keys (label strings only). |
| `src/components/layout/sidebar.tsx` | Modify | Add link "AI Portfolio Manager" → `/dashboard/ai-pm`. |

---

## Public Surface

### API contracts

```
GET    /api/ai-pm/config              → { configs: AiPmConfigPublic[] }
POST   /api/ai-pm/config              body: { bingxApiKeyId, anthropicApiKey, mode?: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE' }
                                      → { config: AiPmConfigPublic }
PATCH  /api/ai-pm/config/:id          body partial of { anthropicApiKey?, mode?, killSwitch?, enabled?, paperMode?,
                                                       maxCapitalUsdt?, maxConcurrentBots?, allowedSymbols?, allowedStrategies?, maxDrawdownPct?, maxLeverage? }
                                      → { config: AiPmConfigPublic }
DELETE /api/ai-pm/config/:id          → { ok: true }
POST   /api/ai-pm/anthropic-test      body: { anthropicApiKey }
                                      → { ok: boolean, error?: string }
```

`AiPmConfigPublic` shape: same as `AiPmConfigRow` minus `anthropicApiKeyEncrypted` (never return decrypted key over HTTP; UI doesn't need it).

All routes require `requireAuth()`. Caller-owned check: every `config.id` operation verifies row.userId === current user. Mismatch → 404 (don't leak existence).

### Component shape

`AiPmConfigPublic`:
```ts
export interface AiPmConfigPublic {
  id: string;
  userId: string;
  bingxApiKeyId: string;
  enabled: boolean;
  mode: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE' | 'CUSTOM';
  maxCapitalUsdt: string | null;
  maxConcurrentBots: number | null;
  allowedSymbols: string[] | null;
  allowedStrategies: string[] | null;
  killSwitch: boolean;
  paperMode: boolean;
  createdAt: string;
  updatedAt: string;
}
```

---

## Task 1: API routes + tests

**Files:**
- Create: `src/app/api/ai-pm/config/route.ts`
- Create: `src/app/api/ai-pm/config/[id]/route.ts` (PATCH/DELETE)
- Create: `src/app/api/ai-pm/anthropic-test/route.ts`
- Create: `src/app/api/ai-pm/config/__tests__/route.test.ts`

- [ ] **Step 1: Add `updateAiPmConfig` helper to service** (`src/services/ai-pm-config.service.ts`):

```ts
export interface UpdateAiPmConfigInput {
  anthropicApiKeyPlaintext?: string;
  mode?: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE' | 'CUSTOM';
  enabled?: boolean;
  killSwitch?: boolean;
  paperMode?: boolean;
  maxCapitalUsdt?: number | null;
  maxConcurrentBots?: number | null;
  allowedSymbols?: string[] | null;
  allowedStrategies?: string[] | null;
  maxDrawdownPct?: number | null;
  maxLeverage?: number | null;
}

export async function updateAiPmConfig(configId: string, input: UpdateAiPmConfigInput): Promise<void> {
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.anthropicApiKeyPlaintext !== undefined) {
    patch.anthropicApiKeyEncrypted = encryptSecret(input.anthropicApiKeyPlaintext);
  }
  if (input.mode !== undefined) patch.mode = input.mode;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.killSwitch !== undefined) patch.killSwitch = input.killSwitch;
  if (input.paperMode !== undefined) patch.paperMode = input.paperMode;
  if (input.maxCapitalUsdt !== undefined) patch.maxCapitalUsdt = input.maxCapitalUsdt === null ? null : String(input.maxCapitalUsdt);
  if (input.maxConcurrentBots !== undefined) patch.maxConcurrentBots = input.maxConcurrentBots;
  if (input.allowedSymbols !== undefined) patch.allowedSymbols = input.allowedSymbols;
  if (input.allowedStrategies !== undefined) patch.allowedStrategies = input.allowedStrategies;
  if (input.maxDrawdownPct !== undefined) patch.maxDrawdownPct = input.maxDrawdownPct === null ? null : String(input.maxDrawdownPct);
  if (input.maxLeverage !== undefined) patch.maxLeverage = input.maxLeverage;

  await db.update(aiPmConfigs).set(patch).where(eq(aiPmConfigs.id, configId));
}

export async function deleteAiPmConfig(configId: string): Promise<void> {
  await db.delete(aiPmConfigs).where(eq(aiPmConfigs.id, configId));
}
```

- [ ] **Step 2: Write API route handlers**

`src/app/api/ai-pm/config/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { requireAuth } from '@/services/auth.service';
import {
  createAiPmConfig,
  listAiPmConfigsForUser,
} from '@/services/ai-pm-config.service';
import { db } from '@/db';
import { bingxApiKeys } from '@/db/schema';
import { and, eq } from 'drizzle-orm';

function toPublic(cfg: { anthropicApiKey?: string; anthropicApiKeyEncrypted?: string; [k: string]: unknown }) {
  // strip both possible secret carriers
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { anthropicApiKey, anthropicApiKeyEncrypted, ...rest } = cfg;
  return rest;
}

export async function GET() {
  try {
    const user = await requireAuth();
    const list = await listAiPmConfigsForUser(user.id);
    return NextResponse.json({ configs: list.map(toPublic) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed';
    if (message.includes('Authentication')) return NextResponse.json({ error: message }, { status: 401 });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireAuth();
    const body = (await req.json()) as {
      bingxApiKeyId: string;
      anthropicApiKey: string;
      mode?: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE' | 'CUSTOM';
    };
    if (!body.bingxApiKeyId || !body.anthropicApiKey) {
      return NextResponse.json({ error: 'bingxApiKeyId and anthropicApiKey required' }, { status: 400 });
    }
    // Confirm the subaccount belongs to this user
    const owns = await db.query.bingxApiKeys.findFirst({
      where: and(eq(bingxApiKeys.id, body.bingxApiKeyId), eq(bingxApiKeys.userId, user.id)),
    });
    if (!owns) {
      return NextResponse.json({ error: 'Subaccount not found' }, { status: 404 });
    }

    const cfg = await createAiPmConfig(user.id, {
      bingxApiKeyId: body.bingxApiKeyId,
      anthropicApiKeyPlaintext: body.anthropicApiKey,
      mode: body.mode,
    });
    return NextResponse.json({ config: toPublic(cfg) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed';
    if (message.includes('Authentication')) return NextResponse.json({ error: message }, { status: 401 });
    if (message.includes('duplicate key')) {
      return NextResponse.json({ error: 'Subaccount already has AI config' }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

`src/app/api/ai-pm/config/[id]/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { requireAuth } from '@/services/auth.service';
import {
  getAiPmConfigById,
  updateAiPmConfig,
  deleteAiPmConfig,
  type UpdateAiPmConfigInput,
} from '@/services/ai-pm-config.service';

async function loadAndCheckOwnership(configId: string, userId: string) {
  const cfg = await getAiPmConfigById(configId);
  if (!cfg || cfg.userId !== userId) return null;
  return cfg;
}

function toPublic(cfg: { anthropicApiKey?: string; anthropicApiKeyEncrypted?: string; [k: string]: unknown }) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { anthropicApiKey, anthropicApiKeyEncrypted, ...rest } = cfg;
  return rest;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth();
    const { id } = await params;
    const owned = await loadAndCheckOwnership(id, user.id);
    if (!owned) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const body = (await req.json()) as UpdateAiPmConfigInput & { anthropicApiKey?: string };
    const patch: UpdateAiPmConfigInput = { ...body };
    if (body.anthropicApiKey !== undefined) {
      patch.anthropicApiKeyPlaintext = body.anthropicApiKey;
      delete (patch as { anthropicApiKey?: unknown }).anthropicApiKey;
    }

    await updateAiPmConfig(id, patch);
    const fresh = await getAiPmConfigById(id);
    return NextResponse.json({ config: toPublic(fresh!) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed';
    if (message.includes('Authentication')) return NextResponse.json({ error: message }, { status: 401 });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth();
    const { id } = await params;
    const owned = await loadAndCheckOwnership(id, user.id);
    if (!owned) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    await deleteAiPmConfig(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed';
    if (message.includes('Authentication')) return NextResponse.json({ error: message }, { status: 401 });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

`src/app/api/ai-pm/anthropic-test/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { requireAuth } from '@/services/auth.service';
import { testAnthropicApiKey } from '@/services/ai-pm-config.service';

export async function POST(req: Request) {
  try {
    await requireAuth();
    const body = (await req.json()) as { anthropicApiKey: string };
    if (!body.anthropicApiKey) {
      return NextResponse.json({ ok: false, error: 'anthropicApiKey required' }, { status: 400 });
    }
    const result = await testAnthropicApiKey(body.anthropicApiKey);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed';
    if (message.includes('Authentication')) return NextResponse.json({ error: message }, { status: 401 });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
```

- [ ] **Step 3: Tests** at `src/app/api/ai-pm/config/__tests__/route.test.ts`. Use integration-style tests against real DB (same pattern as `ai-pm-config.service.test.ts`):

```ts
// Set up: insert user + bingx api key. Call route handlers directly (Next.js route handlers are async functions).
// Cover: GET empty, POST 400 missing, POST 200, POST 409 dup, GET returns list, PATCH 200, DELETE 200, anthropic-test fake factory.
```

Stub `requireAuth` via vi.mock or mock at module level. Verify response shapes.

- [ ] **Step 4: Lint + commit**

```bash
bunx eslint src/app/api/ai-pm src/services/ai-pm-config.service.ts
git add src/app/api/ai-pm src/services/ai-pm-config.service.ts
git commit -m "feat(ai-pm): config + anthropic-test API routes"
```

---

## Task 2: UI components

**Files:**
- Create: `src/components/ai-pm/SubaccountAiCard.tsx`
- Create: `src/components/ai-pm/AnthropicKeyForm.tsx`
- Create: `src/components/ai-pm/GuardrailForm.tsx`
- Create: `src/components/ai-pm/KillSwitch.tsx`
- Create: `src/components/ai-pm/PaperModeToggle.tsx`

- [ ] **`SubaccountAiCard`** — props: `{ subaccount: { id, label }, config: AiPmConfigPublic | null, onChange: () => Promise<void> }`. Renders:
  - **No config:** "Enable AI" button → expands `AnthropicKeyForm` + `GuardrailForm`.
  - **Has config:** label + status pills (enabled / paper / killSwitch) + 3 action buttons:
    - "Edit profile" → opens `GuardrailForm` inline
    - "Replace Anthropic key" → opens `AnthropicKeyForm` (replace mode)
    - "Disable AI" → DELETE confirm modal
  - Two switches always visible: `enabled`, `paperMode` (PATCH on flip).
  - `KillSwitch` button below switches.

- [ ] **`AnthropicKeyForm`** — props: `{ existingConfigId: string | null, bingxApiKeyId: string, onSaved: (cfg: AiPmConfigPublic) => void }`. UI:
  - `<input type="password">` for key.
  - "Test" button → POST `/api/ai-pm/anthropic-test`. Shows success/error inline.
  - "Save" button: if `existingConfigId` → PATCH (`anthropicApiKey`); else POST `/api/ai-pm/config` with `bingxApiKeyId`. Disabled until test passes.

- [ ] **`GuardrailForm`** — props: `{ config: AiPmConfigPublic | null, bingxApiKeyId: string, anthropicApiKey?: string, onSaved: (cfg: AiPmConfigPublic) => void }`. UI:
  - Profile picker (3 cards): CONSERVATIVE, BALANCED, AGGRESSIVE (presets fill the custom fields below; user can override → mode flips to CUSTOM).
  - Custom fields (collapsible): `maxCapitalUsdt`, `maxConcurrentBots`, `allowedSymbols` (CSV → string[]), `allowedStrategies` (multi-select).
  - "Save" button → PATCH if config exists, else POST.

- [ ] **`KillSwitch`** — props: `{ configId: string, killSwitchOn: boolean, onChange: () => Promise<void> }`. Red button. Confirm modal: "This will immediately halt all AI activity on this subaccount. Continue?". On confirm, PATCH `{ killSwitch: true }`.

- [ ] **`PaperModeToggle`** — props: `{ configId: string, paperMode: boolean, onChange: () => Promise<void> }`. Switch + tooltip explaining paper mode.

- [ ] **Lint + commit:**

```bash
bunx eslint src/components/ai-pm
git add src/components/ai-pm
git commit -m "feat(ai-pm): settings UI components"
```

---

## Task 3: Page wiring + sidebar + i18n

**Files:**
- Create: `src/app/(dashboard)/dashboard/ai-pm/page.tsx`
- Modify: `src/components/layout/sidebar.tsx` (add link)
- Modify: `messages/en.json`, `messages/pt.json`, `messages/zh.json`

- [ ] **Page** (server component shell + client fetch):

```tsx
import { requireAuth } from '@/services/auth.service';
import { getUserApiKeys } from '@/services/bingx.service';
import { AiPmSettingsClient } from '@/components/ai-pm/AiPmSettingsClient';

export default async function AiPmPage() {
  const user = await requireAuth();
  const subaccounts = await getUserApiKeys(user.id);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">AI Portfolio Manager</h1>
      <AiPmSettingsClient subaccounts={subaccounts} />
    </div>
  );
}
```

`AiPmSettingsClient` (new component): client component, fetches `GET /api/ai-pm/config`, joins by `bingxApiKeyId`, renders one `SubaccountAiCard` per subaccount.

- [ ] **Sidebar link** add entry pointing to `/dashboard/ai-pm`.

- [ ] **i18n keys** — add `AiPm.Settings.title`, `AiPm.Settings.enableAi`, `AiPm.Settings.testKey`, `AiPm.Settings.killSwitch`, `AiPm.Settings.paperMode`, etc. Keep English-first; pt/zh can be machine-translated stubs.

- [ ] **Manual smoke** — `npm run dev`, log in, open `/dashboard/ai-pm`. Enable AI on one subaccount (paper mode), paste a test Anthropic key, observe a row appears in `ai_pm_configs`. Toggle kill switch, verify cron logs `kill_switch_at_start` in next tick (or set 1-min cron temporarily).

- [ ] **Commit:**

```bash
git add src/app/(dashboard)/dashboard/ai-pm src/components/layout/sidebar.tsx messages
git commit -m "feat(ai-pm): settings page + sidebar + i18n"
```

---

## Self-Review

- **Multi-subaccount aware:** one card per subaccount; config keyed by `configId`; service-layer signatures match.
- **API security:** every PATCH/DELETE checks `cfg.userId === user.id`.
- **Anthropic key never returned over HTTP:** `toPublic` strips both `anthropicApiKey` (decrypted) and `anthropicApiKeyEncrypted` (encrypted).
- **Spec deviation:** spec mentioned `SubaccountSetup` for pasting BingX key+secret with `managedByAi=true`. That flow already exists via `connect-keys-form.tsx` on `/dashboard/accounts` — no duplication. New UI assumes subaccounts already exist; if user has none, page shows "Add a BingX subaccount first" link to accounts page.

## Done Criteria

1. API routes return correct shapes; auth + ownership enforced.
2. UI loads existing configs and renders per-subaccount cards.
3. User can enable, edit, disable AI per subaccount.
4. Kill switch and paper mode toggles work.
5. Anthropic key test endpoint validates without persisting.
6. Tests pass for API routes.
7. Lint + build clean.
