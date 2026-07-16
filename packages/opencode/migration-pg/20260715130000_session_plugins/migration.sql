CREATE TABLE IF NOT EXISTS "session_plugins" (
  "id" text PRIMARY KEY,
  "session_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "code" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_plugins_session_id_session_id_fk') THEN
    ALTER TABLE "session_plugins" ADD CONSTRAINT "session_plugins_session_id_session_id_fk"
    FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE cascade;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_plugins_session_idx" ON "session_plugins" ("session_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "session_plugins_session_name_idx" ON "session_plugins" ("session_id", "name");
