ALTER TABLE "ai_chat_messages" ADD COLUMN "tokens_input" integer;--> statement-breakpoint
ALTER TABLE "ai_chat_messages" ADD COLUMN "tokens_output" integer;--> statement-breakpoint
ALTER TABLE "ai_chat_messages" ADD COLUMN "cached_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "ai_chat_messages" ADD COLUMN "cost_usd" numeric(10, 6);--> statement-breakpoint
ALTER TABLE "ai_decisions" ADD COLUMN "chat_message_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_decisions" ADD CONSTRAINT "ai_decisions_chat_message_id_fk" FOREIGN KEY ("chat_message_id") REFERENCES "ai_chat_messages"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX "ai_decisions_chat_message_idx" ON "ai_decisions" USING btree ("chat_message_id");