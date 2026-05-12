import { eq } from 'drizzle-orm';
import { inngest } from '@/inngest/client';
import { aiDecisions } from '@/db/schema';
import { db } from '@/db';
import { listEnabledAiPmConfigs, getAiPmConfigById } from '@/services/ai-pm-config.service';
import { getBingxClientByApiKeyId } from '@/services/bingx.service';
import { runSignal, type SignalOutcome } from '@/lib/ai-pm/signal';
import { runDecision, type DecisionOutcome } from '@/lib/ai-pm/decision';
import { validate, type ValidationResult } from '@/lib/ai-pm/validation';
import { execute, type ExecutionResult } from '@/lib/ai-pm/executor';
import { loadPortfolioState, type PortfolioState } from '@/lib/ai-pm/portfolio-state';
import type { BingxClient } from '@/lib/bingx/client';
import type { ProposedAction } from '@/lib/ai-pm/decision.prompt';

const DEFAULT_REVIEWER_THRESHOLD_PCT = 30;
const DEFAULT_MAX_CAPITAL = 1000;
const DEFAULT_MAX_CONCURRENT = 5;
const DEFAULT_STRATEGIES: Array<'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER'> = [
  'DCA',
  'TRAILING_STOP',
  'DCA_SPOT',
  'SMA_CROSSOVER',
];

export interface RunUserTickParams {
  userId: string;
  anthropicApiKey: string;
  bingxApiKeyId: string;
  paperMode: boolean;
  allowedSymbols: string[];
  maxCapitalUsdt: number;
  maxConcurrentBots: number;
  maxLeverage: number;
  allowedStrategies: Array<'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER'>;
  reviewerThresholdPct?: number;
  isKillSwitchActive: () => Promise<boolean>;
  loadBingxClient: () => Promise<BingxClient | null>;
  loadPortfolio: () => Promise<PortfolioState>;
  signalFn: typeof runSignal;
  decisionFn: typeof runDecision;
  validateFn: typeof validate;
  executeFn: typeof execute;
  db: typeof db;
  logger: { info: (msg: string, ctx?: unknown) => void; warn: (msg: string, ctx?: unknown) => void; error: (msg: string, ctx?: unknown) => void };
}

export interface UserTickReport {
  userId: string;
  status:
    | 'COMPLETED'
    | 'SKIPPED_KILL_SWITCH'
    | 'SKIPPED_NO_BINGX_CLIENT'
    | 'SIGNAL_FAILED'
    | 'DECISION_FAILED'
    | 'PARTIAL';
  proposedCount: number;
  executedCount: number;
  failedCount: number;
  rejectedCount: number;
}

async function updateDecisionStatus(
  database: typeof db,
  decisionId: string,
  status: 'EXECUTED' | 'EXECUTION_FAILED',
  reason: string | null,
): Promise<void> {
  await database
    .update(aiDecisions)
    .set({
      status,
      rejectionReason: reason,
      executedAt: status === 'EXECUTED' ? new Date() : null,
    })
    .where(eq(aiDecisions.id, decisionId))
    .returning();
}

