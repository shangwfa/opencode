ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "pvc_mode" text;
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "app_id" text;
