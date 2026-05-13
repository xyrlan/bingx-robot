import { getContractInfo as defaultGetContractInfo } from '@/services/bingx.service';
import type { BingxClient } from '@/lib/bingx/client';

export interface ExecutorContractInfo {
  quantityPrecision: number;
  minNotional: string;
}

const SAFE_FALLBACK: ExecutorContractInfo = { quantityPrecision: 4, minNotional: '1' };

/**
 * Adapter: wraps real BingX getContractInfo into the shape the AI PM executor
 * expects ({ quantityPrecision, minNotional }). Falls back to a conservative
 * default if the contract isn't found, so trades on unknown symbols still
 * attempt instead of hard-failing.
 */
export function makeGetContractInfoFn(
  client: BingxClient,
  getContractInfoFn: typeof defaultGetContractInfo = defaultGetContractInfo,
): (symbol: string) => Promise<ExecutorContractInfo> {
  return async (symbol: string) => {
    const info = await getContractInfoFn(client, symbol);
    if (!info) return SAFE_FALLBACK;
    return {
      quantityPrecision: info.quantityPrecision ?? SAFE_FALLBACK.quantityPrecision,
      minNotional: String(info.tradeMinUSDT || SAFE_FALLBACK.minNotional),
    };
  };
}
