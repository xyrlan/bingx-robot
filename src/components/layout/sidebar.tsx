'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  LayoutDashboard,
  Bot,
  KeyRound,
  Settings,
  Sparkles,
  Activity,
  MessageSquare,
} from 'lucide-react';
import { AccountSwitcher } from './account-switcher';

const navItems = [
  { href: '/dashboard', icon: LayoutDashboard, labelKey: 'overview' },
  { href: '/dashboard/bots', icon: Bot, labelKey: 'bots' },
  { href: '/dashboard/ai-pm', icon: Sparkles, labelKey: 'aiPm' },
  { href: '/dashboard/ai-pm/activity', icon: Activity, labelKey: 'aiActivity' },
  { href: '/dashboard/ai-pm/chat', icon: MessageSquare, labelKey: 'aiChat' },
  { href: '/dashboard/accounts', icon: KeyRound, labelKey: 'accounts' },
  { href: '/dashboard/settings', icon: Settings, labelKey: 'settings' },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const t = useTranslations('Nav');

  const isActive = (href: string) => {
    if (href === '/dashboard') return pathname === '/dashboard';
    if (href === '/dashboard/ai-pm') return pathname === '/dashboard/ai-pm';
    return pathname.startsWith(href);
  };

  return (
    <>
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex md:flex-col md:w-64 md:fixed md:inset-y-0 border-r border-default-200 bg-background z-40">
        <div className="flex items-center h-16 px-6 border-b border-default-200">
          <span className="text-lg font-bold text-foreground">BingX Bot</span>
        </div>
        <AccountSwitcher />
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
                className={`flex flex-col items-center gap-1 px-4 py-3 text-xs font-medium transition-colors touch-manipulation ${
                  active ? 'text-accent' : 'text-muted'
                }`}
              >
                <item.icon className="w-6 h-6" />
                <span>{t(item.labelKey)}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
