ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "saas_project_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_saas_project_idx" ON "session" ("saas_project_id");
