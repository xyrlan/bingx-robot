import { z } from 'zod';
import { callOpus, type AnthropicFactory, type LlmError, type LlmUsage } from '@/lib/ai-pm/llm';
import type { ProposedAction } from '@/lib/ai-pm/decision.prompt';

export const ReviewerSchema = z.object({
  approve: z.boolean(),
  rationale: z.string().min(1).max(1000),
});

export type ReviewerVerdict = z.infer<typeof ReviewerSchema>;

export interface BacktestSummary {
  pnlPct: number;
  maxDrawdownPct: number;
  sharpeApprox: number;
  winRatePct: number;
  totalTrades: number;
}

export interface ReviewWithOpusParams {
  action: ProposedAction;
  backtestSummary: BacktestSummary | null;
  reasoning: string;
  anthropicApiKey: string;
  factory?: AnthropicFactory;
}

export type ReviewerError =
  | { kind: 'LLM_ERROR'; cause: LlmError }
  | { kind: 'SCHEMA_REJECTED'; issues: unknown };

export type ReviewerOutcome =
  | { ok: true; verdict: ReviewerVerdict; usage: LlmUsage }
  | { ok: false; error: ReviewerError };

function buildSystemPrompt(): string {
  return [
    'You are a senior risk reviewer for a crypto trading portfolio.',
    'Given a proposed action, its rationale, and (when applicable) a backtest summary,',
    'decide whether to approve or veto.',
    '',
    'Approve only if the action has acceptable risk-reward given the data.',
    'Return JSON only: {"approve":boolean,"rationale":"one sentence"}.',
  ].join('\n');
}

function buildUserPrompt(params: ReviewWithOpusParams): string {
  const summaryLine = params.backtestSummary
    ? `Backtest: pnl=${params.backtestSummary.pnlPct.toFixed(2)}% dd=${params.backtestSummary.maxDrawdownPct.toFixed(2)}% sharpe=${params.backtestSummary.sharpeApprox.toFixed(2)} winRate=${params.backtestSummary.winRatePct.toFixed(2)}% trades=${params.backtestSummary.totalTrades}`
    : 'Backtest: (not applicable)';
  return [
    `Action: ${JSON.stringify(params.action)}`,
    `Original reasoning: ${params.reasoning}`,
    summaryLine,
    '',
    'Return verdict as JSON.',
  ].join('\n');
}

export async function reviewWithOpus(params: ReviewWithOpusParams): Promise<ReviewerOutcome> {
  const llm = await callOpus({
    apiKey: params.anthropicApiKey,
    systemPrompt: buildSystemPrompt(),
    userPrompt: buildUserPrompt(params),
    schema: ReviewerSchema,
    factory: params.factory,
  });

  if (!llm.ok) {
    if (llm.error.kind === 'SCHEMA_REJECTED') {
      return { ok: false, error: { kind: 'SCHEMA_REJECTED', issues: llm.error.issues } };
    }
    return { ok: false, error: { kind: 'LLM_ERROR', cause: llm.error } };
  }

  return { ok: true, verdict: llm.data, usage: llm.usage };
}
