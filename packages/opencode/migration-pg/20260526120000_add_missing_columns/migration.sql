ALTER TABLE "workspace" ADD COLUMN IF NOT EXISTS "time_used" bigint;
--> statement-breakpoint
ALTER TABLE "event_sequence" ADD COLUMN IF NOT EXISTS "owner_id" text;
