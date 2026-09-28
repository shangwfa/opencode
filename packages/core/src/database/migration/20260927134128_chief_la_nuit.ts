import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20260927134128_chief_la_nuit",
  up(tx) {
    return Effect.gen(function* () {
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
      yield* tx.run(`CREATE INDEX \`session_mcps_session_idx\` ON \`session_mcps\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_mcps_session_name_idx\` ON \`session_mcps\` (\`session_id\`,\`name\`);`,
      )
    })
  },
}

export default migration
