import { z } from 'zod';
import type { SignalCandidate } from '@/lib/ai-pm/signal';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';

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
    '- Active bots after actions must not exceed config.maxConcurrentBots.',
    '- Each action requires a one-sentence reasoning (plain English, no markdown).',
    '',
    'If no candidate is compelling, return a single no_action with reasoning.',
  ].join('\n');
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

  return [
    `Mode: ${input.config.mode}`,
    `Max capital USDT: ${input.config.maxCapitalUsdt}`,
    `Max concurrent bots: ${input.config.maxConcurrentBots}`,
    `Allowed strategies: ${input.config.allowedStrategies.join(', ')}`,
    `Capital used USDT: ${input.portfolioState.capitalUsedUsdt}`,
    '',
    'Signal candidates:',
    candLines || '(none)',
    '',
    'Running AI bots:',
    botLines || '(none)',
    '',
    'Decide actions via `propose_actions` tool.',
  ].join('\n');
}
