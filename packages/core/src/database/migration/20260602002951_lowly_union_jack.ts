import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20260602002951_lowly_union_jack",
  up(tx) {
    return Effect.gen(function* () {
      // Replace the v1 project-level permission table with the v2 saved-rule
      // table (different schema: id PK + action/resource columns vs the v1
      // project_id PK + data JSONB layout).
      yield* tx.run(`DROP TABLE IF EXISTS \`permission\`;`)
      yield* tx.run(`
        CREATE TABLE \`permission\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`user_id\` text NOT NULL DEFAULT '',
          \`action\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_permission_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`permission_project_user_action_resource_idx\` ON \`permission\` (\`project_id\`,\`user_id\`,\`action\`,\`resource\`);`,
      )
    })
  },
}

export default migration
