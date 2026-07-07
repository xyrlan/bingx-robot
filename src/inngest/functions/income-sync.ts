import { inngest } from '@/inngest/client';
import {
  listApiKeyIdsForIncomeSync,
  syncIncomeForApiKey,
} from '@/services/income-sync.service';

/**
 * Hourly sync of real exchange income (fills: realized PnL + fees) into
 * bot_income_records. Feeds the "real" P&L numbers on the bots page;
 * bots without synced rows fall back to watcher estimates.
 */
export const incomeSync = inngest.createFunction(
  {
    id: 'income-sync',
    name: 'Income Sync (real P&L)',
    retries: 2,
    concurrency: { limit: 1 },
  },
  { cron: '17 * * * *' },
  async ({ step, logger }) => {
    const apiKeyIds = await step.run('list-api-keys', () => listApiKeyIdsForIncomeSync());

    let inserted = 0;
    for (const apiKeyId of apiKeyIds) {
      const result = await step.run(`sync-${apiKeyId}`, () => syncIncomeForApiKey(apiKeyId));
      inserted += result.inserted;
      if (result.inserted > 0) {
        logger.info(
          `[IncomeSync] key ${apiKeyId}: +${result.inserted} records (${result.orders} orders, ${result.windows} windows)`
        );
      }
    }

    return { apiKeys: apiKeyIds.length, inserted };
  }
);
