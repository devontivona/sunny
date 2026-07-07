CREATE TABLE "outbound_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_handle" text NOT NULL,
	"thread_id" text NOT NULL,
	"text" text NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"last_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_deliveries_handle_idx" ON "outbound_deliveries" USING btree ("message_handle");