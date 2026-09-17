CREATE TABLE IF NOT EXISTS "session_skill" (
  "id" text PRIMARY KEY,
  "session_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "content" text NOT NULL,
  "resources" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL,
  CONSTRAINT "session_skill_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE "session_skill" ADD COLUMN IF NOT EXISTS "resources" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
DELETE FROM "session_skill" WHERE NOT EXISTS (SELECT 1 FROM "session" WHERE "session"."id" = "session_skill"."session_id");
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'session_skill_session_id_session_id_fk'
  ) THEN
    ALTER TABLE "session_skill" ADD CONSTRAINT "session_skill_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE cascade;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_skill_session_idx" ON "session_skill" ("session_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "session_skill_session_name_idx" ON "session_skill" ("session_id", "name");
