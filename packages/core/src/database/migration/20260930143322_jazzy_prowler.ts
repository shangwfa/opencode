import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20260930143322_jazzy_prowler",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`sandbox_execution_gate\` (
          \`root_session_id\` text PRIMARY KEY,
          \`epoch\` integer DEFAULT 1 NOT NULL,
          \`state\` text DEFAULT 'open' NOT NULL,
          \`sandbox_id\` text,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_execution_gate\` (
          \`session_id\` text PRIMARY KEY,
          \`root_session_id\` text NOT NULL,
          \`epoch\` integer DEFAULT 1 NOT NULL,
          \`state\` text DEFAULT 'open' NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
}

export default migration
