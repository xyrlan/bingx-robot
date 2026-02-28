CREATE TYPE "public"."bot_status" AS ENUM('STOPPED', 'RUNNING');--> statement-breakpoint
CREATE TABLE "bingx_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"api_key" text NOT NULL,
	"secret_key_encrypted" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "bingx_api_keys_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "trading_bots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"price_min" numeric(18, 8) NOT NULL,
	"price_max" numeric(18, 8) NOT NULL,
	"status" "bot_status" DEFAULT 'STOPPED' NOT NULL,
	"current_order_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bingx_api_keys" ADD CONSTRAINT "bingx_api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trading_bots" ADD CONSTRAINT "trading_bots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;