CREATE TABLE IF NOT EXISTS "session_agents_md" (
  "id" text PRIMARY KEY NOT NULL,
  "session_id" text NOT NULL,
  "content" text NOT NULL,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL,
  CONSTRAINT "session_agents_md_session_id_session_id_fk"
    FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "session_agents_md_session_idx" ON "session_agents_md" ("session_id");
