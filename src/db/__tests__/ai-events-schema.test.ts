import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { aiEvents, aiPmFundingCache, aiEventStatusEnum } from '@/db/schema';

describe('ai_events schema', () => {
  it('exposes aiEvents table with required columns', () => {
    const cols = getTableColumns(aiEvents);
    expect(cols).toHaveProperty('id');
    expect(cols).toHaveProperty('configId');
    expect(cols).toHaveProperty('userId');
    expect(cols).toHaveProperty('eventType');
    expect(cols).toHaveProperty('symbol');
    expect(cols).toHaveProperty('payload');
    expect(cols).toHaveProperty('status');
    expect(cols).toHaveProperty('decisionId');
    expect(cols).toHaveProperty('emittedAt');
    expect(cols).toHaveProperty('processedAt');
    expect(cols).toHaveProperty('createdAt');
  });

  it('exposes aiPmFundingCache table with required columns', () => {
    const cols = getTableColumns(aiPmFundingCache);
    expect(cols).toHaveProperty('id');
    expect(cols).toHaveProperty('configId');
    expect(cols).toHaveProperty('symbol');
    expect(cols).toHaveProperty('fundingRate');
    expect(cols).toHaveProperty('observedAt');
  });

  it('aiEventStatusEnum contains all states', () => {
    expect(aiEventStatusEnum.enumValues).toEqual([
      'PENDING',
      'THROTTLED',
      'PROCESSING',
      'PROCESSED',
      'FAILED',
    ]);
  });
});
