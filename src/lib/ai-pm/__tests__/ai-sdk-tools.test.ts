import { describe, it, expect, vi } from 'vitest';

const { toolMock, executeToolMock } = vi.hoisted(() => ({
  toolMock: vi.fn((def: { description: string; inputSchema: unknown; execute: (args: unknown) => Promise<unknown> }) => def),
  executeToolMock: vi.fn().mockResolvedValue({
    status: 'EXECUTED',
    decisionId: 'dec-1',
    summary: 'ok',
    payload: { ok: true },
  }),
}));

vi.mock('ai', () => ({ tool: toolMock }));
vi.mock('@/lib/ai-pm/chat-tools', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ai-pm/chat-tools')>('@/lib/ai-pm/chat-tools');
  return { ...actual, executeTool: executeToolMock };
});

import { buildAiSdkTools } from '@/lib/ai-pm/ai-sdk-tools';
import { ALL_TOOL_DEFINITIONS, type ToolExecContext } from '@/lib/ai-pm/chat-tools';

const ctx = {
  userId: 'u1',
  configId: 'cfg1',
  chatMessageId: null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  portfolioState: { runningBots: [], capitalUsedUsdt: 0, bingxApiKeyId: 'k1' } as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: { id: 'cfg1', killSwitch: false } as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: {} as any,
} as ToolExecContext;

describe('buildAiSdkTools', () => {
  it('returns one entry per ALL_TOOL_DEFINITIONS entry, keyed by tool name', () => {
    const tools = buildAiSdkTools(ctx);
    const expectedNames = ALL_TOOL_DEFINITIONS.map((d) => d.name).sort();
    const actualNames = Object.keys(tools).sort();
    expect(actualNames).toEqual(expectedNames);
  });

  it('forwards description and zod inputSchema from chat-tools to AI SDK tool()', () => {
    buildAiSdkTools(ctx);
    for (const def of ALL_TOOL_DEFINITIONS) {
      const call = toolMock.mock.calls.find(
        (c) => (c[0] as { description: string }).description === def.description,
      );
      expect(call, `tool() not called for ${def.name}`).toBeTruthy();
      expect((call![0] as { inputSchema: unknown }).inputSchema).toBe(def.schema);
    }
  });

  it('execute delegates to executeTool with (toolName, args, ctx)', async () => {
    executeToolMock.mockClear();
    const tools = buildAiSdkTools(ctx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = (tools as any)['read_portfolio'] as { execute: (a: unknown) => Promise<unknown> };
    const res = await t.execute({});
    expect(executeToolMock).toHaveBeenCalledWith('read_portfolio', {}, ctx);
    expect(res).toEqual({ status: 'EXECUTED', decisionId: 'dec-1', summary: 'ok', payload: { ok: true } });
  });

  it('execute returns the full ToolExecResult (does NOT throw on REJECTED_*)', async () => {
    executeToolMock.mockResolvedValueOnce({
      status: 'REJECTED_GUARDRAIL',
      decisionId: 'dec-2',
      summary: 'too much capital',
      payload: null,
    });
    const tools = buildAiSdkTools(ctx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = (tools as any)['create_bot'] as { execute: (a: unknown) => Promise<unknown> };
    const res = await t.execute({ symbol: 'BTC-USDT', strategy: 'DCA', capitalUsdt: 100, leverage: 2, reasoning: 'r' });
    expect(res).toMatchObject({ status: 'REJECTED_GUARDRAIL', decisionId: 'dec-2' });
  });
});
