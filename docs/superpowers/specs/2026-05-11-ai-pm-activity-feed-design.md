# AI Portfolio Manager — Activity Feed (S13) Design

**Date:** 2026-05-11
**Branch:** `feat/ai-pm-activity-feed` (to create)
**Status:** Approved design — ready for implementation plan

## 1. Goal

Read-only dashboard surfacing AI PM brain output. User sees:

- Every decision (PROPOSED / REJECTED_REVIEWER / REJECTED_GUARDRAIL_* / EXECUTED / EXECUTION_FAILED) with reasoning, params, signal snapshot, linked bot, model cost.
- Latest 10 signals from `ai_signals`.
- Active paper bots from `paper_bots` (status = RUNNING).
- Today's spend summary (token counts, USD cost, decision count).
- Last cron tick pulse (age of newest `ai_decisions` row).

Filterable by status (multi), action type, symbol, date range. Cursor-paginated decisions. Manual refresh. No writes.

## 2. Non-Goals

- Subaccount filter — deferred. `ai_decisions`/`paper_bots`/`ai_signals` carry only `userId`; no `bingxApiKeyId` column. Filter requires schema change + writer updates across S7/S9/S10/S11 — out of scope here.
- Realtime push / SSE — deferred. Manual refresh button only.
- pt/zh translations — EN only this session. Stubs added later.
- Editing or replaying decisions, killing paper bots from feed — read-only.

## 3. Architecture

```
/dashboard/ai-pm/activity (server page)
  ├─ requireAuth
  └─ <ActivityClient />  (client; reads useSearchParams)
        └─ fetch GET /api/ai-pm/activity?<filters>&cursor=
              └─ src/services/ai-pm-activity.service.ts
                    ├─ listDecisions(userId, filters, cursor, limit)
                    ├─ listLatestSignals(userId, limit=10)
                    ├─ listActivePaperBots(userId)
                    ├─ getTodaySpendSummary(userId)
                    └─ getLastTickAt(userId)
```

Layout: 2-column on desktop (`lg:grid-cols-3`). Left 2 cols = decisions feed + filter bar. Right 1 col = stacked rail cards: Signals · Paper Bots · Today · Cron Pulse. Single-column stack on mobile.

Pattern mirrors S12 settings: server page → client orchestrator → presentational subcomponents. Service layer is pure read; no writes anywhere in this slice.

## 4. File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/services/ai-pm-activity.service.ts` | Create | Read queries: `listDecisions`, `listLatestSignals`, `listActivePaperBots`, `getTodaySpendSummary`, `getLastTickAt`. Cursor + filter compilation. |
| `src/services/__tests__/ai-pm-activity.service.test.ts` | Create | Vitest: cursor walk, status filter, symbol filter, date range, summary sum. |
| `src/app/api/ai-pm/activity/route.ts` | Create | GET. Parse query. Auth + own-data only. Returns combined payload. |
| `src/app/api/ai-pm/activity/__tests__/route.test.ts` | Create | Happy + auth-401 + bad-cursor-400 + filter passthrough. |
| `src/app/(dashboard)/dashboard/ai-pm/activity/page.tsx` | Create | Server shell: auth, title, mounts `<ActivityClient />`. |
| `src/components/ai-pm/activity/ActivityClient.tsx` | Create | Orchestrator. Reads `useSearchParams`. Fetches on mount + filter change + refresh click. Manages cursor state. |
| `src/components/ai-pm/activity/FilterBar.tsx` | Create | Status multi-select, action-type select, symbol input, from/to date, Reset, Refresh. Writes URL via `router.replace`. |
| `src/components/ai-pm/activity/DecisionsList.tsx` | Create | Renders rows; "Load more" button using `nextCursor`. Empty state. |
| `src/components/ai-pm/activity/DecisionRow.tsx` | Create | Collapsed row (status badge, symbol, action, age). Expands to detail panel. |
| `src/components/ai-pm/activity/DecisionDetail.tsx` | Create | Sections: Reasoning + rejectionReason · Signal/Params JSON · Linked Bot · Model/Cost. |
| `src/components/ai-pm/activity/SignalsRail.tsx` | Create | Top-10 signals card. Each row: symbol, regime pill, score, age. |
| `src/components/ai-pm/activity/PaperBotsRail.tsx` | Create | Active paper bots card. symbol, strategy, pnl, trades count, age. |
| `src/components/ai-pm/activity/SpendRail.tsx` | Create | Today summary: input/output tokens, cost USD, decision count. |
| `src/components/ai-pm/activity/CronPulseRail.tsx` | Create | "Last AI tick: 3m ago" badge. Green <30m, amber <60m, red ≥60m. |
| `src/components/layout/sidebar.tsx` | Modify | Add child link under AI PM: "Activity" → `/dashboard/ai-pm/activity`. |
| `messages/en.json` | Modify | `AiPm.Activity.*` keys (EN only this session). |

