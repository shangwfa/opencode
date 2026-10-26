import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261024093925_vercel_endpoint_token",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`sandbox\` ADD \`endpoint_token\` text;`)
    })
  },
}

export default migration
