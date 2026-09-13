CREATE TABLE IF NOT EXISTS "hitl_request" (
	"id" text PRIMARY KEY,
	"kind" text NOT NULL,
	"directory" text NOT NULL,
	"session_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"status" text NOT NULL,
	"payload" jsonb NOT NULL,
	"result" jsonb,
	"close_reason" text,
	"lease_until" bigint,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hitl_pending_idx" ON "hitl_request" ("status","lease_until");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hitl_session_idx" ON "hitl_request" ("session_id");
