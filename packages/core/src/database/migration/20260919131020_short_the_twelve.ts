import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20260919131020_short_the_twelve",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`exec_log\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`command\` text NOT NULL,
          \`working_directory\` text,
          \`status\` text NOT NULL,
          \`exit_code\` integer,
          \`stdout\` text,
          \`stderr\` text,
          \`error\` text,
          \`rule\` text,
          \`trace_id\` text,
          \`source\` text NOT NULL,
          \`time_started\` integer NOT NULL,
          \`time_finished\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_exec_log_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`hitl_request\` (
          \`id\` text PRIMARY KEY,
          \`kind\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`user_id\` text DEFAULT '' NOT NULL,
          \`session_id\` text NOT NULL,
          \`owner_id\` text NOT NULL,
          \`status\` text NOT NULL,
          \`payload\` text NOT NULL,
          \`result\` text,
          \`close_reason\` text,
          \`lease_until\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_hitl_request_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`app_id\` text;`)
      yield* tx.run(`ALTER TABLE \`workspace\` ADD \`resource\` text;`)
      yield* tx.run(`CREATE INDEX \`exec_log_session_idx\` ON \`exec_log\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`hitl_pending_idx\` ON \`hitl_request\` (\`directory\`,\`user_id\`,\`kind\`,\`status\`,\`lease_until\`);`,
      )
      yield* tx.run(`CREATE INDEX \`hitl_session_idx\` ON \`hitl_request\` (\`directory\`,\`session_id\`,\`status\`);`)
      yield* tx.run(`CREATE INDEX \`hitl_retention_idx\` ON \`hitl_request\` (\`status\`,\`time_updated\`);`)
    })
  },
}

export default migration
