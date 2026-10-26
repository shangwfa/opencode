import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261024062646_vercel_sandbox_binding",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`sandbox_command\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`sandbox_id\` text NOT NULL,
          \`command_id\` text NOT NULL,
          \`operation_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`ALTER TABLE \`sandbox\` ADD \`provider\` text DEFAULT 'opensandbox' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`sandbox\` ADD \`provider_scope\` text;`)
      yield* tx.run(`ALTER TABLE \`sandbox\` ADD \`remote_name\` text;`)
      yield* tx.run(
        `CREATE INDEX \`sandbox_command_session_idx\` ON \`sandbox_command\` (\`session_id\`,\`sandbox_id\`);`,
      )
    })
  },
}

export default migration
