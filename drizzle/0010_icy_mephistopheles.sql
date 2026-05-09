CREATE TYPE "public"."ai_action_type" AS ENUM('CREATE_BOT', 'STOP_BOT', 'ADJUST_PARAMS', 'REALLOCATE_CAPITAL', 'NO_ACTION');--> statement-breakpoint
CREATE TYPE "public"."ai_decision_status" AS ENUM('PROPOSED', 'REJECTED_GUARDRAIL', 'REJECTED_BACKTEST', 'REJECTED_REVIEWER', 'EXECUTED', 'EXECUTION_FAILED');--> statement-breakpoint
CREATE TYPE "public"."ai_pm_mode" AS ENUM('CONSERVATIVE', 'BALANCED', 'AGGRESSIVE', 'CUSTOM');--> statement-breakpoint
CREATE TYPE "public"."ai_trigger_source" AS ENUM('CRON_TICK', 'EVENT_DRAWDOWN', 'EVENT_FUNDING_FLIP', 'EVENT_FILL', 'EVENT_ERROR', 'CHAT');--> statement-breakpoint
CREATE TABLE "ai_chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text,
	"tool_calls" jsonb,
	"decision_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"triggered_by" "ai_trigger_source" NOT NULL,
	"trigger_detail" text,
	"action_type" "ai_action_type" NOT NULL,
	"status" "ai_decision_status" NOT NULL,
	"symbol" text,
	"strategy" "bot_type",
	"params" jsonb,
	"reasoning" text,
	"signal_snapshot" jsonb,
	"backtest_run_id" uuid,
	"rejection_reason" text,
	"model_used" text,
	"tokens_input" integer,
	"tokens_output" integer,
	"cost_usd" numeric(10, 6),
	"result_bot_id" uuid,
	"executed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_pm_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"bingx_api_key_id" uuid NOT NULL,
	"anthropic_api_key_encrypted" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"mode" "ai_pm_mode" DEFAULT 'BALANCED' NOT NULL,
	"max_capital_usdt" numeric(20, 8),
	"max_drawdown_pct" numeric(5, 2),
	"max_leverage" integer,
	"allowed_symbols" jsonb,
	"allowed_strategies" jsonb,
	"max_concurrent_bots" integer DEFAULT 5,
	"monthly_llm_budget_usd" numeric(10, 2),
	"kill_switch" boolean DEFAULT false NOT NULL,
	"paper_mode" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"regime" text NOT NULL,
	"score" integer NOT NULL,
	"reason" text,
	"indicators_snapshot" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backtest_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol" text NOT NULL,
	"strategy" "bot_type" NOT NULL,
	"params_hash" text NOT NULL,
	"params" jsonb NOT NULL,
	"window_days" integer NOT NULL,
	"pnl_pct" numeric(10, 4),
	"max_drawdown_pct" numeric(10, 4),
	"sharpe_approx" numeric(10, 4),
	"win_rate_pct" numeric(5, 2),
	"total_trades" integer,
	"metrics_json" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_bots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"decision_id" uuid,
	"symbol" text NOT NULL,
	"strategy" "bot_type" NOT NULL,
	"params" jsonb NOT NULL,
	"capital_usdt" numeric(20, 8) NOT NULL,
	"status" "bot_status" DEFAULT 'STOPPED' NOT NULL,
	"pnl_usdt" numeric(20, 8) DEFAULT '0',
	"trades" jsonb,
	"started_at" timestamp,
	"stopped_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_chat_messages" ADD CONSTRAINT "ai_chat_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_chat_messages" ADD CONSTRAINT "ai_chat_messages_decision_id_ai_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."ai_decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_decisions" ADD CONSTRAINT "ai_decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_decisions" ADD CONSTRAINT "ai_decisions_backtest_run_id_backtest_runs_id_fk" FOREIGN KEY ("backtest_run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_decisions" ADD CONSTRAINT "ai_decisions_result_bot_id_trading_bots_id_fk" FOREIGN KEY ("result_bot_id") REFERENCES "public"."trading_bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_pm_configs" ADD CONSTRAINT "ai_pm_configs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_pm_configs" ADD CONSTRAINT "ai_pm_configs_bingx_api_key_id_bingx_api_keys_id_fk" FOREIGN KEY ("bingx_api_key_id") REFERENCES "public"."bingx_api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_signals" ADD CONSTRAINT "ai_signals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_bots" ADD CONSTRAINT "paper_bots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_bots" ADD CONSTRAINT "paper_bots_decision_id_ai_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."ai_decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_chat_user_created_idx" ON "ai_chat_messages" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_decisions_user_created_idx" ON "ai_decisions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_decisions_status_idx" ON "ai_decisions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_pm_configs_user_idx" ON "ai_pm_configs" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_pm_configs_apikey_idx" ON "ai_pm_configs" USING btree ("bingx_api_key_id");--> statement-breakpoint
CREATE INDEX "ai_signals_user_symbol_idx" ON "ai_signals" USING btree ("user_id","symbol","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "backtest_runs_dedup_idx" ON "backtest_runs" USING btree ("symbol","strategy","params_hash","window_days");--> statement-breakpoint
CREATE INDEX "paper_bots_user_status_idx" ON "paper_bots" USING btree ("user_id","status");