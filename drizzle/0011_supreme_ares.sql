DROP INDEX "ai_pm_configs_user_idx";--> statement-breakpoint
CREATE INDEX "ai_pm_configs_user_idx" ON "ai_pm_configs" USING btree ("user_id");