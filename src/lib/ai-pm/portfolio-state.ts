import { and, eq } from 'drizzle-orm';
import { tradingBots } from '@/db/schema';
import { getFuturesBalance } from '@/services/bingx-orders.service';
import type { BingxClient } from '@/lib/bingx/client';
import type { db as Db } from '@/db';

export interface PortfolioBotSnapshot {
  id: string;
  symbol: string;
  strategy: 'DCA' | 'TRAILING_STOP' | 'DCA_SPOT' | 'SMA_CROSSOVER';
  capitalUsdt: number;
  leverage: number;
  status: 'RUNNING' | 'STOPPED';
}

export interface PortfolioState {
  runningBots: PortfolioBotSnapshot[];
  capitalUsedUsdt: number;
  bingxApiKeyId: string;
  /** Real free margin (USDT) from BingX. Undefined when not fetched or the fetch failed. */
  availableBalanceUsdt?: number;
}

const NON_GRID_STRATEGIES = ['DCA', 'TRAILING_STOP', 'DCA_SPOT', 'SMA_CROSSOVER'] as const;
type NonGridStrategy = (typeof NON_GRID_STRATEGIES)[number];

function isNonGrid(s: string): s is NonGridStrategy {
  return (NON_GRID_STRATEGIES as readonly string[]).includes(s);
}

export async function loadPortfolioState(params: {
  userId: string;
  bingxApiKeyId: string;
  db: typeof Db;
  bingxClient?: BingxClient;
  getFuturesBalanceFn?: typeof getFuturesBalance;
}): Promise<PortfolioState> {
  const rows = await params.db
    .select()
    .from(tradingBots)
    .where(
      and(
        eq(tradingBots.userId, params.userId),
        eq(tradingBots.apiKeyId, params.bingxApiKeyId),
        eq(tradingBots.status, 'RUNNING'),
      ),
    );

  const runningBots: PortfolioBotSnapshot[] = [];
  let capitalUsedUsdt = 0;

  for (const row of rows) {
    if (!isNonGrid(row.botType)) continue;
    const capital = Number(row.positionSizeUsdt);
    runningBots.push({
      id: row.id,
      symbol: row.symbol,
      strategy: row.botType,
      capitalUsdt: capital,
      leverage: row.leverage,
      status: row.status,
    });
    capitalUsedUsdt += capital;
  }

  let availableBalanceUsdt: number | undefined;
  if (params.bingxClient) {
    const fetchBalance = params.getFuturesBalanceFn ?? getFuturesBalance;
    try {
      const balance = await fetchBalance(params.bingxClient);
      const parsed = Number(balance.availableUsdt);
      if (Number.isFinite(parsed)) availableBalanceUsdt = parsed;
    } catch {
      // fail-open: leave undefined — guardrails degrade to static-cap-only behaviour
    }
  }

  return { runningBots, capitalUsedUsdt, bingxApiKeyId: params.bingxApiKeyId, availableBalanceUsdt };
}
