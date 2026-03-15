# UI/UX Overhaul Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the single-page dashboard into a proper multi-page app with sidebar navigation, dashboard overview, and mobile-first responsive design using HeroUI v3.

**Architecture:** App Router route groups under `(dashboard)` with a shared sidebar layout. Pages: Overview, Bots, Accounts, Settings. Sidebar collapses to bottom nav on mobile. All components use HeroUI v3.

**Tech Stack:** Next.js 16 App Router, React 19, HeroUI v3, Tailwind CSS v4, next-intl

**Dependency:** This plan should be executed FIRST — Plans 2 (Subaccounts) and 3 (New Bot Types) build on this layout.

---

## File Structure

### New Files
- `src/components/layout/sidebar.tsx` — Sidebar navigation (desktop) + bottom nav (mobile)
- `src/components/layout/header.tsx` — Top header with user info, sign out, theme toggle
- `src/app/(dashboard)/dashboard/bots/page.tsx` — Bots management page
- `src/app/(dashboard)/dashboard/accounts/page.tsx` — API keys / subaccounts page
- `src/app/(dashboard)/dashboard/settings/page.tsx` — Settings page
- `src/components/dashboard/overview-stats.tsx` — Dashboard stats cards
- `src/components/dashboard/active-bots-summary.tsx` — Quick bot status overview

### Modified Files
- `src/app/(dashboard)/layout.tsx` — Add sidebar layout wrapper (existing file)
- `src/app/(dashboard)/dashboard/page.tsx` — Refactor to overview page (existing file)
- `src/app/layout.tsx` — Remove fixed ThemeToggle (moved to Header)
- `src/components/trading/bot-config-form.tsx` — Update grid to stack on mobile
- `src/components/trading/edit-bot-modal.tsx` — Mobile bottom sheet pattern
- `src/app/globals.css` — Add safe area CSS
- `messages/en.json` — Add navigation and new page translations
- `messages/pt.json` — Add navigation and new page translations
- `messages/zh.json` — Add navigation and new page translations

---

## Chunk 1: Sidebar Layout & Navigation

### Task 1: Create Sidebar Component

**Files:**
- Create: `src/components/layout/sidebar.tsx`

- [ ] **Step 1: Create the sidebar component**

