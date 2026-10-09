import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261009055437_dazzling_black_tarantula",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`log\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`source\` text NOT NULL,
          \`detail\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_log_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`log_session_time_idx\` ON \`log\` (\`session_id\`,\`time_created\`);`)
    })
  },
}

export default migration
