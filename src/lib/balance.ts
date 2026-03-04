export type BalanceItem = {
  asset?: string;
  balance?: number;
  availableMargin?: number;
  available_margin?: number;
  equity?: number;
  freezedMargin?: number;
  freezed_margin?: number;
  realizedProfit?: number;
  realized_profit?: number;
  unrealizedProfit?: number;
  unrealized_profit?: number;
  usedMargin?: number;
  used_margin?: number;
};

export function getNum(obj: BalanceItem, ...keys: (keyof BalanceItem)[]): number {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && !Number.isNaN(v)) return v;
    if (typeof v === 'string') {
      const n = parseFloat(v);
      if (!Number.isNaN(n)) return n;
    }
  }
  return 0;
}

export function parseBalanceData(data: unknown): BalanceItem[] {
  if (!data || typeof data !== 'object') return [];
  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj)) {
    return obj as BalanceItem[];
  }
  if (Array.isArray(obj.balance)) {
    return obj.balance as BalanceItem[];
  }
  if (typeof obj.balance === 'object' && obj.balance !== null) {
    const bal = obj.balance as Record<string, unknown>;
    if (Array.isArray(bal.balance)) {
      return bal.balance as BalanceItem[];
    }
    return [obj.balance as BalanceItem];
  }
  if (
    obj.asset !== undefined ||
    typeof obj.balance === 'number' ||
    obj.equity !== undefined
  ) {
    return [obj as BalanceItem];
  }
  return [];
}

export function getAvailableMargin(data: unknown): number | null {
  const items = parseBalanceData(data);
  const usdtItem = items.find((i) => (i.asset as string)?.toUpperCase() === 'USDT') ?? items[0];
  if (!usdtItem) return null;
  return getNum(usdtItem, 'availableMargin', 'available_margin');
}
