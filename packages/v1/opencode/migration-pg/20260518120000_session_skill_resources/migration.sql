ALTER TABLE "session_skill" ADD COLUMN IF NOT EXISTS "resources" jsonb NOT NULL DEFAULT '[]'::jsonb;
