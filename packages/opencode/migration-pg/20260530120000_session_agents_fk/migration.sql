DELETE FROM "session_agents" WHERE NOT EXISTS (SELECT 1 FROM "session" WHERE "session"."id" = "session_agents"."session_id");
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'session_agents_session_id_session_id_fk'
  ) THEN
    ALTER TABLE "session_agents" ADD CONSTRAINT "session_agents_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE cascade;
  END IF;
END $$;
