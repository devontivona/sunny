ALTER TABLE "messages" ADD COLUMN "processed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_channel_msgid_uniq" ON "messages" USING btree ("channel","message_id");