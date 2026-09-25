import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20260924233159_session_command_hints",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_commands\` ADD \`hints\` text DEFAULT '[]' NOT NULL;`)
    })
  },
}

export default migration
