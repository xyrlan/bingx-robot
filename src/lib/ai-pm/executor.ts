import { and, eq } from 'drizzle-orm';
import { tradingBots, paperBots, aiDecisions } from '@/db/schema';
import type { db as Db } from '@/db';
import { createBot as defaultCreateBot } from '@/services/bingx.service';
import { createPaperBot as defaultCreatePaperBot } from '@/services/paper-bots.service';
import {
  placeFuturesOrder as defaultPlaceFuturesOrder,
  cancelFuturesOrder as defaultCancelFuturesOrder,
  cancelAllFuturesOrders as defaultCancelAllFuturesOrders,
  closeAllPositions as defaultCloseAllPositions,
  listFuturesPositions as defaultListFuturesPositions,
  type PlaceOrderParams,
} from '@/services/bingx-orders.service';
import type { ProposedAction } from '@/lib/ai-pm/decision.prompt';

export type ExecutionStatus = 'EXECUTED' | 'EXECUTION_FAILED';

export interface ExecutionResult {
  status: ExecutionStatus;
  decisionId: string;
  realBotId?: string;
  paperBotId?: string;
  newBotId?: string;
  resultOrderId?: string;
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
  placeOrderFn?: typeof defaultPlaceFuturesOrder;
  cancelOrderFn?: typeof defaultCancelFuturesOrder;
  cancelAllOrdersFn?: typeof defaultCancelAllFuturesOrders;
  closeAllPositionsFn?: typeof defaultCloseAllPositions;
  listPositionsFn?: typeof defaultListFuturesPositions;
  getLastPriceFn?: (client: unknown, symbol: string) => Promise<string>;
  getContractInfoFn?: (symbol: string) => Promise<{ quantityPrecision: number; minNotional: string }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bingxClient?: any;
}

function computeQuantity(
  capitalUsdt: number,
  leverage: number,
  lastPrice: string,
  precision: number,
): string {
  const rawQty = (capitalUsdt * leverage) / Number(lastPrice);
  const factor = Math.pow(10, precision);
  return (Math.ceil(rawQty * factor) / factor).toFixed(precision);
}

