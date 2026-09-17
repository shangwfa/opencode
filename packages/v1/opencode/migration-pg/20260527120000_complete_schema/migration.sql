-- Session table: add missing columns from SQLite schema
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "path" text;
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "cost" double precision NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "tokens_input" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "tokens_output" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "tokens_reasoning" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "tokens_cache_read" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "tokens_cache_write" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "agent" text;
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "model" jsonb;
--> statement-breakpoint
-- Project table: add missing column
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "icon_url_override" text;
--> statement-breakpoint
-- session_message table (v2 messages) — matches SessionMessageTable in session.sql.ts
CREATE TABLE IF NOT EXISTS "session_message" (
  "id" text PRIMARY KEY,
  "session_id" text NOT NULL,
  "type" text NOT NULL,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL,
  "data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_message_session_idx" ON "session_message" ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_message_session_type_idx" ON "session_message" ("session_id", "type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_message_time_created_idx" ON "session_message" ("time_created");
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'session_message_session_id_session_id_fk'
  ) THEN
    ALTER TABLE "session_message" ADD CONSTRAINT "session_message_session_id_session_id_fk"
      FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
