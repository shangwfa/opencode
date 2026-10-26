import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261025152054_session_mcp_runtime_port",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_mcps\` ADD \`runtime_port\` integer;`)
    })
  },
}

export default migration
