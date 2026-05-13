import { tool, type ToolSet, type Tool } from 'ai';
import {
  ALL_TOOL_DEFINITIONS,
  executeTool,
  type ToolExecContext,
  type ToolName,
} from '@/lib/ai-pm/chat-tools';

/**
 * Adapt the AI PM chat tools (zod schemas + executeTool dispatcher) into the
 * AI SDK v6 `tool()` shape, with the executor closing over the per-request
 * ToolExecContext (userId, configId, db, bingxClient, portfolioState, config).
 *
 * The execute function returns the full ToolExecResult — the LLM reads
 * `status` and decides whether to retry, surface an error, or move on.
 * It does NOT throw on REJECTED_* / EXECUTION_FAILED, because that would
 * surface as a `tool-error` part on the wire and lose the decisionId + reason.
 * Real system failures (DB exception, etc.) are already trapped by executeTool
 * and surfaced as EXECUTION_FAILED.
 */
export function buildAiSdkTools(ctx: ToolExecContext): ToolSet {
  const tools: Record<string, Tool<unknown, unknown>> = {};
  for (const def of ALL_TOOL_DEFINITIONS) {
    const name = def.name as ToolName;
    tools[name] = tool({
      description: def.description,
      inputSchema: def.schema,
      execute: async (args: unknown) => {
        return executeTool(name, args, ctx);
      },
    }) as unknown as Tool<unknown, unknown>;
  }
  return tools as unknown as ToolSet;
}
