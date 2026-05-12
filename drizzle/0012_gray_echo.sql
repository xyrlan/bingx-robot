CREATE TYPE "public"."ai_event_status" AS ENUM('PENDING', 'THROTTLED', 'PROCESSING', 'PROCESSED', 'FAILED');--> statement-breakpoint
CREATE TABLE "ai_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"config_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"event_type" "ai_trigger_source" NOT NULL,
	"symbol" text,
	"payload" jsonb NOT NULL,
	"status" "ai_event_status" DEFAULT 'PENDING' NOT NULL,
	"decision_id" uuid,
	"emitted_at" timestamp NOT NULL,
	"processed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_pm_funding_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"config_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"funding_rate" numeric(10, 8) NOT NULL,
	"observed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_events" ADD CONSTRAINT "ai_events_config_id_ai_pm_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."ai_pm_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_events" ADD CONSTRAINT "ai_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_events" ADD CONSTRAINT "ai_events_decision_id_ai_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."ai_decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_pm_funding_cache" ADD CONSTRAINT "ai_pm_funding_cache_config_id_ai_pm_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."ai_pm_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_events_cfg_type_sym_idx" ON "ai_events" USING btree ("config_id","event_type","symbol","created_at");--> statement-breakpoint
CREATE INDEX "ai_events_status_idx" ON "ai_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ai_events_user_created_idx" ON "ai_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_pm_funding_cache_cfg_sym" ON "ai_pm_funding_cache" USING btree ("config_id","symbol");