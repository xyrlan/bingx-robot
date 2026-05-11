import { describe, it, expect, beforeEach } from 'vitest';
import {
  createPaperBot,
  stopPaperBot,
  getPaperBotById,
  type PaperBotRow,
} from '@/services/paper-bots.service';

interface DbState {
  rows: PaperBotRow[];
  lastInsertValues?: Record<string, unknown>;
  lastUpdatePatch?: Record<string, unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeDb(state: DbState): any {
  return {
    insert: () => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      values: (vals: any) => {
        const v = Array.isArray(vals) ? vals[0] : vals;
        state.lastInsertValues = v;
        return {
          returning: async () => {
            const row: PaperBotRow = {
              id: `pb-${state.rows.length}`,
              userId: v.userId,
              decisionId: v.decisionId ?? null,
              symbol: v.symbol,
              strategy: v.strategy,
              capitalUsdt: v.capitalUsdt,
              status: v.status ?? 'RUNNING',
              pnlUsdt: '0',
              startedAt: v.startedAt ?? null,
              stoppedAt: null,
            };
            state.rows.push(row);
            return [row];
          },
        };
      },
    }),
    update: () => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      set: (patch: any) => {
        state.lastUpdatePatch = patch;
        return {
          where: () => ({
            returning: async () => {
              // For test: stop the most recently inserted row
              const target = state.rows[state.rows.length - 1];
              if (!target) return [];
              const updated: PaperBotRow = { ...target, ...patch };
              state.rows[state.rows.length - 1] = updated;
              return [updated];
            },
          }),
        };
      },
    }),
    query: {
      paperBots: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
        findFirst: async (_args: any) => state.rows[0] ?? null,
      },
    },
  };
}

const userId = '00000000-0000-0000-0000-000000000001';

describe('paper-bots service', () => {
  let state: DbState;
  beforeEach(() => {
    state = { rows: [] };
  });

  it('createPaperBot inserts a row with RUNNING status and returns it', async () => {
    const row = await createPaperBot(fakeDb(state) as never, {
      userId,
      decisionId: null,
      symbol: 'BTC-USDT',
      strategy: 'DCA',
      capitalUsdt: 100,
      params: { foo: 'bar' },
    });
    expect(row.symbol).toBe('BTC-USDT');
    expect(row.status).toBe('RUNNING');
    expect(row.capitalUsdt).toBe('100');
    expect(state.rows).toHaveLength(1);
    expect(state.lastInsertValues?.userId).toBe(userId);
    expect(state.lastInsertValues?.strategy).toBe('DCA');
  });

  it('stopPaperBot updates status to STOPPED and sets stoppedAt', async () => {
    await createPaperBot(fakeDb(state) as never, {
      userId, decisionId: null, symbol: 'BTC-USDT', strategy: 'DCA', capitalUsdt: 100, params: {},
    });
    const updated = await stopPaperBot(fakeDb(state) as never, userId, state.rows[0].id);
    expect(updated?.status).toBe('STOPPED');
    expect(state.lastUpdatePatch?.status).toBe('STOPPED');
    expect(state.lastUpdatePatch?.stoppedAt).toBeInstanceOf(Date);
  });

  it('stopPaperBot returns null when no row matches', async () => {
    // override fakeDb to simulate no match
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const emptyDb: any = {
      update: () => ({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
        set: (_p: any) => ({ where: () => ({ returning: async () => [] }) }),
      }),
    };
    const result = await stopPaperBot(emptyDb, userId, 'nope');
    expect(result).toBeNull();
  });

  it('getPaperBotById returns the row', async () => {
    await createPaperBot(fakeDb(state) as never, {
      userId, decisionId: null, symbol: 'BTC-USDT', strategy: 'DCA', capitalUsdt: 100, params: {},
    });
    const row = await getPaperBotById(fakeDb(state) as never, userId, state.rows[0].id);
    expect(row?.symbol).toBe('BTC-USDT');
  });
});
