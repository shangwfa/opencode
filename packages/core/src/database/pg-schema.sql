-- 自动生成：上游 sqlite 迁移链的 PG 翻译（dump-pg-schema.ts 产出）
-- 顺序：全部表（无 FK）-> 索引 -> FK 约束
CREATE TABLE "account_state" (
          "id" bigint PRIMARY KEY,
          "active_account_id" text,
          "active_org_id" text
        );
CREATE TABLE "account" (
          "id" text PRIMARY KEY,
          "email" text NOT NULL,
          "url" text NOT NULL,
          "access_token" text NOT NULL,
          "refresh_token" text NOT NULL,
          "token_expiry" bigint,
          "time_created" bigint NOT NULL,
          "time_updated" bigint NOT NULL
        );
CREATE TABLE "control_account" (
          "email" text NOT NULL,
          "url" text NOT NULL,
          "access_token" text NOT NULL,
          "refresh_token" text NOT NULL,
          "token_expiry" bigint,
          "active" bigint NOT NULL,
          "time_created" bigint NOT NULL,
          "time_updated" bigint NOT NULL,
          CONSTRAINT "control_account_pk" PRIMARY KEY("email", "url")
        );
CREATE TABLE "credential" (
          "id" text PRIMARY KEY,
          "integration_id" text,
          "label" text NOT NULL,
          "value" text NOT NULL,
          "connector_id" text,
          "method_id" text,
          "active" bigint,
          "time_created" bigint NOT NULL,
          "time_updated" bigint NOT NULL
        );
CREATE TABLE "event_sequence" (
          "aggregate_id" text PRIMARY KEY,
          "seq" bigint NOT NULL,
          "owner_id" text
        );
CREATE TABLE "event" (
          "id" text PRIMARY KEY,
          "aggregate_id" text NOT NULL,
          "seq" bigint NOT NULL,
          "created" bigint DEFAULT 0 NOT NULL,
          "type" text NOT NULL,
          "data" text NOT NULL
        );
CREATE TABLE "kv" (
          "key" text PRIMARY KEY,
          "value" text NOT NULL,
          "time_created" bigint NOT NULL,
          "time_updated" bigint NOT NULL
        );
CREATE TABLE "permission" (
          "id" text PRIMARY KEY,
          "project_id" text NOT NULL,
          "action" text NOT NULL,
          "resource" text NOT NULL,
          "time_created" bigint NOT NULL,
          "time_updated" bigint NOT NULL
        );
CREATE TABLE "project_directory" (
          "project_id" text NOT NULL,
          "directory" text NOT NULL,
          "type" text,
          "strategy" text,
          "time_created" bigint NOT NULL,
          CONSTRAINT "project_directory_pk" PRIMARY KEY("project_id", "directory")
        );
CREATE TABLE "project" (
          "id" text PRIMARY KEY,
          "worktree" text NOT NULL,
          "vcs" text,
          "name" text,
          "icon_url" text,
          "icon_url_override" text,
          "icon_color" text,
          "time_created" bigint NOT NULL,
          "time_updated" bigint NOT NULL,
          "time_initialized" bigint,
          "sandboxes" text NOT NULL,
          "commands" text
        );
CREATE TABLE "sandbox" (
          "id" text PRIMARY KEY,
          "session_id" text NOT NULL,
          "host" text NOT NULL,
          "state" text NOT NULL,
          "keep_alive" bigint DEFAULT false NOT NULL,
          "command_session_id" text,
          "time_created" bigint NOT NULL,
          "time_updated" bigint NOT NULL
        );
CREATE TABLE "instruction_blob" (
          "hash" text PRIMARY KEY,
          "value" text
        );
CREATE TABLE "instruction_entry" (
          "session_id" text NOT NULL,
          "key" text NOT NULL,
          "value" text,
          "removed" bigint DEFAULT false NOT NULL,
          "time_created" bigint NOT NULL,
          "time_updated" bigint NOT NULL,
          CONSTRAINT "instruction_entry_pk" PRIMARY KEY("session_id", "key")
        );
CREATE TABLE "instruction_state" (
          "session_id" text PRIMARY KEY,
          "epoch_start" bigint NOT NULL,
          "through_seq" bigint NOT NULL,
          "initial_values" text NOT NULL,
          "current_values" text NOT NULL
        );
CREATE TABLE "session_inbox" (
          "id" text PRIMARY KEY,
          "session_id" text NOT NULL,
          "type" text NOT NULL,
          "payload" text NOT NULL,
          "delivery" text NOT NULL,
          "enqueued_seq" bigint NOT NULL,
          "time_created" bigint NOT NULL
        );
CREATE TABLE "session_message" (
          "id" text PRIMARY KEY,
          "session_id" text NOT NULL,
          "type" text NOT NULL,
          "seq" bigint NOT NULL,
          "time_created" bigint NOT NULL,
          "time_updated" bigint NOT NULL,
          "data" text NOT NULL
        );
CREATE TABLE "session_pending" (
          "id" text PRIMARY KEY,
          "session_id" text NOT NULL,
          "type" text NOT NULL,
          "data" text NOT NULL,
          "delivery" text,
          "admitted_seq" bigint NOT NULL,
          "time_created" bigint NOT NULL
        );