## 5. API Contract

```
GET /api/ai-pm/activity
  Query:
    status?:     comma-sep AiDecisionStatus
                 (PROPOSED | REJECTED_REVIEWER | REJECTED_GUARDRAIL_* | EXECUTED | EXECUTION_FAILED)
    actionType?: comma-sep AiActionType
    symbol?:     string (uppercased server-side, exact match)
    from?:       ISO timestamp
    to?:         ISO timestamp
    cursor?:     base64-encoded JSON { createdAt: ISO, id: uuid }
    limit?:      int 1..100 (default 50)

  200 →
    {
      decisions: AiDecisionPublic[],
      nextCursor: string | null,
      signals:    AiSignalPublic[],     // top 10 by createdAt
      paperBots:  PaperBotPublic[],     // status = RUNNING
      summary: {
        decisionsToday: number,
        tokensInputToday: number,
        tokensOutputToday: number,
        costUsdToday: string,
      },
      lastTickAt: string | null         // max(createdAt) of ai_decisions
    }

  401 — unauthenticated
  400 — invalid cursor, invalid limit, invalid date
  500 — misc
```

All paths require `requireAuth()`. All queries filter on `userId = currentUser.id`. No cross-user data leakage possible since `userId` is server-derived, never client-supplied.

## 6. Public Types

```ts
export interface AiDecisionPublic {
  id: string;
  triggeredBy: string;
  triggerDetail: string | null;
  actionType: string;
  status: AiDecisionStatus;
  symbol: string | null;
  strategy: string | null;
  params: unknown;
  reasoning: string | null;
  signalSnapshot: unknown;
  rejectionReason: string | null;
  modelUsed: string | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  costUsd: string | null;
  resultBotId: string | null;
  paperBot: {
    id: string;
    symbol: string;
    strategy: string;
    status: string;
    pnlUsdt: string;
    tradesCount: number;
  } | null;
  executedAt: string | null;
  createdAt: string;
}

export interface AiSignalPublic {
  id: string;
  symbol: string;
  regime: string;
  score: number;
  reason: string | null;
  createdAt: string;
}

export interface PaperBotPublic {
  id: string;
  symbol: string;
  strategy: string;
  status: string;
  pnlUsdt: string;
  capitalUsdt: string;
  tradesCount: number;
  startedAt: string | null;
  createdAt: string;
}
```

`paperBot` field on `AiDecisionPublic` populated only when `paper_bots.decision_id = decision.id` exists. Uses LEFT JOIN with `tradesCount = jsonb_array_length(trades)`.

## 7. Cursor Pagination

Order: `createdAt DESC, id DESC` (stable tiebreak on identical timestamps).
Cursor encodes last row's `(createdAt, id)` as base64 JSON.
Next page predicate:

```ts
or(
  lt(aiDecisions.createdAt, cursor.createdAt),
  and(eq(aiDecisions.createdAt, cursor.createdAt), lt(aiDecisions.id, cursor.id)),
)
```

Query fetches `limit + 1` rows; if returned `> limit`, drop the extra and emit `nextCursor` from last kept row. Else `nextCursor = null`.

Index hit: existing `ai_decisions_user_created_idx (userId, createdAt)`. No new index required.

## 8. Filter Compilation

All filters AND together inside the `userId` scope:

- `status`: `inArray(aiDecisions.status, statuses)`
- `actionType`: `inArray(aiDecisions.actionType, types)`
- `symbol`: `eq(aiDecisions.symbol, symbol.toUpperCase())`
- `from`: `gte(aiDecisions.createdAt, from)`
- `to`: `lte(aiDecisions.createdAt, to)`

Unknown enum values → 400. Empty arrays after parsing → omit filter (same as absent).

Filters apply to **decisions only**. Rails always show user's full set (latest 10 signals, all active paper bots, today's summary, last tick). Filter changes do not refetch rails — separate query keys.

## 9. Client State + URL

Filter state lives in URL search params via Next.js `useSearchParams` + `router.replace`. Refresh-safe, shareable, deep-linkable.

- Filter change → `router.replace('?...')` → client effect re-fetches decisions (rails skipped via dependency split).
- "Refresh" button → forced re-fetch of entire payload regardless of URL.
- "Load more" → append-mode fetch with current `nextCursor`; new rows appended client-side, not pushed to URL.
- Cursor itself is **not** in URL — only filter dimensions are.

## 10. Side Rails — Behaviour

