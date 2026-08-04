CREATE TABLE IF NOT EXISTS "schedule" (
	"id" text PRIMARY KEY,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"cron" text NOT NULL,
	"enabled" boolean NOT NULL DEFAULT true,
	"payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"last_run_at" bigint,
	"next_run_at" bigint,
	"run_count" integer NOT NULL DEFAULT 0,
	"last_error" text,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedule_next_run_idx" ON "schedule" ("next_run_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedule_owner_idx" ON "schedule" ("owner_type", "owner_id");
