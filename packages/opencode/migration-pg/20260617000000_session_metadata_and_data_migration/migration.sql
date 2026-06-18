ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "pvc_mode" text;
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "app_id" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "data_migration" (
	"name" text PRIMARY KEY,
	"time_completed" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credential" (
	"id" text PRIMARY KEY,
	"connector_id" text NOT NULL,
	"method_id" text NOT NULL,
	"label" text NOT NULL,
	"value" jsonb NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_message" ADD COLUMN IF NOT EXISTS "seq" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "session_message_session_seq_idx" ON "session_message" ("session_id", "seq");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session_context_epoch" (
	"session_id" text PRIMARY KEY,
	"baseline" text NOT NULL,
	"agent" text NOT NULL DEFAULT 'build',
	"snapshot" jsonb NOT NULL,
	"baseline_seq" integer NOT NULL,
	"replacement_seq" integer,
	"revision" integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session_input" (
	"id" text PRIMARY KEY,
	"session_id" text NOT NULL,
	"prompt" jsonb NOT NULL,
	"delivery" text NOT NULL,
	"admitted_seq" integer NOT NULL,
	"promoted_seq" integer,
	"time_created" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_directory" (
	"project_id" text NOT NULL,
	"directory" text NOT NULL,
	"type" text NOT NULL,
	"time_created" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "control_account" (
	"email" text NOT NULL,
	"url" text NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"token_expiry" integer,
	"active" boolean NOT NULL DEFAULT false,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
