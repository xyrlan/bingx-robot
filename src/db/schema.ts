import { relations } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  pgEnum,
  decimal,
} from 'drizzle-orm/pg-core';

// ==========================================
// 1. ENUMS
// ==========================================

export const userRoleEnum = pgEnum('user_role', ['USER', 'ADMIN']);

export const botStatusEnum = pgEnum('bot_status', ['STOPPED', 'RUNNING']);

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
    .notNull()
    .unique(),
  apiKey: text('api_key').notNull(),
  secretKeyEncrypted: text('secret_key_encrypted').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ==========================================
// 5. TRADING BOTS
// ==========================================

export const tradingBots = pgTable('trading_bots', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  symbol: text('symbol').notNull(),
  priceMin: decimal('price_min', { precision: 18, scale: 8 }).notNull(),
  priceMax: decimal('price_max', { precision: 18, scale: 8 }).notNull(),
  status: botStatusEnum('status').notNull().default('STOPPED'),
  currentOrderId: text('current_order_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ==========================================
// 6. RELATIONS (BingX)
// ==========================================

export const bingxApiKeysRelations = relations(bingxApiKeys, ({ one }) => ({
  user: one(users, {
    fields: [bingxApiKeys.userId],
    references: [users.id],
  }),
}));

export const tradingBotsRelations = relations(tradingBots, ({ one }) => ({
  user: one(users, {
    fields: [tradingBots.userId],
    references: [users.id],
  }),
}));