async function defaultGetLastPriceFn(client: unknown, symbol: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = client as any;
  const res = await c.get('/openApi/swap/v2/quote/price', { symbol });
  return String(res?.price ?? '0');
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function defaultGetContractInfoFn(_symbol: string): Promise<{ quantityPrecision: number; minNotional: string }> {
  // Conservative default. Most BTC/ETH perpetuals on BingX use 4 decimals for quantity.
  return { quantityPrecision: 4, minNotional: '1' };
}

function syntheticOrderId(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g: any = globalThis;
  if (g.crypto?.randomUUID) {
    return `paper-${(g.crypto.randomUUID() as string).slice(0, 8)}`;
  }
  return `paper-${Math.random().toString(36).slice(2, 10)}`;
}

async function placeOrderHelper(
  params: ExecuteParams,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  action: any,
  bingxOrderType: PlaceOrderParams['type'],
  extra: Partial<PlaceOrderParams>,
): Promise<ExecutionResult> {
  const placeFn = params.placeOrderFn ?? defaultPlaceFuturesOrder;
  const getLastPriceFn = params.getLastPriceFn ?? defaultGetLastPriceFn;
  const getContractInfoFn = params.getContractInfoFn ?? defaultGetContractInfoFn;

  if (params.config.paperMode) {
    try {
      let lastPrice = '0';
      let precision = 4;
      if (params.bingxClient) {
        const [price, contract] = await Promise.all([
          getLastPriceFn(params.bingxClient, action.symbol),
          getContractInfoFn(action.symbol),
        ]);
        lastPrice = price;
        precision = contract.quantityPrecision;
      }
      const quantity = Number(lastPrice) > 0
        ? computeQuantity(action.capitalUsdt, action.leverage, lastPrice, precision)
        : '0';
      const resultOrderId = syntheticOrderId();
      await setResultOrderId(params.db, params.decisionId, resultOrderId);
      return {
        status: 'EXECUTED',
        decisionId: params.decisionId,
        resultOrderId,
        reason: `paper ${bingxOrderType} ${action.symbol} qty=${quantity} @${lastPrice}`,
      };
    } catch (err) {
      return {
        status: 'EXECUTION_FAILED',
        decisionId: params.decisionId,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (!params.bingxClient) {
    return { status: 'EXECUTION_FAILED', decisionId: params.decisionId, reason: 'missing_bingx_client' };
  }

  try {
    const [lastPrice, contract] = await Promise.all([
      getLastPriceFn(params.bingxClient, action.symbol),
      getContractInfoFn(action.symbol),
    ]);
    const quantity = computeQuantity(action.capitalUsdt, action.leverage, lastPrice, contract.quantityPrecision);

    const orderParams: PlaceOrderParams = {
      symbol: action.symbol,
      side: action.side,
      positionSide: action.positionSide,
      type: bingxOrderType,
      quantity,
      ...extra,
    };

    if (action.stopLossPercent !== undefined) {
      const entry = Number(lastPrice);
      const slPrice = action.side === 'BUY'
        ? entry * (1 - action.stopLossPercent / 100)
        : entry * (1 + action.stopLossPercent / 100);
      orderParams.stopLoss = { type: 'STOP_MARKET', stopPrice: String(Math.round(slPrice)) };
    }
    if (action.takeProfitPercent !== undefined) {
      const entry = Number(lastPrice);
      const tpPrice = action.side === 'BUY'
        ? entry * (1 + action.takeProfitPercent / 100)
        : entry * (1 - action.takeProfitPercent / 100);
      orderParams.takeProfit = { type: 'TAKE_PROFIT_MARKET', stopPrice: String(Math.round(tpPrice)) };
    }

    const res = await placeFn(params.bingxClient, orderParams);
    await setResultOrderId(params.db, params.decisionId, res.orderId);
    return { status: 'EXECUTED', decisionId: params.decisionId, resultOrderId: res.orderId };
  } catch (err) {
    return {
      status: 'EXECUTION_FAILED',
      decisionId: params.decisionId,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
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

    case 'reallocate_capital': {
      if (action.fromBotId === action.toBotId) {
        return { status: 'EXECUTION_FAILED', decisionId, reason: 'same bot for from and to' };
      }

      if (config.paperMode) {
        const fromRow = await params.db.query.paperBots.findFirst({
          where: and(eq(paperBots.id, action.fromBotId), eq(paperBots.userId, userId)),
        });
        const toRow = await params.db.query.paperBots.findFirst({
          where: and(eq(paperBots.id, action.toBotId), eq(paperBots.userId, userId)),
        });
        if (!fromRow || !toRow) {
          return { status: 'EXECUTION_FAILED', decisionId, reason: 'one or both paper bots not found' };
        }
        const fromCap = Number(fromRow.capitalUsdt);
        if (fromCap < action.amountUsdt) {
          return { status: 'EXECUTION_FAILED', decisionId, reason: `insufficient_capital: ${fromCap} < ${action.amountUsdt}` };
        }
        const toCap = Number(toRow.capitalUsdt);
        await params.db.transaction(async (tx) => {
          await tx.update(paperBots).set({ capitalUsdt: String(fromCap - action.amountUsdt) }).where(and(eq(paperBots.id, action.fromBotId), eq(paperBots.userId, userId))).returning();
          await tx.update(paperBots).set({ capitalUsdt: String(toCap + action.amountUsdt) }).where(and(eq(paperBots.id, action.toBotId), eq(paperBots.userId, userId))).returning();
        });
        return { status: 'EXECUTED', decisionId, paperBotId: fromRow.id };
      }

      const fromRow = await params.db.query.tradingBots.findFirst({
        where: and(eq(tradingBots.id, action.fromBotId), eq(tradingBots.userId, userId)),
      });
      const toRow = await params.db.query.tradingBots.findFirst({
        where: and(eq(tradingBots.id, action.toBotId), eq(tradingBots.userId, userId)),
      });
      if (!fromRow || !toRow) {
        return { status: 'EXECUTION_FAILED', decisionId, reason: 'one or both bots not found' };
      }
      if (fromRow.apiKeyId !== config.bingxApiKeyId || toRow.apiKeyId !== config.bingxApiKeyId) {
        return { status: 'EXECUTION_FAILED', decisionId, reason: `Bot apiKeyId mismatch — not in AI subaccount scope` };
      }
      const fromCap = Number(fromRow.positionSizeUsdt);
      if (fromCap < action.amountUsdt) {
        return { status: 'EXECUTION_FAILED', decisionId, reason: `insufficient_capital: ${fromCap} < ${action.amountUsdt}` };
      }
      const toCap = Number(toRow.positionSizeUsdt);
      await params.db.transaction(async (tx) => {
        await tx.update(tradingBots).set({ positionSizeUsdt: String(fromCap - action.amountUsdt) }).where(and(eq(tradingBots.id, action.fromBotId), eq(tradingBots.userId, userId))).returning();
        await tx.update(tradingBots).set({ positionSizeUsdt: String(toCap + action.amountUsdt) }).where(and(eq(tradingBots.id, action.toBotId), eq(tradingBots.userId, userId))).returning();
      });
      return { status: 'EXECUTED', decisionId, realBotId: fromRow.id };
    }

    case 'place_market_order':
      return placeOrderHelper(params, action, 'MARKET', {});

    case 'place_limit_order':
      return placeOrderHelper(params, action, 'LIMIT', {
        price: String(action.price),
        timeInForce: action.timeInForce,
      });

    case 'place_stop_order':
      return placeOrderHelper(params, action, 'STOP_MARKET', {
        stopPrice: String(action.stopPrice),
      });

    case 'place_take_profit':
      return placeOrderHelper(params, action, 'TAKE_PROFIT_MARKET', {
        stopPrice: String(action.stopPrice),
      });

    case 'place_trailing_stop':
      return placeOrderHelper(params, action, 'TRAILING_STOP_MARKET', {
        priceRate: String(action.callbackRate),
      });

    case 'close_position': {
      if (config.paperMode) {
        const resultOrderId = syntheticOrderId();
        await setResultOrderId(params.db, decisionId, resultOrderId);
        const detail = action.side && action.percent
          ? `paper close ${action.percent}% ${action.side} ${action.symbol}`
          : `paper close all ${action.symbol}`;
        return { status: 'EXECUTED', decisionId, resultOrderId, reason: detail };
      }
      if (!params.bingxClient) {
        return { status: 'EXECUTION_FAILED', decisionId, reason: 'missing_bingx_client' };
      }
      try {
        // No side+percent → close all positions for this symbol.
        if (!action.side || !action.percent) {
          const closeAllFn = params.closeAllPositionsFn ?? defaultCloseAllPositions;
          const res = await closeAllFn(params.bingxClient, action.symbol);
          return { status: 'EXECUTED', decisionId, reason: `closed ${res.closedCount} position(s)` };
        }
        // Partial close: look up the position, compute closeQty, place reduce-only inverse-side market.
        const listFn = params.listPositionsFn ?? defaultListFuturesPositions;
        const placeFn = params.placeOrderFn ?? defaultPlaceFuturesOrder;
        const positions = await listFn(params.bingxClient, action.symbol);
        const match = positions.find((p) => p.side === action.side);
        if (!match) {
          return { status: 'EXECUTION_FAILED', decisionId, reason: `no ${action.side} position for ${action.symbol}` };
        }
        const closeQty = (Number(match.qty) * action.percent) / 100;
        const orderParams: PlaceOrderParams = {
          symbol: action.symbol,
          side: action.side === 'LONG' ? 'SELL' : 'BUY',
          positionSide: action.side,
          type: 'MARKET',
          quantity: String(closeQty),
          reduceOnly: true,
        };
        const res = await placeFn(params.bingxClient, orderParams);
        await setResultOrderId(params.db, decisionId, res.orderId);
        return { status: 'EXECUTED', decisionId, resultOrderId: res.orderId };
      } catch (err) {
        return { status: 'EXECUTION_FAILED', decisionId, reason: err instanceof Error ? err.message : String(err) };
      }
    }

    case 'cancel_order': {
      if (config.paperMode) {
        return {
          status: 'EXECUTED',
          decisionId,
          reason: `paper cancel ${action.orderId} on ${action.symbol}`,
        };
      }
      if (!params.bingxClient) {
        return { status: 'EXECUTION_FAILED', decisionId, reason: 'missing_bingx_client' };
      }
      const cancelFn = params.cancelOrderFn ?? defaultCancelFuturesOrder;
      try {
        await cancelFn(params.bingxClient, action.symbol, action.orderId);
        return { status: 'EXECUTED', decisionId };
      } catch (err) {
        return { status: 'EXECUTION_FAILED', decisionId, reason: err instanceof Error ? err.message : String(err) };
      }
    }

    case 'cancel_all_orders': {
      if (config.paperMode) {
        return {
          status: 'EXECUTED',
          decisionId,
          reason: `paper cancel_all${action.symbol ? ' on ' + action.symbol : ''}`,
        };
      }
      if (!params.bingxClient) {
        return { status: 'EXECUTION_FAILED', decisionId, reason: 'missing_bingx_client' };
      }
      const cancelAllFn = params.cancelAllOrdersFn ?? defaultCancelAllFuturesOrders;
      try {
        const res = await cancelAllFn(params.bingxClient, action.symbol);
        return { status: 'EXECUTED', decisionId, reason: `canceled ${res.canceledCount} order(s)` };
      } catch (err) {
        return { status: 'EXECUTION_FAILED', decisionId, reason: err instanceof Error ? err.message : String(err) };
      }
    }
  }
}

export async function setResultOrderId(
  database: typeof Db,
  decisionId: string,
  orderId: string,
): Promise<void> {
  await database
    .update(aiDecisions)
    .set({ resultOrderId: orderId })
    .where(eq(aiDecisions.id, decisionId));
}
