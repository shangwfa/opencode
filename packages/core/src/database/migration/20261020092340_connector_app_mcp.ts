import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261020092340_connector_app_mcp",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`connector_mcp_deployment\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`service\` text NOT NULL,
          \`connection_id\` text,
          \`name\` text NOT NULL,
          \`status\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`tools_json\` text NOT NULL,
          \`token_hash\` text NOT NULL,
          \`token_prefix\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`connector_mcp_owner_idx\` ON \`connector_mcp_deployment\` (\`session_id\`,\`status\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`connector_mcp_connection_idx\` ON \`connector_mcp_deployment\` (\`connection_id\`);`,
      )
    })
  },
}

export default migration
