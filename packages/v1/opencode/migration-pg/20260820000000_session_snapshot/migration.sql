CREATE TABLE IF NOT EXISTS "session_snapshot" (
  "id" text PRIMARY KEY NOT NULL,
  "session_id" text,
  "app_id" text,
  "scope" text NOT NULL,
  "state" text NOT NULL,
  "reason" text,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "session_snapshot_session_idx" ON "session_snapshot" ("session_id","state");
CREATE INDEX IF NOT EXISTS "session_snapshot_app_idx" ON "session_snapshot" ("app_id","scope");
