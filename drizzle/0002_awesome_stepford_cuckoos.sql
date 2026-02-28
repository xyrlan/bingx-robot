CREATE TABLE "grid_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"price_level" numeric(18, 8) NOT NULL,
	"order_id" text,
	"position_side" text DEFAULT 'LONG' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trading_bots" ADD COLUMN "position_size_usdt" numeric(18, 8) DEFAULT '10' NOT NULL;--> statement-breakpoint
ALTER TABLE "trading_bots" ADD COLUMN "take_profit_percentage" numeric(8, 4) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "trading_bots" ADD COLUMN "grid_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "trading_bots" ADD COLUMN "leverage" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "trading_bots" ADD COLUMN "margin_type" text DEFAULT 'SEPARATE_ISOLATED' NOT NULL;--> statement-breakpoint
ALTER TABLE "grid_levels" ADD CONSTRAINT "grid_levels_bot_id_trading_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."trading_bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "grid_levels_bot_price_idx" ON "grid_levels" USING btree ("bot_id","price_level");--> statement-breakpoint
ALTER TABLE "trading_bots" DROP COLUMN "current_order_id";