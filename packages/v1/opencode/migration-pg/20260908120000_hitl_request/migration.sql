-- HITL (human-in-the-loop) request store: question / permission pending
-- rows survive instance restarts; leases prevent cross-instance double
-- delivery. user_id scopes each request to the requesting identity so
-- tenants only see and answer their own approvals ('' = public/anonymous).
-- One-shot hardened shape (merged from the former two-step create-then-harden
-- migrations): NOT NULL lease_until, session FK with cascade delete, enum
-- CHECKs, directory+user scoped indexes. Every statement is idempotent so
-- replaying on databases that already applied either historical migration is
-- a no-op.
CREATE TABLE IF NOT EXISTS "hitl_request" (
	"id" text PRIMARY KEY,
	"kind" text NOT NULL,
	"directory" text NOT NULL,
	"user_id" text NOT NULL DEFAULT '',
	"session_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"status" text NOT NULL,
	"payload" jsonb NOT NULL,
	"result" jsonb,
	"close_reason" text,
	"lease_until" bigint NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL,
	CONSTRAINT "hitl_session_fk" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE,
	CONSTRAINT "hitl_kind_check" CHECK ("kind" IN ('question', 'permission')),
	CONSTRAINT "hitl_status_check" CHECK ("status" IN ('pending', 'replied', 'rejected', 'closed')),
	CONSTRAINT "hitl_close_reason_check" CHECK ("close_reason" IS NULL OR "close_reason" IN ('instance-restart', 'shutdown', 'answered-delivered', 'decision-delivered'))
);
--> statement-breakpoint
ALTER TABLE "hitl_request" ADD COLUMN IF NOT EXISTS "user_id" text NOT NULL DEFAULT '';
--> statement-breakpoint
DROP INDEX IF EXISTS "hitl_pending_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hitl_pending_idx" ON "hitl_request" ("directory", "user_id", "kind", "status", "lease_until");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hitl_session_idx" ON "hitl_request" ("directory", "session_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hitl_retention_idx" ON "hitl_request" ("status", "time_updated");
