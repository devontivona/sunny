-- Custom SQL migration file, put your code below! --
-- Backfill: existing inbound messages are already handled; mark them processed
-- so restart recovery (D-DE1) only re-runs genuinely un-answered messages.
-- Idempotent: a no-op once everything is already marked.
UPDATE "messages" SET "processed_at" = "created_at" WHERE "role" = 'user' AND "processed_at" IS NULL;