```tsx
'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  LayoutDashboard,
  Bot,
  KeyRound,
  Settings,
} from 'lucide-react';

const navItems = [
  { href: '/dashboard', icon: LayoutDashboard, labelKey: 'overview' },
  { href: '/dashboard/bots', icon: Bot, labelKey: 'bots' },
  { href: '/dashboard/accounts', icon: KeyRound, labelKey: 'accounts' },
  { href: '/dashboard/settings', icon: Settings, labelKey: 'settings' },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const t = useTranslations('Nav');

  const isActive = (href: string) => {
    if (href === '/dashboard') return pathname === '/dashboard';
    return pathname.startsWith(href);
  };

  return (
    <>
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex md:flex-col md:w-64 md:fixed md:inset-y-0 border-r border-default-200 bg-background z-40">
        <div className="flex items-center h-16 px-6 border-b border-default-200">
          <span className="text-lg font-bold text-foreground">BingX Bot</span>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {navItems.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  active
                    ? 'bg-accent/10 text-accent'
                    : 'text-muted hover:text-foreground hover:bg-default-100'
                }`}
              >
                <item.icon className="w-5 h-5" />
                {t(item.labelKey)}
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Mobile Bottom Nav */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 border-t border-default-200 bg-background z-40 safe-area-pb">
        <div className="flex items-center justify-around h-16">
          {navItems.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex flex-col items-center gap-1 px-3 py-2 text-xs font-medium transition-colors ${
                  active ? 'text-accent' : 'text-muted'
                }`}
              >
                <item.icon className="w-5 h-5" />
                <span>{t(item.labelKey)}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
```

- [ ] **Step 2: Verify the component renders without errors**

Run: `npm run build 2>&1 | head -30`
Expected: No TypeScript errors related to sidebar

- [ ] **Step 3: Commit**

```bash
git add src/components/layout/sidebar.tsx
git commit -m "feat: add sidebar navigation component with desktop sidebar and mobile bottom nav"
```

### Task 2: Create Header Component

**Files:**
- Create: `src/components/layout/header.tsx`

- [ ] **Step 1: Create the header component**

**IMPORTANT:** `ThemeToggle` requires `initialTheme` and `fontVariableClass` props (see `src/components/theme-toggle.tsx:10-14`). These must be passed from the server layout which reads the theme cookie.

```tsx
'use client';

import { Button } from '@heroui/react';
import { useTranslations } from 'next-intl';
import { ThemeToggle } from '@/components/theme-toggle';
import type { Theme } from '@/lib/theme';

type HeaderProps = {
  signOutAction: () => Promise<void>;
  initialTheme: Theme;
  fontVariableClass: string;
};

export function Header({ signOutAction, initialTheme, fontVariableClass }: HeaderProps) {
  const t = useTranslations('Nav');

  return (
    <header className="sticky top-0 z-30 flex items-center justify-between h-16 px-4 sm:px-6 border-b border-default-200 bg-background">
      {/* Mobile: show app name (sidebar hidden) */}
      <span className="md:hidden text-lg font-bold text-foreground">BingX Bot</span>
      {/* Desktop: spacer (sidebar has the brand) */}
      <div className="hidden md:block" />

      <div className="flex items-center gap-2">
        <ThemeToggle initialTheme={initialTheme} fontVariableClass={fontVariableClass} />
        <form action={signOutAction}>
          <Button type="submit" variant="outline" size="sm">
            {t('signOut')}
          </Button>
        </form>
      </div>
    </header>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/layout/header.tsx
git commit -m "feat: add header component with theme toggle and sign out"
```

### Task 3: Update Dashboard Layout

**Files:**
- Modify: `src/app/(dashboard)/layout.tsx`

- [ ] **Step 1: Update the layout to include sidebar and header**

Replace the current layout with:

**IMPORTANT:** The layout must read the theme cookie and font variable class to pass to the Header component, since ThemeToggle requires `initialTheme` and `fontVariableClass` props. These values are currently read in `src/app/layout.tsx` — replicate the pattern here.

```tsx
import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { signOutAction } from '@/app/(dashboard)/dashboard/actions';
import { THEME_COOKIE_NAME } from '@/lib/theme';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  // Read theme for ThemeToggle props (same pattern as root layout)
  const cookieStore = await cookies();
  const themeCookie = cookieStore.get(THEME_COOKIE_NAME)?.value;
  const theme = themeCookie === 'light' || themeCookie === 'dark' ? themeCookie : 'dark';
  // Font variable classes are set on <html> by root layout; grab them for ThemeToggle
  // These must match the variable names in src/app/layout.tsx
  const fontVariableClasses = 'var(--font-inter) var(--font-jetbrains-mono)';

  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <div className="md:pl-64 flex flex-col min-h-screen">
        <Header
          signOutAction={signOutAction}
          initialTheme={theme}
          fontVariableClass={fontVariableClasses}
        />
        <main className="flex-1 p-4 sm:p-6 pb-20 md:pb-6">
          <div className="max-w-5xl mx-auto">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
```

**Note on fontVariableClass:** The root layout (`src/app/layout.tsx`) sets font CSS classes on `<html>` as `${inter.variable} ${jetbrainsMono.variable}`. The ThemeToggle uses this to preserve font classes when toggling theme (it sets `document.documentElement.className`). The exact variable class string should match what the root layout produces. During implementation, read the actual generated class names from the root layout's font variables rather than hardcoding.

- [ ] **Step 2: Run dev server and verify layout renders**

Run: `npm run build 2>&1 | head -30`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/app/(dashboard)/layout.tsx
git commit -m "feat: update dashboard layout with sidebar and header"
```

### Task 4: Add i18n Navigation Keys

**IMPORTANT:** This task should be done BEFORE Tasks 1-3 since the sidebar and header use `useTranslations('Nav')`. Without these keys, the build will produce missing translation warnings.

**Files:**
- Modify: `messages/en.json`
- Modify: `messages/pt.json`
- Modify: `messages/zh.json`

- [ ] **Step 1: Add Nav and Dashboard namespaces to en.json**

Add to the JSON:
```json
"Nav": {
  "overview": "Overview",
  "bots": "Bots",
  "accounts": "Accounts",
  "settings": "Settings",
  "signOut": "Sign out"
},
"Dashboard": {
  "balance": "Balance",
  "equity": "Equity",
  "unrealizedPnl": "Unrealized P&L",
  "available": "Available",
  "bots": "Bots",
  "viewAll": "View all",
  "running": "Running",
  "stopped": "Stopped",
  "grids": "grids"
}
```

- [ ] **Step 2: Add Nav and Dashboard namespaces to pt.json**

```json
"Nav": {
  "overview": "Visão Geral",
  "bots": "Bots",
  "accounts": "Contas",
  "settings": "Configurações",
  "signOut": "Sair"
},
"Dashboard": {
  "balance": "Saldo",
  "equity": "Patrimônio",
  "unrealizedPnl": "P&L Não Realizado",
  "available": "Disponível",
  "bots": "Bots",
  "viewAll": "Ver todos",
  "running": "Rodando",
  "stopped": "Parados",
  "grids": "grids"
}
```

- [ ] **Step 3: Add Nav and Dashboard namespaces to zh.json**

```json
"Nav": {
  "overview": "概览",
  "bots": "机器人",
  "accounts": "账户",
  "settings": "设置",
  "signOut": "退出"
},
"Dashboard": {
  "balance": "余额",
  "equity": "权益",
  "unrealizedPnl": "未实现盈亏",
  "available": "可用",
  "bots": "机器人",
  "viewAll": "查看全部",
  "running": "运行中",
  "stopped": "已停止",
  "grids": "网格"
}
```

- [ ] **Step 4: Commit**

```bash
git add messages/en.json messages/pt.json messages/zh.json
git commit -m "feat: add navigation and dashboard i18n translations for en/pt/zh"
```

## Chunk 2: Page Restructuring

### Task 5: Create Overview Page (Dashboard Home)

**Files:**
- Create: `src/components/dashboard/overview-stats.tsx`
- Create: `src/components/dashboard/active-bots-summary.tsx`
- Modify: `src/app/(dashboard)/dashboard/page.tsx`

- [ ] **Step 1: Create overview stats component**

```tsx
'use client';

import { Card, Spinner } from '@heroui/react';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

type BalanceData = {
  balance: string;
  equity: string;
  unrealizedProfit: string;
  availableMargin: string;
};

export function OverviewStats() {
  const t = useTranslations('Dashboard');
  const [data, setData] = useState<BalanceData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/bingx/balance')
      .then((r) => r.json())
      .then((d) => setData(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!data) return null;

  const stats = [
    { labelKey: 'balance' as const, value: `$${Number(data.balance).toFixed(2)}` },
    { labelKey: 'equity' as const, value: `$${Number(data.equity).toFixed(2)}` },
    {
      labelKey: 'unrealizedPnl' as const,
      value: `$${Number(data.unrealizedProfit).toFixed(2)}`,
      color: Number(data.unrealizedProfit) >= 0 ? 'text-success' : 'text-danger',
    },
    { labelKey: 'available' as const, value: `$${Number(data.availableMargin).toFixed(2)}` },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {stats.map((stat) => (
        <Card key={stat.labelKey}>
          <Card.Content className="p-4">
            <p className="text-xs text-muted">{t(stat.labelKey)}</p>
            <p className={`text-lg font-bold ${stat.color ?? 'text-foreground'}`}>
              {stat.value}
            </p>
          </Card.Content>
        </Card>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Create active bots summary component**

```tsx
'use client';

import { Card, Spinner } from '@heroui/react';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';

type BotSummary = {
  id: string;
  symbol: string;
  status: string;
  gridCount: number;
};

export function ActiveBotsSummary() {
  const t = useTranslations('Dashboard');
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/bingx/bot')
      .then((r) => r.json())
      .then((data) => setBots(Array.isArray(data) ? data : data.bots ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center py-4">
        <Spinner />
      </div>
    );
  }

  const running = bots.filter((b) => b.status === 'RUNNING');
  const stopped = bots.filter((b) => b.status === 'STOPPED');

  return (
    <Card>
      <Card.Content className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground">{t('bots')}</h3>
          <Link
            href="/dashboard/bots"
            className="text-xs text-accent hover:underline"
          >
            {t('viewAll')}
          </Link>
        </div>
        <div className="flex gap-4 text-sm">
          <div>
            <span className="text-success font-medium">{running.length}</span>
            <span className="text-muted ml-1">{t('running')}</span>
          </div>
          <div>
            <span className="text-muted font-medium">{stopped.length}</span>
            <span className="text-muted ml-1">{t('stopped')}</span>
          </div>
        </div>
        {running.length > 0 && (
          <div className="mt-3 space-y-2">
            {running.slice(0, 3).map((bot) => (
              <div
                key={bot.id}
                className="flex items-center justify-between text-sm py-1"
              >
                <span className="font-medium">{bot.symbol}</span>
                <span className="text-xs text-muted">
                  {bot.gridCount} {t('grids')}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card.Content>
    </Card>
  );
}
```

- [ ] **Step 3: Update dashboard page to be overview**

```tsx
import { createClient } from '@/lib/supabase/server';
import { OverviewStats } from '@/components/dashboard/overview-stats';
import { ActiveBotsSummary } from '@/components/dashboard/active-bots-summary';
import { BalanceDisplay } from '@/components/trading/balance-display';

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Overview</h1>
      <OverviewStats />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <ActiveBotsSummary />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add src/components/dashboard/ src/app/(dashboard)/dashboard/page.tsx
git commit -m "feat: create overview dashboard page with stats and bot summary"
```

### Task 6: Create Bots Page

**Files:**
- Create: `src/app/(dashboard)/dashboard/bots/page.tsx`

- [ ] **Step 1: Create the bots page**

```tsx
import { createClient } from '@/lib/supabase/server';
import { BotConfigForm } from '@/components/trading/bot-config-form';
import { BotsList } from '@/components/trading/bots-list';

export default async function BotsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Bots</h1>
      <BotConfigForm />
      <BotsList />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/(dashboard)/dashboard/bots/page.tsx
git commit -m "feat: create bots management page"
```

### Task 7: Create Accounts Page

**Files:**
- Create: `src/app/(dashboard)/dashboard/accounts/page.tsx`

- [ ] **Step 1: Create the accounts page**

```tsx
import { createClient } from '@/lib/supabase/server';
import { ConnectKeysForm } from '@/components/trading/connect-keys-form';
import { BalanceDisplay } from '@/components/trading/balance-display';

export default async function AccountsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Accounts</h1>
      <ConnectKeysForm />
      <BalanceDisplay />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/(dashboard)/dashboard/accounts/page.tsx
git commit -m "feat: create accounts page with API keys and balance"
```

### Task 8: Create Settings Page

**Files:**
- Create: `src/app/(dashboard)/dashboard/settings/page.tsx`

- [ ] **Step 1: Create the settings page**

```tsx
import { createClient } from '@/lib/supabase/server';
import { SymbolLeverageCard } from '@/components/trading/symbol-leverage-card';

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Settings</h1>
      <SymbolLeverageCard />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/(dashboard)/dashboard/settings/page.tsx
git commit -m "feat: create settings page with symbol leverage config"
```

### Task 9: Remove ThemeToggle from Root Layout

**Files:**
- Modify: `src/app/layout.tsx`

- [ ] **Step 1: Remove the fixed ThemeToggle from root layout**

The ThemeToggle is now in the Header component. Remove the fixed-position ThemeToggle from `layout.tsx` root to avoid duplication.

- [ ] **Step 2: Build and verify**

Run: `npm run build 2>&1 | head -30`
Expected: Build succeeds, no duplicate theme toggles

- [ ] **Step 3: Commit**

```bash
git add src/app/layout.tsx
git commit -m "refactor: move theme toggle from root layout to dashboard header"
```

## Chunk 3: Mobile-First Responsive Polish

### Task 10: Add Safe Area CSS and Mobile Polish

**Files:**
- Modify: `src/app/globals.css`

- [ ] **Step 1: Add safe area and mobile utility classes**

Add to globals.css:
```css
/* Safe area for mobile bottom nav */
.safe-area-pb {
  padding-bottom: env(safe-area-inset-bottom, 0px);
}

/* Prevent content from hiding behind bottom nav on mobile */
@media (max-width: 767px) {
  main {
    padding-bottom: 5rem;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/globals.css
git commit -m "feat: add mobile safe area CSS for bottom navigation"
```

### Task 11: Update Bot Config Form for Mobile

**Files:**
- Modify: `src/components/trading/bot-config-form.tsx`

- [ ] **Step 1: Update grid layout to stack on mobile**

Change the price inputs grid from `grid-cols-2` to `grid-cols-1 sm:grid-cols-2` so they stack on small screens.

- [ ] **Step 2: Commit**

```bash
git add src/components/trading/bot-config-form.tsx
git commit -m "feat: make bot config form mobile-responsive"
```

### Task 12: Update Edit Bot Modal for Mobile

**Files:**
- Modify: `src/components/trading/edit-bot-modal.tsx`

- [ ] **Step 1: Make modal full-screen on mobile**

Update the modal container classes:
- Mobile: full screen with `inset-0` or `inset-x-0 bottom-0` (bottom sheet pattern)
- Desktop: centered card with max-w-md

- [ ] **Step 2: Commit**

```bash
git add src/components/trading/edit-bot-modal.tsx
git commit -m "feat: make edit bot modal responsive with mobile bottom sheet"
```

### Task 13: Final Build Verification

- [ ] **Step 1: Run full build**

Run: `npm run build`
Expected: Build succeeds with no errors

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: No lint errors

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve any remaining build/lint issues from UI overhaul"
```
