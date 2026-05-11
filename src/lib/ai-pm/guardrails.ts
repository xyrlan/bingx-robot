import type { ProposedAction } from '@/lib/ai-pm/decision.prompt';
import type { PortfolioState } from '@/lib/ai-pm/portfolio-state';

export interface GuardrailConfig {
  maxCapitalUsdt: number;
  maxConcurrentBots: number;
  allowedStrategies: Array<'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER'>;
  killSwitch: boolean;
}

export type GuardrailReason =
  | 'KILL_SWITCH'
  | 'CAPITAL_CAP'
  | 'CONCURRENT_CAP'
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
      return { ok: true };
    }

    case 'stop_bot':
      if (!runningBotIds.has(action.botId)) {
        return { ok: false, reason: 'UNKNOWN_BOT_ID', message: `Bot ${action.botId} not running` };
      }
      return { ok: true };

    case 'adjust_params':
      if (!runningBotIds.has(action.botId)) {
        return { ok: false, reason: 'UNKNOWN_BOT_ID', message: `Bot ${action.botId} not running` };
      }
      return { ok: true };

    case 'reallocate_capital':
      if (!runningBotIds.has(action.fromBotId) || !runningBotIds.has(action.toBotId)) {
        return { ok: false, reason: 'UNKNOWN_BOT_ID', message: `Bot id(s) not running` };
      }
      return { ok: true };
  }
}
