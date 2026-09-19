ALTER TABLE "session_plugins" ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'code';
ALTER TABLE "session_plugins" ADD COLUMN IF NOT EXISTS "spec" text;
ALTER TABLE "session_plugins" ALTER COLUMN "code" SET DEFAULT '';
