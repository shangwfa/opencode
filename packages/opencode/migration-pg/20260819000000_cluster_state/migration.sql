CREATE TABLE IF NOT EXISTS cluster_state (
  key TEXT PRIMARY KEY,
  revision BIGINT NOT NULL DEFAULT 0,
  data JSONB,
  time_updated BIGINT NOT NULL
);
--> statement-breakpoint
INSERT INTO cluster_state (key, revision, data, time_updated)
VALUES
  ('auth', 0, NULL, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT),
  ('config', 0, '{}'::jsonb, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION opencode_bump_auth_revision()
RETURNS trigger AS $$
BEGIN
  INSERT INTO cluster_state (key, revision, data, time_updated)
  VALUES ('auth', 1, NULL, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT)
  ON CONFLICT (key) DO UPDATE SET
    revision = cluster_state.revision + 1,
    time_updated = EXCLUDED.time_updated;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS opencode_auth_revision ON auth;
--> statement-breakpoint
CREATE TRIGGER opencode_auth_revision
AFTER INSERT OR UPDATE OR DELETE ON auth
FOR EACH STATEMENT EXECUTE FUNCTION opencode_bump_auth_revision();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS session_abort (
  session_id TEXT PRIMARY KEY,
  directory TEXT NOT NULL,
  generation BIGINT NOT NULL DEFAULT 1,
  time_updated BIGINT NOT NULL
);
--> statement-breakpoint
ALTER TABLE session_abort ADD COLUMN IF NOT EXISTS directory TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE session_abort ALTER COLUMN directory DROP DEFAULT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sandbox_reap_idx ON sandbox (state, keep_alive, time_updated);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cluster_bus_event (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  event JSONB NOT NULL,
  time_created BIGINT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cluster_bus_event_created_idx ON cluster_bus_event (time_created);
