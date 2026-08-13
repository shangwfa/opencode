import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DB_PATH = process.env.OPENUI_ANTD_DB_PATH ?? path.join(process.cwd(), "data", "openui-antd.db");

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!_db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    initSchema(_db);
  }
  return _db;
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      saas_session_id TEXT NOT NULL,
      title TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

export type ThreadRecord = {
  id: string;
  saasSessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export function createThreadRecord(saasSessionId: string, title = ""): ThreadRecord {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO threads (id, saas_session_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, saasSessionId, title, now, now);
  return formatThread(db.prepare(`SELECT * FROM threads WHERE id = ?`).get(id) as any);
}

export function listThreadRecords(): ThreadRecord[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM threads ORDER BY updated_at DESC`).all() as any[];
  return rows.map(formatThread);
}

export function getThreadRecord(threadId: string): ThreadRecord | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM threads WHERE id = ?`).get(threadId) as any;
  return row ? formatThread(row) : null;
}

export function updateThreadRecord(threadId: string, title: string): ThreadRecord | null {
  const db = getDb();
  db.prepare(`UPDATE threads SET title = ?, updated_at = ? WHERE id = ?`).run(title, Date.now(), threadId);
  const row = db.prepare(`SELECT * FROM threads WHERE id = ?`).get(threadId) as any;
  return row ? formatThread(row) : null;
}

export function syncThreadTitle(threadId: string, title: string): ThreadRecord | null {
  const db = getDb();
  db.prepare(`UPDATE threads SET title = ? WHERE id = ? AND title != ?`).run(title, threadId, title);
  const row = db.prepare(`SELECT * FROM threads WHERE id = ?`).get(threadId) as any;
  return row ? formatThread(row) : null;
}

export function deleteThreadRecord(threadId: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM threads WHERE id = ?`).run(threadId);
}

function formatThread(row: any): ThreadRecord {
  return {
    id: row.id,
    saasSessionId: row.saas_session_id,
    title: row.title,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}