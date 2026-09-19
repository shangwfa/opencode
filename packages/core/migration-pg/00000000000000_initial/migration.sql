CREATE TABLE "account_state" (
          "id" bigint PRIMARY KEY,
          "active_account_id" text,
          "active_org_id" text
        );

--> statement-breakpoint

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

--> statement-breakpoint

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

--> statement-breakpoint

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

--> statement-breakpoint

CREATE TABLE "event_sequence" (
          "aggregate_id" text PRIMARY KEY,
          "seq" bigint NOT NULL,
          "owner_id" text
        );

--> statement-breakpoint

CREATE TABLE "event" (
          "id" text PRIMARY KEY,
          "aggregate_id" text NOT NULL,
          "seq" bigint NOT NULL,
          "created" bigint DEFAULT 0 NOT NULL,
          "type" text NOT NULL,
          "data" text NOT NULL
        );

--> statement-breakpoint

CREATE TABLE "kv" (
          "key" text PRIMARY KEY,
          "value" text NOT NULL,
          "time_created" bigint NOT NULL,
          "time_updated" bigint NOT NULL
        );

--> statement-breakpoint

CREATE TABLE "permission" (
          "id" text PRIMARY KEY,
          "project_id" text NOT NULL,
          "action" text NOT NULL,
          "resource" text NOT NULL,
          "time_created" bigint NOT NULL,
          "time_updated" bigint NOT NULL
        );

--> statement-breakpoint

CREATE TABLE "project_directory" (
          "project_id" text NOT NULL,
          "directory" text NOT NULL,
          "type" text,
          "strategy" text,
          "time_created" bigint NOT NULL,
          CONSTRAINT "project_directory_pk" PRIMARY KEY("project_id", "directory")
        );

--> statement-breakpoint

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

--> statement-breakpoint

CREATE TABLE "instruction_blob" (
          "hash" text PRIMARY KEY,
          "value" text
        );

--> statement-breakpoint

CREATE TABLE "instruction_entry" (
          "session_id" text NOT NULL,
          "key" text NOT NULL,
          "value" text,
          "removed" bigint DEFAULT 0 NOT NULL,
          "time_created" bigint NOT NULL,
          "time_updated" bigint NOT NULL,
          CONSTRAINT "instruction_entry_pk" PRIMARY KEY("session_id", "key")
        );

--> statement-breakpoint

CREATE TABLE "instruction_state" (
          "session_id" text PRIMARY KEY,
          "epoch_start" bigint NOT NULL,
          "through_seq" bigint NOT NULL,
          "initial_values" text NOT NULL,
          "current_values" text NOT NULL
        );

--> statement-breakpoint

CREATE TABLE "session_inbox" (
          "id" text PRIMARY KEY,
          "session_id" text NOT NULL,
          "type" text NOT NULL,
          "payload" text NOT NULL,
          "delivery" text NOT NULL,
          "enqueued_seq" bigint NOT NULL,
          "time_created" bigint NOT NULL
        );

--> statement-breakpoint

CREATE TABLE "session_message" (
          "id" text PRIMARY KEY,
          "session_id" text NOT NULL,
          "type" text NOT NULL,
          "seq" bigint NOT NULL,
          "time_created" bigint NOT NULL,
          "time_updated" bigint NOT NULL,
          "data" text NOT NULL
        );

--> statement-breakpoint

CREATE TABLE "session_pending" (
          "id" text PRIMARY KEY,
          "session_id" text NOT NULL,
          "type" text NOT NULL,
          "data" text NOT NULL,
          "delivery" text,
          "admitted_seq" bigint NOT NULL,
          "time_created" bigint NOT NULL
        );

--> statement-breakpoint

CREATE TABLE "session_v2" (
          "id" text PRIMARY KEY,
          "project_id" text NOT NULL,
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
          "cost" real DEFAULT 0 NOT NULL,
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

--> statement-breakpoint

CREATE TABLE "workspace" (
          "id" text PRIMARY KEY,
          "provider" text NOT NULL,
          "binding" text,
          "created_at" bigint NOT NULL,
          "last_used_at" bigint NOT NULL
        );

--> statement-breakpoint

CREATE TABLE "worktree" (
          "project_id" text NOT NULL,
          "directory" text NOT NULL,
          "strategy" text,
          "time_created" bigint NOT NULL,
          CONSTRAINT "worktree_pk" PRIMARY KEY("project_id", "directory")
        );

--> statement-breakpoint

ALTER TABLE "account_state" ADD CONSTRAINT "fk_account_state_active_account_id_account_id_fk" FOREIGN KEY ("active_account_id") REFERENCES "account"("id") ON DELETE SET NULL

--> statement-breakpoint

ALTER TABLE "event" ADD CONSTRAINT "fk_event_aggregate_id_event_sequence_aggregate_id_fk" FOREIGN KEY ("aggregate_id") REFERENCES "event_sequence"("aggregate_id") ON DELETE CASCADE

--> statement-breakpoint

ALTER TABLE "permission" ADD CONSTRAINT "fk_permission_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE

--> statement-breakpoint

ALTER TABLE "project_directory" ADD CONSTRAINT "fk_project_directory_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE

--> statement-breakpoint

ALTER TABLE "instruction_entry" ADD CONSTRAINT "fk_instruction_entry_session_id_session_v2_id_fk" FOREIGN KEY ("session_id") REFERENCES "session_v2"("id") ON DELETE CASCADE

--> statement-breakpoint

ALTER TABLE "instruction_state" ADD CONSTRAINT "fk_instruction_state_session_id_session_v2_id_fk" FOREIGN KEY ("session_id") REFERENCES "session_v2"("id") ON DELETE CASCADE

--> statement-breakpoint

ALTER TABLE "session_inbox" ADD CONSTRAINT "fk_session_inbox_session_id_session_v2_id_fk" FOREIGN KEY ("session_id") REFERENCES "session_v2"("id") ON DELETE CASCADE

--> statement-breakpoint

ALTER TABLE "session_message" ADD CONSTRAINT "fk_session_message_session_id_session_v2_id_fk" FOREIGN KEY ("session_id") REFERENCES "session_v2"("id") ON DELETE CASCADE

--> statement-breakpoint

ALTER TABLE "session_pending" ADD CONSTRAINT "fk_session_pending_session_id_session_v2_id_fk" FOREIGN KEY ("session_id") REFERENCES "session_v2"("id") ON DELETE CASCADE

--> statement-breakpoint

ALTER TABLE "session_v2" ADD CONSTRAINT "fk_session_v2_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE

--> statement-breakpoint

ALTER TABLE "worktree" ADD CONSTRAINT "fk_worktree_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE
