import { describe, it, expect, beforeEach, vi } from 'vitest';
import { execute, type ExecutorConfig } from '@/lib/ai-pm/executor';
import type { ProposedAction } from '@/lib/ai-pm/decision.prompt';

const userId = '00000000-0000-0000-0000-000000000001';
const decisionId = '00000000-0000-0000-0000-000000000d10';
const apiKeyId = '00000000-0000-0000-0000-0000000000a0';
const otherApiKeyId = '00000000-0000-0000-0000-0000000000a1';
const botId = '00000000-0000-0000-0000-0000000000b0';

const realConfig: ExecutorConfig = { bingxApiKeyId: apiKeyId, paperMode: false };
const paperConfig: ExecutorConfig = { bingxApiKeyId: apiKeyId, paperMode: true };

interface TradingBotRow {
  id: string;
  userId: string;
  apiKeyId: string | null;
  status: 'RUNNING' | 'STOPPED';
}

interface DbState {
  trading: TradingBotRow[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeDb(state: DbState): any {
  return {
    query: {
      tradingBots: {
        findFirst: async () => state.trading[0] ?? null,
      },
    },
    update: () => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
      set: (_p: any) => ({
        where: () => ({
          returning: async () => state.trading.map((r) => ({ ...r, status: 'STOPPED' })),
        }),
      }),
    }),
  };
}

describe('execute', () => {
  let state: DbState;
  let createBotMock: ReturnType<typeof vi.fn>;
  let createPaperBotMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    state = { trading: [] };
    createBotMock = vi.fn(async () => ({ id: 'tb-1', userId, symbol: 'BTC-USDT' }));
    createPaperBotMock = vi.fn(async () => ({
      id: 'pb-1', userId, decisionId, symbol: 'BTC-USDT', strategy: 'DCA',
      capitalUsdt: '100', status: 'RUNNING' as const, pnlUsdt: '0',
      startedAt: new Date(), stoppedAt: null,
    }));
  });

  it('real-mode create_bot calls createBot with scoped apiKeyId', async () => {
    const action: ProposedAction = {
      type: 'create_bot', symbol: 'BTC-USDT', strategy: 'DCA',
      capitalUsdt: 100, leverage: 3, reasoning: 'r',
    };
    const result = await execute({
      userId, decisionId, action, config: realConfig,
      db: fakeDb(state) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createBotFn: createBotMock as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createPaperBotFn: createPaperBotMock as any,
    });
    expect(result.status).toBe('EXECUTED');
    expect(result.realBotId).toBe('tb-1');
    expect(createBotMock).toHaveBeenCalledOnce();
    expect(createBotMock.mock.calls[0][1].apiKeyId).toBe(apiKeyId);
    expect(createBotMock.mock.calls[0][1].botType).toBe('DCA');
    expect(createPaperBotMock).not.toHaveBeenCalled();
  });

  it('paper-mode create_bot writes paper_bots, skips real createBot', async () => {
    const action: ProposedAction = {
      type: 'create_bot', symbol: 'BTC-USDT', strategy: 'DCA',
      capitalUsdt: 100, leverage: 3, reasoning: 'r',
    };
    const result = await execute({
      userId, decisionId, action, config: paperConfig,
      db: fakeDb(state) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createBotFn: createBotMock as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createPaperBotFn: createPaperBotMock as any,
    });
    expect(result.status).toBe('EXECUTED');
    expect(result.paperBotId).toBe('pb-1');
    expect(createPaperBotMock).toHaveBeenCalledOnce();
    expect(createBotMock).not.toHaveBeenCalled();
  });

  it('stop_bot rejects when bot apiKeyId does not match config.bingxApiKeyId', async () => {
    state.trading.push({ id: botId, userId, apiKeyId: otherApiKeyId, status: 'RUNNING' });
    const action: ProposedAction = { type: 'stop_bot', botId, reasoning: 'risk' };
    const result = await execute({
      userId, decisionId, action, config: realConfig,
      db: fakeDb(state) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createBotFn: createBotMock as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createPaperBotFn: createPaperBotMock as any,
    });
    expect(result.status).toBe('EXECUTION_FAILED');
    expect(result.reason).toMatch(/apiKeyId/i);
  });

  it('stop_bot succeeds when apiKeyId matches', async () => {
    state.trading.push({ id: botId, userId, apiKeyId, status: 'RUNNING' });
    const action: ProposedAction = { type: 'stop_bot', botId, reasoning: 'risk' };
    const result = await execute({
      userId, decisionId, action, config: realConfig,
      db: fakeDb(state) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createBotFn: createBotMock as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createPaperBotFn: createPaperBotMock as any,
    });
    expect(result.status).toBe('EXECUTED');
  });

  it('no_action returns EXECUTED with no side effects', async () => {
    const result = await execute({
      userId, decisionId, action: { type: 'no_action', reasoning: 'idle' },
      config: realConfig, db: fakeDb(state) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createBotFn: createBotMock as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createPaperBotFn: createPaperBotMock as any,
    });
    expect(result.status).toBe('EXECUTED');
    expect(createBotMock).not.toHaveBeenCalled();
    expect(createPaperBotMock).not.toHaveBeenCalled();
  });

  it('adjust_params returns EXECUTION_FAILED (not implemented)', async () => {
    const result = await execute({
      userId, decisionId,
      action: { type: 'adjust_params', botId, params: { x: 1 }, reasoning: 'r' },
      config: realConfig, db: fakeDb(state) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createBotFn: createBotMock as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createPaperBotFn: createPaperBotMock as any,
    });
    expect(result.status).toBe('EXECUTION_FAILED');
    expect(result.reason).toMatch(/NOT_IMPLEMENTED/);
  });

  it('reallocate_capital returns EXECUTION_FAILED (not implemented)', async () => {
    const result = await execute({
      userId, decisionId,
      action: {
        type: 'reallocate_capital',
        fromBotId: botId,
        toBotId: '00000000-0000-0000-0000-0000000000b1',
        amountUsdt: 50,
        reasoning: 'r',
      },
      config: realConfig, db: fakeDb(state) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createBotFn: createBotMock as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createPaperBotFn: createPaperBotMock as any,
    });
    expect(result.status).toBe('EXECUTION_FAILED');
    expect(result.reason).toMatch(/NOT_IMPLEMENTED/);
  });
});
