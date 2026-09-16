CREATE TABLE IF NOT EXISTS "rpa_app" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
	"directory" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text NOT NULL DEFAULT 'active',
	"params_schema" jsonb,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rpa_app_version" (
	"id" text PRIMARY KEY,
	"app_id" text NOT NULL REFERENCES "rpa_app"("id") ON DELETE CASCADE,
	"version" integer NOT NULL,
	"status" text NOT NULL DEFAULT 'candidate',
	"source" text NOT NULL,
	"script" text NOT NULL,
	"exploration" text,
	"manifest" jsonb,
	"note" text,
	"repair_from_version" integer,
	"validate_run_id" text,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rpa_app_run" (
	"id" text PRIMARY KEY,
	"app_id" text NOT NULL REFERENCES "rpa_app"("id") ON DELETE CASCADE,
	"version_id" text NOT NULL REFERENCES "rpa_app_version"("id") ON DELETE CASCADE,
	"trigger_type" text NOT NULL,
	"status" text NOT NULL DEFAULT 'pending',
	"params" jsonb,
	"result" jsonb,
	"error" text,
	"exit_code" integer,
	"repair_count" integer NOT NULL DEFAULT 0,
	"repair_tokens" integer NOT NULL DEFAULT 0,
	"repair_session_id" text REFERENCES "session"("id") ON DELETE SET NULL,
	"repaired_version_id" text REFERENCES "rpa_app_version"("id") ON DELETE SET NULL,
	"run_session_id" text REFERENCES "session"("id") ON DELETE SET NULL,
	"time_started" bigint,
	"time_finished" bigint,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rpa_app" ADD CONSTRAINT "rpa_app_status_check" CHECK ("status" IN ('active', 'disabled'));
--> statement-breakpoint
ALTER TABLE "rpa_app_version" ADD CONSTRAINT "rpa_app_version_status_check" CHECK ("status" IN ('candidate', 'active', 'retired'));
--> statement-breakpoint
ALTER TABLE "rpa_app_version" ADD CONSTRAINT "rpa_app_version_source_check" CHECK ("source" IN ('exploration', 'repair', 'manual'));
--> statement-breakpoint
ALTER TABLE "rpa_app_run" ADD CONSTRAINT "rpa_app_run_trigger_check" CHECK ("trigger_type" IN ('api', 'cron', 'manual', 'validate'));
--> statement-breakpoint
ALTER TABLE "rpa_app_run" ADD CONSTRAINT "rpa_app_run_status_check" CHECK ("status" IN ('pending', 'running', 'repairing', 'succeeded', 'failed', 'cancelled'));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rpa_app_version_unique" ON "rpa_app_version" ("app_id", "version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rpa_app_version_status_idx" ON "rpa_app_version" ("app_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rpa_app_project_idx" ON "rpa_app" ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rpa_app_run_app_idx" ON "rpa_app_run" ("app_id", "time_created");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rpa_app_run_status_idx" ON "rpa_app_run" ("status");
