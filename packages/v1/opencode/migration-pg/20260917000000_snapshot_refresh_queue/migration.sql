CREATE TABLE IF NOT EXISTS "snapshot_refresh_operation" (
  "id" text PRIMARY KEY,
  "session_id" text NOT NULL,
  "sandbox_id" text,
  "kind" text NOT NULL CHECK ("kind" = 'snapshot_refresh'),
  "state" text NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "next_retry_at" bigint,
  "lease_owner" text,
  "lease_until" bigint,
  "fencing_token" bigint NOT NULL DEFAULT 0,
  "error" text,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "snapshot_refresh_operation_claim_idx" ON "snapshot_refresh_operation" ("state", "next_retry_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "snapshot_refresh_operation_session_idx" ON "snapshot_refresh_operation" ("session_id", "time_created");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "snapshot_refresh_operation_active_uniq" ON "snapshot_refresh_operation" ("session_id", "sandbox_id", "kind") WHERE "state" IN ('pending', 'running');
