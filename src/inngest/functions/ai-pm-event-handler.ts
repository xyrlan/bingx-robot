import { inngest } from '@/inngest/client';
import { db } from '@/db';
import {
  mapNameToEnum,
  type AiPmEventName,
  type AiPmEventPayload,
  type ChatPayload,
} from '@/lib/ai-pm/events';
import {
  insertAiEvent as defaultInsertAiEvent,
  markEvent as defaultMarkEvent,
  checkThrottle as defaultCheckThrottle,
} from '@/services/ai-events.service';
import { getAiPmConfigById } from '@/services/ai-pm-config.service';
import { getBingxClientByApiKeyId } from '@/services/bingx.service';
import { loadPortfolioState } from '@/lib/ai-pm/portfolio-state';
import { runScopedPipeline } from '@/lib/ai-pm/event-pipeline';
import { runChatPipeline } from '@/lib/ai-pm/chat-pipeline';
import { aiChatMessages } from '@/db/schema';
import { desc, eq } from 'drizzle-orm';
import { sql } from '@/db';
import { notifyStream } from '@/lib/ai-pm/streaming';

const THROTTLE_WINDOW_SECONDS = 300;

export type HandleResultStatus =
  | 'PROCESSED'
  | 'THROTTLED'
  | 'FAILED'
  | 'SKIPPED_CONFIG_DISABLED'
  | 'SKIPPED_NO_BINGX_CLIENT';

export interface HandleAiPmEventParams {
  eventName: AiPmEventName;
  data: AiPmEventPayload;
  db: typeof db;
  insertAiEventFn?: typeof defaultInsertAiEvent;
  markEventFn?: typeof defaultMarkEvent;
  checkThrottleFn?: typeof defaultCheckThrottle;
  loadConfigFn?: typeof getAiPmConfigById;
  loadBingxClientFn?: typeof getBingxClientByApiKeyId;
  loadPortfolioFn?: typeof loadPortfolioState;
  runScopedFn?: typeof runScopedPipeline;
  runChatFn?: typeof runChatPipeline;
  logger: {
    info: (msg: string, ctx?: unknown) => void;
    warn: (msg: string, ctx?: unknown) => void;
    error: (msg: string, ctx?: unknown) => void;
  };
}

export interface HandleResult {
  aiEventId: string;
  status: HandleResultStatus;
  decisionId?: string | null;
}

