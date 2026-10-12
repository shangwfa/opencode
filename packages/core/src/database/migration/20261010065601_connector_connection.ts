import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261010065601_connector_connection",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`connector_connection\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`engine_connection_id\` text NOT NULL,
          \`engine_connection_name\` text NOT NULL,
          \`service\` text NOT NULL,
          \`alias\` text NOT NULL,
          \`auth_type\` text NOT NULL,
          \`status\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`connector_connection_engine_id_uq\` ON \`connector_connection\` (\`engine_connection_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`connector_connection_session_idx\` ON \`connector_connection\` (\`session_id\`);`)
    })
  },
}

export default migration
