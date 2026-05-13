import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { aiDecisions, aiSignals } from '@/db/schema';
import type { db as Db } from '@/db';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';
import type { AiPmConfigDecrypted } from '@/services/ai-pm-config.service';
import { setKillSwitch as defaultSetKillSwitch } from '@/services/ai-pm-config.service';
import { validate as defaultValidate } from '@/lib/ai-pm/validation';
import { execute as defaultExecute, type ExecutionResult } from '@/lib/ai-pm/executor';
import type { BingxClient } from '@/lib/bingx/client';
import type { ProposedAction } from '@/lib/ai-pm/decision.prompt';
import type { ToolDefinition } from '@/lib/ai-pm/llm';
import {
  getFuturesBalance,
  listFuturesPositions,
  listFuturesOpenOrders,
} from '@/services/bingx-orders.service';

export type ToolName =
  | 'read_portfolio'
  | 'read_signals'
  | 'read_decisions'
  | 'read_balance'
  | 'read_positions'
  | 'read_open_orders'
  | 'create_bot'
  | 'stop_bot'
  | 'adjust_params'
  | 'reallocate_capital'
  | 'pause_kill_switch'
  | 'place_market_order'
  | 'place_limit_order'
  | 'place_stop_order'
  | 'place_take_profit'
  | 'place_trailing_stop'
  | 'close_position'
  | 'cancel_order'
  | 'cancel_all_orders';

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
export const ReadBalanceArgs = z.object({});
export const ReadPositionsArgs = z.object({ symbol: z.string().min(1).optional() });
export const ReadOpenOrdersArgs = z.object({ symbol: z.string().min(1).optional() });

const SymbolSchema = z.string().regex(/^[A-Z0-9]+-[A-Z]+$/);
const SideSchema = z.enum(['BUY', 'SELL']);
const PositionSideSchema = z.enum(['LONG', 'SHORT']);

export const PlaceMarketOrderArgs = z.object({
  symbol: SymbolSchema,
  side: SideSchema,
  positionSide: PositionSideSchema,
  capitalUsdt: z.number().positive(),
  leverage: z.number().int().min(1).max(20),
  stopLossPercent: z.number().positive().lt(100).optional(),
  takeProfitPercent: z.number().positive().lt(500).optional(),
  reasoning: z.string().min(1).max(500),
});

export const PlaceLimitOrderArgs = z.object({
  symbol: SymbolSchema,
  side: SideSchema,
  positionSide: PositionSideSchema,
  price: z.number().positive(),
  capitalUsdt: z.number().positive(),
  leverage: z.number().int().min(1).max(20),
  timeInForce: z.enum(['GTC', 'IOC', 'FOK', 'PostOnly']).optional(),
  reasoning: z.string().min(1).max(500),
});

export const PlaceStopOrderArgs = z.object({
  symbol: SymbolSchema,
  side: SideSchema,
  positionSide: PositionSideSchema,
  stopPrice: z.number().positive(),
  capitalUsdt: z.number().positive(),
  leverage: z.number().int().min(1).max(20),
  reasoning: z.string().min(1).max(500),
});

export const PlaceTakeProfitArgs = z.object({
  symbol: SymbolSchema,
  side: SideSchema,
  positionSide: PositionSideSchema,
  stopPrice: z.number().positive(),
  capitalUsdt: z.number().positive(),
  leverage: z.number().int().min(1).max(20),
  reasoning: z.string().min(1).max(500),
});

export const PlaceTrailingStopArgs = z.object({
  symbol: SymbolSchema,
  side: SideSchema,
  positionSide: PositionSideSchema,
  capitalUsdt: z.number().positive(),
  leverage: z.number().int().min(1).max(20),
  callbackRate: z.number().positive().max(1),
  reasoning: z.string().min(1).max(500),
});

export const ClosePositionArgs = z.object({
  symbol: SymbolSchema,
  side: PositionSideSchema.optional(),
  percent: z.number().int().min(1).max(100).optional(),
  reasoning: z.string().min(1).max(500),
});

export const CancelOrderArgs = z.object({
  symbol: SymbolSchema,
  orderId: z.string().min(1),
  reasoning: z.string().min(1).max(500),
});

