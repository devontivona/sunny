CREATE TABLE "callback_endpoints" (
	"token" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"ttl_expires_at" timestamp with time zone NOT NULL,
	"captured_params" jsonb,
	"captured_meta" jsonb,
	"captured_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "short_links" (
	"hash" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "callback_endpoints_thread_idx" ON "callback_endpoints" USING btree ("thread_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "short_links_url_uniq" ON "short_links" USING btree ("url");