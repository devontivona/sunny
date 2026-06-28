CREATE TABLE "subagent_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_thread_id" text NOT NULL,
	"child_thread_id" text NOT NULL,
	"child_run_id" text,
	"task" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"depth" integer DEFAULT 1 NOT NULL,
	"orchestrator" boolean DEFAULT false NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "subagent_links_child_thread_uniq" ON "subagent_links" USING btree ("child_thread_id");--> statement-breakpoint
CREATE INDEX "subagent_links_parent_idx" ON "subagent_links" USING btree ("parent_thread_id","status");
