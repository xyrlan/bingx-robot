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
