import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261010093947_connector_trigger_schedule",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`connector_trigger_schedule\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`service\` text NOT NULL,
          \`trigger_id\` text NOT NULL,
          \`engine_connection_id\` text NOT NULL,
          \`endpoint_url\` text NOT NULL,
          \`engine_subscription_id\` text,
          \`engine_token_id\` text,
          \`engine_token\` text,
          \`config_json\` text DEFAULT '{}' NOT NULL,
          \`checkpoint_json\` text,
          \`checkpoint_revision\` integer DEFAULT 0 NOT NULL,
          \`next_run_at\` integer NOT NULL,
          \`lease_epoch\` integer DEFAULT 0 NOT NULL,
          \`lease_until\` integer DEFAULT 0 NOT NULL,
          \`status\` text NOT NULL,
          \`wake_seq\` integer DEFAULT 0 NOT NULL,
          \`last_result_json\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`connector_trigger_schedule_session_idx\` ON \`connector_trigger_schedule\` (\`session_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`connector_trigger_schedule_due_idx\` ON \`connector_trigger_schedule\` (\`next_run_at\`);`,
      )
    })
  },
}

export default migration
