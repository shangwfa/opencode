import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261023005646_session_context_insights",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_context_content\` (
          \`session_id\` text NOT NULL,
          \`hash\` text NOT NULL,
          \`content\` text NOT NULL,
          CONSTRAINT \`session_context_content_pk\` PRIMARY KEY(\`session_id\`, \`hash\`),
          CONSTRAINT \`fk_session_context_content_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_context_request\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`summary\` text NOT NULL,
          \`items\` text NOT NULL,
          CONSTRAINT \`fk_session_context_request_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_context_request_session_seq_idx\` ON \`session_context_request\` (\`session_id\`,\`seq\`);`,
      )
    })
  },
}

export default migration
