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
      <span className="md:hidden text-lg font-bold text-foreground">BingX Bot</span>
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