export async function runUserTick(params: RunUserTickParams): Promise<UserTickReport> {
  const report: UserTickReport = {
    userId: params.userId,
    status: 'COMPLETED',
    proposedCount: 0,
    executedCount: 0,
    failedCount: 0,
    rejectedCount: 0,
  };

  if (await params.isKillSwitchActive()) {
    params.logger.info('kill_switch_at_start', { userId: params.userId });
    return { ...report, status: 'SKIPPED_KILL_SWITCH' };
  }

  const client = await params.loadBingxClient();
  if (!client) {
    params.logger.warn('no_bingx_client', { userId: params.userId });
    return { ...report, status: 'SKIPPED_NO_BINGX_CLIENT' };
  }

  const portfolioState = await params.loadPortfolio();

  const signalOutcome: SignalOutcome = await params.signalFn({
    userId: params.userId,
    allowedSymbols: params.allowedSymbols,
    anthropicApiKey: params.anthropicApiKey,
    bingxClient: client,
    db: params.db,
  });

  if (!signalOutcome.ok) {
    params.logger.warn('signal_failed', { userId: params.userId, kind: signalOutcome.error.kind });
    return { ...report, status: 'SIGNAL_FAILED' };
  }

  if (await params.isKillSwitchActive()) {
    return { ...report, status: 'SKIPPED_KILL_SWITCH' };
  }

  const decisionOutcome: DecisionOutcome = await params.decisionFn({
    userId: params.userId,
    candidates: signalOutcome.result.candidates,
    portfolioState,
    config: {
      mode: 'BALANCED',
      maxCapitalUsdt: params.maxCapitalUsdt,
      maxConcurrentBots: params.maxConcurrentBots,
      allowedStrategies: params.allowedStrategies,
    },
    anthropicApiKey: params.anthropicApiKey,
  });

  if (!decisionOutcome.ok) {
    params.logger.warn('decision_failed', { userId: params.userId, kind: decisionOutcome.error.kind });
    return { ...report, status: 'DECISION_FAILED' };
  }

  const actions: ProposedAction[] = decisionOutcome.result.proposedActions;
  report.proposedCount = actions.length;

  for (const action of actions) {
    if (await params.isKillSwitchActive()) {
      return { ...report, status: 'SKIPPED_KILL_SWITCH' };
    }

    let validation: ValidationResult;
    try {
      validation = await params.validateFn({
        userId: params.userId,
        action,
        config: {
          maxCapitalUsdt: params.maxCapitalUsdt,
          maxConcurrentBots: params.maxConcurrentBots,
          maxLeverage: params.maxLeverage,
          allowedStrategies: params.allowedStrategies,
          killSwitch: false,
          reviewerThresholdPct: params.reviewerThresholdPct ?? DEFAULT_REVIEWER_THRESHOLD_PCT,
        },
        portfolioState,
        anthropicApiKey: params.anthropicApiKey,
        bingxClient: client,
        db: params.db,
      });
    } catch (err) {
      params.logger.error('validate_threw', { userId: params.userId, err: err instanceof Error ? err.message : String(err) });
      report.failedCount += 1;
      continue;
    }

    if (validation.status !== 'PROPOSED') {
      report.rejectedCount += 1;
      continue;
    }

    let execution: ExecutionResult;
    try {
      execution = await params.executeFn({
        userId: params.userId,
        decisionId: validation.decisionId,
        action,
        config: { bingxApiKeyId: params.bingxApiKeyId, paperMode: params.paperMode },
        db: params.db,
      });
    } catch (err) {
      params.logger.error('execute_threw', { userId: params.userId, err: err instanceof Error ? err.message : String(err) });
      report.failedCount += 1;
      await updateDecisionStatus(params.db, validation.decisionId, 'EXECUTION_FAILED', 'execute threw');
      continue;
    }

    if (execution.status === 'EXECUTED') {
      report.executedCount += 1;
      await updateDecisionStatus(params.db, validation.decisionId, 'EXECUTED', null);
    } else {
      report.failedCount += 1;
      await updateDecisionStatus(params.db, validation.decisionId, 'EXECUTION_FAILED', execution.reason ?? null);
    }
  }

  if (report.failedCount > 0) {
    report.status = 'PARTIAL';
  }

  return report;
}

export const aiPmTick = inngest.createFunction(
  {
    id: 'ai-pm-tick',
    name: 'AI Portfolio Manager Tick',
    retries: 0,
    concurrency: { limit: 3 },
  },
  { cron: '*/30 * * * *' },
  async ({ step, logger }) => {
    const configs = await step.run('load-enabled-configs', async () => {
      return listEnabledAiPmConfigs();
    });

    if (configs.length === 0) {
      logger.info('no enabled AI PM configs');
      return { tickAt: Date.now(), users: 0 };
    }

    const reports: UserTickReport[] = [];
    for (const cfg of configs) {
      const report = await step.run(`user-${cfg.userId}`, async () => {
        return runUserTick({
          userId: cfg.userId,
          anthropicApiKey: cfg.anthropicApiKey,
          bingxApiKeyId: cfg.bingxApiKeyId,
          paperMode: cfg.paperMode,
          allowedSymbols: cfg.allowedSymbols ?? [],
          maxCapitalUsdt: Number(cfg.maxCapitalUsdt ?? DEFAULT_MAX_CAPITAL),
          maxConcurrentBots: cfg.maxConcurrentBots ?? DEFAULT_MAX_CONCURRENT,
          maxLeverage: cfg.maxLeverage ?? 20,
          allowedStrategies: (cfg.allowedStrategies ?? DEFAULT_STRATEGIES) as Array<'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER'>,
          reviewerThresholdPct: DEFAULT_REVIEWER_THRESHOLD_PCT,
          isKillSwitchActive: async () => {
            const fresh = await getAiPmConfigById(cfg.id);
            return Boolean(fresh?.killSwitch);
          },
          loadBingxClient: async () => getBingxClientByApiKeyId(cfg.bingxApiKeyId),
          loadPortfolio: async () =>
            loadPortfolioState({ userId: cfg.userId, bingxApiKeyId: cfg.bingxApiKeyId, db }),
          signalFn: runSignal,
          decisionFn: runDecision,
          validateFn: validate,
          executeFn: execute,
          db,
          logger: {
            info: (msg, ctx) => logger.info(msg, ctx ?? {}),
            warn: (msg, ctx) => logger.warn(msg, ctx ?? {}),
            error: (msg, ctx) => logger.error(msg, ctx ?? {}),
          },
        });
      });
      reports.push(report);
    }

    return { tickAt: Date.now(), users: configs.length, reports };
  },
);
