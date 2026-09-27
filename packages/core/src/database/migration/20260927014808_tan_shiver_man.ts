import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20260927014808_tan_shiver_man",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_skills\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`skill_id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`description\` text,
          \`autoinvoke\` integer,
          \`content\` text NOT NULL,
          \`resources\` text DEFAULT '[]' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_skills_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`session_skills_session_idx\` ON \`session_skills\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_skills_session_skill_idx\` ON \`session_skills\` (\`session_id\`,\`skill_id\`);`,
      )
    })
  },
}

export default migration
