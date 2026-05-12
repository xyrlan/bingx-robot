import { aiChatMessages } from '@/db/schema';
import type { db as Db } from '@/db';
import type { ChatPayload } from '@/lib/ai-pm/events';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';
import type { AiPmConfigDecrypted } from '@/services/ai-pm-config.service';
import { callSonnetText, type AnthropicFactory, type LlmUsage } from '@/lib/ai-pm/llm';
import { MODEL_SONNET } from '@/lib/ai-pm/llm.constants';

export interface ChatDecisionResult {
  kind: 'reply';
  assistantText: string;
  usage: LlmUsage;
}

export interface RunChatDecisionParams {
  userMessage: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  portfolioState: PortfolioState;
  anthropicApiKey: string;
  factory?: AnthropicFactory;
}

export async function runChatDecision(params: RunChatDecisionParams): Promise<ChatDecisionResult> {
  const systemPrompt = `You are an AI Portfolio Manager assistant. The user has these positions and bots: ${JSON.stringify(params.portfolioState)}. Respond concisely. For v1 you can only reply in natural language; no tools.`;
  const result = await callSonnetText({
    apiKey: params.anthropicApiKey,
    systemPrompt,
    userPrompt: params.userMessage,
    factory: params.factory,
    cacheSystem: false,
  });
  if (!result.ok) {
    return {
      kind: 'reply',
      assistantText: 'Sorry, I could not process that.',
      usage: result.usage ?? {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        costUsd: 0,
        model: MODEL_SONNET,
      },
    };
  }
  return { kind: 'reply', assistantText: result.data.text, usage: result.usage };
}

export interface ChatPipelineResult {
  decisionId: string | null;
  assistantText: string;
}

export interface RunChatPipelineParams {
  payload: ChatPayload;
  aiEventId: string;
  config: Pick<AiPmConfigDecrypted, 'userId' | 'anthropicApiKey'>;
  portfolioState: PortfolioState;
  db: typeof Db;
  chatDecisionFn?: typeof runChatDecision;
  loadChatHistoryFn: (userId: string, limit: number) => Promise<Array<{ role: 'user' | 'assistant'; content: string }>>;
  isKillSwitchActive: () => Promise<boolean>;
  logger: {
    info: (msg: string, ctx?: unknown) => void;
    warn: (msg: string, ctx?: unknown) => void;
    error: (msg: string, ctx?: unknown) => void;
  };
}

const HISTORY_LIMIT = 20;

export async function runChatPipeline(params: RunChatPipelineParams): Promise<ChatPipelineResult> {
  const chatDecision = params.chatDecisionFn ?? runChatDecision;

  if (await params.isKillSwitchActive()) {
    const text = 'AI is currently disabled (kill switch active).';
    await persistAssistant(params.db, params.config.userId, text, null);
    return { decisionId: null, assistantText: text };
  }

  const history = await params.loadChatHistoryFn(params.config.userId, HISTORY_LIMIT);
  const decision = await chatDecision({
    userMessage: params.payload.userMessage,
    history,
    portfolioState: params.portfolioState,
    anthropicApiKey: params.config.anthropicApiKey,
  });

  await persistAssistant(params.db, params.config.userId, decision.assistantText, null);
  return { decisionId: null, assistantText: decision.assistantText };
}

async function persistAssistant(
  database: typeof Db,
  userId: string,
  content: string,
  decisionId: string | null,
): Promise<void> {
  await database
    .insert(aiChatMessages)
    .values({ userId, role: 'assistant', content, decisionId })
    .returning();
}
