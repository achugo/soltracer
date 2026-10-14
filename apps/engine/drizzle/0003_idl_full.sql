ALTER TABLE "idl_cache" ADD COLUMN "idl" jsonb;
--> statement-breakpoint
-- Cached rows only hold error tables; drop them so every IDL is re-read once with its full contents.
DELETE FROM "idl_cache";
