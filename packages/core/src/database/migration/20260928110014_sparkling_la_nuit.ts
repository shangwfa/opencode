import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20260928110014_sparkling_la_nuit",
  up(tx) {
    return Effect.gen(function* () {
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
      yield* tx.run(`CREATE INDEX \`session_tools_session_idx\` ON \`session_tools\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_tools_session_name_idx\` ON \`session_tools\` (\`session_id\`,\`name\`);`,
      )
    })
  },
}

export default migration
