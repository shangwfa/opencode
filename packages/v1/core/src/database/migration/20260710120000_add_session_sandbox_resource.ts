import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260710120000_add_session_sandbox_resource",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`sandbox\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
