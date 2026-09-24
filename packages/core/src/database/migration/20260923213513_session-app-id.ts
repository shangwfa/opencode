import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20260923213513_session-app-id",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`app_id\` text;`)
      yield* tx.run(`CREATE INDEX \`session_v2_app_id_idx\` ON \`session_v2\` (\`app_id\`);`)
    })
  },
}

export default migration
