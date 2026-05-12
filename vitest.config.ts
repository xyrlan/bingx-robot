import { defineConfig } from 'vitest/config';
import path from 'path';
import { config } from 'dotenv';

// Load .env.test first so it wins over .env.local. If absent, fall back to
// the developer's .env.local (legacy behavior — still functional for solo
// development against a personal Supabase instance, NEVER for a shared one).
config({ path: path.resolve(__dirname, '.env.test') });
config({ path: path.resolve(__dirname, '.env.local') });
config({ path: path.resolve(__dirname, '.env') });

// Prefer the test-only URL. If not set, fall through to DATABASE_URL but
// guard against shared production databases.
const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';

function looksLikeSharedProduction(url: string): boolean {
  // Heuristic: any Supabase pooler hostname (pooler.supabase.com /
  // pooler.supabase.co). Local Docker or a dedicated test branch will not
  // match — overrides via TEST_DATABASE_ALLOW_PROD=1 are honored.
  if (process.env.TEST_DATABASE_ALLOW_PROD === '1') return false;
  return /\.pooler\.supabase\.(com|co)/i.test(url);
}

if (looksLikeSharedProduction(TEST_DB_URL)) {
  // eslint-disable-next-line no-console
  console.error(
    '[vitest] Refusing to run tests against a shared Supabase pooler URL.\n' +
    '  - Set TEST_DATABASE_URL in .env.test pointing at an isolated test database.\n' +
    '  - Or, if you really know what you are doing, set TEST_DATABASE_ALLOW_PROD=1.\n' +
    '  - Current URL host: ' + (TEST_DB_URL.split('@')[1]?.split('/')[0] ?? '<unparseable>'),
  );
  process.exit(2);
}

export default defineConfig({
  test: {
    globals: true,
    fileParallelism: false,
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.claude/worktrees/**'],
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    env: {
      DATABASE_URL: TEST_DB_URL || 'postgresql://test:test@localhost:5432/test',
      DIRECT_URL: process.env.TEST_DIRECT_URL ?? process.env.DIRECT_URL ?? TEST_DB_URL ?? 'postgresql://test:test@localhost:5432/test',
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://test.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? 'test-anon-key',
      ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? 'a]32-char-test-encryption-key!!a',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
