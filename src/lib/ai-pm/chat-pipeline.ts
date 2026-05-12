import { aiChatMessages } from '@/db/schema';
import { sql } from '@/db';
import type { db as Db } from '@/db';
import type { ChatPayload } from '@/lib/ai-pm/events';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';
import type { AiPmConfigDecrypted } from '@/services/ai-pm-config.service';
import { eq } from 'drizzle-orm';
import { runToolLoop, type ToolCallEntry } from '@/lib/ai-pm/chat-loop';
import type { ToolExecContext } from '@/lib/ai-pm/chat-tools';
import type { LlmUsage } from '@/lib/ai-pm/llm';
import { notifyStream, persistChunk, deleteChunks, type StreamEvent } from '@/lib/ai-pm/streaming';

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
  const placeholderId = params.payload.assistantPlaceholderId;

  const updatePlaceholder = async (
    text: string,
    opts: Partial<{ toolCalls: ToolCallEntry[]; decisionId: string | null; usage: LlmUsage }>,
  ): Promise<void> => {
    const { toolCalls, decisionId, usage } = opts;
    await params.db
      .update(aiChatMessages)
      .set({
        content: text,
        toolCalls: toolCalls ?? [],
        decisionId: decisionId ?? null,
        ...(usage ? {
          tokensInput: usage.inputTokens,
          tokensOutput: usage.outputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          costUsd: String(usage.costUsd),
        } : {}),
      })
      .where(eq(aiChatMessages.id, placeholderId));
  };

  const safeNotify = async (event: StreamEvent): Promise<void> => {
    try {
      await notifyStream(sql, placeholderId, event);
    } catch (err) {
      params.logger.warn('notifyStream failed', { err });
    }
  };

  if (!params.config.enabled) {
    const text = 'AI is not enabled for this subaccount. Enable it from the AI PM settings page.';
    await updatePlaceholder(text, {});
    await safeNotify({ type: 'done', decisionId: null, usage: zeroUsage() });
    return { decisionId: null, assistantText: text, toolCallEntries: [], usage: zeroUsage() };
  }

  if (await params.isKillSwitchActive()) {
    const text = 'AI is currently disabled (kill switch active).';
    await updatePlaceholder(text, {});
    await safeNotify({ type: 'done', decisionId: null, usage: zeroUsage() });
    return { decisionId: null, assistantText: text, toolCallEntries: [], usage: zeroUsage() };
  }

  const history = await params.loadChatHistoryFn(params.config.userId, HISTORY_LIMIT);

  const ctx: ToolExecContext = {
    userId: params.config.userId,
    configId: params.config.id,
    chatMessageId: placeholderId,
    portfolioState: params.portfolioState,
    config: params.config,
    db: params.db,
    bingxClient: params.bingxClient ?? undefined,
  };

  const onEvent = async (event: StreamEvent): Promise<void> => {
    if (event.type === 'text_chunk') {
      try {
        await persistChunk(params.db, placeholderId, event.seq, event.text);
      } catch (err) {
        params.logger.warn('persistChunk failed', { err });
      }
    }
    await safeNotify(event);
  };

  let result: Awaited<ReturnType<typeof runToolLoop>>;
  try {
    result = await loop({
      userMessage: params.payload.userMessage,
      history,
      ctx,
      isKillSwitchOnFn: async () => (await params.isKillSwitchActive()),
      onEvent,
    });
  } catch (err) {
    params.logger.error('chat tool loop threw', { err });
    const text = 'Internal error during chat processing.';
    await updatePlaceholder(text, {});
    await safeNotify({ type: 'error', kind: 'INTERNAL', message: 'pipeline crashed' });
    await safeNotify({ type: 'done', decisionId: null, usage: zeroUsage() });
    try { await deleteChunks(params.db, placeholderId); } catch { /* best-effort */ }
    return { decisionId: null, assistantText: text, toolCallEntries: [], usage: zeroUsage() };
  }

  const firstDecisionId = result.toolCallEntries.find((e) => e.decisionId)?.decisionId ?? null;
  await updatePlaceholder(result.assistantText, {
    toolCalls: result.toolCallEntries,
    decisionId: firstDecisionId,
    usage: result.cumulativeUsage,
  });

  // Safety-net done: runToolLoop normally emits it from inside the loop, but tests
  // that mock runToolLoopFn may not. Idempotent on the client.
  await safeNotify({ type: 'done', decisionId: firstDecisionId, usage: result.cumulativeUsage });
  try { await deleteChunks(params.db, placeholderId); } catch { /* best-effort */ }

  return {
    decisionId: firstDecisionId,
    assistantText: result.assistantText,
    toolCallEntries: result.toolCallEntries,
    usage: result.cumulativeUsage,
  };
}
