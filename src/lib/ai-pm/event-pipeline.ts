import { runSignal as defaultSignal } from '@/lib/ai-pm/signal';
import { runDecision as defaultDecision } from '@/lib/ai-pm/decision';
import { validate as defaultValidate } from '@/lib/ai-pm/validation';
import { execute as defaultExecute } from '@/lib/ai-pm/executor';
import { aiDecisions } from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { db as Db } from '@/db';
import type { BingxClient } from '@/lib/bingx/client';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';
import type { AiTriggerEnum, AiPmEventPayload } from '@/lib/ai-pm/events';
import type { AiPmConfigDecrypted } from '@/services/ai-pm-config.service';

export type ScopedPipelineStatus =
  | 'COMPLETED'
  | 'SKIPPED_KILL_SWITCH'
  | 'SKIPPED_NO_BINGX_CLIENT'
  | 'SIGNAL_FAILED'
  | 'DECISION_FAILED'
  | 'PARTIAL';

export interface ScopedPipelineResult {
  status: ScopedPipelineStatus;
  proposedCount: number;
  executedCount: number;
  failedCount: number;
  rejectedCount: number;
  executedDecisionId: string | null;
}

export interface RunScopedPipelineParams {
  eventType: AiTriggerEnum;
  symbol: string;
  payload: AiPmEventPayload;
  aiEventId: string;
  config: AiPmConfigDecrypted;
  bingxClient: BingxClient;
  portfolioState: PortfolioState;
  db: typeof Db;
  signalFn?: typeof defaultSignal;
  decisionFn?: typeof defaultDecision;
  validateFn?: typeof defaultValidate;
  executeFn?: typeof defaultExecute;
  updateDecisionStatusFn?: typeof updateDecisionStatus;
  isKillSwitchActive: () => Promise<boolean>;
  logger: {
    info: (msg: string, ctx?: unknown) => void;
    warn: (msg: string, ctx?: unknown) => void;
    error: (msg: string, ctx?: unknown) => void;
  };
}

const DEFAULT_REVIEWER_THRESHOLD_PCT = 30;

async function updateDecisionStatus(
  database: typeof Db,
  decisionId: string,
  status: 'EXECUTED' | 'EXECUTION_FAILED',
  reason: string | null,
  eventType: AiTriggerEnum,
  triggerDetail: string,
): Promise<void> {
  await database
    .update(aiDecisions)
    .set({
      status,
      rejectionReason: reason,
      executedAt: status === 'EXECUTED' ? new Date() : null,
      triggeredBy: eventType,
      triggerDetail,
    })
    .where(eq(aiDecisions.id, decisionId))
    .returning();
}

export async function runScopedPipeline(params: RunScopedPipelineParams): Promise<ScopedPipelineResult> {
  const signalFn = params.signalFn ?? defaultSignal;
  const decisionFn = params.decisionFn ?? defaultDecision;
  const validateFn = params.validateFn ?? defaultValidate;
  const executeFn = params.executeFn ?? defaultExecute;
  const updateFn = params.updateDecisionStatusFn ?? updateDecisionStatus;

  const result: ScopedPipelineResult = {
    status: 'COMPLETED',
    proposedCount: 0,
    executedCount: 0,
    failedCount: 0,
    rejectedCount: 0,
    executedDecisionId: null,
  };

  if (await params.isKillSwitchActive()) {
    return { ...result, status: 'SKIPPED_KILL_SWITCH' };
  }

  const signalOutcome = await signalFn({
    userId: params.config.userId,
    allowedSymbols: [params.symbol],
    anthropicApiKey: params.config.anthropicApiKey,
    bingxClient: params.bingxClient,
    db: params.db,
  });

  if (!signalOutcome.ok) {
    params.logger.warn('event_signal_failed', { aiEventId: params.aiEventId, kind: signalOutcome.error.kind });
    return { ...result, status: 'SIGNAL_FAILED' };
  }

  if (await params.isKillSwitchActive()) {
    return { ...result, status: 'SKIPPED_KILL_SWITCH' };
  }

  const decisionOutcome = await decisionFn({
    userId: params.config.userId,
    candidates: signalOutcome.result.candidates,
    portfolioState: params.portfolioState,
    config: {
      mode: 'BALANCED',
      maxCapitalUsdt: Number(params.config.maxCapitalUsdt ?? 1000),
      maxConcurrentBots: params.config.maxConcurrentBots ?? 5,
      allowedStrategies: (params.config.allowedStrategies ?? ['DCA', 'TRAILING_STOP', 'DCA_SPOT', 'SMA_CROSSOVER']) as Array<'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER'>,
    },
    anthropicApiKey: params.config.anthropicApiKey,
  });

  if (!decisionOutcome.ok) {
    params.logger.warn('event_decision_failed', { aiEventId: params.aiEventId, kind: decisionOutcome.error.kind });
    return { ...result, status: 'DECISION_FAILED' };
  }

  const actions = decisionOutcome.result.proposedActions;
  result.proposedCount = actions.length;
  const triggerDetail = JSON.stringify({ aiEventId: params.aiEventId, eventType: params.eventType, symbol: params.symbol });

  for (const action of actions) {
    if (await params.isKillSwitchActive()) {
      return { ...result, status: 'SKIPPED_KILL_SWITCH' };
    }

    let validation;
    try {
      validation = await validateFn({
        userId: params.config.userId,
        action,
        config: {
          maxCapitalUsdt: Number(params.config.maxCapitalUsdt ?? 1000),
          maxConcurrentBots: params.config.maxConcurrentBots ?? 5,
          allowedStrategies: (params.config.allowedStrategies ?? ['DCA', 'TRAILING_STOP', 'DCA_SPOT', 'SMA_CROSSOVER']) as Array<'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER'>,
          killSwitch: false,
          reviewerThresholdPct: DEFAULT_REVIEWER_THRESHOLD_PCT,
        },
        portfolioState: params.portfolioState,
        anthropicApiKey: params.config.anthropicApiKey,
        bingxClient: params.bingxClient,
        db: params.db,
      });
    } catch (err) {
      params.logger.error('event_validate_threw', { aiEventId: params.aiEventId, err: err instanceof Error ? err.message : String(err) });
      result.failedCount += 1;
      continue;
    }

    if (validation.status !== 'PROPOSED') {
      result.rejectedCount += 1;
      continue;
    }

    let exec;
    try {
      exec = await executeFn({
        userId: params.config.userId,
        decisionId: validation.decisionId,
        action,
        config: { bingxApiKeyId: params.config.bingxApiKeyId, paperMode: params.config.paperMode },
        db: params.db,
      });
    } catch (err) {
      params.logger.error('event_execute_threw', { aiEventId: params.aiEventId, err: err instanceof Error ? err.message : String(err) });
      result.failedCount += 1;
      await updateFn(params.db, validation.decisionId, 'EXECUTION_FAILED', 'execute threw', params.eventType, triggerDetail);
      continue;
    }

    if (exec.status === 'EXECUTED') {
      result.executedCount += 1;
      result.executedDecisionId ??= validation.decisionId;
      await updateFn(params.db, validation.decisionId, 'EXECUTED', null, params.eventType, triggerDetail);
    } else {
      result.failedCount += 1;
      await updateFn(params.db, validation.decisionId, 'EXECUTION_FAILED', exec.reason ?? null, params.eventType, triggerDetail);
    }
  }

  if (result.failedCount > 0) result.status = 'PARTIAL';
  return result;
}
