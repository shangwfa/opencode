import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261002090000_session_snapshot",
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
          \`restored_count\` integer DEFAULT 0 NOT NULL,
          \`last_restored_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_snapshot_session_idx\` ON \`session_snapshot\` (\`session_id\`, \`state\`);`,
      )
    })
  },
}

export default migration
