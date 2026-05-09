import { defineConfig } from 'vitest/config';
import path from 'path';
import { config } from 'dotenv';

// Load .env.local first (real credentials for integration tests), then .env
config({ path: path.resolve(__dirname, '.env.local') });
config({ path: path.resolve(__dirname, '.env') });

export default defineConfig({
  test: {
    globals: true,
    fileParallelism: false,
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.claude/worktrees/**'],
    env: {
      // Fallbacks used only when not already set by .env.local / .env above
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test',
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
