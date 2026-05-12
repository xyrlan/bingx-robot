import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { aiDecisions, aiSignals } from '@/db/schema';
import type { db as Db } from '@/db';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';
import type { AiPmConfigDecrypted } from '@/services/ai-pm-config.service';
import { setKillSwitch as defaultSetKillSwitch } from '@/services/ai-pm-config.service';
import { validate as defaultValidate } from '@/lib/ai-pm/validation';
import { execute as defaultExecute } from '@/lib/ai-pm/executor';
import type { BingxClient } from '@/lib/bingx/client';
import type { ProposedAction } from '@/lib/ai-pm/decision.prompt';
import type { ToolDefinition } from '@/lib/ai-pm/llm';

export type ToolName =
  | 'read_portfolio'
  | 'read_signals'
  | 'read_decisions'
  | 'create_bot'
  | 'stop_bot'
  | 'pause_kill_switch';

const DECISION_STATUSES = [
  'PROPOSED', 'REJECTED_GUARDRAIL', 'REJECTED_BACKTEST',
  'REJECTED_REVIEWER', 'EXECUTED', 'EXECUTION_FAILED',
] as const;

export const ReadPortfolioArgs = z.object({});
export const ReadSignalsArgs = z.object({ limit: z.number().int().min(1).max(20).optional() });
export const ReadDecisionsArgs = z.object({
  limit: z.number().int().min(1).max(20).optional(),
  status: z.enum(DECISION_STATUSES).optional(),
});
// Note: schemas are intentionally permissive at the tool layer. Tighter
// constraints (e.g. leverage <= maxLeverage from config, valid UUID, allowed
// strategy) are enforced by validate() guardrails so they surface as
// REJECTED_GUARDRAIL decisions instead of zod parse errors.
export const CreateBotArgs = z.object({
  symbol: z.string().min(1),
  strategy: z.enum(['DCA', 'TRAILING_STOP', 'DCA_SPOT', 'SMA_CROSSOVER']),
  capitalUsdt: z.number().positive(),
  leverage: z.number().int().min(1).max(20),
  reasoning: z.string().min(1).max(500),
});
export const StopBotArgs = z.object({
  botId: z.string().uuid(),
  reasoning: z.string().min(1).max(500),
});
export const PauseKillSwitchArgs = z.object({
  reason: z.string().min(1).max(500),
});

export const ALL_TOOL_DEFINITIONS: ToolDefinition<unknown>[] = [
  { name: 'read_portfolio', description: 'Returns the current portfolio snapshot.', schema: ReadPortfolioArgs },
  { name: 'read_signals', description: 'Returns the most recent AI signals.', schema: ReadSignalsArgs },
  { name: 'read_decisions', description: 'Returns recent AI decisions, optionally filtered by status.', schema: ReadDecisionsArgs },
  { name: 'create_bot', description: 'Creates a new trading bot via validate+execute.', schema: CreateBotArgs },
  { name: 'stop_bot', description: 'Stops a running trading bot via validate+execute.', schema: StopBotArgs },
  { name: 'pause_kill_switch', description: 'Activates the kill switch immediately.', schema: PauseKillSwitchArgs },
];

export interface ToolExecContext {
  userId: string;
  configId: string;
  chatMessageId: string | null;
  portfolioState: PortfolioState;
  config: AiPmConfigDecrypted;
  db: typeof Db;
  bingxClient?: BingxClient;
  validateFn?: typeof defaultValidate;
  executeFn?: typeof defaultExecute;
  setKillSwitchFn?: typeof defaultSetKillSwitch;
}

export type ToolStatus =
  | 'EXECUTED'
  | 'REJECTED_GUARDRAIL'
  | 'REJECTED_BACKTEST'
  | 'REJECTED_REVIEWER'
  | 'EXECUTION_FAILED';

export interface ToolExecResult {
  status: ToolStatus;
  decisionId: string | null;
  summary: string;
  payload: unknown;
}

