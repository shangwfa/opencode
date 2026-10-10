import { Effect } from "effect"
import type { DatabaseMigration } from "./migration.js"

const schema: Omit<DatabaseMigration.Migration, "id"> = {
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_snapshot\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text,
          \`scope\` text NOT NULL,
          \`state\` text NOT NULL,
          \`reason\` text,
          \`image\` text,
          \`source_sandbox_id\` text,
          \`arch\` text,
          \`schema_version\` integer,
          \`runtime_version\` text,
          \`manifest_token\` text,
          \`restored_count\` integer DEFAULT 0 NOT NULL,
          \`last_restored_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`snapshot_operation\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`sandbox_id\` text,
          \`kind\` text NOT NULL,
          \`state\` text NOT NULL,
          \`attempts\` integer DEFAULT 0 NOT NULL,
          \`next_retry_at\` integer,
          \`lease_owner\` text,
          \`lease_until\` integer,
          \`fencing_token\` integer DEFAULT 0 NOT NULL,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`snapshot_refresh_operation\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`sandbox_id\` text,
          \`kind\` text NOT NULL,
          \`state\` text NOT NULL,
          \`attempts\` integer DEFAULT 0 NOT NULL,
          \`next_retry_at\` integer,
          \`lease_owner\` text,
          \`lease_until\` integer,
          \`fencing_token\` integer DEFAULT 0 NOT NULL,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account_state\` (
          \`id\` integer PRIMARY KEY,
          \`active_account_id\` text,
          \`active_org_id\` text,
          CONSTRAINT \`fk_account_state_active_account_id_account_id_fk\` FOREIGN KEY (\`active_account_id\`) REFERENCES \`account\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account\` (
          \`id\` text PRIMARY KEY,
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`control_account\` (
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`active\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`control_account_pk\` PRIMARY KEY(\`email\`, \`url\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`credential\` (
          \`id\` text PRIMARY KEY,
          \`integration_id\` text,
          \`label\` text NOT NULL,
          \`value\` text NOT NULL,
          \`connector_id\` text,
          \`method_id\` text,
          \`active\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event_sequence\` (
          \`aggregate_id\` text PRIMARY KEY,
          \`seq\` integer NOT NULL,
          \`owner_id\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event\` (
          \`id\` text PRIMARY KEY,
          \`aggregate_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`created\` integer DEFAULT 0 NOT NULL,
          \`type\` text NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_event_aggregate_id_event_sequence_aggregate_id_fk\` FOREIGN KEY (\`aggregate_id\`) REFERENCES \`event_sequence\`(\`aggregate_id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`hitl_request\` (
          \`id\` text PRIMARY KEY,
          \`kind\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`payload\` text NOT NULL,
          \`decision\` text DEFAULT 'pending' NOT NULL,
          \`result\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_hitl_request_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`kv\` (
          \`key\` text PRIMARY KEY,
          \`value\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`log\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`source\` text NOT NULL,
          \`detail\` text,
          \`trace_id\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_log_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`permission\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_permission_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_permission_approval\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`source_request_id\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_permission_approval_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_directory\` (
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`type\` text,
          \`strategy\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`project_directory_pk\` PRIMARY KEY(\`project_id\`, \`directory\`),
          CONSTRAINT \`fk_project_directory_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project\` (
          \`id\` text PRIMARY KEY,
          \`worktree\` text NOT NULL,
          \`vcs\` text,
          \`name\` text,
          \`icon_url\` text,
          \`icon_url_override\` text,
          \`icon_color\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_initialized\` integer,
          \`sandboxes\` text NOT NULL,
          \`commands\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`sandbox\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`host\` text NOT NULL,
          \`state\` text NOT NULL,
          \`keep_alive\` integer DEFAULT false NOT NULL,
          \`command_session_id\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`instruction_blob\` (
          \`hash\` text PRIMARY KEY,
          \`value\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`instruction_entry\` (
          \`session_id\` text NOT NULL,
          \`key\` text NOT NULL,
          \`value\` text,
          \`removed\` integer DEFAULT false NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`instruction_entry_pk\` PRIMARY KEY(\`session_id\`, \`key\`),
          CONSTRAINT \`fk_instruction_entry_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`instruction_state\` (
          \`session_id\` text PRIMARY KEY,
          \`epoch_start\` integer NOT NULL,
          \`through_seq\` integer NOT NULL,
          \`initial_values\` text NOT NULL,
          \`current_values\` text NOT NULL,
          CONSTRAINT \`fk_instruction_state_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`sandbox_execution_gate\` (
          \`root_session_id\` text PRIMARY KEY,
          \`epoch\` integer DEFAULT 1 NOT NULL,
          \`state\` text DEFAULT 'open' NOT NULL,
          \`sandbox_id\` text,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_agents\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`agent_id\` text NOT NULL,
          \`config\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_agents_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_agents_md\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`content\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_agents_md_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_commands\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`description\` text,
          \`template\` text NOT NULL,
          \`agent\` text,
          \`model\` text,
          \`subagent\` integer,
          \`hints\` text DEFAULT '[]' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_commands_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_execution_gate\` (
          \`session_id\` text PRIMARY KEY,
          \`root_session_id\` text NOT NULL,
          \`epoch\` integer DEFAULT 1 NOT NULL,
          \`state\` text DEFAULT 'open' NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_execution_lease\` (
          \`session_id\` text PRIMARY KEY,
          \`owner_id\` text NOT NULL,
          \`epoch\` integer NOT NULL,
          \`time_acquired\` integer NOT NULL,
          \`time_expires\` integer NOT NULL,
          CONSTRAINT \`fk_session_execution_lease_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_inbox\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`payload\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`enqueued_seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_inbox_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_mcps\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`config\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_mcps_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_session_message_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_pending\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`data\` text NOT NULL,
          \`delivery\` text,
          \`admitted_seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_pending_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_plugins\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`description\` text NOT NULL,
          \`source\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_plugins_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_skills\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`skill_id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`description\` text,
          \`autoinvoke\` integer,
          \`content\` text NOT NULL,
          \`resources\` text DEFAULT '[]' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_skills_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_v2\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`app_id\` text,
          \`pvc_mode\` text,
          \`workspace_id\` text,
          \`parent_id\` text,
          \`fork_session_id\` text,
          \`fork_boundary\` text,
          \`slug\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`path\` text,
          \`title\` text,
          \`version\` text NOT NULL,
          \`share_url\` text,
          \`summary_additions\` integer,
          \`summary_deletions\` integer,
          \`summary_files\` integer,
          \`summary_diffs\` text,
          \`metadata\` text,
          \`sandbox\` text,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`revert\` text,
          \`permission\` text,
          \`agent\` text,
          \`model\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_idle\` integer,
          \`time_viewed\` integer,
          \`idle_outcome\` text,
          \`time_compacting\` integer,
          \`time_archived\` integer,
          \`time_suspended\` integer,
          \`resume_attempts\` integer DEFAULT 0 NOT NULL,
          CONSTRAINT \`fk_session_v2_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_tools\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`description\` text NOT NULL,
          \`code\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_tools_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`workspace\` (
          \`id\` text PRIMARY KEY,
          \`provider\` text NOT NULL,
          \`binding\` text,
          \`created_at\` integer NOT NULL,
          \`last_used_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`worktree\` (
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`strategy\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`worktree_pk\` PRIMARY KEY(\`project_id\`, \`directory\`),
          CONSTRAINT \`fk_worktree_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`session_snapshot_session_idx\` ON \`session_snapshot\` (\`session_id\`,\`state\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_snapshot_creating_uniq\` ON \`session_snapshot\` (\`session_id\`,\`scope\`) WHERE "session_snapshot"."state" = 'creating';`,
      )
      yield* tx.run(
        `CREATE INDEX \`snapshot_operation_claim_idx\` ON \`snapshot_operation\` (\`state\`,\`next_retry_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`snapshot_operation_session_idx\` ON \`snapshot_operation\` (\`session_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`snapshot_operation_active_uniq\` ON \`snapshot_operation\` (\`session_id\`,\`sandbox_id\`,\`kind\`) WHERE "snapshot_operation"."state" in ('pending', 'running');`,
      )
      yield* tx.run(
        `CREATE INDEX \`snapshot_refresh_operation_claim_idx\` ON \`snapshot_refresh_operation\` (\`state\`,\`next_retry_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`snapshot_refresh_operation_session_idx\` ON \`snapshot_refresh_operation\` (\`session_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`snapshot_refresh_operation_active_uniq\` ON \`snapshot_refresh_operation\` (\`session_id\`,\`sandbox_id\`,\`kind\`) WHERE "snapshot_refresh_operation"."state" in ('pending', 'running');`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`event_aggregate_type_seq_idx\` ON \`event\` (\`aggregate_id\`,\`type\`,\`seq\`);`)
      yield* tx.run(
        `CREATE INDEX \`hitl_request_session_pending_idx\` ON \`hitl_request\` (\`session_id\`,\`decision\`);`,
      )
      yield* tx.run(`CREATE INDEX \`hitl_request_decision_idx\` ON \`hitl_request\` (\`decision\`);`)
      yield* tx.run(`CREATE INDEX \`log_session_time_idx\` ON \`log\` (\`session_id\`,\`time_created\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`permission_project_action_resource_idx\` ON \`permission\` (\`project_id\`,\`action\`,\`resource\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_permission_approval_scope_idx\` ON \`session_permission_approval\` (\`session_id\`,\`action\`,\`resource\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`sandbox_session_id_idx\` ON \`sandbox\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`sandbox_state_time_updated_idx\` ON \`sandbox\` (\`state\`,\`time_updated\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_agents_session_agent_idx\` ON \`session_agents\` (\`session_id\`,\`agent_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_agents_md_session_unique_idx\` ON \`session_agents_md\` (\`session_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_commands_session_idx\` ON \`session_commands\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_commands_session_name_idx\` ON \`session_commands\` (\`session_id\`,\`name\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_inbox_session_delivery_seq_idx\` ON \`session_inbox\` (\`session_id\`,\`delivery\`,\`enqueued_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_inbox_session_enqueued_seq_idx\` ON \`session_inbox\` (\`session_id\`,\`enqueued_seq\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_mcps_session_idx\` ON \`session_mcps\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_mcps_session_name_idx\` ON \`session_mcps\` (\`session_id\`,\`name\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`,\`type\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_time_created_id_idx\` ON \`session_message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_message_time_created_idx\` ON \`session_message\` (\`time_created\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_pending_session_delivery_seq_idx\` ON \`session_pending\` (\`session_id\`,\`delivery\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_pending_session_compaction_idx\` ON \`session_pending\` (\`session_id\`) WHERE "session_pending"."type" = 'compaction';`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_pending_session_admitted_seq_idx\` ON \`session_pending\` (\`session_id\`,\`admitted_seq\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_plugins_session_idx\` ON \`session_plugins\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_plugins_session_name_idx\` ON \`session_plugins\` (\`session_id\`,\`name\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_skills_session_idx\` ON \`session_skills\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_skills_session_skill_idx\` ON \`session_skills\` (\`session_id\`,\`skill_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_v2_project_idx\` ON \`session_v2\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_v2_app_id_idx\` ON \`session_v2\` (\`app_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_v2_workspace_idx\` ON \`session_v2\` (\`workspace_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_v2_parent_idx\` ON \`session_v2\` (\`parent_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_v2_time_suspended_idx\` ON \`session_v2\` (\`time_suspended\`) WHERE "session_v2"."time_suspended" is not null;`,
      )
      yield* tx.run(`CREATE INDEX \`session_tools_session_idx\` ON \`session_tools\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_tools_session_name_idx\` ON \`session_tools\` (\`session_id\`,\`name\`);`,
      )
    })
  },
}

export default schema
