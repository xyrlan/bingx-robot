import { and, eq } from 'drizzle-orm';
import { tradingBots, paperBots } from '@/db/schema';
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
  newBotId?: string;
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
  setLeverageFn?: (client: unknown, symbol: string, leverage: number) => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bingxClient?: any;
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

    case 'adjust_params': {
      if (config.paperMode) {
        const row = await params.db.query.paperBots.findFirst({
          where: and(eq(paperBots.id, action.botId), eq(paperBots.userId, userId)),
        });
        if (!row) {
          return { status: 'EXECUTION_FAILED', decisionId, reason: `Paper bot ${action.botId} not found` };
        }
        const p = action.params as { capitalUsdt?: number; leverage?: number; strategy?: 'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER'; config?: Record<string, unknown> };
        const updateValues: Record<string, unknown> = {};
        if (typeof p.capitalUsdt === 'number') updateValues.capitalUsdt = String(p.capitalUsdt);
        if (p.strategy) updateValues.strategy = p.strategy;
        if (p.leverage !== undefined || p.config !== undefined) {
          const merged = { ...((row.params as Record<string, unknown> | null) ?? {}) };
          if (p.leverage !== undefined) merged.leverage = p.leverage;
          if (p.config !== undefined) Object.assign(merged, p.config);
          updateValues.params = merged;
        }
        await params.db.update(paperBots).set(updateValues).where(and(eq(paperBots.id, action.botId), eq(paperBots.userId, userId))).returning();
        return { status: 'EXECUTED', decisionId, paperBotId: row.id };
      }

      const row = await params.db.query.tradingBots.findFirst({
        where: and(eq(tradingBots.id, action.botId), eq(tradingBots.userId, userId)),
      });
      if (!row) {
        return { status: 'EXECUTION_FAILED', decisionId, reason: `Bot ${action.botId} not found` };
      }
      if (row.apiKeyId !== config.bingxApiKeyId) {
        return { status: 'EXECUTION_FAILED', decisionId, reason: `Bot apiKeyId mismatch — not in AI subaccount scope` };
      }

      const p = action.params as { capitalUsdt?: number; leverage?: number; strategy?: 'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER'; config?: Record<string, unknown> };

      // Strategy change → stop + recreate
      if (p.strategy && p.strategy !== row.botType) {
        await params.db
          .update(tradingBots)
          .set({ status: 'STOPPED' })
          .where(and(eq(tradingBots.id, action.botId), eq(tradingBots.userId, userId)))
          .returning();

        try {
          const newBot = await createBot(userId, {
            symbol: row.symbol,
            botType: p.strategy,
            positionSizeUsdt: typeof p.capitalUsdt === 'number' ? String(p.capitalUsdt) : row.positionSizeUsdt,
            takeProfitPercentage: row.takeProfitPercentage,
            gridCount: row.gridCount,
            leverage: typeof p.leverage === 'number' ? p.leverage : row.leverage,
            apiKeyId: config.bingxApiKeyId,
            priceMin: row.priceMin,
            priceMax: row.priceMax,
            config: (p.config ?? {}) as Record<string, unknown>,
          });
          return { status: 'EXECUTED', decisionId, realBotId: row.id, newBotId: newBot.id };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { status: 'EXECUTION_FAILED', decisionId, reason: `recreate_failed: ${msg}` };
        }
      }

      // Direct-field update
      const updateValues: Record<string, unknown> = {};
      if (typeof p.capitalUsdt === 'number') updateValues.positionSizeUsdt = String(p.capitalUsdt);
      if (typeof p.leverage === 'number') updateValues.leverage = p.leverage;
      if (p.config !== undefined) updateValues.config = { ...(row.config ?? {}), ...p.config };

      if (Object.keys(updateValues).length === 0) {
        return { status: 'EXECUTED', decisionId, realBotId: row.id };
      }

      await params.db
        .update(tradingBots)
        .set(updateValues)
        .where(and(eq(tradingBots.id, action.botId), eq(tradingBots.userId, userId)))
        .returning();

      if (typeof p.leverage === 'number' && params.bingxClient && params.setLeverageFn) {
        try {
          await params.setLeverageFn(params.bingxClient, row.symbol, p.leverage);
        } catch {
          // warn-not-throw; leverage stays at exchange-side last-accepted
        }
      }

      return { status: 'EXECUTED', decisionId, realBotId: row.id };
    }

    case 'reallocate_capital':
      return { status: 'EXECUTION_FAILED', decisionId, reason: 'NOT_IMPLEMENTED: reallocate_capital' };
  }
}
