import { describe, it, expect, vi } from 'vitest';
import { runToolLoop } from '@/lib/ai-pm/chat-loop';
import type { ToolExecContext, ToolExecResult } from '@/lib/ai-pm/chat-tools';
import type { StreamEvent } from '@/lib/ai-pm/streaming';

function ctxStub(overrides: Partial<ToolExecContext> = {}): ToolExecContext {
  return {
    userId: 'u',
    configId: 'c',
    chatMessageId: null,
    portfolioState: { runningBots: [], capitalUsedUsdt: 0, bingxApiKeyId: 'k' },
    config: {
      id: 'c', userId: 'u', bingxApiKeyId: 'k', anthropicApiKey: 'sk',
      enabled: true, mode: 'BALANCED', maxCapitalUsdt: '1000', maxDrawdownPct: '20',
      maxLeverage: 5, allowedSymbols: [], allowedStrategies: [],
      maxConcurrentBots: 5, monthlyLlmBudgetUsd: '100',
      killSwitch: false, paperMode: true,
      createdAt: new Date(), updatedAt: new Date(),
    } as ToolExecContext['config'],
    db: {} as ToolExecContext['db'],
    ...overrides,
  };
}

function llmOk(result: { kind: 'text'; text: string } | { kind: 'tool_use'; toolName: string; toolUseId: string; args: unknown }, cost = 0.001) {
  return { ok: true as const, data: result, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: cost, model: 'claude-sonnet-4-6' as const } };
}

describe('runToolLoop', () => {
  it('returns text reply when LLM responds with text on first turn', async () => {
    const llmFn = vi.fn().mockResolvedValueOnce(llmOk({ kind: 'text', text: 'hello back' }));
    const executeToolFn = vi.fn();
    const got = await runToolLoop({
      userMessage: 'hi', history: [], ctx: ctxStub(),
      llmFn, executeToolFn,
    });
    expect(got.assistantText).toBe('hello back');
    expect(got.toolCallEntries).toEqual([]);
    expect(executeToolFn).not.toHaveBeenCalled();
  });

  it('dispatches one tool then returns text on next turn', async () => {
    const llmFn = vi.fn()
      .mockResolvedValueOnce(llmOk({ kind: 'tool_use', toolName: 'read_portfolio', toolUseId: 'tu1', args: {} }))
      .mockResolvedValueOnce(llmOk({ kind: 'text', text: 'done' }));
    const executeToolFn = vi.fn<(name: string, args: unknown, ctx: ToolExecContext) => Promise<ToolExecResult>>().mockResolvedValue({ status: 'EXECUTED', decisionId: null, summary: 'ok', payload: {} });

    const got = await runToolLoop({
      userMessage: 'p', history: [], ctx: ctxStub(),
      llmFn, executeToolFn,
    });
    expect(got.assistantText).toBe('done');
    expect(got.toolCallEntries).toHaveLength(1);
    expect(got.toolCallEntries[0].toolName).toBe('read_portfolio');
    expect(executeToolFn).toHaveBeenCalledTimes(1);
  });

  it('terminates at MAX_TURNS', async () => {
    const llmFn = vi.fn().mockResolvedValue(llmOk({ kind: 'tool_use', toolName: 'read_portfolio', toolUseId: 'tu', args: {} }));
    const executeToolFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: null, summary: 'ok', payload: {} });
    const got = await runToolLoop({
      userMessage: 'x', history: [], ctx: ctxStub(),
      llmFn, executeToolFn,
      budgets: { maxTurns: 3 },
    });
    expect(got.toolCallEntries).toHaveLength(3);
    expect(got.assistantText).toMatch(/limit/i);
  });

  it('terminates when cost cap exceeded', async () => {
    const llmFn = vi.fn().mockResolvedValue(llmOk({ kind: 'tool_use', toolName: 'read_portfolio', toolUseId: 'tu', args: {} }, 0.4));
    const executeToolFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: null, summary: 'ok', payload: {} });
    const got = await runToolLoop({
      userMessage: 'x', history: [], ctx: ctxStub(),
      llmFn, executeToolFn,
      budgets: { maxCostUsdPerTurn: 0.5 },
    });
    expect(got.assistantText).toMatch(/budget/i);
  });

  it('aborts when kill switch flips mid-loop', async () => {
    const ctx = ctxStub();
    let killOn = false;
    const llmFn = vi.fn().mockResolvedValue(llmOk({ kind: 'tool_use', toolName: 'create_bot', toolUseId: 'tu', args: { symbol: 'X', strategy: 'DCA', capitalUsdt: 1, leverage: 1, reasoning: 'r' } }));
    const executeToolFn = vi.fn().mockImplementation(async () => {
      killOn = true;
      return { status: 'EXECUTED', decisionId: 'd1', summary: 'ok', payload: {} };
    });
    const isKillSwitchOnFn = vi.fn().mockImplementation(async () => killOn);
    const got = await runToolLoop({
      userMessage: 'x', history: [], ctx,
      llmFn, executeToolFn, isKillSwitchOnFn,
    });
    expect(got.assistantText).toMatch(/kill switch/i);
    expect(got.toolCallEntries).toHaveLength(1);
    expect(executeToolFn).toHaveBeenCalledTimes(1);
  });

  it('on LLM api error returns text describing the error and any accumulated entries', async () => {
    const llmFn = vi.fn()
      .mockResolvedValueOnce(llmOk({ kind: 'tool_use', toolName: 'read_portfolio', toolUseId: 'tu', args: {} }))
      .mockResolvedValueOnce({ ok: false as const, error: { kind: 'API_ERROR', message: 'boom' } });
    const executeToolFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: null, summary: 'ok', payload: {} });
    const got = await runToolLoop({
      userMessage: 'x', history: [], ctx: ctxStub(),
      llmFn, executeToolFn,
    });
    expect(got.assistantText).toMatch(/AI service error/i);
    expect(got.toolCallEntries).toHaveLength(1);
  });
});

