import { aiDecisions } from '@/db/schema';
import type { db as Db } from '@/db';
import type { ProposedAction } from '@/lib/ai-pm/decision.prompt';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';
import type { SignalCandidate } from '@/lib/ai-pm/signal';
import { runGuardrails, type GuardrailConfig } from '@/lib/ai-pm/guardrails';
import { reviewWithOpus } from '@/lib/ai-pm/reviewer';
import type { AnthropicFactory, LlmUsage } from '@/lib/ai-pm/llm';
import type { BingxClient } from '@/lib/bingx/client';
import { runBacktest } from '@/lib/backtest';
import type { BacktestResult } from '@/lib/backtest/types';

export type ValidationStatus =
  | 'PROPOSED'
  | 'REJECTED_GUARDRAIL'
  | 'REJECTED_BACKTEST'
  | 'REJECTED_REVIEWER';

export interface ValidationResult {
  status: ValidationStatus;
  decisionId: string;
  reason?: string;
  backtestRunId?: string;
  reviewerUsage?: LlmUsage;
}

export interface ValidateParams {
  userId: string;
  action: ProposedAction;
  config: GuardrailConfig & { reviewerThresholdPct: number };
  portfolioState: PortfolioState;
  signalCandidate?: SignalCandidate;
  anthropicApiKey: string;
  bingxClient?: BingxClient;
  db: typeof Db;
  runBacktestFn?: typeof runBacktest;
  reviewerFn?: typeof reviewWithOpus;
  factory?: AnthropicFactory;
  triggeredBy?: 'CRON_TICK' | 'EVENT_DRAWDOWN' | 'EVENT_FUNDING_FLIP' | 'EVENT_FILL' | 'EVENT_ERROR' | 'CHAT';
  chatMessageId?: string | null;
  resultOrderId?: string | null;
}

const ACTION_TYPE_MAP: Record<ProposedAction['type'], 'CREATE_BOT' | 'STOP_BOT' | 'ADJUST_PARAMS' | 'REALLOCATE_CAPITAL' | 'NO_ACTION'> = {
  create_bot: 'CREATE_BOT',
  stop_bot: 'STOP_BOT',
  adjust_params: 'ADJUST_PARAMS',
  reallocate_capital: 'REALLOCATE_CAPITAL',
  no_action: 'NO_ACTION',
};

function actionSymbol(action: ProposedAction): string | null {
  return action.type === 'create_bot' ? action.symbol : null;
}

function needsBacktest(action: ProposedAction): boolean {
  return action.type === 'create_bot';
}

function needsReviewer(action: ProposedAction, portfolio: PortfolioState, thresholdPct: number, maxCapital: number): boolean {
  if (action.type !== 'create_bot') return false;
  const firstTime = !portfolio.runningBots.some((b) => b.symbol === action.symbol);
  const ratio = ((portfolio.capitalUsedUsdt + action.capitalUsdt) / maxCapital) * 100;
  return firstTime || ratio > thresholdPct;
}

async function persistDecision(
  params: ValidateParams,
  status: ValidationStatus,
  reason?: string,
  backtestRunId?: string,
  reviewerUsage?: LlmUsage,
): Promise<string> {
  const action = params.action;
  const inserted = await params.db
    .insert(aiDecisions)
    .values([{
      userId: params.userId,
      triggeredBy: params.triggeredBy ?? 'CRON_TICK',
      chatMessageId: params.chatMessageId ?? null,
      actionType: ACTION_TYPE_MAP[action.type],
      status,
      symbol: actionSymbol(action),
      strategy: action.type === 'create_bot' ? action.strategy : null,
      params: action,
      reasoning: 'reasoning' in action ? action.reasoning : null,
      signalSnapshot: params.signalCandidate ?? null,
      backtestRunId: backtestRunId ?? null,
      rejectionReason: reason ?? null,
      modelUsed: reviewerUsage ? reviewerUsage.model : null,
      tokensInput: reviewerUsage ? reviewerUsage.inputTokens : null,
      tokensOutput: reviewerUsage ? reviewerUsage.outputTokens : null,
      costUsd: reviewerUsage ? String(reviewerUsage.costUsd) : null,
      resultOrderId: params.resultOrderId ?? null,
    }])
    .returning();
  return inserted[0].id;
}

