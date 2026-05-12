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

export const aiPmModeEnum = pgEnum('ai_pm_mode', [
  'CONSERVATIVE',
  'BALANCED',
  'AGGRESSIVE',
  'CUSTOM',
]);

export const aiDecisionStatusEnum = pgEnum('ai_decision_status', [
  'PROPOSED',
  'REJECTED_GUARDRAIL',
  'REJECTED_BACKTEST',
  'REJECTED_REVIEWER',
  'EXECUTED',
  'EXECUTION_FAILED',
]);

export const aiActionTypeEnum = pgEnum('ai_action_type', [
  'CREATE_BOT',
  'STOP_BOT',
  'ADJUST_PARAMS',
  'REALLOCATE_CAPITAL',
  'NO_ACTION',
]);

export const aiTriggerSourceEnum = pgEnum('ai_trigger_source', [
  'CRON_TICK',
  'EVENT_DRAWDOWN',
  'EVENT_FUNDING_FLIP',
  'EVENT_FILL',
  'EVENT_ERROR',
  'CHAT',
]);

export const aiEventStatusEnum = pgEnum('ai_event_status', [
  'PENDING',
  'THROTTLED',
  'PROCESSING',
  'PROCESSED',
  'FAILED',
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
  managedByAi: boolean('managed_by_ai').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('bingx_api_keys_user_id_idx').on(table.userId),
  index('bingx_api_keys_managed_by_ai_idx').on(table.managedByAi),
]);

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
// 6. AI PORTFOLIO MANAGER
// ==========================================

/**
 * Per-user AI portfolio manager configuration.
 * One row per user. Points to a dedicated AI-managed BingX subaccount key.
 * Stores guardrails, profile, kill switch, and BYOK Anthropic API key.
 */
export const aiPmConfigs = pgTable('ai_pm_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  bingxApiKeyId: uuid('bingx_api_key_id')
    .notNull()
    .references(() => bingxApiKeys.id, { onDelete: 'cascade' }),
  anthropicApiKeyEncrypted: text('anthropic_api_key_encrypted').notNull(),
  enabled: boolean('enabled').default(false).notNull(),
  mode: aiPmModeEnum('mode').default('BALANCED').notNull(),
  maxCapitalUsdt: decimal('max_capital_usdt', { precision: 20, scale: 8 }),
  maxDrawdownPct: decimal('max_drawdown_pct', { precision: 5, scale: 2 }),
  maxLeverage: integer('max_leverage'),
  allowedSymbols: jsonb('allowed_symbols').$type<string[]>(),
  allowedStrategies: jsonb('allowed_strategies').$type<string[]>(),
  maxConcurrentBots: integer('max_concurrent_bots').default(5),
  monthlyLlmBudgetUsd: decimal('monthly_llm_budget_usd', { precision: 10, scale: 2 }),
  killSwitch: boolean('kill_switch').default(false).notNull(),
  paperMode: boolean('paper_mode').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('ai_pm_configs_user_idx').on(table.userId),
  uniqueIndex('ai_pm_configs_apikey_idx').on(table.bingxApiKeyId),
]);

/**
 * Audit log of every AI decision proposed, rejected, or executed.
 * Insert-only; updates restricted to defined status transitions enforced at the service layer.
 */
export const aiDecisions = pgTable('ai_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  triggeredBy: aiTriggerSourceEnum('triggered_by').notNull(),
  triggerDetail: text('trigger_detail'),
  actionType: aiActionTypeEnum('action_type').notNull(),
  status: aiDecisionStatusEnum('status').notNull(),
  symbol: text('symbol'),
  strategy: botTypeEnum('strategy'),
  params: jsonb('params'),
  reasoning: text('reasoning'),
  signalSnapshot: jsonb('signal_snapshot'),
  backtestRunId: uuid('backtest_run_id').references(() => backtestRuns.id, { onDelete: 'set null' }),
  rejectionReason: text('rejection_reason'),
  modelUsed: text('model_used'),
  tokensInput: integer('tokens_input'),
  tokensOutput: integer('tokens_output'),
  costUsd: decimal('cost_usd', { precision: 10, scale: 6 }),
  resultBotId: uuid('result_bot_id').references(() => tradingBots.id, { onDelete: 'set null' }),
  executedAt: timestamp('executed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('ai_decisions_user_created_idx').on(table.userId, table.createdAt),
  index('ai_decisions_status_idx').on(table.status),
]);

/**
 * Simulated bots used when aiPmConfigs.paperMode = true.
 * Executor writes here instead of creating real BingX bots.
 * Trades are simulated by feeding live OHLCV through the same pure-core simulators that backtest uses.
 */
export const paperBots = pgTable('paper_bots', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  decisionId: uuid('decision_id').references(() => aiDecisions.id, { onDelete: 'set null' }),
  symbol: text('symbol').notNull(),
  strategy: botTypeEnum('strategy').notNull(),
  params: jsonb('params').notNull(),
  capitalUsdt: decimal('capital_usdt', { precision: 20, scale: 8 }).notNull(),
  status: botStatusEnum('status').notNull().default('STOPPED'),
  pnlUsdt: decimal('pnl_usdt', { precision: 20, scale: 8 }).default('0'),
  trades: jsonb('trades').$type<unknown[]>(),
  startedAt: timestamp('started_at'),
  stoppedAt: timestamp('stopped_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('paper_bots_user_status_idx').on(table.userId, table.status),
]);

/**
 * Signal layer output cache. One row per (user, symbol, tick).
 * Used by analyst dashboard watchlist and by Decision layer to read recent context.
 */
export const aiSignals = pgTable('ai_signals', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  symbol: text('symbol').notNull(),
  regime: text('regime').notNull(),
  score: integer('score').notNull(),
  reason: text('reason'),
  indicatorsSnapshot: jsonb('indicators_snapshot'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('ai_signals_user_symbol_idx').on(table.userId, table.symbol, table.createdAt),
]);

