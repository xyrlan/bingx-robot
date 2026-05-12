import { callSonnetTools, type AnthropicChatMessage, type SonnetToolsResponse } from '@/lib/ai-pm/llm';
import type { LlmResult, LlmUsage } from '@/lib/ai-pm/llm';
import { ALL_TOOL_DEFINITIONS, executeTool as defaultExecuteTool, type ToolExecContext, type ToolName, type ToolStatus } from '@/lib/ai-pm/chat-tools';

export interface ToolCallEntry {
  toolName: ToolName;
  args: unknown;
  status: ToolStatus;
  decisionId: string | null;
  summary: string;
}

export interface RunToolLoopParams {
  userMessage: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  ctx: ToolExecContext;
  llmFn?: (params: Parameters<typeof callSonnetTools>[0]) => Promise<LlmResult<SonnetToolsResponse>>;
  executeToolFn?: typeof defaultExecuteTool;
  isKillSwitchOnFn?: (configId: string) => Promise<boolean>;
  budgets?: { maxTurns?: number; maxCostUsdPerTurn?: number };
  systemPrompt?: string;
}

export interface RunToolLoopResult {
  assistantText: string;
  toolCallEntries: ToolCallEntry[];
  cumulativeUsage: LlmUsage;
}

const DEFAULT_MAX_TURNS = 8;
const DEFAULT_MAX_COST = 0.5;
const DEFAULT_MODEL = 'claude-sonnet-4-6' as const;

function defaultSystemPrompt(): string {
  return [
    'You are the AI Portfolio Manager. You can read portfolio state and execute',
    'create_bot / stop_bot / pause_kill_switch actions through tools.',
    'Always include a reasoning string when mutating. Prefer reading before acting.',
    'When a guardrail rejects a tool call, adjust and retry once. Stop after a final summary.',
  ].join(' ');
}

function isMutating(name: ToolName): boolean {
  return name === 'create_bot' || name === 'stop_bot' || name === 'pause_kill_switch';
}

function mergeUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    costUsd: a.costUsd + b.costUsd,
    model: b.model,
  };
}

export async function runToolLoop(params: RunToolLoopParams): Promise<RunToolLoopResult> {
  const llmFn = params.llmFn ?? callSonnetTools;
  const executeToolFn = params.executeToolFn ?? defaultExecuteTool;
  const maxTurns = params.budgets?.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxCost = params.budgets?.maxCostUsdPerTurn ?? DEFAULT_MAX_COST;
  const isKillSwitchOn = params.isKillSwitchOnFn ?? (async () => false);
  const systemPrompt = params.systemPrompt ?? defaultSystemPrompt();

  const messages: AnthropicChatMessage[] = [
    ...params.history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: params.userMessage },
  ];

  const toolCallEntries: ToolCallEntry[] = [];
  let cumulativeUsage: LlmUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, model: DEFAULT_MODEL };

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const llmRes = await llmFn({
      apiKey: params.ctx.config.anthropicApiKey,
      systemPrompt,
      messages,
      tools: ALL_TOOL_DEFINITIONS,
    });

    if (!llmRes.ok) {
      return {
        assistantText: `AI service error: ${llmRes.error.kind}`,
        toolCallEntries,
        cumulativeUsage,
      };
    }

    cumulativeUsage = mergeUsage(cumulativeUsage, llmRes.usage);

    if (llmRes.data.kind === 'text') {
      return { assistantText: llmRes.data.text, toolCallEntries, cumulativeUsage };
    }

    if (cumulativeUsage.costUsd > maxCost) {
      return {
        assistantText: `Budget exhausted after ${toolCallEntries.length} tool call${toolCallEntries.length === 1 ? '' : 's'}, stopping.`,
        toolCallEntries,
        cumulativeUsage,
      };
    }

    const tu = llmRes.data;
    const toolName = tu.toolName as ToolName;

    if (isMutating(toolName) && (await isKillSwitchOn(params.ctx.configId))) {
      return {
        assistantText: 'Kill switch flipped mid-conversation; stopped.',
        toolCallEntries,
        cumulativeUsage,
      };
    }

    const exec = await executeToolFn(toolName, tu.args, params.ctx);
    toolCallEntries.push({
      toolName,
      args: tu.args,
      status: exec.status,
      decisionId: exec.decisionId,
      summary: exec.summary,
    });

    // After executing a mutating tool, re-check the kill switch for the *next* turn.
    if (isMutating(toolName) && (await isKillSwitchOn(params.ctx.configId))) {
      return {
        assistantText: 'Kill switch flipped mid-conversation; stopped.',
        toolCallEntries,
        cumulativeUsage,
      };
    }

    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: tu.toolUseId, name: tu.toolName, input: tu.args }],
    });
    messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: tu.toolUseId,
        content: JSON.stringify({ summary: exec.summary, payload: exec.payload, status: exec.status }),
        is_error: exec.status !== 'EXECUTED',
      }],
    });
  }

  return {
    assistantText: `Hit ${maxTurns}-call limit; here is what I did.`,
    toolCallEntries,
    cumulativeUsage,
  };
}