export async function validate(params: ValidateParams): Promise<ValidationResult> {
  const gate = runGuardrails({
    action: params.action,
    config: params.config,
    portfolioState: params.portfolioState,
  });

  if (!gate.ok) {
    const decisionId = await persistDecision(params, 'REJECTED_GUARDRAIL', gate.message);
    return { status: 'REJECTED_GUARDRAIL', decisionId, reason: gate.message };
  }

  let backtestRunId: string | undefined;
  let backtestSummary: BacktestResult | null = null;

  if (needsBacktest(params.action) && params.action.type === 'create_bot') {
    if (!params.bingxClient) {
      const decisionId = await persistDecision(params, 'REJECTED_GUARDRAIL', 'BingxClient required for backtest');
      return { status: 'REJECTED_GUARDRAIL', decisionId, reason: 'BingxClient required for backtest' };
    }
    const fn = params.runBacktestFn ?? runBacktest;
    backtestSummary = await fn({
      client: params.bingxClient,
      symbol: params.action.symbol,
      strategy: params.action.strategy,
      params: { initialCapitalUsdt: params.action.capitalUsdt } as never,
      initialCapitalUsdt: params.action.capitalUsdt,
    });
    backtestRunId = backtestSummary.runId;

    if (backtestSummary.pnlPct < 0) {
      const decisionId = await persistDecision(
        params,
        'REJECTED_BACKTEST',
        `Backtest pnl ${backtestSummary.pnlPct.toFixed(2)}% < 0`,
        backtestRunId,
      );
      return { status: 'REJECTED_BACKTEST', decisionId, reason: 'Backtest negative P&L', backtestRunId };
    }
  }

  if (
    needsReviewer(
      params.action,
      params.portfolioState,
      params.config.reviewerThresholdPct,
      params.config.maxCapitalUsdt,
    )
  ) {
    const reviewer = params.reviewerFn ?? reviewWithOpus;
    const review = await reviewer({
      action: params.action,
      backtestSummary: backtestSummary
        ? {
            pnlPct: backtestSummary.pnlPct,
            maxDrawdownPct: backtestSummary.maxDrawdownPct,
            sharpeApprox: backtestSummary.sharpeApprox,
            winRatePct: backtestSummary.winRatePct,
            totalTrades: backtestSummary.totalTrades,
          }
        : null,
      reasoning: 'reasoning' in params.action ? params.action.reasoning : '',
      anthropicApiKey: params.anthropicApiKey,
      factory: params.factory,
    });

    if (!review.ok) {
      const decisionId = await persistDecision(
        params,
        'REJECTED_REVIEWER',
        `Reviewer error: ${review.error.kind}`,
        backtestRunId,
      );
      return { status: 'REJECTED_REVIEWER', decisionId, reason: `Reviewer error: ${review.error.kind}`, backtestRunId };
    }

    if (!review.verdict.approve) {
      const decisionId = await persistDecision(
        params,
        'REJECTED_REVIEWER',
        review.verdict.rationale,
        backtestRunId,
        review.usage,
      );
      return {
        status: 'REJECTED_REVIEWER',
        decisionId,
        reason: review.verdict.rationale,
        backtestRunId,
        reviewerUsage: review.usage,
      };
    }

    const decisionId = await persistDecision(params, 'PROPOSED', undefined, backtestRunId, review.usage);
    return { status: 'PROPOSED', decisionId, backtestRunId, reviewerUsage: review.usage };
  }

  const decisionId = await persistDecision(params, 'PROPOSED', undefined, backtestRunId);
  return { status: 'PROPOSED', decisionId, backtestRunId };
}
