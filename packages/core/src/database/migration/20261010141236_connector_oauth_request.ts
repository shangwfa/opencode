import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261010141236_connector_oauth_request",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`connector_oauth_request\` (
          \`connection_request_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`service\` text NOT NULL,
          \`state\` text NOT NULL,
          \`alias\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`connector_oauth_request_session_idx\` ON \`connector_oauth_request\` (\`session_id\`);`,
      )
    })
  },
}

export default migration
