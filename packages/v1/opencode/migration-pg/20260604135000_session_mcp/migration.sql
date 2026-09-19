CREATE TABLE IF NOT EXISTS "session_mcps" (
	"id" text PRIMARY KEY,
	"session_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"command" jsonb,
	"url" text,
	"environment" jsonb DEFAULT '{}' NOT NULL,
	"headers" jsonb DEFAULT '{}' NOT NULL,
	"enabled" jsonb DEFAULT 'true' NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_mcps_session_id_session_id_fk') THEN
    ALTER TABLE "session_mcps" ADD CONSTRAINT "session_mcps_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE cascade;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_mcps_session_idx" ON "session_mcps" ("session_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "session_mcps_session_name_idx" ON "session_mcps" ("session_id", "name");
