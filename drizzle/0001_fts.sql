-- Custom SQL migration file, put your code below! --
-- Full-text search over message bodies (agent-memory: keyword recall).
-- A generated tsvector column kept in sync with `text`, plus a GIN index.
ALTER TABLE "messages"
  ADD COLUMN "text_search" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', "text")) STORED;
--> statement-breakpoint
CREATE INDEX "messages_fts_idx" ON "messages" USING gin ("text_search");