ALTER TABLE "workspace" ADD COLUMN IF NOT EXISTS "time_used" bigint;
--> statement-breakpoint
ALTER TABLE "event_sequence" ADD COLUMN IF NOT EXISTS "owner_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_time_updated_idx" ON "session" ("time_updated" DESC);
