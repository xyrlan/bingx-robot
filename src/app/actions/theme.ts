'use server';

import { cookies } from 'next/headers';
import { THEME_COOKIE_NAME, type Theme } from '@/lib/theme';

const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

/**
 * Server Action to set theme preference in cookie.
 * Persists user's light/dark theme choice across sessions.
 */
export async function setThemeAction(theme: Theme): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(THEME_COOKIE_NAME, theme, {
    path: '/',
    maxAge: THEME_COOKIE_MAX_AGE,
    sameSite: 'lax',
  });
}
