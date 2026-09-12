/**
 * Exchange minimums for a single order. Both fields come from
 * getContractInfo(), which defaults them to 0 when BingX omits them.
 */
export interface MinOrderContract {
  tradeMinUSDT: number;
  tradeMinQuantity: number;
}

export type MinOrderRejection = 'MIN_NOTIONAL' | 'MIN_QUANTITY';

export interface MinOrderCheck {
  ok: boolean;
  reason?: MinOrderRejection;
  message?: string;
}

/**
 * Checks one order's notional and derived quantity against the symbol's
 * exchange minimums.
 *
 * The watcher skips any level failing these checks with a bare `continue`
 * (no log, no status change, nothing in the UI), so a bot configured below
 * the minimum stays RUNNING while placing nothing — indefinitely. Callers
 * run this at bot creation to reject the config up front, and the watcher
 * logs it if one slips through.
 *
 * Fails OPEN when a minimum is 0 or contract info is missing, matching the
 * watcher's own behaviour: an unknown minimum must never block an order the
 * exchange would have accepted.
 *
 * For a grid, pass the HIGHEST price in the range: quantity is
 * notional/price, so the top of the grid is where the quantity floor is
 * breached first.
 */
export function checkMinOrderSize(params: {
  positionSizeUsdt: number;
  priceLevel: number;
  contract: MinOrderContract | null | undefined;
  symbol?: string;
}): MinOrderCheck {
  const { positionSizeUsdt, priceLevel, contract, symbol } = params;
  if (!contract) return { ok: true };

  const where = symbol ? ` for ${symbol}` : '';

  const minUsdt = contract.tradeMinUSDT ?? 0;
  if (minUsdt > 0 && positionSizeUsdt < minUsdt) {
    return {
      ok: false,
      reason: 'MIN_NOTIONAL',
      message:
        `Position size per level (${positionSizeUsdt} USDT) is below the exchange ` +
        `minimum of ${minUsdt} USDT${where}. Raise the position size.`,
    };
  }

  const minQty = contract.tradeMinQuantity ?? 0;
  if (minQty > 0 && priceLevel > 0) {
    const quantity = positionSizeUsdt / priceLevel;
    if (quantity < minQty) {
      return {
        ok: false,
        reason: 'MIN_QUANTITY',
        message:
          `Position size per level (${positionSizeUsdt} USDT) buys ${quantity} units at ` +
          `${priceLevel}, below the exchange minimum of ${minQty}${where}. ` +
          `Raise the position size.`,
      };
    }
  }

  return { ok: true };
}
