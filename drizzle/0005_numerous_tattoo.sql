ALTER TABLE "bingx_api_keys" DROP CONSTRAINT "bingx_api_keys_user_id_unique";--> statement-breakpoint
ALTER TABLE "bingx_api_keys" ADD COLUMN "label" text DEFAULT 'Main' NOT NULL;--> statement-breakpoint
ALTER TABLE "trading_bots" ADD COLUMN "api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "trading_bots" ADD CONSTRAINT "trading_bots_api_key_id_bingx_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."bingx_api_keys"("id") ON DELETE set null ON UPDATE no action;