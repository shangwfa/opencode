import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261026114630_e2b_snapshot",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`e2b_snapshot\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`provider_scope\` text NOT NULL,
          \`sandbox_id\` text NOT NULL,
          \`remote_name\` text NOT NULL,
          \`snapshot_id\` text,
          \`state\` text NOT NULL,
          \`restored_count\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`e2b_snapshot_session_idx\` ON \`e2b_snapshot\` (\`session_id\`,\`time_created\`);`)
    })
  },
}

export default migration
