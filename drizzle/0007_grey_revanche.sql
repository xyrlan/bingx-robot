ALTER TYPE "public"."bot_type" ADD VALUE 'DCA_SPOT';--> statement-breakpoint
ALTER TYPE "public"."bot_type" ADD VALUE 'SMA_CROSSOVER';--> statement-breakpoint
CREATE INDEX "bingx_api_keys_user_id_idx" ON "bingx_api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "trading_bots_user_status_idx" ON "trading_bots" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "trading_bots_api_key_idx" ON "trading_bots" USING btree ("api_key_id");