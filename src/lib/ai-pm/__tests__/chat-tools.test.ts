import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { db } from '@/db';
import { users, aiChatMessages, aiDecisions, aiSignals, tradingBots, bingxApiKeys, aiPmConfigs } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { executeTool, ALL_TOOL_DEFINITIONS } from '@/lib/ai-pm/chat-tools';
import type { ToolExecContext } from '@/lib/ai-pm/chat-tools';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000080';
const CONFIG_ID = '00000000-0000-0000-0000-000000000081';
const API_KEY_ID = '00000000-0000-0000-0000-000000000082';

function makeCtx(overrides: Partial<ToolExecContext> = {}): ToolExecContext {
  return {
    userId: TEST_USER_ID,
    configId: CONFIG_ID,
    chatMessageId: null,
    portfolioState: { runningBots: [], capitalUsedUsdt: 0, bingxApiKeyId: API_KEY_ID },
    config: {
      id: CONFIG_ID,
      userId: TEST_USER_ID,
      bingxApiKeyId: API_KEY_ID,
      anthropicApiKey: 'sk-test',
      enabled: true,
      mode: 'BALANCED',
      maxCapitalUsdt: '1000',
      maxDrawdownPct: '20',
      maxLeverage: 5,
      allowedSymbols: ['BTC-USDT'],
      allowedStrategies: ['DCA', 'TRAILING_STOP', 'DCA_SPOT', 'SMA_CROSSOVER'],
      maxConcurrentBots: 5,
      monthlyLlmBudgetUsd: '100',
      killSwitch: false,
      paperMode: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    db,
    validateFn: vi.fn(),
    executeFn: vi.fn(),
    setKillSwitchFn: vi.fn(),
    ...overrides,
  };
}

async function ensureUser() {
  await db.insert(users).values({ id: TEST_USER_ID, email: 'chat-tools@example.com' }).onConflictDoNothing();
  await db.insert(bingxApiKeys).values({
    id: API_KEY_ID,
    userId: TEST_USER_ID,
    label: 'test-key',
    apiKey: 'plain',
    secretKeyEncrypted: 'enc',
  }).onConflictDoNothing();
}

async function cleanup() {
  await db.delete(aiDecisions).where(eq(aiDecisions.userId, TEST_USER_ID));
  await db.delete(aiSignals).where(eq(aiSignals.userId, TEST_USER_ID));
  await db.delete(tradingBots).where(eq(tradingBots.userId, TEST_USER_ID));
  await db.delete(aiChatMessages).where(eq(aiChatMessages.userId, TEST_USER_ID));
  await db.delete(aiPmConfigs).where(eq(aiPmConfigs.userId, TEST_USER_ID));
}

async function insertDecisionRow(actionType: string): Promise<string> {
  const [row] = await db.insert(aiDecisions).values({
    userId: TEST_USER_ID,
    triggeredBy: 'CHAT',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    actionType: actionType as any,
    status: 'PROPOSED',
  }).returning();
  return row.id;
}

describe('chat-tools', () => {
  beforeAll(async () => { await ensureUser(); await cleanup(); });
  afterEach(async () => { await cleanup(); });

  it('exports ALL_TOOL_DEFINITIONS with 19 tools', () => {
    expect(ALL_TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual([
      'adjust_params', 'cancel_all_orders', 'cancel_order', 'close_position', 'create_bot',
      'pause_kill_switch', 'place_limit_order', 'place_market_order', 'place_stop_order',
      'place_take_profit', 'place_trailing_stop', 'read_balance', 'read_decisions',
      'read_open_orders', 'read_portfolio', 'read_positions', 'read_signals',
      'reallocate_capital', 'stop_bot',
    ].sort());
  });

  it('place_market_order dispatches and surfaces resultOrderId in summary', async () => {
    const id = await insertDecisionRow('PLACE_MARKET_ORDER');
    const validateFn = vi.fn().mockResolvedValue({ status: 'PROPOSED', decisionId: id });
    const executeFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: id, resultOrderId: 'abc12345' });
    const ctx = makeCtx({ validateFn, executeFn });
    const got = await executeTool('place_market_order', {
      symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG',
      capitalUsdt: 100, leverage: 5, reasoning: 'test',
    }, ctx);
    expect(got.status).toBe('EXECUTED');
    expect(got.summary).toMatch(/abc12345/);
  });

  it('place_limit_order dispatches', async () => {
    const id = await insertDecisionRow('PLACE_LIMIT_ORDER');
    const validateFn = vi.fn().mockResolvedValue({ status: 'PROPOSED', decisionId: id });
    const executeFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: id, resultOrderId: 'lim-1' });
    const ctx = makeCtx({ validateFn, executeFn });
    const got = await executeTool('place_limit_order', {
      symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG',
      price: 49000, capitalUsdt: 50, leverage: 3, reasoning: 'r',
    }, ctx);
    expect(got.status).toBe('EXECUTED');
    expect(validateFn).toHaveBeenCalledOnce();
  });

  it('place_stop_order dispatches', async () => {
    const id = await insertDecisionRow('PLACE_STOP_ORDER');
    const validateFn = vi.fn().mockResolvedValue({ status: 'PROPOSED', decisionId: id });
    const executeFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: id, resultOrderId: 'stop-1' });
    const ctx = makeCtx({ validateFn, executeFn });
    const got = await executeTool('place_stop_order', {
      symbol: 'BTC-USDT', side: 'SELL', positionSide: 'SHORT',
      stopPrice: 60000, capitalUsdt: 50, leverage: 3, reasoning: 'r',
    }, ctx);
    expect(got.status).toBe('EXECUTED');
  });

  it('place_take_profit dispatches', async () => {
    const id = await insertDecisionRow('PLACE_TAKE_PROFIT');
    const validateFn = vi.fn().mockResolvedValue({ status: 'PROPOSED', decisionId: id });
    const executeFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: id, resultOrderId: 'tp-1' });
    const ctx = makeCtx({ validateFn, executeFn });
    const got = await executeTool('place_take_profit', {
      symbol: 'BTC-USDT', side: 'SELL', positionSide: 'LONG',
      stopPrice: 60000, capitalUsdt: 50, leverage: 3, reasoning: 'r',
    }, ctx);
    expect(got.status).toBe('EXECUTED');
  });

  it('place_trailing_stop dispatches', async () => {
    const id = await insertDecisionRow('PLACE_TRAILING_STOP');
    const validateFn = vi.fn().mockResolvedValue({ status: 'PROPOSED', decisionId: id });
    const executeFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: id, resultOrderId: 'tr-1' });
    const ctx = makeCtx({ validateFn, executeFn });
    const got = await executeTool('place_trailing_stop', {
      symbol: 'BTC-USDT', side: 'SELL', positionSide: 'LONG',
      capitalUsdt: 50, leverage: 3, callbackRate: 0.05, reasoning: 'r',
    }, ctx);
    expect(got.status).toBe('EXECUTED');
  });

  it('close_position dispatches', async () => {
    const id = await insertDecisionRow('CLOSE_POSITION');
    const validateFn = vi.fn().mockResolvedValue({ status: 'PROPOSED', decisionId: id });
    const executeFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: id });
    const ctx = makeCtx({ validateFn, executeFn });
    const got = await executeTool('close_position', {
      symbol: 'BTC-USDT', reasoning: 'r',
    }, ctx);
    expect(got.status).toBe('EXECUTED');
  });

  it('cancel_order dispatches', async () => {
    const id = await insertDecisionRow('CANCEL_ORDER');
    const validateFn = vi.fn().mockResolvedValue({ status: 'PROPOSED', decisionId: id });
    const executeFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: id });
    const ctx = makeCtx({ validateFn, executeFn });
    const got = await executeTool('cancel_order', {
      symbol: 'BTC-USDT', orderId: '99', reasoning: 'r',
    }, ctx);
    expect(got.status).toBe('EXECUTED');
  });

  it('cancel_all_orders dispatches', async () => {
    const id = await insertDecisionRow('CANCEL_ALL_ORDERS');
    const validateFn = vi.fn().mockResolvedValue({ status: 'PROPOSED', decisionId: id });
    const executeFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: id });
    const ctx = makeCtx({ validateFn, executeFn });
    const got = await executeTool('cancel_all_orders', {
      reasoning: 'r',
    }, ctx);
    expect(got.status).toBe('EXECUTED');
  });

  it('place_market_order flips ai_decisions.status from PROPOSED to EXECUTED in DB', async () => {
    const [row] = await db.insert(aiDecisions).values({
      userId: TEST_USER_ID, triggeredBy: 'CHAT', actionType: 'PLACE_MARKET_ORDER', status: 'PROPOSED',
    }).returning();
    const validateFn = vi.fn().mockResolvedValue({ status: 'PROPOSED', decisionId: row.id });
    const executeFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: row.id, resultOrderId: 'real-7' });
    const ctx = makeCtx({ validateFn, executeFn });
    await executeTool('place_market_order', {
      symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG', capitalUsdt: 100, leverage: 5, reasoning: 'r',
    }, ctx);
    const [after] = await db.select().from(aiDecisions).where(eq(aiDecisions.id, row.id));
    expect(after.status).toBe('EXECUTED');
    expect(after.executedAt).toBeInstanceOf(Date);
  });

  it('place_market_order flips status to EXECUTION_FAILED with rejectionReason on exec failure', async () => {
    const [row] = await db.insert(aiDecisions).values({
      userId: TEST_USER_ID, triggeredBy: 'CHAT', actionType: 'PLACE_MARKET_ORDER', status: 'PROPOSED',
    }).returning();
    const validateFn = vi.fn().mockResolvedValue({ status: 'PROPOSED', decisionId: row.id });
    const executeFn = vi.fn().mockResolvedValue({ status: 'EXECUTION_FAILED', decisionId: row.id, reason: 'BingX error 80014: bad symbol' });
    const ctx = makeCtx({ validateFn, executeFn });
    await executeTool('place_market_order', {
      symbol: 'XYZ-USDT', side: 'BUY', positionSide: 'LONG', capitalUsdt: 100, leverage: 5, reasoning: 'r',
    }, ctx);
    const [after] = await db.select().from(aiDecisions).where(eq(aiDecisions.id, row.id));
    expect(after.status).toBe('EXECUTION_FAILED');
    expect(after.rejectionReason).toMatch(/80014/);
  });

  it('create_bot flips ai_decisions.status from PROPOSED to EXECUTED in DB', async () => {
    const [row] = await db.insert(aiDecisions).values({
      userId: TEST_USER_ID, triggeredBy: 'CHAT', actionType: 'CREATE_BOT', status: 'PROPOSED',
    }).returning();
    const validateFn = vi.fn().mockResolvedValue({ status: 'PROPOSED', decisionId: row.id });
    const executeFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: row.id, paperBotId: 'paper-1' });
    const ctx = makeCtx({ validateFn, executeFn });
    await executeTool('create_bot', {
      symbol: 'BTC-USDT', strategy: 'DCA', capitalUsdt: 100, leverage: 2, reasoning: 'r',
    }, ctx);
    const [after] = await db.select().from(aiDecisions).where(eq(aiDecisions.id, row.id));
    expect(after.status).toBe('EXECUTED');
  });

  it('place_market_order refuses on kill switch', async () => {
    const validateFn = vi.fn();
    const ctx = makeCtx({ validateFn, config: { ...makeCtx().config, killSwitch: true } });
    const got = await executeTool('place_market_order', {
      symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG',
      capitalUsdt: 100, leverage: 5, reasoning: 'r',
    }, ctx);
    expect(validateFn).not.toHaveBeenCalled();
    expect(got.status).toBe('EXECUTION_FAILED');
    expect(got.summary).toMatch(/kill switch/i);
  });

  it('read_portfolio returns the snapshot', async () => {
    const ctx = makeCtx({ portfolioState: { runningBots: [{ id: 'b1', symbol: 'BTC-USDT', strategy: 'DCA', capitalUsdt: 100, leverage: 2, status: 'RUNNING' }], capitalUsedUsdt: 100, bingxApiKeyId: API_KEY_ID } });
    const got = await executeTool('read_portfolio', {}, ctx);
    expect(got.status).toBe('EXECUTED');
    expect(got.decisionId).toBeNull();
    expect(got.payload).toEqual(ctx.portfolioState);
    expect(got.summary).toMatch(/1 bot/);
  });

  it('read_signals queries db and returns rows', async () => {
    await db.insert(aiSignals).values([
      { userId: TEST_USER_ID, symbol: 'BTC-USDT', regime: 'TRENDING', score: 80, reason: 'r' },
    ]);
    const ctx = makeCtx();
    const got = await executeTool('read_signals', { limit: 5 }, ctx);
    expect(got.status).toBe('EXECUTED');
    expect(got.decisionId).toBeNull();
    expect(Array.isArray(got.payload)).toBe(true);
    expect((got.payload as unknown[]).length).toBe(1);
  });

  it('read_decisions filters by status when provided', async () => {
    await db.insert(aiDecisions).values([
      { userId: TEST_USER_ID, triggeredBy: 'CHAT', actionType: 'NO_ACTION', status: 'EXECUTED' },
      { userId: TEST_USER_ID, triggeredBy: 'CHAT', actionType: 'NO_ACTION', status: 'REJECTED_GUARDRAIL' },
    ]);
    const ctx = makeCtx();
    const got = await executeTool('read_decisions', { limit: 10, status: 'EXECUTED' }, ctx);
    expect(got.status).toBe('EXECUTED');
    expect((got.payload as Array<{ status: string }>).every(d => d.status === 'EXECUTED')).toBe(true);
  });

  it('create_bot routes through validate+execute and returns decisionId', async () => {
    const id = await insertDecisionRow('CREATE_BOT');
    const validateFn = vi.fn().mockResolvedValue({ status: 'PROPOSED', decisionId: id });
    const executeFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: id, paperBotId: 'paper-1' });
    const ctx = makeCtx({ validateFn, executeFn });
    const got = await executeTool('create_bot', {
      symbol: 'BTC-USDT', strategy: 'DCA', capitalUsdt: 100, leverage: 2, reasoning: 'test',
    }, ctx);
    expect(validateFn).toHaveBeenCalledOnce();
    expect(executeFn).toHaveBeenCalledOnce();
    expect(got.status).toBe('EXECUTED');
    expect(got.decisionId).toBe(id);
  });

  it('create_bot returns REJECTED_GUARDRAIL when validate rejects', async () => {
    const validateFn = vi.fn().mockResolvedValue({ status: 'REJECTED_GUARDRAIL', decisionId: 'dec-2', reason: 'leverage too high' });
    const executeFn = vi.fn();
    const ctx = makeCtx({ validateFn, executeFn });
    const got = await executeTool('create_bot', {
      symbol: 'BTC-USDT', strategy: 'DCA', capitalUsdt: 100, leverage: 6, reasoning: 'test',
    }, ctx);
    expect(executeFn).not.toHaveBeenCalled();
    expect(got.status).toBe('REJECTED_GUARDRAIL');
    expect(got.summary).toMatch(/leverage/);
  });

  it('stop_bot routes through validate+execute', async () => {
    const id = await insertDecisionRow('STOP_BOT');
    const validateFn = vi.fn().mockResolvedValue({ status: 'PROPOSED', decisionId: id });
    const executeFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: id });
    const ctx = makeCtx({ validateFn, executeFn });
    const got = await executeTool('stop_bot', {
      botId: '11111111-2222-4333-8444-555555555555',
      reasoning: 'risk off',
    }, ctx);
    expect(got.status).toBe('EXECUTED');
    expect(got.decisionId).toBe(id);
  });

  it('pause_kill_switch flips switch and inserts NO_ACTION decision', async () => {
    await db.insert(aiPmConfigs).values({
      id: CONFIG_ID,
      userId: TEST_USER_ID,
      bingxApiKeyId: API_KEY_ID,
      anthropicApiKeyEncrypted: 'enc',
      enabled: true,
    });
    const setKillSwitchFn = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ setKillSwitchFn });
    const got = await executeTool('pause_kill_switch', { reason: 'too volatile' }, ctx);
    expect(setKillSwitchFn).toHaveBeenCalledWith(CONFIG_ID, true);
    expect(got.status).toBe('EXECUTED');
    expect(got.decisionId).toBeTruthy();
    const rows = await db.select().from(aiDecisions).where(eq(aiDecisions.userId, TEST_USER_ID));
    expect(rows[0].actionType).toBe('NO_ACTION');
    expect(rows[0].reasoning).toBe('too volatile');
  });

  it('mutating tools refuse when kill switch is active', async () => {
    const validateFn = vi.fn();
    const executeFn = vi.fn();
    const ctx = makeCtx({
      validateFn,
      executeFn,
      config: { ...makeCtx().config, killSwitch: true },
    });
    const got = await executeTool('create_bot', {
      symbol: 'BTC-USDT', strategy: 'DCA', capitalUsdt: 100, leverage: 2, reasoning: 'r',
    }, ctx);
    expect(validateFn).not.toHaveBeenCalled();
    expect(got.status).toBe('EXECUTION_FAILED');
    expect(got.summary).toMatch(/kill switch/i);
  });

  it('adjust_params dispatches through validate+execute', async () => {
    const id = await insertDecisionRow('ADJUST_PARAMS');
    const validateFn = vi.fn().mockResolvedValue({ status: 'PROPOSED', decisionId: id });
    const executeFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: id, realBotId: 'bot-1' });
    const ctx = makeCtx({ validateFn, executeFn });
    const got = await executeTool('adjust_params', {
      botId: '11111111-2222-4333-8444-555555555555',
      params: { capitalUsdt: 200, leverage: 3 },
      reasoning: 'tighten',
    }, ctx);
    expect(validateFn).toHaveBeenCalledOnce();
    expect(executeFn).toHaveBeenCalledOnce();
    expect(got.status).toBe('EXECUTED');
    expect(got.decisionId).toBe(id);
  });

  it('reallocate_capital dispatches through validate+execute', async () => {
    const id = await insertDecisionRow('REALLOCATE_CAPITAL');
    const validateFn = vi.fn().mockResolvedValue({ status: 'PROPOSED', decisionId: id });
    const executeFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: id });
    const ctx = makeCtx({ validateFn, executeFn });
    const got = await executeTool('reallocate_capital', {
      fromBotId: '11111111-2222-4333-8444-555555555555',
      toBotId: '22222222-2222-4333-8444-555555555555',
      amountUsdt: 50,
      reasoning: 'move',
    }, ctx);
    expect(validateFn).toHaveBeenCalledOnce();
    expect(executeFn).toHaveBeenCalledOnce();
    expect(got.status).toBe('EXECUTED');
  });

  it('mutating adjust/reallocate also refuse on kill switch', async () => {
    const validateFn = vi.fn();
    const ctx = makeCtx({
      validateFn,
      config: { ...makeCtx().config, killSwitch: true },
    });
    const got = await executeTool('adjust_params', {
      botId: '11111111-2222-4333-8444-555555555555',
      params: { capitalUsdt: 200 },
      reasoning: 'r',
    }, ctx);
    expect(validateFn).not.toHaveBeenCalled();
    expect(got.status).toBe('EXECUTION_FAILED');
    expect(got.summary).toMatch(/kill switch/i);
  });

  it('read_balance returns balance from getFuturesBalanceFn', async () => {
    const getFuturesBalanceFn = vi.fn().mockResolvedValue({
      availableUsdt: '900', equityUsdt: '1000', marginUsedUsdt: '100', unrealizedPnlUsdt: '0',
    });
    const ctx = makeCtx({ getFuturesBalanceFn, bingxClient: {} as ToolExecContext['bingxClient'] });
    const got = await executeTool('read_balance', {}, ctx);
    expect(got.status).toBe('EXECUTED');
    expect(got.decisionId).toBeNull();
    expect(got.summary).toMatch(/\$900/);
  });

  it('read_positions returns positions from listFuturesPositionsFn', async () => {
    const listFuturesPositionsFn = vi.fn().mockResolvedValue([
      { symbol: 'BTC-USDT', side: 'LONG', qty: '0.1', entryPrice: '50000', markPrice: '51000', unrealizedPnlUsdt: '100', leverage: 5, liquidationPrice: '45000' },
    ]);
    const ctx = makeCtx({ listFuturesPositionsFn, bingxClient: {} as ToolExecContext['bingxClient'] });
    const got = await executeTool('read_positions', {}, ctx);
    expect(got.status).toBe('EXECUTED');
    expect((got.payload as unknown[]).length).toBe(1);
  });

  it('read_open_orders returns from listFuturesOpenOrdersFn', async () => {
    const listFuturesOpenOrdersFn = vi.fn().mockResolvedValue([
      { orderId: '1', symbol: 'BTC-USDT', side: 'BUY', type: 'LIMIT', quantity: '0.01', price: '49000', stopPrice: '0', status: 'NEW', createdAt: '2026-05-13T00:00:00Z' },
    ]);
    const ctx = makeCtx({ listFuturesOpenOrdersFn, bingxClient: {} as ToolExecContext['bingxClient'] });
    const got = await executeTool('read_open_orders', {}, ctx);
    expect(got.status).toBe('EXECUTED');
    expect((got.payload as unknown[]).length).toBe(1);
  });

  it('read_balance refuses when bingxClient is missing', async () => {
    const ctx = makeCtx({ bingxClient: undefined });
    const got = await executeTool('read_balance', {}, ctx);
    expect(got.status).toBe('EXECUTION_FAILED');
    expect(got.summary).toMatch(/bingx/i);
  });
});
