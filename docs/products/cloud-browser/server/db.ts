import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'

const dataDir = path.resolve(import.meta.dirname, './data')
fs.mkdirSync(dataDir, { recursive: true })

export const db = new Database(path.join(dataDir, 'cloud-browser.db'))

db.exec(`
  CREATE TABLE IF NOT EXISTS agent (
    id TEXT PRIMARY KEY,
    sandbox_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    directory TEXT NOT NULL,
    prompt TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sandbox (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sandbox_alias (
    old_id TEXT PRIMARY KEY,
    new_id TEXT NOT NULL
  );
`)