export async function handleAiPmEvent(params: HandleAiPmEventParams): Promise<HandleResult> {
  const insertAiEvent = params.insertAiEventFn ?? defaultInsertAiEvent;
  const markEvent = params.markEventFn ?? defaultMarkEvent;
  const checkThrottle = params.checkThrottleFn ?? defaultCheckThrottle;
  const loadConfig = params.loadConfigFn ?? getAiPmConfigById;
  const loadBingx = params.loadBingxClientFn ?? getBingxClientByApiKeyId;
  const loadPortfolio = params.loadPortfolioFn ?? loadPortfolioState;
  const runScoped = params.runScopedFn ?? runScopedPipeline;
  const runChat = params.runChatFn ?? runChatPipeline;

  const eventType = mapNameToEnum(params.eventName);
  const symbol = 'symbol' in params.data ? params.data.symbol : null;
  const emittedAt = new Date(params.data.emittedAt);

  const aiEventId = await insertAiEvent({
    db: params.db,
    configId: params.data.configId,
    eventType,
    symbol: symbol ?? null,
    payload: params.data,
    emittedAt,
  });

  const throttled = await checkThrottle({
    db: params.db,
    configId: params.data.configId,
    eventType,
    symbol: symbol ?? null,
    currentEventId: aiEventId,
    windowSeconds: THROTTLE_WINDOW_SECONDS,
  });

  if (throttled) {
    await markEvent({ db: params.db, aiEventId, status: 'THROTTLED' });
    return { aiEventId, status: 'THROTTLED' };
  }

  let config;
  try {
    config = await loadConfig(params.data.configId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    params.logger.error('loadConfig threw — likely corrupted encrypted key', { msg, configId: params.data.configId });
    // Chat path: surface a clear canned reply via the placeholder so the user
    // sees an actionable message instead of a 180s timeout.
    if (params.eventName === 'ai-pm/event.chat') {
      const placeholderId = (params.data as ChatPayload).assistantPlaceholderId;
      if (placeholderId) {
        const text = 'AI configuration is corrupted (could not decrypt the Anthropic key). Re-save the key from the AI PM settings page.';
        try {
          await params.db
            .update(aiChatMessages)
            .set({ content: text, toolCalls: [], decisionId: null })
            .where(eq(aiChatMessages.id, placeholderId));
          await notifyStream(sql, placeholderId, {
            type: 'done',
            decisionId: null,
            usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, model: 'claude-sonnet-4-6' },
          });
        } catch (e) {
          params.logger.warn('failed to write canned config-corrupt message', { e });
        }
      }
    }
    await markEvent({ db: params.db, aiEventId, status: 'FAILED' });
    return { aiEventId, status: 'FAILED' };
  }
  if (!config || (!config.enabled && params.eventName !== 'ai-pm/event.chat')) {
    await markEvent({ db: params.db, aiEventId, status: 'FAILED' });
    return { aiEventId, status: 'SKIPPED_CONFIG_DISABLED' };
  }

  await markEvent({ db: params.db, aiEventId, status: 'PROCESSING' });

  try {
    if (params.eventName === 'ai-pm/event.chat') {
      const client = await loadBingx(config.bingxApiKeyId);
      const portfolioState = await loadPortfolio({
        userId: config.userId,
        bingxApiKeyId: config.bingxApiKeyId,
        db: params.db,
      });
      const result = await runChat({
        payload: params.data as ChatPayload,
        aiEventId,
        config,
        portfolioState,
        db: params.db,
        loadChatHistoryFn: async (userId, limit) => loadChatHistory(params.db, userId, limit),
        isKillSwitchActive: async () => {
          const fresh = await loadConfig(config.id);
          return Boolean(fresh?.killSwitch);
        },
        bingxClient: client,
        logger: params.logger,
      });
      await markEvent({ db: params.db, aiEventId, status: 'PROCESSED', decisionId: result.decisionId });
      return { aiEventId, status: 'PROCESSED', decisionId: result.decisionId };
    }

    const client = await loadBingx(config.bingxApiKeyId);
    if (!client) {
      await markEvent({ db: params.db, aiEventId, status: 'FAILED' });
      return { aiEventId, status: 'SKIPPED_NO_BINGX_CLIENT' };
    }

    const portfolioState = await loadPortfolio({
      userId: config.userId,
      bingxApiKeyId: config.bingxApiKeyId,
      db: params.db,
    });

    const result = await runScoped({
      eventType,
      symbol: symbol ?? '',
      payload: params.data,
      aiEventId,
      config,
      bingxClient: client,
      portfolioState,
      db: params.db,
      isKillSwitchActive: async () => {
        const fresh = await loadConfig(config.id);
        return Boolean(fresh?.killSwitch);
      },
      logger: params.logger,
    });

    await markEvent({
      db: params.db,
      aiEventId,
      status: 'PROCESSED',
      decisionId: result.executedDecisionId,
    });
    return { aiEventId, status: 'PROCESSED', decisionId: result.executedDecisionId };
  } catch (err) {
    params.logger.error('event_handler_failed', {
      aiEventId,
      err: err instanceof Error ? err.message : String(err),
    });
    await markEvent({ db: params.db, aiEventId, status: 'FAILED' });
    throw err;
  }
}

async function loadChatHistory(
  database: typeof db,
  userId: string,
  limit: number,
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const rows = await database
    .select({ role: aiChatMessages.role, content: aiChatMessages.content })
    .from(aiChatMessages)
    .where(eq(aiChatMessages.userId, userId))
    .orderBy(desc(aiChatMessages.createdAt))
    .limit(limit);
  return rows
    .reverse()
    .map((r) => ({
      role: (r.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
      content: r.content ?? '',
    }));
}

export const aiPmEventHandler = inngest.createFunction(
  {
    id: 'ai-pm-event-handler',
    retries: 2,
    concurrency: [
      { limit: 5 },
      { limit: 1, key: 'event.data.configId' },
    ],
  },
  [
    { event: 'ai-pm/event.fill' as const },
    { event: 'ai-pm/event.error' as const },
    { event: 'ai-pm/event.drawdown' as const },
    { event: 'ai-pm/event.funding-flip' as const },
    { event: 'ai-pm/event.chat' as const },
  ],
  async ({ event, logger }) => {
    return handleAiPmEvent({
      eventName: event.name as AiPmEventName,
      data: event.data as AiPmEventPayload,
      db,
      logger: {
        info: (msg, ctx) => logger.info(msg, ctx ?? {}),
        warn: (msg, ctx) => logger.warn(msg, ctx ?? {}),
        error: (msg, ctx) => logger.error(msg, ctx ?? {}),
      },
    });
  },
);
