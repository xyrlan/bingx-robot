import { aiChatMessages } from '@/db/schema';
import type { db as Db } from '@/db';
import type { ChatPayload } from '@/lib/ai-pm/events';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';
import type { AiPmConfigDecrypted } from '@/services/ai-pm-config.service';
import { eq } from 'drizzle-orm';
import { runToolLoop, type ToolCallEntry } from '@/lib/ai-pm/chat-loop';
import type { ToolExecContext } from '@/lib/ai-pm/chat-tools';
import type { LlmUsage } from '@/lib/ai-pm/llm';

export interface ChatPipelineResult {
  decisionId: string | null;
  assistantText: string;
  toolCallEntries: ToolCallEntry[];
  usage: LlmUsage;
}

export interface RunChatPipelineParams {
  payload: ChatPayload;
  aiEventId: string;
  config: AiPmConfigDecrypted;
  portfolioState: PortfolioState;
  db: typeof Db;
  loadChatHistoryFn: (userId: string, limit: number) => Promise<Array<{ role: 'user' | 'assistant'; content: string }>>;
  isKillSwitchActive: () => Promise<boolean>;
  runToolLoopFn?: typeof runToolLoop;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bingxClient?: any;
  logger: {
    info: (msg: string, ctx?: unknown) => void;
    warn: (msg: string, ctx?: unknown) => void;
    error: (msg: string, ctx?: unknown) => void;
  };
}

const HISTORY_LIMIT = 20;

function zeroUsage(): LlmUsage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, model: 'claude-sonnet-4-6' };
}

export async function runChatPipeline(params: RunChatPipelineParams): Promise<ChatPipelineResult> {
  const loop = params.runToolLoopFn ?? runToolLoop;

  if (!params.config.enabled) {
    const text = 'AI is not enabled for this subaccount. Enable it from the AI PM settings page.';
    await params.db
      .insert(aiChatMessages)
      .values({ userId: params.config.userId, role: 'assistant', content: text, toolCalls: [], decisionId: null });
    return { decisionId: null, assistantText: text, toolCallEntries: [], usage: zeroUsage() };
  }

  if (await params.isKillSwitchActive()) {
    const text = 'AI is currently disabled (kill switch active).';
    await params.db
      .insert(aiChatMessages)
      .values({ userId: params.config.userId, role: 'assistant', content: text, toolCalls: [], decisionId: null });
    return { decisionId: null, assistantText: text, toolCallEntries: [], usage: zeroUsage() };
  }

  // Pre-insert empty assistant row so decision rows can FK to it.
  const [placeholder] = await params.db
    .insert(aiChatMessages)
    .values({ userId: params.config.userId, role: 'assistant', content: '', toolCalls: [], decisionId: null })
    .returning();

  const history = await params.loadChatHistoryFn(params.config.userId, HISTORY_LIMIT);

  const ctx: ToolExecContext = {
    userId: params.config.userId,
    configId: params.config.id,
    chatMessageId: placeholder.id,
    portfolioState: params.portfolioState,
    config: params.config,
    db: params.db,
    bingxClient: params.bingxClient ?? undefined,
  };

  let result: Awaited<ReturnType<typeof runToolLoop>>;
  try {
    result = await loop({
      userMessage: params.payload.userMessage,
      history,
      ctx,
      isKillSwitchOnFn: async () => (await params.isKillSwitchActive()),
    });
  } catch (err) {
    params.logger.error('chat tool loop threw', { err });
    await params.db
      .update(aiChatMessages)
      .set({ content: 'Internal error during chat processing.' })
      .where(eq(aiChatMessages.id, placeholder.id));
    return { decisionId: null, assistantText: 'Internal error during chat processing.', toolCallEntries: [], usage: zeroUsage() };
  }

  const firstDecisionId = result.toolCallEntries.find((e) => e.decisionId)?.decisionId ?? null;

  await params.db
    .update(aiChatMessages)
    .set({
      content: result.assistantText,
      toolCalls: result.toolCallEntries,
      decisionId: firstDecisionId,
      tokensInput: result.cumulativeUsage.inputTokens,
      tokensOutput: result.cumulativeUsage.outputTokens,
      cachedInputTokens: result.cumulativeUsage.cachedInputTokens,
      costUsd: String(result.cumulativeUsage.costUsd),
    })
    .where(eq(aiChatMessages.id, placeholder.id));

  return {
    decisionId: firstDecisionId,
    assistantText: result.assistantText,
    toolCallEntries: result.toolCallEntries,
    usage: result.cumulativeUsage,
  };
}
