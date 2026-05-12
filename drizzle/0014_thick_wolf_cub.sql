CREATE TABLE "chat_message_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_message_chunks" ADD CONSTRAINT "chat_message_chunks_message_id_ai_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."ai_chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_message_chunks_msg_seq_unique" ON "chat_message_chunks" USING btree ("message_id","seq");--> statement-breakpoint
CREATE INDEX "chat_message_chunks_msg_seq_idx" ON "chat_message_chunks" USING btree ("message_id","seq");