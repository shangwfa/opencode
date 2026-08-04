ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "task_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_task_idx" ON "session" ("task_id");