export const CancelAllOrdersArgs = z.object({
  symbol: SymbolSchema.optional(),
  reasoning: z.string().min(1).max(500),
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

export const AdjustParamsArgs = z.object({
  botId: z.string().uuid(),
  params: z.object({
    capitalUsdt: z.number().positive().optional(),
    leverage: z.number().int().min(1).max(20).optional(),
    strategy: z.enum(['DCA', 'TRAILING_STOP', 'DCA_SPOT', 'SMA_CROSSOVER']).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  }).refine(
    (p) => p.capitalUsdt !== undefined || p.leverage !== undefined || p.strategy !== undefined || p.config !== undefined,
    { message: 'At least one of capitalUsdt / leverage / strategy / config must be set' },
  ),
  reasoning: z.string().min(1).max(500),
});

export const ReallocateCapitalArgs = z.object({
  fromBotId: z.string().uuid(),
  toBotId: z.string().uuid(),
  amountUsdt: z.number().positive(),
  reasoning: z.string().min(1).max(500),
}).refine((v) => v.fromBotId !== v.toBotId, { message: 'fromBotId and toBotId must differ' });

export const ALL_TOOL_DEFINITIONS: ToolDefinition<unknown>[] = [
  { name: 'read_portfolio', description: 'Returns the current portfolio snapshot.', schema: ReadPortfolioArgs },
  { name: 'read_signals', description: 'Returns the most recent AI signals.', schema: ReadSignalsArgs },
  { name: 'read_decisions', description: 'Returns recent AI decisions, optionally filtered by status.', schema: ReadDecisionsArgs },
  { name: 'create_bot', description: 'Creates a new trading bot via validate+execute.', schema: CreateBotArgs },
  { name: 'stop_bot', description: 'Stops a running trading bot via validate+execute.', schema: StopBotArgs },
  { name: 'adjust_params', description: 'Adjusts a running bot config (capital, leverage, strategy, or strategy-specific config). Mutating; routes through validate+execute.', schema: AdjustParamsArgs },
  { name: 'reallocate_capital', description: 'Moves capital between two running bots in the same subaccount.', schema: ReallocateCapitalArgs },
  { name: 'pause_kill_switch', description: 'Activates the kill switch immediately.', schema: PauseKillSwitchArgs },
  { name: 'read_balance', description: 'Read futures account balance, equity, margin, and unrealized P&L.', schema: ReadBalanceArgs },
  { name: 'read_positions', description: 'List current open futures positions.', schema: ReadPositionsArgs },
  { name: 'read_open_orders', description: 'List pending (not yet filled) futures orders.', schema: ReadOpenOrdersArgs },
  { name: 'place_market_order', description: 'Open a futures position at market price.', schema: PlaceMarketOrderArgs },
  { name: 'place_limit_order', description: 'Place a limit-price futures order.', schema: PlaceLimitOrderArgs },
  { name: 'place_stop_order', description: 'Place a stop-market futures order that triggers when the price reaches stopPrice.', schema: PlaceStopOrderArgs },
  { name: 'place_take_profit', description: 'Place a take-profit-market futures order that triggers when the price reaches stopPrice.', schema: PlaceTakeProfitArgs },
  { name: 'place_trailing_stop', description: 'Place a trailing-stop-market futures order with a callbackRate (e.g. 0.05 = 5%).', schema: PlaceTrailingStopArgs },
  { name: 'close_position', description: 'Close an open futures position; without side+percent closes ALL positions for the symbol.', schema: ClosePositionArgs },
  { name: 'cancel_order', description: 'Cancel a single pending futures order by orderId.', schema: CancelOrderArgs },
  { name: 'cancel_all_orders', description: 'Cancel all pending futures orders, optionally filtered by symbol.', schema: CancelAllOrdersArgs },
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
  getFuturesBalanceFn?: typeof getFuturesBalance;
  listFuturesPositionsFn?: typeof listFuturesPositions;
  listFuturesOpenOrdersFn?: typeof listFuturesOpenOrders;
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
    case 'read_balance': return readBalanceTool(ReadBalanceArgs.parse(args), ctx);
    case 'read_positions': return readPositionsTool(ReadPositionsArgs.parse(args), ctx);
    case 'read_open_orders': return readOpenOrdersTool(ReadOpenOrdersArgs.parse(args), ctx);
    case 'create_bot': return createBotTool(CreateBotArgs.parse(args), ctx);
    case 'stop_bot': return stopBotTool(StopBotArgs.parse(args), ctx);
    case 'adjust_params': return adjustParamsTool(AdjustParamsArgs.parse(args), ctx);
    case 'reallocate_capital': return reallocateCapitalTool(ReallocateCapitalArgs.parse(args), ctx);
    case 'pause_kill_switch': return pauseKillSwitchTool(PauseKillSwitchArgs.parse(args), ctx);
    case 'place_market_order': return placeMarketOrderTool(PlaceMarketOrderArgs.parse(args), ctx);
    case 'place_limit_order': return placeLimitOrderTool(PlaceLimitOrderArgs.parse(args), ctx);
    case 'place_stop_order': return placeStopOrderTool(PlaceStopOrderArgs.parse(args), ctx);
    case 'place_take_profit': return placeTakeProfitTool(PlaceTakeProfitArgs.parse(args), ctx);
    case 'place_trailing_stop': return placeTrailingStopTool(PlaceTrailingStopArgs.parse(args), ctx);
    case 'close_position': return closePositionTool(ClosePositionArgs.parse(args), ctx);
    case 'cancel_order': return cancelOrderTool(CancelOrderArgs.parse(args), ctx);
    case 'cancel_all_orders': return cancelAllOrdersTool(CancelAllOrdersArgs.parse(args), ctx);
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
    maxLeverage: cfg.maxLeverage ?? 20,
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
  });

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
  });

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

