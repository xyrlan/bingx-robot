import { z } from 'zod';
import type { SignalCandidate } from '@/lib/ai-pm/signal';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';
import { MARGIN_HEADROOM_PCT } from '@/lib/ai-pm/guardrails';

export const ALLOWED_STRATEGIES = ['DCA', 'TRAILING_STOP', 'DCA_SPOT', 'SMA_CROSSOVER'] as const;
export const AllowedStrategySchema = z.enum(ALLOWED_STRATEGIES);

const ReasoningSchema = z.string().min(1).max(500);

export const CreateBotActionSchema = z.object({
  type: z.literal('create_bot'),
  symbol: z.string().min(1),
  strategy: AllowedStrategySchema,
  capitalUsdt: z.number().positive(),
  leverage: z.number().int().min(1).max(20),
  reasoning: ReasoningSchema,
});

export const StopBotActionSchema = z.object({
  type: z.literal('stop_bot'),
  botId: z.string().uuid(),
  reasoning: ReasoningSchema,
});

export const AdjustParamsActionSchema = z.object({
  type: z.literal('adjust_params'),
  botId: z.string().uuid(),
  params: z.record(z.string(), z.unknown()),
  reasoning: ReasoningSchema,
});

export const ReallocateCapitalActionSchema = z.object({
  type: z.literal('reallocate_capital'),
  fromBotId: z.string().uuid(),
  toBotId: z.string().uuid(),
  amountUsdt: z.number().positive(),
  reasoning: ReasoningSchema,
});

export const NoActionSchema = z.object({
  type: z.literal('no_action'),
  reasoning: ReasoningSchema,
});

const SideSchema = z.enum(['BUY', 'SELL']);
const PositionSideSchema = z.enum(['LONG', 'SHORT']);

export const PlaceMarketOrderActionSchema = z.object({
  type: z.literal('place_market_order'),
  symbol: z.string().min(1),
  side: SideSchema,
  positionSide: PositionSideSchema,
  capitalUsdt: z.number().positive(),
  leverage: z.number().int().min(1).max(20),
  stopLossPercent: z.number().positive().lt(100).optional(),
  takeProfitPercent: z.number().positive().lt(500).optional(),
  reasoning: ReasoningSchema,
});

export const PlaceLimitOrderActionSchema = z.object({
  type: z.literal('place_limit_order'),
  symbol: z.string().min(1),
  side: SideSchema,
  positionSide: PositionSideSchema,
  price: z.number().positive(),
  capitalUsdt: z.number().positive(),
  leverage: z.number().int().min(1).max(20),
  timeInForce: z.enum(['GTC', 'IOC', 'FOK', 'PostOnly']).optional(),
  reasoning: ReasoningSchema,
});

export const PlaceStopOrderActionSchema = z.object({
  type: z.literal('place_stop_order'),
  symbol: z.string().min(1),
  side: SideSchema,
  positionSide: PositionSideSchema,
  stopPrice: z.number().positive(),
  capitalUsdt: z.number().positive(),
  leverage: z.number().int().min(1).max(20),
  reasoning: ReasoningSchema,
});

export const PlaceTakeProfitActionSchema = z.object({
  type: z.literal('place_take_profit'),
  symbol: z.string().min(1),
  side: SideSchema,
  positionSide: PositionSideSchema,
  stopPrice: z.number().positive(),
  capitalUsdt: z.number().positive(),
  leverage: z.number().int().min(1).max(20),
  reasoning: ReasoningSchema,
});

export const PlaceTrailingStopActionSchema = z.object({
  type: z.literal('place_trailing_stop'),
  symbol: z.string().min(1),
  side: SideSchema,
  positionSide: PositionSideSchema,
  capitalUsdt: z.number().positive(),
  leverage: z.number().int().min(1).max(20),
  callbackRate: z.number().positive().max(1),
  reasoning: ReasoningSchema,
});

export const ClosePositionActionSchema = z.object({
  type: z.literal('close_position'),
  symbol: z.string().min(1),
  side: PositionSideSchema.optional(),
  percent: z.number().int().min(1).max(100).optional(),
  reasoning: ReasoningSchema,
});

export const CancelOrderActionSchema = z.object({
  type: z.literal('cancel_order'),
  symbol: z.string().min(1),
  orderId: z.string().min(1),
  reasoning: ReasoningSchema,
});

export const CancelAllOrdersActionSchema = z.object({
  type: z.literal('cancel_all_orders'),
  symbol: z.string().min(1).optional(),
  reasoning: ReasoningSchema,
});

