-- v1 hitl_request 的 v2 侧迁移（与 v1 表结构完全一致：表名/列/枚举/索引）。
-- v2 的 form 问询落 kind=question，权限审批落 kind=permission；pending 经 CAS 迁移到终态。
CREATE TABLE "hitl_request" (
  "id" text PRIMARY KEY,
  "kind" text NOT NULL,
  "directory" text NOT NULL,
  "user_id" text NOT NULL DEFAULT '',
  "session_id" text NOT NULL,
  "owner_id" text NOT NULL,
  "status" text NOT NULL,
  "payload" text NOT NULL,
  "result" text,
  "close_reason" text,
  "lease_until" bigint NOT NULL,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL
);

--> statement-breakpoint

ALTER TABLE "hitl_request" ADD CONSTRAINT "hitl_session_id_session_v2_id_fk" FOREIGN KEY ("session_id") REFERENCES "session_v2"("id") ON DELETE cascade;

--> statement-breakpoint

CREATE INDEX "hitl_pending_idx" ON "hitl_request" ("directory", "user_id", "kind", "status", "lease_until");

--> statement-breakpoint

CREATE INDEX "hitl_session_idx" ON "hitl_request" ("directory", "session_id", "status");

--> statement-breakpoint

CREATE INDEX "hitl_retention_idx" ON "hitl_request" ("status", "time_updated");
