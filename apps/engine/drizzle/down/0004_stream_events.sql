DROP TABLE IF EXISTS "stream_events";
--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN IF EXISTS "source";
