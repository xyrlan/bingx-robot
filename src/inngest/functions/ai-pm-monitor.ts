import { eq, and } from 'drizzle-orm';
import { inngest } from '@/inngest/client';
import { db } from '@/db';
import { aiPmFundingCache } from '@/db/schema';
import { listEnabledAiPmConfigs } from '@/services/ai-pm-config.service';
import { getBingxClientByApiKeyId } from '@/services/bingx.service';
import { tickPaperBots } from '@/services/paper-bot-sim.service';
import { tickRealBots } from '@/services/real-bot-monitor.service';
import type { BingxClient } from '@/lib/bingx/client';
import type { AiPmEventName, AiPmEventPayload } from '@/lib/ai-pm/events';
import type { AiPmConfigDecrypted } from '@/services/ai-pm-config.service';

export interface RunMonitorForConfigParams {
  db: typeof db;
  config: Pick<AiPmConfigDecrypted, 'id' | 'userId' | 'bingxApiKeyId' | 'paperMode' | 'maxDrawdownPct' | 'allowedSymbols' | 'enabled' | 'killSwitch'>;
  loadBingxClientFn?: (apiKeyId: string) => Promise<BingxClient | null>;
  fetchFundingRateFn?: (client: BingxClient, symbol: string) => Promise<number>;
  tickPaperBotsFn?: typeof tickPaperBots;
  tickRealBotsFn?: typeof tickRealBots;
  sendEventFn: (event: { name: AiPmEventName; data: AiPmEventPayload }) => Promise<void>;
  logger: { info: (msg: string, ctx?: unknown) => void; warn: (msg: string, ctx?: unknown) => void; error: (msg: string, ctx?: unknown) => void };
}

// client.get<T>() already unwraps the `data` field and returns T directly.
async function defaultFetchFundingRate(client: BingxClient, symbol: string): Promise<number> {
  const resp = await client.get<Array<{ lastFundingRate?: string }> | { lastFundingRate?: string }>(
    '/openApi/swap/v2/quote/premiumIndex',
    { symbol },
  );
  const item = Array.isArray(resp) ? resp[0] : resp;
  return Number(item?.lastFundingRate ?? 0);
}

export async function runMonitorForConfig(params: RunMonitorForConfigParams): Promise<{ advanced: number; flipped: string[] }> {
  if (params.config.killSwitch || !params.config.enabled) {
    return { advanced: 0, flipped: [] };
  }

  const loadBingx = params.loadBingxClientFn ?? getBingxClientByApiKeyId;
  const fetchRate = params.fetchFundingRateFn ?? defaultFetchFundingRate;
  const tickFn = params.tickPaperBotsFn ?? tickPaperBots;
  const tickRealFn = params.tickRealBotsFn ?? tickRealBots;

  const client = await loadBingx(params.config.bingxApiKeyId);
  if (!client) {
    params.logger.warn('monitor_no_bingx_client', { configId: params.config.id });
    return { advanced: 0, flipped: [] };
  }

  const allowedSymbols = params.config.allowedSymbols ?? [];
  const maxDrawdownPct = Number(params.config.maxDrawdownPct ?? 20);

  const tickResult = params.config.paperMode
    ? await tickFn({
        db: params.db,
        configId: params.config.id,
        userId: params.config.userId,
        allowedSymbols,
        maxDrawdownPct,
        sendEventFn: params.sendEventFn,
        bingxClient: client,
        logger: params.logger,
      })
    : await tickRealFn({
        db: params.db,
        configId: params.config.id,
        userId: params.config.userId,
        bingxApiKeyId: params.config.bingxApiKeyId,
        allowedSymbols,
        maxDrawdownPct,
        sendEventFn: params.sendEventFn,
        bingxClient: client,
        logger: params.logger,
      });

  const flipped: string[] = [];
  for (const symbol of allowedSymbols) {
    const cached = await params.db.query.aiPmFundingCache.findFirst({
      where: and(eq(aiPmFundingCache.configId, params.config.id), eq(aiPmFundingCache.symbol, symbol)),
    });
    let currentRate: number;
    try {
      currentRate = await fetchRate(client, symbol);
    } catch (err) {
      params.logger.warn('funding_rate_fetch_failed', { symbol, err: err instanceof Error ? err.message : String(err) });
      continue;
    }

    if (cached) {
      const prev = Number(cached.fundingRate);
      if (Math.sign(prev) !== 0 && Math.sign(currentRate) !== 0 && Math.sign(prev) !== Math.sign(currentRate)) {
        await params.sendEventFn({
          name: 'ai-pm/event.funding-flip',
          data: {
            configId: params.config.id,
            emittedAt: new Date().toISOString(),
            symbol,
            previousRate: prev,
            currentRate,
          },
        });
        flipped.push(symbol);
      }
    }

    await params.db
      .insert(aiPmFundingCache)
      .values({ configId: params.config.id, symbol, fundingRate: String(currentRate) })
      .onConflictDoUpdate({
        target: [aiPmFundingCache.configId, aiPmFundingCache.symbol],
        set: { fundingRate: String(currentRate), observedAt: new Date() },
      });
  }

  return { advanced: tickResult.advanced, flipped };
}

export const aiPmMonitor = inngest.createFunction(
  {
    id: 'ai-pm-monitor',
    retries: 0,
    concurrency: { limit: 3 },
  },
  { cron: '*/5 * * * *' },
  async ({ step, logger }) => {
    const configs = await step.run('load-configs', listEnabledAiPmConfigs);
    if (configs.length === 0) return { tickAt: Date.now(), configs: 0 };

    const results: Array<{ configId: string; advanced: number; flipped: string[] }> = [];
    for (const cfg of configs) {
      const r = await step.run(`monitor-${cfg.id}`, () =>
        runMonitorForConfig({
          db,
          config: cfg,
          sendEventFn: async (event) => {
            await inngest.send(event);
          },
          logger: {
            info: (msg, ctx) => logger.info(msg, ctx ?? {}),
            warn: (msg, ctx) => logger.warn(msg, ctx ?? {}),
            error: (msg, ctx) => logger.error(msg, ctx ?? {}),
          },
        }),
      );
      results.push({ configId: cfg.id, ...r });
    }
    return { tickAt: Date.now(), configs: configs.length, results };
  },
);
