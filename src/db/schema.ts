import { relations } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  pgEnum,
  decimal,
  integer,
  boolean,
  uniqueIndex,
  index,
  jsonb,
} from 'drizzle-orm/pg-core';

// ==========================================
// 1. ENUMS
// ==========================================

export const userRoleEnum = pgEnum('user_role', ['USER', 'ADMIN']);

export const botStatusEnum = pgEnum('bot_status', ['STOPPED', 'RUNNING']);

export const botTypeEnum = pgEnum('bot_type', [
  'GRID_LONG',
  'GRID_SHORT',
  'DCA',
  'TRAILING_STOP',
  'DCA_SPOT',
  'SMA_CROSSOVER',
]);

// ==========================================
// 2. USERS & PROFILES
// ==========================================

/**
 * Users table - Identity sync with Supabase Auth
 * id matches auth.users.id from Supabase
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull().unique(),
  emailVerifiedAt: timestamp('email_verified_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * Profiles table - Extended user data (1:1 with users)
 * id = user_id for Supabase compatibility (auth.users.id)
 */
export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull()
    .unique(),
  fullName: text('full_name'),
  avatarUrl: text('avatar_url'),
  phone: text('phone'),
  role: userRoleEnum('role').notNull().default('USER'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ==========================================
// 3. RELATIONS
// ==========================================

export const usersRelations = relations(users, ({ one }) => ({
  profile: one(profiles),
}));

export const profilesRelations = relations(profiles, ({ one }) => ({
  user: one(users, {
    fields: [profiles.userId],
    references: [users.id],
  }),
}));

// ==========================================
// 4. BINGX API KEYS
// ==========================================

export const bingxApiKeys = pgTable('bingx_api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  label: text('label').notNull().default('Main'),
  apiKey: text('api_key').notNull(),
  secretKeyEncrypted: text('secret_key_encrypted').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [index('bingx_api_keys_user_id_idx').on(table.userId)]);

// ==========================================
// 5. TRADING BOTS
// ==========================================

export const tradingBots = pgTable('trading_bots', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  apiKeyId: uuid('api_key_id')
    .references(() => bingxApiKeys.id, { onDelete: 'set null' }),
  symbol: text('symbol').notNull(),
  botType: botTypeEnum('bot_type').notNull().default('GRID_LONG'),
  config: jsonb('config').$type<Record<string, unknown>>(),
  priceMin: decimal('price_min', { precision: 18, scale: 8 }).notNull(),
  priceMax: decimal('price_max', { precision: 18, scale: 8 }).notNull(),
  positionSizeUsdt: decimal('position_size_usdt', { precision: 18, scale: 8 }).notNull().default('10'),
  takeProfitPercentage: decimal('take_profit_percentage', { precision: 8, scale: 4 }).notNull().default('1'),
  gridCount: integer('grid_count').notNull().default(1),
  leverage: integer('leverage').notNull().default(1),
  marginType: text('margin_type').notNull().default('SEPARATE_ISOLATED'),
  status: botStatusEnum('status').notNull().default('STOPPED'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('trading_bots_user_status_idx').on(table.userId, table.status),
  index('trading_bots_api_key_idx').on(table.apiKeyId),
]);

// ==========================================
// 5b. GRID LEVELS
// ==========================================

export const gridLevels = pgTable(
  'grid_levels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    botId: uuid('bot_id')
      .references(() => tradingBots.id, { onDelete: 'cascade' })
      .notNull(),
    priceLevel: decimal('price_level', { precision: 18, scale: 8 }).notNull(),
    orderId: text('order_id'),
    tpOrderId: text('tp_order_id'),
    isActive: boolean('is_active').default(true).notNull(),
    positionSide: text('position_side').notNull().default('LONG'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [uniqueIndex('grid_levels_bot_price_idx').on(table.botId, table.priceLevel)]
);

// ==========================================
// 5c. BOT TRADES (P&L tracking)
// ==========================================

export const botTrades = pgTable(
  'bot_trades',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    botId: uuid('bot_id')
      .references(() => tradingBots.id, { onDelete: 'cascade' })
      .notNull(),
    symbol: text('symbol').notNull(),
    side: text('side').notNull(), // 'LONG' | 'SHORT'
    type: text('type').notNull(), // 'ENTRY' | 'EXIT_TP' | 'EXIT_TRAILING' | 'EXIT_SIGNAL' | 'EXIT_MANUAL'
    price: decimal('price', { precision: 18, scale: 8 }).notNull(),
    quantity: decimal('quantity', { precision: 18, scale: 8 }).notNull(),
    realizedPnl: decimal('realized_pnl', { precision: 18, scale: 8 }).notNull().default('0'),
    orderId: text('order_id'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('bot_trades_bot_id_idx').on(table.botId),
    index('bot_trades_bot_id_type_idx').on(table.botId, table.type),
  ]
);

// ==========================================
// 6. RELATIONS (BingX)
// ==========================================

export const bingxApiKeysRelations = relations(bingxApiKeys, ({ one, many }) => ({
  user: one(users, {
    fields: [bingxApiKeys.userId],
    references: [users.id],
  }),
  bots: many(tradingBots),
}));

export const tradingBotsRelations = relations(tradingBots, ({ one, many }) => ({
  user: one(users, {
    fields: [tradingBots.userId],
    references: [users.id],
  }),
  apiKey: one(bingxApiKeys, {
    fields: [tradingBots.apiKeyId],
    references: [bingxApiKeys.id],
  }),
  gridLevels: many(gridLevels),
  trades: many(botTrades),
}));

export const gridLevelsRelations = relations(gridLevels, ({ one }) => ({
  bot: one(tradingBots, {
    fields: [gridLevels.botId],
    references: [tradingBots.id],
  }),
}));

export const botTradesRelations = relations(botTrades, ({ one }) => ({
  bot: one(tradingBots, {
    fields: [botTrades.botId],
    references: [tradingBots.id],
  }),
}));
