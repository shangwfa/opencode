import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261010022744_session_execution_lease",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_execution_lease\` (
          \`session_id\` text PRIMARY KEY,
          \`owner_id\` text NOT NULL,
          \`epoch\` integer NOT NULL,
          \`time_acquired\` integer NOT NULL,
          \`time_expires\` integer NOT NULL,
          CONSTRAINT \`fk_session_execution_lease_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
}

export default migration
