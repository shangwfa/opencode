CREATE TABLE IF NOT EXISTS "session_goal" (
	"session_id" text PRIMARY KEY,
	"condition" text NOT NULL,
	"react" integer NOT NULL DEFAULT 0,
	"status" text NOT NULL DEFAULT 'active',
	"last_verdict" jsonb,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_goal_session_id_session_id_fk') THEN
    ALTER TABLE "session_goal" ADD CONSTRAINT "session_goal_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE cascade;
  END IF;
END $$;
