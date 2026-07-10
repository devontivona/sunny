CREATE TABLE "dream_state" (
	"id" text PRIMARY KEY NOT NULL,
	"covered_through_created_at" timestamp with time zone NOT NULL,
	"covered_through_message_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_compactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"thread_id" text NOT NULL,
	"boundary_created_at" timestamp with time zone NOT NULL,
	"boundary_message_id" text NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "thread_compactions_thread_idx" ON "thread_compactions" USING btree ("thread_id","seq");