/**
 * Smoke-test helper: insert an AI PM config row in paper mode so ai-pm-tick
 * has a user to process. Picks the first bingx_api_key row by default.
 *
 * Usage:
 *   ENCRYPTION_KEY="..." DATABASE_URL="..." \
 *     bunx tsx scripts/insert-paper-config.ts <anthropic-key> \
 *     [--user <user_uuid>] [--apikey <bingx_api_key_uuid>] \
 *     [--budget 50] [--max-bots 5]
 *
 * Delete after Settings UI (S12) ships.
 */

import postgres from 'postgres';
import { config as loadEnv } from 'dotenv';
import { encryptSecret } from '@/lib/bingx/encryption';

loadEnv({ path: '.env.local' });
loadEnv();

interface Args {
  anthropicKey: string;
  userId?: string;
  apiKeyId?: string;
  budgetUsd: number;
  maxBots: number;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      flags.set(a.slice(2), argv[++i] ?? '');
    } else {
      positional.push(a);
    }
  }
  const anthropicKey = positional[0] ?? process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    console.error('usage: insert-paper-config.ts <anthropic-key> [--user UUID] [--apikey UUID] [--budget N] [--max-bots N]');
    console.error('       (or set ANTHROPIC_API_KEY env var)');
    process.exit(1);
  }
  return {
    anthropicKey,
    userId: flags.get('user'),
    apiKeyId: flags.get('apikey'),
    budgetUsd: Number(flags.get('budget') ?? 50),
    maxBots: Number(flags.get('max-bots') ?? 5),
  };
}

async function main() {
  if (!process.env.ENCRYPTION_KEY) {
    console.error('ENCRYPTION_KEY env var required');
    process.exit(1);
  }
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL or DIRECT_URL required');
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));
  const sql = postgres(url, { prepare: false, max: 1 });

  try {
    let userId = args.userId;
    let apiKeyId = args.apiKeyId;

    if (!apiKeyId) {
      const rows = userId
        ? await sql<{ id: string; user_id: string }[]>`
            SELECT id, user_id FROM bingx_api_keys WHERE user_id = ${userId} ORDER BY created_at ASC LIMIT 1
          `
        : await sql<{ id: string; user_id: string }[]>`
            SELECT id, user_id FROM bingx_api_keys ORDER BY created_at ASC LIMIT 1
          `;
      if (rows.length === 0) {
        console.error('no bingx_api_keys row found; create one via the UI first');
        process.exit(1);
      }
      apiKeyId = rows[0].id;
      userId = userId ?? rows[0].user_id;
    } else if (!userId) {
      const rows = await sql<{ user_id: string }[]>`
        SELECT user_id FROM bingx_api_keys WHERE id = ${apiKeyId}
      `;
      if (rows.length === 0) {
        console.error(`bingx_api_key ${apiKeyId} not found`);
        process.exit(1);
      }
      userId = rows[0].user_id;
    }

    const existing = await sql<{ id: string }[]>`
      SELECT id FROM ai_pm_configs WHERE bingx_api_key_id = ${apiKeyId!}
    `;
    if (existing.length > 0) {
      console.error(`ai_pm_configs row already exists for bingx_api_key_id=${apiKeyId} (id=${existing[0].id}); update enabled/paper_mode via UPDATE instead`);
      process.exit(1);
    }

    const encrypted = encryptSecret(args.anthropicKey);
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO ai_pm_configs (
        user_id, bingx_api_key_id, anthropic_api_key_encrypted,
        enabled, paper_mode, mode, max_concurrent_bots,
        monthly_llm_budget_usd, kill_switch
      ) VALUES (
        ${userId!}, ${apiKeyId!}, ${encrypted},
        true, true, 'BALANCED', ${args.maxBots},
        ${args.budgetUsd}, false
      )
      RETURNING id
    `;

    console.log(JSON.stringify({
      ok: true,
      configId: inserted[0].id,
      userId,
      bingxApiKeyId: apiKeyId,
      enabled: true,
      paperMode: true,
      maxConcurrentBots: args.maxBots,
      monthlyLlmBudgetUsd: args.budgetUsd,
    }, null, 2));
  } finally {
    await sql.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
