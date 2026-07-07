'use client';

import { Button } from '@heroui/react';
import { useTranslations } from 'next-intl';
import { ThemeToggle } from '@/components/theme-toggle';
import { AccountSwitcher } from '@/components/layout/account-switcher';
import { MegaBrainLogo } from '@/components/brand/mega-brain-logo';
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
      <div className="flex items-center gap-3 min-w-0">
        <MegaBrainLogo className="md:hidden w-7 h-7" />
        <span className="md:hidden text-lg font-bold text-foreground shrink-0">Mega Brain</span>
        <div className="md:hidden min-w-0 max-w-[140px]">
          <AccountSwitcher />
        </div>
      </div>
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