CREATE TABLE "session_v2" (
          "id" text PRIMARY KEY,
          "project_id" text NOT NULL,
          "app_id" text,
          "workspace_id" text,
          "parent_id" text,
          "fork_session_id" text,
          "fork_boundary" text,
          "slug" text NOT NULL,
          "directory" text NOT NULL,
          "path" text,
          "title" text,
          "version" text NOT NULL,
          "share_url" text,
          "summary_additions" bigint,
          "summary_deletions" bigint,
          "summary_files" bigint,
          "summary_diffs" text,
          "metadata" text,
          "sandbox" text,
          "cost" double precision DEFAULT 0 NOT NULL,
          "tokens_input" bigint DEFAULT 0 NOT NULL,
          "tokens_output" bigint DEFAULT 0 NOT NULL,
          "tokens_reasoning" bigint DEFAULT 0 NOT NULL,
          "tokens_cache_read" bigint DEFAULT 0 NOT NULL,
          "tokens_cache_write" bigint DEFAULT 0 NOT NULL,
          "revert" text,
          "permission" text,
          "agent" text,
          "model" text,
          "time_created" bigint NOT NULL,
          "time_updated" bigint NOT NULL,
          "time_idle" bigint,
          "time_viewed" bigint,
          "idle_outcome" text,
          "time_compacting" bigint,
          "time_archived" bigint,
          "time_suspended" bigint,
          "resume_attempts" bigint DEFAULT 0 NOT NULL
        );
CREATE TABLE "workspace" (
          "id" text PRIMARY KEY,
          "provider" text NOT NULL,
          "binding" text,
          "created_at" bigint NOT NULL,
          "last_used_at" bigint NOT NULL
        );
CREATE TABLE "worktree" (
          "project_id" text NOT NULL,
          "directory" text NOT NULL,
          "strategy" text,
          "time_created" bigint NOT NULL,
          CONSTRAINT "worktree_pk" PRIMARY KEY("project_id", "directory")
        );
CREATE TABLE "migration" (id TEXT PRIMARY KEY, time_completed bigint NOT NULL);

CREATE UNIQUE INDEX "event_aggregate_seq_idx" ON "event" ("aggregate_id","seq");
CREATE INDEX "event_aggregate_type_seq_idx" ON "event" ("aggregate_id","type","seq");
CREATE UNIQUE INDEX "permission_project_action_resource_idx" ON "permission" ("project_id","action","resource");
CREATE UNIQUE INDEX "sandbox_session_id_idx" ON "sandbox" ("session_id");
CREATE INDEX "sandbox_state_time_updated_idx" ON "sandbox" ("state","time_updated");
CREATE INDEX "session_inbox_session_delivery_seq_idx" ON "session_inbox" ("session_id","delivery","enqueued_seq");
CREATE UNIQUE INDEX "session_inbox_session_enqueued_seq_idx" ON "session_inbox" ("session_id","enqueued_seq");
CREATE UNIQUE INDEX "session_message_session_seq_idx" ON "session_message" ("session_id","seq");
CREATE INDEX "session_message_session_type_seq_idx" ON "session_message" ("session_id","type","seq");
CREATE INDEX "session_message_session_time_created_id_idx" ON "session_message" ("session_id","time_created","id");
CREATE INDEX "session_message_time_created_idx" ON "session_message" ("time_created");
CREATE INDEX "session_pending_session_delivery_seq_idx" ON "session_pending" ("session_id","delivery","admitted_seq");
CREATE UNIQUE INDEX "session_pending_session_compaction_idx" ON "session_pending" ("session_id") WHERE "session_pending"."type" = 'compaction';
CREATE UNIQUE INDEX "session_pending_session_admitted_seq_idx" ON "session_pending" ("session_id","admitted_seq");
CREATE INDEX "session_v2_project_idx" ON "session_v2" ("project_id");
CREATE INDEX "session_v2_app_id_idx" ON "session_v2" ("app_id");
CREATE INDEX "session_v2_workspace_idx" ON "session_v2" ("workspace_id");
CREATE INDEX "session_v2_parent_idx" ON "session_v2" ("parent_id");
CREATE INDEX "session_v2_time_suspended_idx" ON "session_v2" ("time_suspended") WHERE "session_v2"."time_suspended" is not null;

ALTER TABLE "account_state" ADD CONSTRAINT "fk_account_state_active_account_id_account_id_fk" FOREIGN KEY ("active_account_id") REFERENCES "account"("id") ON DELETE SET NULL;
ALTER TABLE "event" ADD CONSTRAINT "fk_event_aggregate_id_event_sequence_aggregate_id_fk" FOREIGN KEY ("aggregate_id") REFERENCES "event_sequence"("aggregate_id") ON DELETE CASCADE;
ALTER TABLE "permission" ADD CONSTRAINT "fk_permission_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;
ALTER TABLE "project_directory" ADD CONSTRAINT "fk_project_directory_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;
ALTER TABLE "instruction_entry" ADD CONSTRAINT "fk_instruction_entry_session_id_session_v2_id_fk" FOREIGN KEY ("session_id") REFERENCES "session_v2"("id") ON DELETE CASCADE;
ALTER TABLE "instruction_state" ADD CONSTRAINT "fk_instruction_state_session_id_session_v2_id_fk" FOREIGN KEY ("session_id") REFERENCES "session_v2"("id") ON DELETE CASCADE;
ALTER TABLE "session_inbox" ADD CONSTRAINT "fk_session_inbox_session_id_session_v2_id_fk" FOREIGN KEY ("session_id") REFERENCES "session_v2"("id") ON DELETE CASCADE;
ALTER TABLE "session_message" ADD CONSTRAINT "fk_session_message_session_id_session_v2_id_fk" FOREIGN KEY ("session_id") REFERENCES "session_v2"("id") ON DELETE CASCADE;
ALTER TABLE "session_pending" ADD CONSTRAINT "fk_session_pending_session_id_session_v2_id_fk" FOREIGN KEY ("session_id") REFERENCES "session_v2"("id") ON DELETE CASCADE;
ALTER TABLE "session_v2" ADD CONSTRAINT "fk_session_v2_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;
ALTER TABLE "worktree" ADD CONSTRAINT "fk_worktree_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;
