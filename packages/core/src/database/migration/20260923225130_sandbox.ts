import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20260923225130_sandbox",
  up(tx) {
    return Effect.gen(function* () {
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
      yield* tx.run(`CREATE UNIQUE INDEX \`sandbox_session_id_idx\` ON \`sandbox\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`sandbox_state_time_updated_idx\` ON \`sandbox\` (\`state\`,\`time_updated\`);`)
    })
  },
}

export default migration