export const ActionSchema = z.discriminatedUnion('type', [
  CreateBotActionSchema,
  StopBotActionSchema,
  AdjustParamsActionSchema,
  ReallocateCapitalActionSchema,
  NoActionSchema,
  PlaceMarketOrderActionSchema,
  PlaceLimitOrderActionSchema,
  PlaceStopOrderActionSchema,
  PlaceTakeProfitActionSchema,
  PlaceTrailingStopActionSchema,
  ClosePositionActionSchema,
  CancelOrderActionSchema,
  CancelAllOrdersActionSchema,
]);

/**
 * Autonomous action surface — direct exchange orders only. Excludes the bot-management
 * actions (create_bot/stop_bot/adjust_params/reallocate_capital) so the autonomous tick
 * cannot create per-strategy bots whose configs it cannot fully populate.
 */
export const AutonomousActionSchema = z.discriminatedUnion('type', [
  NoActionSchema,
  PlaceMarketOrderActionSchema,
  PlaceLimitOrderActionSchema,
  PlaceStopOrderActionSchema,
  PlaceTakeProfitActionSchema,
  PlaceTrailingStopActionSchema,
  ClosePositionActionSchema,
  CancelOrderActionSchema,
  CancelAllOrdersActionSchema,
]);

export type AutonomousAction = z.infer<typeof AutonomousActionSchema>;

export const ProposeActionsSchema = z.object({
  actions: z.array(z.unknown()),
});

export type ProposedAction = z.infer<typeof ActionSchema>;

export interface DecisionConfig {
  mode: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';
  maxCapitalUsdt: number;
  maxConcurrentBots: number;
  allowedStrategies: Array<(typeof ALLOWED_STRATEGIES)[number]>;
}

export function buildSystemPrompt(): string {
  return [
    'You are a portfolio manager for a crypto futures trading account.',
    'Given Signal candidates + current portfolio state + risk config, decide actions.',
    '',
    'Use the `propose_actions` tool. Return an `actions` array of typed objects.',
    'Each action has a `type` field discriminating the shape:',
    '',
    '- create_bot: open a new bot. Fields: symbol, strategy, capitalUsdt, leverage, reasoning.',
    '- stop_bot: stop a running bot. Fields: botId (uuid), reasoning.',
    '- adjust_params: change a running bot config. Fields: botId, params (object), reasoning.',
    '- reallocate_capital: move capital between bots. Fields: fromBotId, toBotId, amountUsdt, reasoning.',
    '- no_action: skip this tick. Fields: reasoning.',
    '',
    'Constraints:',
    '- Only use strategies from config.allowedStrategies.',
    '- Total capital across running bots + new create_bot capital must not exceed config.maxCapitalUsdt.',
    '- New or increased capital must also fit within the account\'s real available margin — never propose more than "Effective spendable USDT" shown below.',
    '- Active bots after actions must not exceed config.maxConcurrentBots.',
    '- Each action requires a one-sentence reasoning (plain English, no markdown).',
    '',
    'If no candidate is compelling, return a single no_action with reasoning.',
  ].join('\n');
}

export function buildAutonomousSystemPrompt(): string {
  return [
    'You are a discretionary portfolio manager for a crypto futures trading account.',
    'You operate by issuing direct trade orders against the live exchange — there are no bots.',
    'Given Signal candidates, current open positions, current open orders, available margin and risk config, decide actions.',
    '',
    'Use the `propose_actions` tool. Return an `actions` array of typed objects.',
    'Each action has a `type` field discriminating the shape:',
    '',
    '- place_market_order: open or add to a position at market. Fields: symbol, side (BUY/SELL), positionSide (LONG/SHORT), capitalUsdt, leverage, optional stopLossPercent, optional takeProfitPercent, reasoning.',
    '- place_limit_order: rest a limit at price. Fields: symbol, side, positionSide, price, capitalUsdt, leverage, optional timeInForce, reasoning.',
    '- place_stop_order: trigger market when stopPrice hit. Fields: symbol, side, positionSide, stopPrice, capitalUsdt, leverage, reasoning.',
    '- place_take_profit: trigger market when stopPrice hit (in profit direction). Fields: symbol, side, positionSide, stopPrice, capitalUsdt, leverage, reasoning.',
    '- place_trailing_stop: trail a stop by callbackRate. Fields: symbol, side, positionSide, capitalUsdt, leverage, callbackRate (0–1), reasoning.',
    '- close_position: close all or part of an existing position. Fields: symbol, optional side (LONG/SHORT), optional percent (1–100), reasoning.',
    '- cancel_order: cancel a specific resting order. Fields: symbol, orderId, reasoning.',
    '- cancel_all_orders: cancel all resting orders, optionally for a single symbol. Fields: optional symbol, reasoning.',
    '- no_action: skip this tick. Fields: reasoning.',
    '',
    'Constraints:',
    '- Always reconcile your proposals with the reported open positions and open orders before acting — do not duplicate an existing position or stack redundant stop/TP orders.',
    '- New or increased capital must fit within the account\'s real available margin — never propose more than "Effective spendable USDT" shown below.',
    '- Total deployed capital must not exceed config.maxCapitalUsdt.',
    '- Leverage must not exceed config.maxLeverage shown in the user prompt.',
    '- Each action requires a one-sentence reasoning (plain English, no markdown).',
    '',
    'If no candidate is compelling and existing positions need no adjustment, return a single no_action with reasoning.',
  ].join('\n');
}

