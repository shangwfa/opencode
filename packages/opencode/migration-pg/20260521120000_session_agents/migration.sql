CREATE TABLE IF NOT EXISTS "session_agents" (
  "id" text PRIMARY KEY,
  "session_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "mode" text NOT NULL DEFAULT 'all',
  "prompt" text,
  "permission" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "model" jsonb,
  "temperature" real,
  "top_p" real,
  "steps" integer,
  "color" text,
  "variant" text,
  "options" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_agents" DROP CONSTRAINT IF EXISTS "session_agents_session_id_session_id_fk";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_agents_session_idx" ON "session_agents" ("session_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "session_agents_session_name_idx" ON "session_agents" ("session_id", "name");
