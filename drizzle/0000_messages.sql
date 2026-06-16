CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"thread_id" text NOT NULL,
	"message_id" text NOT NULL,
	"role" text NOT NULL,
	"sender_id" text NOT NULL,
	"sender_name" text,
	"text" text NOT NULL,
	"is_owner" boolean DEFAULT false NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("thread_id","timestamp");