export function buildAutonomousUserPrompt(input: {
  candidates: SignalCandidate[];
  portfolioState: PortfolioState;
  config: DecisionConfig;
}): string {
  const candLines = input.candidates
    .map((c) => `- ${c.symbol} regime=${c.regime} score=${c.score} reason=${c.reason}`)
    .join('\n');

  const posLines = (input.portfolioState.openPositions ?? [])
    .map(
      (p) =>
        `- ${p.symbol} ${p.positionSide} entry=${p.entryPrice} qty=${p.positionAmt} pnl=${p.unrealizedPnl ?? 0} lev=${p.leverage ?? 'n/a'}${p.positionId ? ` id=${p.positionId}` : ''}`,
    )
    .join('\n');

  const orderLines = (input.portfolioState.openOrders ?? [])
    .map(
      (o) =>
        `- id=${o.orderId} ${o.symbol ?? '?'} type=${o.type ?? '?'} side=${o.side ?? '?'} positionSide=${o.positionSide ?? '?'} price=${o.price ?? '?'} stopPrice=${o.stopPrice ?? '?'} qty=${o.quantity ?? '?'}`,
    )
    .join('\n');

  const avail = input.portfolioState.availableBalanceUsdt;
  const lines = [
    `Mode: ${input.config.mode}`,
    `Max capital USDT: ${input.config.maxCapitalUsdt}`,
    `Allowed strategies (advisory): ${input.config.allowedStrategies.join(', ')}`,
    `Capital used USDT: ${input.portfolioState.capitalUsedUsdt}`,
    `Real available margin USDT: ${avail ?? 'unknown'}`,
  ];

  if (typeof avail === 'number') {
    const effectiveSpendable = Math.min(
      input.config.maxCapitalUsdt - input.portfolioState.capitalUsedUsdt,
      avail * MARGIN_HEADROOM_PCT,
    );
    lines.push(`Effective spendable USDT: ${effectiveSpendable}`);
  }

  lines.push(
    '',
    'Signal candidates:',
    candLines || '(none)',
    '',
    'Open positions:',
    posLines || '(none)',
    '',
    'Open orders:',
    orderLines || '(none)',
    '',
    'Decide actions via `propose_actions` tool.',
  );

  return lines.join('\n');
}

export function buildUserPrompt(input: {
  candidates: SignalCandidate[];
  portfolioState: PortfolioState;
  config: DecisionConfig;
}): string {
  const candLines = input.candidates
    .map((c) => `- ${c.symbol} regime=${c.regime} score=${c.score} reason=${c.reason}`)
    .join('\n');
  const botLines = input.portfolioState.runningBots
    .map(
      (b) =>
        `- id=${b.id} symbol=${b.symbol} strategy=${b.strategy} capital=${b.capitalUsdt} leverage=${b.leverage}`,
    )
    .join('\n');

  const avail = input.portfolioState.availableBalanceUsdt;
  const lines = [
    `Mode: ${input.config.mode}`,
    `Max capital USDT: ${input.config.maxCapitalUsdt}`,
    `Max concurrent bots: ${input.config.maxConcurrentBots}`,
    `Allowed strategies: ${input.config.allowedStrategies.join(', ')}`,
    `Capital used USDT: ${input.portfolioState.capitalUsedUsdt}`,
    `Real available margin USDT: ${avail ?? 'unknown'}`,
  ];

  if (typeof avail === 'number') {
    const effectiveSpendable = Math.min(
      input.config.maxCapitalUsdt - input.portfolioState.capitalUsedUsdt,
      avail * MARGIN_HEADROOM_PCT,
    );
    lines.push(`Effective spendable USDT: ${effectiveSpendable}`);
  }

  lines.push(
    '',
    'Signal candidates:',
    candLines || '(none)',
    '',
    'Running AI bots:',
    botLines || '(none)',
    '',
    'Decide actions via `propose_actions` tool.',
  );

  return lines.join('\n');
}
