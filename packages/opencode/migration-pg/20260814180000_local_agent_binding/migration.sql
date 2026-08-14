CREATE TABLE IF NOT EXISTS "local_agent_binding" (
  "session_id" text PRIMARY KEY NOT NULL,
  "agent_id" text NOT NULL,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL,
  CONSTRAINT "local_agent_binding_session_id_session_id_fk"
    FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "local_agent_binding_agent_idx" ON "local_agent_binding" ("agent_id");
