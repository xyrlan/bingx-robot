/**
 * One-off helper to encrypt an Anthropic API key for direct SQL insertion
 * into ai_pm_configs.anthropic_api_key_encrypted.
 *
 * Usage:
 *   ENCRYPTION_KEY="<your-prod-encryption-key>" bunx tsx scripts/encrypt-anthropic-key.ts sk-ant-...
 *
 * The output is the exact string to put in the encrypted column.
 * Delete this script after smoke test; Settings UI (S12) replaces it.
 */

import { encryptSecret } from '@/lib/bingx/encryption';

const plaintext = process.argv[2];
if (!plaintext) {
  console.error('usage: bunx tsx scripts/encrypt-anthropic-key.ts <anthropic-key>');
  process.exit(1);
}
if (!process.env.ENCRYPTION_KEY) {
  console.error('ENCRYPTION_KEY env var required (use prod value)');
  process.exit(1);
}

console.log(encryptSecret(plaintext));