| Rail | Query | Empty State |
|---|---|---|
| Signals (top 10) | `SELECT * FROM ai_signals WHERE userId = ? ORDER BY createdAt DESC LIMIT 10` | "No signals yet — cron hasn't run or watchlist empty." |
| Active Paper Bots | `SELECT * FROM paper_bots WHERE userId = ? AND status = 'RUNNING' ORDER BY createdAt DESC` | "No paper bots active." |
| Today | `SUM(tokens_input), SUM(tokens_output), SUM(cost_usd), COUNT(*) FROM ai_decisions WHERE userId = ? AND createdAt >= today_00:00 UTC` | All zeros rendered. |
| Cron Pulse | `MAX(createdAt) FROM ai_decisions WHERE userId = ?` → age → color band | "Never" / red. |

"Today" boundary: UTC midnight. Acceptable for first version; per-user TZ deferred.

## 11. Decision Row UX

**Collapsed:**
`[STATUS BADGE] [actionType] [symbol] [createdAt age]   [chevron]`

Status badge colors:
- `EXECUTED` — green
- `PROPOSED` — blue (transient, only visible if executor mid-flight)
- `REJECTED_GUARDRAIL_*` — amber
- `REJECTED_REVIEWER` — orange
- `EXECUTION_FAILED` — red

**Expanded** (4 stacked sections):

1. **Reasoning** — `decision.reasoning` text; `rejectionReason` below in muted color if present.
2. **Signal + Params JSON** — two `<details>` blocks with pretty-printed JSON.
3. **Linked Bot** — if `paperBot` non-null: mini-card with symbol, strategy, pnl, status, trades. Else if `resultBotId`: link to `/dashboard/bots/{id}`. Else "—".
4. **Model + Cost** — `modelUsed`, `tokensInput`, `tokensOutput`, `costUsd` formatted as `$0.001234`.

## 12. Error / Empty / Loading

- API error → top banner with retry button (similar to S12 settings load-error). Existing rows kept visible.
- Empty filter result → "No decisions match filters. Reset?"
- Empty unfiltered result → "No AI decisions yet. Enable AI on a subaccount in Settings."
- Initial loading → skeleton list (5 rows) + skeleton rail cards.
- "Load more" loading → button shows spinner; previous rows stay.

## 13. Testing

**Service tests** (`ai-pm-activity.service.test.ts`):
- Seed user + 5 decisions across 3 statuses + 2 paper bots + 4 signals.
- `listDecisions` returns DESC order, applies status filter, applies symbol filter, applies date range, walks cursor correctly across 2 pages.
- `getTodaySpendSummary` sums only today's rows.
- `listLatestSignals` caps at 10.
- `listActivePaperBots` filters status=RUNNING.
- `getLastTickAt` returns max or null.

**API tests** (`route.test.ts`):
- 401 when `requireAuth` throws.
- 400 on invalid cursor / invalid limit / invalid date.
- 200 happy path returns full shape.
- Filter query string passes through to service (mocked).
- Cross-user isolation: seed user B, ensure GET as user A returns 0 of B's rows.

**Component tests:** none (repo has no component-test infra). Manual smoke required.

## 14. Manual Smoke Checklist

1. `npm run dev`, log in, navigate `/dashboard/ai-pm/activity`.
2. Empty state (if no decisions): correct copy + link to settings.
3. After cron tick (or manual Inngest invoke): rows appear, status badges correct.
4. Filter by `EXECUTED` → list shrinks to that subset.
5. Date range filter → respects bounds.
6. "Load more" → fetches older rows, appends, button hides when nextCursor null.
7. Refresh button → re-fetches rails + decisions, summary updates.
8. Expand row → reasoning, JSON blocks, linked bot, cost all populated.
9. Sidebar shows "Activity" under "AI Portfolio Manager".

## 15. Security Notes

- All queries filter on `requireAuth()` user id; no path takes a `userId` from query/body.
- Cursor is decoded JSON but only used as comparison values in WHERE clause — no SQL string concat; Drizzle bind params.
- `params` and `signalSnapshot` jsonb returned as-is to client. These are authored by the AI PM stack (server side), not user input — no XSS vector via JSON content. Rendered as text inside `<pre>` blocks.
- No Anthropic key or any encrypted secret reachable through this route. `ai_pm_configs` not queried at all.

## 16. Done Criteria

1. `GET /api/ai-pm/activity` returns correct shape under all filter combinations.
2. Service tests + API tests pass under Vitest.
3. Page renders at `/dashboard/ai-pm/activity` with sidebar link.
4. Filters reflected in URL, refresh-safe.
5. "Load more" walks cursor without dupes/gaps.
6. Rails populate independently of filters.
7. Lint + build clean.
8. Manual smoke run captured in PR description.

## 17. Out-of-Scope Follow-ups (for future sessions)

- Add `bingxApiKeyId` column to `ai_decisions`, `paper_bots`, `ai_signals` + writer updates → enable subaccount filter.
- Realtime push (SSE or Inngest realtime) for live tick observation.
- pt/zh translations.
- Per-user timezone for "today" boundary.
- CSV export of decisions.
- Drill-down on a single decision → dedicated detail page.
