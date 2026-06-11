-- Make all FK constraints DEFERRABLE INITIALLY DEFERRED
-- This matches SQLite behavior where FK checks happen at commit time,
-- preventing race conditions when concurrent events insert parent/child rows.

-- part → message
ALTER TABLE "part" DROP CONSTRAINT "part_message_id_message_id_fkey";
ALTER TABLE "part" ADD CONSTRAINT "part_message_id_message_id_fkey"
  FOREIGN KEY ("message_id") REFERENCES "message"("id") ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

-- message → session
ALTER TABLE "message" DROP CONSTRAINT "message_session_id_session_id_fkey";
ALTER TABLE "message" ADD CONSTRAINT "message_session_id_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

-- session → project
ALTER TABLE "session" DROP CONSTRAINT "session_project_id_project_id_fkey";
ALTER TABLE "session" ADD CONSTRAINT "session_project_id_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

-- session_entry → session
ALTER TABLE "session_entry" DROP CONSTRAINT "session_entry_session_id_session_id_fkey";
ALTER TABLE "session_entry" ADD CONSTRAINT "session_entry_session_id_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

-- session_share → session
ALTER TABLE "session_share" DROP CONSTRAINT "session_share_session_id_session_id_fkey";
ALTER TABLE "session_share" ADD CONSTRAINT "session_share_session_id_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

-- todo → session
ALTER TABLE "todo" DROP CONSTRAINT "todo_session_id_session_id_fkey";
ALTER TABLE "todo" ADD CONSTRAINT "todo_session_id_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

-- permission → project
ALTER TABLE "permission" DROP CONSTRAINT "permission_project_id_project_id_fkey";
ALTER TABLE "permission" ADD CONSTRAINT "permission_project_id_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

-- workspace → project
ALTER TABLE "workspace" DROP CONSTRAINT "workspace_project_id_project_id_fkey";
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_project_id_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

-- event → event_sequence
ALTER TABLE "event" DROP CONSTRAINT "event_aggregate_id_event_sequence_aggregate_id_fkey";
ALTER TABLE "event" ADD CONSTRAINT "event_aggregate_id_event_sequence_aggregate_id_fkey"
  FOREIGN KEY ("aggregate_id") REFERENCES "event_sequence"("aggregate_id") ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;
