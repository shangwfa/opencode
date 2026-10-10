import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261010025311_hitl_request",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`hitl_request\` (
          \`id\` text PRIMARY KEY,
          \`kind\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`payload\` text NOT NULL,
          \`decision\` text DEFAULT 'pending' NOT NULL,
          \`result\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_hitl_request_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`hitl_request_session_pending_idx\` ON \`hitl_request\` (\`session_id\`,\`decision\`);`,
      )
      yield* tx.run(`CREATE INDEX \`hitl_request_decision_idx\` ON \`hitl_request\` (\`decision\`);`)
    })
  },
}

export default migration
