CREATE TABLE "schedule_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"output" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"spec" text NOT NULL,
	"prompt" text NOT NULL,
	"thread_id" text NOT NULL,
	"timezone" text NOT NULL,
	"label" text,
	"next_run_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "schedules_due_idx" ON "schedules" USING btree ("active","next_run_at");