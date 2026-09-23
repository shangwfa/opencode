import Database from "better-sqlite3"
import fs from "node:fs"
import path from "node:path"

const dataDir = path.resolve(import.meta.dirname, "data")
fs.mkdirSync(dataDir, { recursive: true })

export const db = new Database(path.join(dataDir, "browser-cdp.db"))

db.exec(`
  CREATE TABLE IF NOT EXISTS browser_session (
    id TEXT PRIMARY KEY,
    sandbox_id TEXT,
    title TEXT NOT NULL,
    image TEXT NOT NULL,
    time_updated INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
`)

export function listSessions() {
  return db
    .prepare("SELECT id, title, image, time_updated FROM browser_session ORDER BY time_updated DESC")
    .all()
    .map((row) => {
      const session = row as { id: string; title: string; image: string; time_updated: number }
      return {
        id: session.id,
        title: session.title,
        timeUpdated: session.time_updated,
        sandbox: { image: session.image },
      }
    })
}

export function saveSession(input: { id: string; sandboxId: string | null; image: string }) {
  const now = Date.now()
  db.prepare(
    "INSERT OR REPLACE INTO browser_session (id, sandbox_id, title, image, time_updated, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(input.id, input.sandboxId, `Browser session · ${new Date(now).toLocaleString("zh-CN")}`, input.image, now, now)
}

export function updateSessionTitle(id: string, title: string) {
  db.prepare("UPDATE browser_session SET title = ?, time_updated = ? WHERE id = ?").run(title, Date.now(), id)
}
