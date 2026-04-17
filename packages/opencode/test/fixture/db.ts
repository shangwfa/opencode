import { rm } from "fs/promises"
import { Instance } from "../../src/project/instance"
import { Database } from "../../src/storage/db"
import postgres from "postgres"

export async function resetDatabase() {
  await Instance.disposeAll().catch(() => undefined)
  await Database.close().catch(() => undefined)

  if (Database.dialect === "pg") {
    const client = postgres(Database.Path)
    try {
      await client.unsafe(`
        DO $$ DECLARE
          r RECORD;
        BEGIN
          FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
            EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
          END LOOP;
        END $$;
      `)
    } finally {
      await client.end()
    }
    return
  }

  await rm(Database.Path, { force: true }).catch(() => undefined)
  await rm(`${Database.Path}-wal`, { force: true }).catch(() => undefined)
  await rm(`${Database.Path}-shm`, { force: true }).catch(() => undefined)
}
