-- v1 exec_log 的 v2 侧迁移（与 v1 表结构完全一致：表名/列/枚举/索引）。
-- 命令执行与权限拒绝的审计轨迹；source=permission-deny 记录 deny 规则命中。
CREATE TABLE "exec_log" (
  "id" text PRIMARY KEY,
  "session_id" text NOT NULL,
  "command" text NOT NULL,
  "working_directory" text,
  "status" text NOT NULL,
  "exit_code" integer,
  "stdout" text,
  "stderr" text,
  "error" text,
  "rule" text,
  "trace_id" text,
  "source" text NOT NULL,
  "time_started" bigint NOT NULL,
  "time_finished" bigint,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL
);

--> statement-breakpoint

ALTER TABLE "exec_log" ADD CONSTRAINT "exec_log_session_id_session_v2_id_fk" FOREIGN KEY ("session_id") REFERENCES "session_v2"("id") ON DELETE cascade;

--> statement-breakpoint

CREATE INDEX "exec_log_session_idx" ON "exec_log" ("session_id");
