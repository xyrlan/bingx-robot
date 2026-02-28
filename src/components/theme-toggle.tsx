'use client';

import { useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@heroui/react';
import { setThemeAction } from '@/app/actions/theme';
import type { Theme } from '@/lib/theme';

interface ThemeToggleProps {
  initialTheme: Theme;
  /** CSS class for font variable (e.g. from next/font) - preserved when switching theme */
  fontVariableClass?: string;
}

/**
 * Client component to toggle between light and dark mode.
 * Persists preference via cookie.
 */
export function ThemeToggle({ initialTheme, fontVariableClass }: ThemeToggleProps) {
  const t = useTranslations('Theme');
  const [theme, setTheme] = useState<Theme>(initialTheme);

  const toggleTheme = async () => {
    const nextTheme: Theme = theme === 'dark' ? 'light' : 'dark';

    // Update state and DOM immediately for instant feedback
    setTheme(nextTheme);
    const classes = fontVariableClass ? `${nextTheme} ${fontVariableClass}` : nextTheme;
    document.documentElement.className = classes;
    document.documentElement.setAttribute('data-theme', nextTheme);

    await setThemeAction(nextTheme);
  };

  return (
    <Button
      variant="secondary"
      isIconOnly
      size="sm"
      onPress={toggleTheme}
      aria-label={t('toggle')}
    >
      {theme === 'dark' ? (
        <Sun className="size-5" />
      ) : (
        <Moon className="size-5" />
      )}
    </Button>
  );
}
