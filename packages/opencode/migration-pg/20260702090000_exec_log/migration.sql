CREATE TABLE IF NOT EXISTS "exec_log" (
	"id" text PRIMARY KEY,
	"session_id" text NOT NULL REFERENCES "session"("id") ON DELETE CASCADE,
	"command" text NOT NULL,
	"working_directory" text,
	"status" text NOT NULL,
	"exit_code" integer,
	"stdout" text,
	"stderr" text,
	"error" text,
	"source" text NOT NULL,
	"time_started" bigint NOT NULL,
	"time_finished" bigint,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exec_log_session_idx" ON "exec_log" ("session_id");
