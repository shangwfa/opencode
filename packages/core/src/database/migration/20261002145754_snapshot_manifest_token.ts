import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261002145754_snapshot_manifest_token",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_snapshot\` ADD \`manifest_token\` text;`)
    })
  },
}

export default migration