export async function executeTool(
  name: ToolName,
  args: unknown,
  ctx: ToolExecContext,
): Promise<ToolExecResult> {
  switch (name) {
    case 'read_portfolio': return readPortfolio(ctx);
    case 'read_signals': return readSignals(ReadSignalsArgs.parse(args), ctx);
    case 'read_decisions': return readDecisions(ReadDecisionsArgs.parse(args), ctx);
    case 'create_bot': return createBotTool(CreateBotArgs.parse(args), ctx);
    case 'stop_bot': return stopBotTool(StopBotArgs.parse(args), ctx);
    case 'pause_kill_switch': return pauseKillSwitchTool(PauseKillSwitchArgs.parse(args), ctx);
  }
}

function readPortfolio(ctx: ToolExecContext): ToolExecResult {
  const n = ctx.portfolioState.runningBots.length;
  return {
    status: 'EXECUTED',
    decisionId: null,
    summary: `${n} bot${n === 1 ? '' : 's'} running, $${ctx.portfolioState.capitalUsedUsdt.toFixed(2)} used`,
    payload: ctx.portfolioState,
  };
}

async function readSignals(args: z.infer<typeof ReadSignalsArgs>, ctx: ToolExecContext): Promise<ToolExecResult> {
  const rows = await ctx.db
    .select()
    .from(aiSignals)
    .where(eq(aiSignals.userId, ctx.userId))
    .orderBy(desc(aiSignals.createdAt))
    .limit(args.limit ?? 10);
  return {
    status: 'EXECUTED',
    decisionId: null,
    summary: `${rows.length} signal${rows.length === 1 ? '' : 's'} returned`,
    payload: rows.map((r) => ({
      id: r.id, symbol: r.symbol, regime: r.regime, score: r.score, reason: r.reason,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

async function readDecisions(args: z.infer<typeof ReadDecisionsArgs>, ctx: ToolExecContext): Promise<ToolExecResult> {
  const whereExpr = args.status
    ? and(eq(aiDecisions.userId, ctx.userId), eq(aiDecisions.status, args.status))
    : eq(aiDecisions.userId, ctx.userId);
  const rows = await ctx.db
    .select()
    .from(aiDecisions)
    .where(whereExpr)
    .orderBy(desc(aiDecisions.createdAt))
    .limit(args.limit ?? 10);
  return {
    status: 'EXECUTED',
    decisionId: null,
    summary: `${rows.length} decision${rows.length === 1 ? '' : 's'} returned`,
    payload: rows.map((r) => ({
      id: r.id, actionType: r.actionType, status: r.status, symbol: r.symbol,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

function killSwitchRefusal(ctx: ToolExecContext): ToolExecResult {
  return {
    status: 'EXECUTION_FAILED',
    decisionId: null,
    summary: 'Kill switch is active — mutating tools refused.',
    payload: { configId: ctx.configId, killSwitch: true },
  };
}

type AllowedStrategy = 'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER';
const STRATEGY_VALUES: readonly AllowedStrategy[] = ['DCA', 'TRAILING_STOP', 'DCA_SPOT', 'SMA_CROSSOVER'];

function guardrailConfig(cfg: ToolExecContext['config']) {
  const allowed = (cfg.allowedStrategies ?? STRATEGY_VALUES).filter(
    (s): s is AllowedStrategy => (STRATEGY_VALUES as readonly string[]).includes(s),
  );
  return {
    maxCapitalUsdt: Number(cfg.maxCapitalUsdt ?? 0),
    maxConcurrentBots: cfg.maxConcurrentBots ?? 5,
    allowedStrategies: allowed,
    killSwitch: cfg.killSwitch,
    reviewerThresholdPct: 50,
  };
}

async function createBotTool(args: z.infer<typeof CreateBotArgs>, ctx: ToolExecContext): Promise<ToolExecResult> {
  if (ctx.config.killSwitch) return killSwitchRefusal(ctx);
  const action: ProposedAction = { type: 'create_bot', ...args };
  const validateFn = ctx.validateFn ?? defaultValidate;
  const executeFn = ctx.executeFn ?? defaultExecute;

  const validation = await validateFn({
    userId: ctx.userId,
    action,
    config: guardrailConfig(ctx.config),
    portfolioState: ctx.portfolioState,
    anthropicApiKey: ctx.config.anthropicApiKey,
    bingxClient: ctx.bingxClient,
    db: ctx.db,
    triggeredBy: 'CHAT',
    chatMessageId: ctx.chatMessageId,
  } as Parameters<typeof defaultValidate>[0]);

  if (validation.status !== 'PROPOSED') {
    return {
      status: validation.status,
      decisionId: validation.decisionId,
      summary: `create_bot rejected: ${validation.reason ?? validation.status}`,
      payload: { decisionId: validation.decisionId, reason: validation.reason },
    };
  }

  try {
    const exec = await executeFn({
      userId: ctx.userId,
      decisionId: validation.decisionId,
      action,
      config: { bingxApiKeyId: ctx.config.bingxApiKeyId, paperMode: ctx.config.paperMode },
      db: ctx.db,
    });
    return {
      status: exec.status,
      decisionId: exec.decisionId,
      summary: exec.status === 'EXECUTED'
        ? `create_bot ${args.symbol} ${args.strategy} executed (bot ${(exec.realBotId ?? exec.paperBotId ?? '?').slice(0, 8)})`
        : `create_bot failed: ${exec.reason ?? 'unknown'}`,
      payload: exec,
    };
  } catch (err) {
    return {
      status: 'EXECUTION_FAILED',
      decisionId: validation.decisionId,
      summary: `create_bot threw: ${err instanceof Error ? err.message : String(err)}`,
      payload: null,
    };
  }
}

async function stopBotTool(args: z.infer<typeof StopBotArgs>, ctx: ToolExecContext): Promise<ToolExecResult> {
  if (ctx.config.killSwitch) return killSwitchRefusal(ctx);
  const action: ProposedAction = { type: 'stop_bot', ...args };
  const validateFn = ctx.validateFn ?? defaultValidate;
  const executeFn = ctx.executeFn ?? defaultExecute;

  const validation = await validateFn({
    userId: ctx.userId,
    action,
    config: guardrailConfig(ctx.config),
    portfolioState: ctx.portfolioState,
    anthropicApiKey: ctx.config.anthropicApiKey,
    bingxClient: ctx.bingxClient,
    db: ctx.db,
    triggeredBy: 'CHAT',
    chatMessageId: ctx.chatMessageId,
  } as Parameters<typeof defaultValidate>[0]);

  if (validation.status !== 'PROPOSED') {
    return {
      status: validation.status,
      decisionId: validation.decisionId,
      summary: `stop_bot rejected: ${validation.reason ?? validation.status}`,
      payload: { decisionId: validation.decisionId, reason: validation.reason },
    };
  }

  try {
    const exec = await executeFn({
      userId: ctx.userId,
      decisionId: validation.decisionId,
      action,
      config: { bingxApiKeyId: ctx.config.bingxApiKeyId, paperMode: ctx.config.paperMode },
      db: ctx.db,
    });
    return {
      status: exec.status,
      decisionId: exec.decisionId,
      summary: exec.status === 'EXECUTED' ? `stop_bot ${args.botId.slice(0, 8)} executed` : `stop_bot failed: ${exec.reason ?? 'unknown'}`,
      payload: exec,
    };
  } catch (err) {
    return {
      status: 'EXECUTION_FAILED',
      decisionId: validation.decisionId,
      summary: `stop_bot threw: ${err instanceof Error ? err.message : String(err)}`,
      payload: null,
    };
  }
}

async function pauseKillSwitchTool(args: z.infer<typeof PauseKillSwitchArgs>, ctx: ToolExecContext): Promise<ToolExecResult> {
  const setSwitch = ctx.setKillSwitchFn ?? defaultSetKillSwitch;
  // Fail-closed: if setSwitch succeeds but the audit insert throws, the switch
  // remains ON without an audit row. Acceptable v1: safer to be paused than not.
  try {
    await setSwitch(ctx.configId, true);
    const [row] = await ctx.db
      .insert(aiDecisions)
      .values({
        userId: ctx.userId,
        triggeredBy: 'CHAT',
        actionType: 'NO_ACTION',
        status: 'EXECUTED',
        reasoning: args.reason,
        chatMessageId: ctx.chatMessageId,
      })
      .returning();
    return {
      status: 'EXECUTED',
      decisionId: row.id,
      summary: 'Kill switch activated.',
      payload: { configId: ctx.configId, killSwitch: true },
    };
  } catch (err) {
    return {
      status: 'EXECUTION_FAILED',
      decisionId: null,
      summary: `pause_kill_switch failed: ${err instanceof Error ? err.message : String(err)}`,
      payload: null,
    };
  }
}
