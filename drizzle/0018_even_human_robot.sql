CREATE TABLE "bot_income_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_key_id" uuid NOT NULL,
	"bot_id" uuid,
	"symbol" text NOT NULL,
	"income_type" text NOT NULL,
	"amount" numeric(18, 8) NOT NULL,
	"trade_id" text NOT NULL,
	"order_id" text,
	"client_order_id" text,
	"income_time" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_income_records" ADD CONSTRAINT "bot_income_records_api_key_id_bingx_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."bingx_api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_income_records" ADD CONSTRAINT "bot_income_records_bot_id_trading_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."trading_bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_income_key_trade_type_idx" ON "bot_income_records" USING btree ("api_key_id","trade_id","income_type");--> statement-breakpoint
CREATE INDEX "bot_income_bot_time_idx" ON "bot_income_records" USING btree ("bot_id","income_time");