async function adjustParamsTool(args: z.infer<typeof AdjustParamsArgs>, ctx: ToolExecContext): Promise<ToolExecResult> {
  if (ctx.config.killSwitch) return killSwitchRefusal(ctx);
  const action: ProposedAction = { type: 'adjust_params', botId: args.botId, params: args.params as Record<string, unknown>, reasoning: args.reasoning };
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
  });

  if (validation.status !== 'PROPOSED') {
    return {
      status: validation.status,
      decisionId: validation.decisionId,
      summary: `adjust_params rejected: ${validation.reason ?? validation.status}`,
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
      bingxClient: ctx.bingxClient,
    });
    return {
      status: exec.status,
      decisionId: exec.decisionId,
      summary: exec.status === 'EXECUTED'
        ? exec.newBotId
          ? `adjust_params ${args.botId.slice(0, 8)} strategy change → new bot ${exec.newBotId.slice(0, 8)}`
          : `adjust_params ${args.botId.slice(0, 8)} executed`
        : `adjust_params failed: ${exec.reason ?? 'unknown'}`,
      payload: exec,
    };
  } catch (err) {
    return {
      status: 'EXECUTION_FAILED',
      decisionId: validation.decisionId,
      summary: `adjust_params threw: ${err instanceof Error ? err.message : String(err)}`,
      payload: null,
    };
  }
}

async function reallocateCapitalTool(args: z.infer<typeof ReallocateCapitalArgs>, ctx: ToolExecContext): Promise<ToolExecResult> {
  if (ctx.config.killSwitch) return killSwitchRefusal(ctx);
  const action: ProposedAction = { type: 'reallocate_capital', fromBotId: args.fromBotId, toBotId: args.toBotId, amountUsdt: args.amountUsdt, reasoning: args.reasoning };
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
  });

  if (validation.status !== 'PROPOSED') {
    return {
      status: validation.status,
      decisionId: validation.decisionId,
      summary: `reallocate_capital rejected: ${validation.reason ?? validation.status}`,
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
        ? `reallocate_capital $${args.amountUsdt} ${args.fromBotId.slice(0, 8)} → ${args.toBotId.slice(0, 8)}`
        : `reallocate_capital failed: ${exec.reason ?? 'unknown'}`,
      payload: exec,
    };
  } catch (err) {
    return {
      status: 'EXECUTION_FAILED',
      decisionId: validation.decisionId,
      summary: `reallocate_capital threw: ${err instanceof Error ? err.message : String(err)}`,
      payload: null,
    };
  }
}

