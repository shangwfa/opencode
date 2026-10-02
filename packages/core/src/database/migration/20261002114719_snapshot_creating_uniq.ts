import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261002114719_snapshot_creating_uniq",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_snapshot_creating_uniq\` ON \`session_snapshot\` (\`session_id\`,\`scope\`) WHERE "session_snapshot"."state" = 'creating';`,
      )
    })
  },
}

export default migration
