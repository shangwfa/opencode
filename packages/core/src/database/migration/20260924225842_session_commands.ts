import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20260924225842_session_commands",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_commands\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`description\` text,
          \`template\` text NOT NULL,
          \`agent\` text,
          \`model\` text,
          \`subagent\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_commands_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`session_commands_session_idx\` ON \`session_commands\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_commands_session_name_idx\` ON \`session_commands\` (\`session_id\`,\`name\`);`,
      )
    })
  },
}

export default migration
