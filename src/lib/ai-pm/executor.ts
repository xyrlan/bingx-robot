import { and, eq } from 'drizzle-orm';
import { tradingBots } from '@/db/schema';
import type { db as Db } from '@/db';
import { createBot as defaultCreateBot } from '@/services/bingx.service';
import { createPaperBot as defaultCreatePaperBot } from '@/services/paper-bots.service';
import type { ProposedAction } from '@/lib/ai-pm/decision.prompt';

export type ExecutionStatus = 'EXECUTED' | 'EXECUTION_FAILED';

export interface ExecutionResult {
  status: ExecutionStatus;
  decisionId: string;
  realBotId?: string;
  paperBotId?: string;
  reason?: string;
}

export interface ExecutorConfig {
  bingxApiKeyId: string;
  paperMode: boolean;
}

export interface ExecuteParams {
  userId: string;
  decisionId: string;
  action: ProposedAction;
  config: ExecutorConfig;
  db: typeof Db;
  createBotFn?: typeof defaultCreateBot;
  createPaperBotFn?: typeof defaultCreatePaperBot;
}

export async function execute(params: ExecuteParams): Promise<ExecutionResult> {
  const { action, userId, decisionId, config } = params;
  const createBot = params.createBotFn ?? defaultCreateBot;
  const createPaper = params.createPaperBotFn ?? defaultCreatePaperBot;

  switch (action.type) {
    case 'no_action':
      return { status: 'EXECUTED', decisionId };

    case 'create_bot': {
      if (config.paperMode) {
        const row = await createPaper(params.db, {
          userId,
          decisionId,
          symbol: action.symbol,
          strategy: action.strategy,
          capitalUsdt: action.capitalUsdt,
          params: { reasoning: action.reasoning, leverage: action.leverage },
        });
        return { status: 'EXECUTED', decisionId, paperBotId: row.id };
      }
      const bot = await createBot(userId, {
        symbol: action.symbol,
        botType: action.strategy,
        positionSizeUsdt: String(action.capitalUsdt),
        leverage: action.leverage,
        apiKeyId: config.bingxApiKeyId,
        priceMin: '0',
        priceMax: '0',
        takeProfitPercentage: '1',
        gridCount: 1,
        config: { reasoning: action.reasoning },
      });
      return { status: 'EXECUTED', decisionId, realBotId: bot.id };
    }

    case 'stop_bot': {
      const row = await params.db.query.tradingBots.findFirst({
        where: and(eq(tradingBots.id, action.botId), eq(tradingBots.userId, userId)),
      });
      if (!row) {
        return { status: 'EXECUTION_FAILED', decisionId, reason: `Bot ${action.botId} not found` };
      }
      if (row.apiKeyId !== config.bingxApiKeyId) {
        return {
          status: 'EXECUTION_FAILED',
          decisionId,
          reason: `Bot apiKeyId mismatch — not in AI subaccount scope`,
        };
      }
      await params.db
        .update(tradingBots)
        .set({ status: 'STOPPED' })
        .where(and(eq(tradingBots.id, action.botId), eq(tradingBots.userId, userId)))
        .returning();
      return { status: 'EXECUTED', decisionId, realBotId: row.id };
    }

    case 'adjust_params':
      return { status: 'EXECUTION_FAILED', decisionId, reason: 'NOT_IMPLEMENTED: adjust_params' };

    case 'reallocate_capital':
      return { status: 'EXECUTION_FAILED', decisionId, reason: 'NOT_IMPLEMENTED: reallocate_capital' };
  }
}