async function readBalanceTool(_args: z.infer<typeof ReadBalanceArgs>, ctx: ToolExecContext): Promise<ToolExecResult> {
  if (!ctx.bingxClient) {
    return { status: 'EXECUTION_FAILED', decisionId: null, summary: 'bingxClient unavailable', payload: null };
  }
  const fn = ctx.getFuturesBalanceFn ?? getFuturesBalance;
  try {
    const bal = await fn(ctx.bingxClient);
    return {
      status: 'EXECUTED',
      decisionId: null,
      summary: `$${Number(bal.availableUsdt).toFixed(2)} available, $${Number(bal.equityUsdt).toFixed(2)} equity, $${Number(bal.marginUsedUsdt).toFixed(2)} margin used`,
      payload: bal,
    };
  } catch (err) {
    return { status: 'EXECUTION_FAILED', decisionId: null, summary: `read_balance failed: ${err instanceof Error ? err.message : String(err)}`, payload: null };
  }
}

async function readPositionsTool(args: z.infer<typeof ReadPositionsArgs>, ctx: ToolExecContext): Promise<ToolExecResult> {
  if (!ctx.bingxClient) {
    return { status: 'EXECUTION_FAILED', decisionId: null, summary: 'bingxClient unavailable', payload: null };
  }
  const fn = ctx.listFuturesPositionsFn ?? listFuturesPositions;
  try {
    const positions = await fn(ctx.bingxClient, args.symbol);
    return {
      status: 'EXECUTED',
      decisionId: null,
      summary: `${positions.length} position${positions.length === 1 ? '' : 's'} open`,
      payload: positions,
    };
  } catch (err) {
    return { status: 'EXECUTION_FAILED', decisionId: null, summary: `read_positions failed: ${err instanceof Error ? err.message : String(err)}`, payload: null };
  }
}

async function readOpenOrdersTool(args: z.infer<typeof ReadOpenOrdersArgs>, ctx: ToolExecContext): Promise<ToolExecResult> {
  if (!ctx.bingxClient) {
    return { status: 'EXECUTION_FAILED', decisionId: null, summary: 'bingxClient unavailable', payload: null };
  }
  const fn = ctx.listFuturesOpenOrdersFn ?? listFuturesOpenOrders;
  try {
    const orders = await fn(ctx.bingxClient, args.symbol);
    return {
      status: 'EXECUTED',
      decisionId: null,
      summary: `${orders.length} open order${orders.length === 1 ? '' : 's'}`,
      payload: orders,
    };
  } catch (err) {
    return { status: 'EXECUTION_FAILED', decisionId: null, summary: `read_open_orders failed: ${err instanceof Error ? err.message : String(err)}`, payload: null };
  }
}

async function dispatchMutatingAction(
  args: { reasoning: string },
  action: ProposedAction,
  ctx: ToolExecContext,
  successSummary: (exec: ExecutionResult) => string,
  toolName: string,
): Promise<ToolExecResult> {
  void args;
  if (ctx.config.killSwitch) return killSwitchRefusal(ctx);
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
  });

  if (validation.status !== 'PROPOSED') {
    return {
      status: validation.status,
      decisionId: validation.decisionId,
      summary: `${toolName} rejected: ${validation.reason ?? validation.status}`,
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
      bingxClient: ctx.bingxClient,
    });
    return {
      status: exec.status,
      decisionId: exec.decisionId,
      summary: exec.status === 'EXECUTED'
        ? successSummary(exec)
        : `${toolName} failed: ${exec.reason ?? 'unknown'}`,
      payload: exec,
    };
  } catch (err) {
    return {
      status: 'EXECUTION_FAILED',
      decisionId: validation.decisionId,
      summary: `${toolName} threw: ${err instanceof Error ? err.message : String(err)}`,
      payload: null,
    };
  }
}

async function placeMarketOrderTool(args: z.infer<typeof PlaceMarketOrderArgs>, ctx: ToolExecContext): Promise<ToolExecResult> {
  return dispatchMutatingAction(args, {
    type: 'place_market_order', symbol: args.symbol, side: args.side, positionSide: args.positionSide,
    capitalUsdt: args.capitalUsdt, leverage: args.leverage,
    stopLossPercent: args.stopLossPercent, takeProfitPercent: args.takeProfitPercent,
    reasoning: args.reasoning,
  }, ctx,
  (exec) => `${args.side} ${args.symbol} $${args.capitalUsdt} ×${args.leverage} → order ${(exec.resultOrderId ?? '?').slice(0, 8)}`,
  'place_market_order');
}

