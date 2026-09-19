-- session_snapshot 扩展：血缘/兼容性元数据 + 消费计数（已发布库走 ADD COLUMN 增量）
ALTER TABLE "session_snapshot" ADD COLUMN IF NOT EXISTS "image" text;
--> statement-breakpoint
ALTER TABLE "session_snapshot" ADD COLUMN IF NOT EXISTS "source_sandbox_id" text;
--> statement-breakpoint
ALTER TABLE "session_snapshot" ADD COLUMN IF NOT EXISTS "arch" text;
--> statement-breakpoint
ALTER TABLE "session_snapshot" ADD COLUMN IF NOT EXISTS "schema_version" integer;
--> statement-breakpoint
ALTER TABLE "session_snapshot" ADD COLUMN IF NOT EXISTS "runtime_version" text;
--> statement-breakpoint
ALTER TABLE "session_snapshot" ADD COLUMN IF NOT EXISTS "restored_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "session_snapshot" ADD COLUMN IF NOT EXISTS "last_restored_at" bigint;
--> statement-breakpoint
-- 快照编排操作队列（durable job：租约 + fencing + 幂等唯一索引）
CREATE TABLE IF NOT EXISTS "snapshot_operation" (
  "id" text PRIMARY KEY NOT NULL,
  "session_id" text NOT NULL,
  "sandbox_id" text,
  "kind" text NOT NULL,
  "state" text NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_retry_at" bigint,
  "lease_owner" text,
  "lease_until" bigint,
  "fencing_token" bigint DEFAULT 0 NOT NULL,
  "error" text,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "snapshot_operation_claim_idx" ON "snapshot_operation" ("state","next_retry_at");
CREATE INDEX IF NOT EXISTS "snapshot_operation_session_idx" ON "snapshot_operation" ("session_id","time_created");
CREATE UNIQUE INDEX IF NOT EXISTS "snapshot_operation_active_uniq" ON "snapshot_operation" ("session_id","sandbox_id","kind") WHERE "state" IN ('pending', 'running');
