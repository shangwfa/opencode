import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261002034731_snapshot_operations",
  up(tx) {
    return Effect.gen(function* () {
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
    })
  },
}

export default migration
