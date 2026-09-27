import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20260925133852_session_agents",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_agents\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`agent_id\` text NOT NULL,
          \`config\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_agents_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_agents_session_agent_idx\` ON \`session_agents\` (\`session_id\`,\`agent_id\`);`,
      )
    })
  },
}

export default migration
