import { z } from 'zod';

export const dcaConfigSchema = z.object({
  intervalMinutes: z.number().int().min(1).max(10080), // max 1 week
  totalOrders: z.number().int().min(1).max(1000),
  orderSizeUsdt: z.number().positive(),
  ordersPlaced: z.number().int().min(0).default(0),
  side: z.enum(['BUY', 'SELL']).default('BUY'),
  lastOrderAt: z.number().optional(),
});

export const trailingStopConfigSchema = z.object({
  positionSizeUsdt: z.number().positive(),
  activationPricePct: z.number().min(0).max(100),
  trailingPct: z.number().positive().max(100),
  highestPrice: z.number().min(0).default(0),
  isActivated: z.boolean().default(false),
  entryOrderId: z.string().nullable().default(null),
});

export const gridBotStartSchema = z.object({
  symbol: z.string().min(1).default('BTC-USDT'),
  apiKeyId: z.string().uuid().optional(),
  priceMin: z.union([z.string(), z.number()]).transform(Number).pipe(z.number().positive()),
  priceMax: z.union([z.string(), z.number()]).transform(Number).pipe(z.number().positive()),
  positionSizeUsdt: z.union([z.string(), z.number()]).transform(Number).pipe(z.number().positive()),
  takeProfitPercentage: z.union([z.string(), z.number()]).transform(Number).pipe(z.number().positive().max(100)),
  gridCount: z.number().int().min(1).max(100).default(1),
  botType: z.enum(['GRID_LONG', 'GRID_SHORT']).optional(),
}).refine((data) => data.priceMin < data.priceMax, {
  message: 'priceMin must be less than priceMax',
  path: ['priceMin'],
});

export const smaConfigSchema = z.object({
  symbols: z.array(z.string().min(1)).min(1).max(20),
  timeframe: z.enum(['1h', '4h', '1d']).default('4h'),
  fastPeriod: z.number().int().min(2).max(50).default(3),
  mediumPeriod: z.number().int().min(5).max(100).default(20),
  trendPeriod: z.number().int().min(50).max(500).default(150),
  activationPct: z.number().min(0.1).max(50).default(1.5),
  trailingPct: z.number().min(0.1).max(20).default(0.5),
  initialStopPct: z.number().min(0.1).max(20).default(1.5),
  positionSizeUsdt: z.number().positive(),
  leverage: z.number().int().min(1).max(125).default(1),
  marginType: z.enum(['ISOLATED', 'CROSSED', 'SEPARATE_ISOLATED']).default('SEPARATE_ISOLATED'),
}).refine((data) => data.fastPeriod < data.mediumPeriod, {
  message: 'fastPeriod must be less than mediumPeriod',
  path: ['fastPeriod'],
}).refine((data) => data.mediumPeriod < data.trendPeriod, {
  message: 'mediumPeriod must be less than trendPeriod',
  path: ['mediumPeriod'],
});

export const botStartSchema = z.object({
  botId: z.string().uuid().optional(),
  apiKeyId: z.string().uuid().optional(),
  symbol: z.string().min(1).optional(),
  botType: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  priceMin: z.union([z.string(), z.number()]).optional(),
  priceMax: z.union([z.string(), z.number()]).optional(),
  positionSizeUsdt: z.union([z.string(), z.number()]).optional(),
  takeProfitPercentage: z.union([z.string(), z.number()]).optional(),
  gridCount: z.number().optional(),
});
