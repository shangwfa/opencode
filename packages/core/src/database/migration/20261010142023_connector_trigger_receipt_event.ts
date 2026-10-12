import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261010142023_connector_trigger_receipt_event",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`connector_trigger_event\` (
          \`id\` text PRIMARY KEY,
          \`schedule_id\` text NOT NULL,
          \`delivery_key\` text NOT NULL,
          \`payload_json\` text NOT NULL,
          \`delivered_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`connector_trigger_receipt\` (
          \`id\` text PRIMARY KEY,
          \`schedule_id\` text NOT NULL,
          \`received_at\` integer NOT NULL,
          \`dedup_key\` text NOT NULL,
          \`body_base64\` text NOT NULL,
          \`headers_json\` text NOT NULL,
          \`state\` text NOT NULL,
          \`engine_result_json\` text,
          \`checkpoint_json\` text,
          \`attempts\` integer DEFAULT 0 NOT NULL,
          \`next_retry_at\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`connector_trigger_event_delivery_uq\` ON \`connector_trigger_event\` (\`schedule_id\`,\`delivery_key\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`connector_trigger_event_schedule_idx\` ON \`connector_trigger_event\` (\`schedule_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`connector_trigger_receipt_dedup_uq\` ON \`connector_trigger_receipt\` (\`schedule_id\`,\`dedup_key\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`connector_trigger_receipt_retry_idx\` ON \`connector_trigger_receipt\` (\`state\`,\`next_retry_at\`);`,
      )
    })
  },
}

export default migration
