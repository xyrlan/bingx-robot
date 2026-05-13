import type { ProposedAction } from '@/lib/ai-pm/decision.prompt';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';

export interface GuardrailConfig {
  maxCapitalUsdt: number;
  maxConcurrentBots: number;
  maxLeverage: number;
  allowedStrategies: Array<'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER'>;
  allowedSymbols?: string[];
  killSwitch: boolean;
}

export type GuardrailReason =
  | 'KILL_SWITCH'
  | 'CAPITAL_CAP'
  | 'CONCURRENT_CAP'
  | 'LEVERAGE_CAP'
  | 'STRATEGY_NOT_ALLOWED'
  | 'UNKNOWN_BOT_ID';

export type GuardrailResult =
  | { ok: true }
  | { ok: false; reason: GuardrailReason; message: string };

export function runGuardrails(input: {
  action: ProposedAction;
  config: GuardrailConfig;
  portfolioState: PortfolioState;
}): GuardrailResult {
  const { action, config, portfolioState } = input;

  if (config.killSwitch) {
    return { ok: false, reason: 'KILL_SWITCH', message: 'Kill switch is engaged' };
  }

  const runningBotIds = new Set(portfolioState.runningBots.map((b) => b.id));

  switch (action.type) {
    case 'no_action':
      return { ok: true };

    case 'create_bot': {
      if (!config.allowedStrategies.includes(action.strategy)) {
        return {
          ok: false,
          reason: 'STRATEGY_NOT_ALLOWED',
          message: `Strategy ${action.strategy} not in allowedStrategies`,
        };
      }
      if (portfolioState.runningBots.length >= config.maxConcurrentBots) {
        return {
          ok: false,
          reason: 'CONCURRENT_CAP',
          message: `Active bots (${portfolioState.runningBots.length}) at cap (${config.maxConcurrentBots})`,
        };
      }
      if (portfolioState.capitalUsedUsdt + action.capitalUsdt > config.maxCapitalUsdt) {
        return {
          ok: false,
          reason: 'CAPITAL_CAP',
          message: `Capital used + new ${action.capitalUsdt} exceeds cap ${config.maxCapitalUsdt}`,
        };
      }
      if (action.leverage > config.maxLeverage) {
        return {
          ok: false,
          reason: 'LEVERAGE_CAP',
          message: `Leverage ${action.leverage} exceeds cap ${config.maxLeverage}`,
        };
      }
      return { ok: true };
    }

    case 'stop_bot':
      if (!runningBotIds.has(action.botId)) {
        return { ok: false, reason: 'UNKNOWN_BOT_ID', message: `Bot ${action.botId} not running` };
      }
      return { ok: true };

    case 'adjust_params': {
      if (!runningBotIds.has(action.botId)) {
        return { ok: false, reason: 'UNKNOWN_BOT_ID', message: `Bot ${action.botId} not running` };
      }
      const p = action.params as {
        capitalUsdt?: number;
        leverage?: number;
        strategy?: string;
      };
      if (typeof p.leverage === 'number' && p.leverage > config.maxLeverage) {
        return {
          ok: false,
          reason: 'LEVERAGE_CAP',
          message: `Leverage ${p.leverage} exceeds cap ${config.maxLeverage}`,
        };
      }
      if (
        typeof p.strategy === 'string' &&
        !config.allowedStrategies.includes(p.strategy as GuardrailConfig['allowedStrategies'][number])
      ) {
        return {
          ok: false,
          reason: 'STRATEGY_NOT_ALLOWED',
          message: `Strategy ${p.strategy} not in allowedStrategies`,
        };
      }
      if (typeof p.capitalUsdt === 'number') {
        const current = portfolioState.runningBots.find((b) => b.id === action.botId)?.capitalUsdt ?? 0;
        const delta = p.capitalUsdt - current;
        if (portfolioState.capitalUsedUsdt + delta > config.maxCapitalUsdt) {
          return {
            ok: false,
            reason: 'CAPITAL_CAP',
            message: `New capital pushes total over cap ${config.maxCapitalUsdt}`,
          };
        }
      }
      return { ok: true };
    }

    case 'reallocate_capital':
      if (action.fromBotId === action.toBotId) {
        return { ok: false, reason: 'UNKNOWN_BOT_ID', message: `fromBotId and toBotId must differ` };
      }
      if (!runningBotIds.has(action.fromBotId) || !runningBotIds.has(action.toBotId)) {
        return { ok: false, reason: 'UNKNOWN_BOT_ID', message: `Bot id(s) not running` };
      }
      return { ok: true };

    case 'place_market_order':
    case 'place_limit_order':
    case 'place_stop_order':
    case 'place_take_profit':
    case 'place_trailing_stop': {
      if (action.leverage > config.maxLeverage) {
        return { ok: false, reason: 'LEVERAGE_CAP', message: `Leverage ${action.leverage} exceeds cap ${config.maxLeverage}` };
      }
      if (portfolioState.capitalUsedUsdt + action.capitalUsdt > config.maxCapitalUsdt) {
        return { ok: false, reason: 'CAPITAL_CAP', message: `Capital used + new ${action.capitalUsdt} exceeds cap ${config.maxCapitalUsdt}` };
      }
      if (config.allowedSymbols && config.allowedSymbols.length > 0 && !config.allowedSymbols.includes(action.symbol)) {
        return { ok: false, reason: 'STRATEGY_NOT_ALLOWED', message: `Symbol ${action.symbol} not in allowedSymbols` };
      }
      return { ok: true };
    }

    case 'close_position':
    case 'cancel_order':
    case 'cancel_all_orders':
      return { ok: true };
  }
}
