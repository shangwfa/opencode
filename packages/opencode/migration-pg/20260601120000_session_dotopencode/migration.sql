CREATE TABLE IF NOT EXISTS "session_dotopencode" (
  "id" text PRIMARY KEY NOT NULL,
  "session_id" text NOT NULL,
  "opencode_json" text,
  "agents" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "commands" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "instructions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "plugins" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "scanned_at" bigint NOT NULL,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_dotopencode_session_idx" ON "session_dotopencode" ("session_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "session_dotopencode_session_uniq" ON "session_dotopencode" ("session_id");
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'session_dotopencode_session_id_session_id_fk'
  ) THEN
    ALTER TABLE "session_dotopencode" ADD CONSTRAINT "session_dotopencode_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE cascade;
  END IF;
END $$;
