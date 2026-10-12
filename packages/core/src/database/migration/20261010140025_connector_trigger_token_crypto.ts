import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261010140025_connector_trigger_token_crypto",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`connector_trigger_schedule\` ADD \`engine_token_encrypted\` text;`)
      yield* tx.run(`ALTER TABLE \`connector_trigger_schedule\` ADD \`token_state\` text DEFAULT 'active' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`connector_trigger_schedule\` ADD \`poll_attempts\` integer DEFAULT 0 NOT NULL;`)
    })
  },
}

export default migration