describe('runToolLoop — onEvent', () => {
  it('emits started, tool_start/tool_done per tool, and done at end', async () => {
    const events: StreamEvent[] = [];
    const llmFn = vi.fn()
      .mockResolvedValueOnce(llmOk({ kind: 'tool_use', toolName: 'read_portfolio', toolUseId: 'tu1', args: {} }))
      .mockResolvedValueOnce(llmOk({ kind: 'text', text: 'ok' }));
    const executeToolFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: null, summary: 'snap', payload: {} });

    await runToolLoop({
      userMessage: 'x', history: [], ctx: ctxStub(),
      llmFn, executeToolFn,
      onEvent: (e) => { events.push(e); },
    });

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('started');
    expect(types).toContain('tool_start');
    expect(types).toContain('tool_done');
    expect(types[types.length - 1]).toBe('done');
  });

  it('onEvent throwing does not abort the loop', async () => {
    const llmFn = vi.fn().mockResolvedValueOnce(llmOk({ kind: 'text', text: 'fine' }));
    const onEvent = vi.fn().mockRejectedValue(new Error('downstream dead'));
    const got = await runToolLoop({
      userMessage: 'x', history: [], ctx: ctxStub(),
      llmFn, executeToolFn: vi.fn(),
      onEvent,
    });
    expect(got.assistantText).toBe('fine');
  });

  it('emits an error event then done when llmFn returns API_ERROR', async () => {
    const events: StreamEvent[] = [];
    const llmFn = vi.fn().mockResolvedValueOnce({ ok: false as const, error: { kind: 'API_ERROR', message: 'boom' } });
    await runToolLoop({
      userMessage: 'x', history: [], ctx: ctxStub(),
      llmFn, executeToolFn: vi.fn(),
      onEvent: (e) => { events.push(e); },
    });
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('emits done on MAX_TURNS termination', async () => {
    const events: StreamEvent[] = [];
    const llmFn = vi.fn().mockResolvedValue(llmOk({ kind: 'tool_use', toolName: 'read_portfolio', toolUseId: 'tu', args: {} }));
    const executeToolFn = vi.fn().mockResolvedValue({ status: 'EXECUTED', decisionId: null, summary: 'ok', payload: {} });
    await runToolLoop({
      userMessage: 'x', history: [], ctx: ctxStub(),
      llmFn, executeToolFn,
      onEvent: (e) => { events.push(e); },
      budgets: { maxTurns: 2 },
    });
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  });
});