/**
 * Cached backtest results, deduplicated by (symbol, strategy, paramsHash, windowDays).
 * Same input always returns the same row — backtest is deterministic.
 */
export const backtestRuns = pgTable('backtest_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  symbol: text('symbol').notNull(),
  strategy: botTypeEnum('strategy').notNull(),
  paramsHash: text('params_hash').notNull(),
  params: jsonb('params').notNull(),
  windowDays: integer('window_days').notNull(),
  pnlPct: decimal('pnl_pct', { precision: 10, scale: 4 }),
  maxDrawdownPct: decimal('max_drawdown_pct', { precision: 10, scale: 4 }),
  sharpeApprox: decimal('sharpe_approx', { precision: 10, scale: 4 }),
  winRatePct: decimal('win_rate_pct', { precision: 5, scale: 2 }),
  totalTrades: integer('total_trades'),
  metricsJson: jsonb('metrics_json'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('backtest_runs_dedup_idx').on(table.symbol, table.strategy, table.paramsHash, table.windowDays),
]);

/**
 * Persistent chat history for the AI Portfolio Manager conversational UI.
 * decisionId optionally links a tool-call message to the decision it produced.
 */
export const aiChatMessages = pgTable('ai_chat_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  content: text('content'),
  toolCalls: jsonb('tool_calls'),
  decisionId: uuid('decision_id').references(() => aiDecisions.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('ai_chat_user_created_idx').on(table.userId, table.createdAt),
]);

/**
 * Event log for the AI Portfolio Monitor.
 * Each detected market event (fill, drawdown, funding flip, error) is stored here
 * before being processed by the decision pipeline.
 */
export const aiEvents = pgTable('ai_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  configId: uuid('config_id')
    .notNull()
    .references(() => aiPmConfigs.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  eventType: aiTriggerSourceEnum('event_type').notNull(),
  symbol: text('symbol'),
  payload: jsonb('payload').notNull(),
  status: aiEventStatusEnum('status').notNull().default('PENDING'),
  decisionId: uuid('decision_id').references(() => aiDecisions.id, { onDelete: 'set null' }),
  emittedAt: timestamp('emitted_at').notNull(),
  processedAt: timestamp('processed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('ai_events_cfg_type_sym_idx').on(table.configId, table.eventType, table.symbol, table.createdAt),
  index('ai_events_status_idx').on(table.status),
  index('ai_events_user_created_idx').on(table.userId, table.createdAt),
]);

/**
 * Per-config funding rate cache. One row per (configId, symbol), upserted on each tick.
 * Used by the monitor to detect funding rate flips without hitting the BingX API on every check.
 */
export const aiPmFundingCache = pgTable('ai_pm_funding_cache', {
  id: uuid('id').primaryKey().defaultRandom(),
  configId: uuid('config_id')
    .notNull()
    .references(() => aiPmConfigs.id, { onDelete: 'cascade' }),
  symbol: text('symbol').notNull(),
  fundingRate: decimal('funding_rate', { precision: 10, scale: 8 }).notNull(),
  observedAt: timestamp('observed_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('ai_pm_funding_cache_cfg_sym').on(table.configId, table.symbol),
]);

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

export const aiPmConfigsRelations = relations(aiPmConfigs, ({ one }) => ({
  user: one(users, {
    fields: [aiPmConfigs.userId],
    references: [users.id],
  }),
  bingxApiKey: one(bingxApiKeys, {
    fields: [aiPmConfigs.bingxApiKeyId],
    references: [bingxApiKeys.id],
  }),
}));

export const aiDecisionsRelations = relations(aiDecisions, ({ one, many }) => ({
  user: one(users, {
    fields: [aiDecisions.userId],
    references: [users.id],
  }),
  resultBot: one(tradingBots, {
    fields: [aiDecisions.resultBotId],
    references: [tradingBots.id],
  }),
  backtestRun: one(backtestRuns, {
    fields: [aiDecisions.backtestRunId],
    references: [backtestRuns.id],
  }),
  chatMessages: many(aiChatMessages),
  paperBots: many(paperBots),
}));

export const paperBotsRelations = relations(paperBots, ({ one }) => ({
  user: one(users, {
    fields: [paperBots.userId],
    references: [users.id],
  }),
  decision: one(aiDecisions, {
    fields: [paperBots.decisionId],
    references: [aiDecisions.id],
  }),
}));

export const aiSignalsRelations = relations(aiSignals, ({ one }) => ({
  user: one(users, {
    fields: [aiSignals.userId],
    references: [users.id],
  }),
}));

export const backtestRunsRelations = relations(backtestRuns, ({ many }) => ({
  decisions: many(aiDecisions),
}));

export const aiChatMessagesRelations = relations(aiChatMessages, ({ one }) => ({
  user: one(users, {
    fields: [aiChatMessages.userId],
    references: [users.id],
  }),
  decision: one(aiDecisions, {
    fields: [aiChatMessages.decisionId],
    references: [aiDecisions.id],
  }),
}));

export const aiEventsRelations = relations(aiEvents, ({ one }) => ({
  user: one(users, { fields: [aiEvents.userId], references: [users.id] }),
  config: one(aiPmConfigs, { fields: [aiEvents.configId], references: [aiPmConfigs.id] }),
  decision: one(aiDecisions, { fields: [aiEvents.decisionId], references: [aiDecisions.id] }),
}));

export const aiPmFundingCacheRelations = relations(aiPmFundingCache, ({ one }) => ({
  config: one(aiPmConfigs, { fields: [aiPmFundingCache.configId], references: [aiPmConfigs.id] }),
}));