async function placeLimitOrderTool(args: z.infer<typeof PlaceLimitOrderArgs>, ctx: ToolExecContext): Promise<ToolExecResult> {
  return dispatchMutatingAction(args, {
    type: 'place_limit_order', symbol: args.symbol, side: args.side, positionSide: args.positionSide,
    price: args.price, capitalUsdt: args.capitalUsdt, leverage: args.leverage,
    timeInForce: args.timeInForce, reasoning: args.reasoning,
  }, ctx,
  (exec) => `${args.side} ${args.symbol} LIMIT @${args.price} $${args.capitalUsdt} → order ${(exec.resultOrderId ?? '?').slice(0, 8)}`,
  'place_limit_order');
}

async function placeStopOrderTool(args: z.infer<typeof PlaceStopOrderArgs>, ctx: ToolExecContext): Promise<ToolExecResult> {
  return dispatchMutatingAction(args, {
    type: 'place_stop_order', symbol: args.symbol, side: args.side, positionSide: args.positionSide,
    stopPrice: args.stopPrice, capitalUsdt: args.capitalUsdt, leverage: args.leverage,
    reasoning: args.reasoning,
  }, ctx,
  (exec) => `${args.side} ${args.symbol} STOP @${args.stopPrice} → order ${(exec.resultOrderId ?? '?').slice(0, 8)}`,
  'place_stop_order');
}

async function placeTakeProfitTool(args: z.infer<typeof PlaceTakeProfitArgs>, ctx: ToolExecContext): Promise<ToolExecResult> {
  return dispatchMutatingAction(args, {
    type: 'place_take_profit', symbol: args.symbol, side: args.side, positionSide: args.positionSide,
    stopPrice: args.stopPrice, capitalUsdt: args.capitalUsdt, leverage: args.leverage,
    reasoning: args.reasoning,
  }, ctx,
  (exec) => `${args.side} ${args.symbol} TP @${args.stopPrice} → order ${(exec.resultOrderId ?? '?').slice(0, 8)}`,
  'place_take_profit');
}

async function placeTrailingStopTool(args: z.infer<typeof PlaceTrailingStopArgs>, ctx: ToolExecContext): Promise<ToolExecResult> {
  return dispatchMutatingAction(args, {
    type: 'place_trailing_stop', symbol: args.symbol, side: args.side, positionSide: args.positionSide,
    capitalUsdt: args.capitalUsdt, leverage: args.leverage, callbackRate: args.callbackRate,
    reasoning: args.reasoning,
  }, ctx,
  (exec) => `${args.side} ${args.symbol} TRAILING ${args.callbackRate * 100}% → order ${(exec.resultOrderId ?? '?').slice(0, 8)}`,
  'place_trailing_stop');
}

async function closePositionTool(args: z.infer<typeof ClosePositionArgs>, ctx: ToolExecContext): Promise<ToolExecResult> {
  return dispatchMutatingAction(args, {
    type: 'close_position', symbol: args.symbol, side: args.side, percent: args.percent,
    reasoning: args.reasoning,
  }, ctx,
  () => args.percent && args.side
    ? `close_position ${args.percent}% of ${args.side} ${args.symbol}`
    : `close_position all ${args.symbol}`,
  'close_position');
}

async function cancelOrderTool(args: z.infer<typeof CancelOrderArgs>, ctx: ToolExecContext): Promise<ToolExecResult> {
  return dispatchMutatingAction(args, {
    type: 'cancel_order', symbol: args.symbol, orderId: args.orderId, reasoning: args.reasoning,
  }, ctx,
  () => `cancel_order ${args.orderId.slice(0, 8)} on ${args.symbol}`,
  'cancel_order');
}

async function cancelAllOrdersTool(args: z.infer<typeof CancelAllOrdersArgs>, ctx: ToolExecContext): Promise<ToolExecResult> {
  return dispatchMutatingAction(args, {
    type: 'cancel_all_orders', symbol: args.symbol, reasoning: args.reasoning,
  }, ctx,
  () => `cancel_all_orders${args.symbol ? ' on ' + args.symbol : ''}`,
  'cancel_all_orders');
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
