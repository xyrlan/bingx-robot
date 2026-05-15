import { callSonnet, type AnthropicFactory, type LlmError, type LlmUsage } from '@/lib/ai-pm/llm';
import {
  ActionSchema,
  AutonomousActionSchema,
  ProposeActionsSchema,
  buildSystemPrompt,
  buildUserPrompt,
  buildAutonomousSystemPrompt,
  buildAutonomousUserPrompt,
  type ProposedAction,
  type DecisionConfig,
} from '@/lib/ai-pm/decision.prompt';
import type { SignalCandidate } from '@/lib/ai-pm/signal';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';

export interface RejectedAction {
  raw: unknown;
  issues: unknown;
}

export interface DecisionResult {
  proposedActions: ProposedAction[];
  rejectedActions: RejectedAction[];
  usage: LlmUsage;
}

export type DecisionError =
  | { kind: 'LLM_ERROR'; cause: LlmError }
  | { kind: 'NO_TOOL_USE'; message: string }
  | { kind: 'SCHEMA_REJECTED'; issues: unknown };

export type DecisionOutcome =
  | { ok: true; result: DecisionResult }
  | { ok: false; error: DecisionError };

export interface RunDecisionParams {
  userId: string;
  candidates: SignalCandidate[];
  portfolioState: PortfolioState;
  config: DecisionConfig;
  anthropicApiKey: string;
  factory?: AnthropicFactory;
  cacheSystem?: boolean;
  /** When true, restrict the action surface to direct-order actions and use the autonomous prompts. */
  autonomous?: boolean;
}

const TOOL_NAME = 'propose_actions';

export async function runDecision(params: RunDecisionParams): Promise<DecisionOutcome> {
  const autonomous = params.autonomous === true;
  const systemPrompt = autonomous ? buildAutonomousSystemPrompt() : buildSystemPrompt();
  const userPrompt = autonomous
    ? buildAutonomousUserPrompt({
        candidates: params.candidates,
        portfolioState: params.portfolioState,
        config: params.config,
      })
    : buildUserPrompt({
        candidates: params.candidates,
        portfolioState: params.portfolioState,
        config: params.config,
      });
  const actionSchema = autonomous ? AutonomousActionSchema : ActionSchema;

  const llm = await callSonnet({
    apiKey: params.anthropicApiKey,
    systemPrompt,
    userPrompt,
    tools: [
      {
        name: TOOL_NAME,
        description: 'Propose a list of trading actions in response to current portfolio state.',
        schema: ProposeActionsSchema,
      },
    ],
    factory: params.factory,
    cacheSystem: params.cacheSystem ?? true,
  });

  if (!llm.ok) {
    if (llm.error.kind === 'NO_TOOL_USE') {
      return { ok: false, error: { kind: 'NO_TOOL_USE', message: llm.error.message } };
    }
    if (llm.error.kind === 'SCHEMA_REJECTED') {
      return { ok: false, error: { kind: 'SCHEMA_REJECTED', issues: llm.error.issues } };
    }
    return { ok: false, error: { kind: 'LLM_ERROR', cause: llm.error } };
  }

  const raw = llm.data.args as { actions: unknown[] };
  const proposedActions: ProposedAction[] = [];
  const rejectedActions: RejectedAction[] = [];

  for (const entry of raw.actions) {
    const parsed = actionSchema.safeParse(entry);
    if (parsed.success) {
      proposedActions.push(parsed.data);
    } else {
      rejectedActions.push({ raw: entry, issues: parsed.error.issues });
    }
  }

  return { ok: true, result: { proposedActions, rejectedActions, usage: llm.usage } };
}
