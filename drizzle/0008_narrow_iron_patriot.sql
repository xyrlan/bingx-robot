CREATE TABLE "bot_trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"type" text NOT NULL,
	"price" numeric(18, 8) NOT NULL,
	"quantity" numeric(18, 8) NOT NULL,
	"realized_pnl" numeric(18, 8) DEFAULT '0' NOT NULL,
	"order_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_trades" ADD CONSTRAINT "bot_trades_bot_id_trading_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."trading_bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bot_trades_bot_id_idx" ON "bot_trades" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "bot_trades_bot_id_type_idx" ON "bot_trades" USING btree ("bot_id","type");