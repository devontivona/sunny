-- unified-voice-layer D-VL10: audience is the ONE addressing encoding. Backfill the retired
-- output_target flag into the audience it implied (silent → nobody; user → null = the
-- creating thread's agent), then drop the column so the legacy vocabulary cannot survive
-- anywhere in the runtime.
UPDATE "schedules" SET "audience" = 'nobody' WHERE "output_target" = 'silent' AND "audience" IS NULL;--> statement-breakpoint
ALTER TABLE "schedules" DROP COLUMN "output_target";
