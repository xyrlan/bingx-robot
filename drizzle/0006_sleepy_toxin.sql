CREATE TYPE "public"."bot_type" AS ENUM('GRID_LONG', 'GRID_SHORT', 'DCA', 'TRAILING_STOP');--> statement-breakpoint
ALTER TABLE "trading_bots" ADD COLUMN "bot_type" "bot_type" DEFAULT 'GRID_LONG' NOT NULL;--> statement-breakpoint
ALTER TABLE "trading_bots" ADD COLUMN "config" jsonb;