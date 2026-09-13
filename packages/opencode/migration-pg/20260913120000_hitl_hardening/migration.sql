ALTER TABLE "hitl_request"
	ALTER COLUMN "lease_until" SET NOT NULL;
--> statement-breakpoint
DELETE FROM "hitl_request" h
	WHERE NOT EXISTS (SELECT 1 FROM "session" s WHERE s."id" = h."session_id");
--> statement-breakpoint
ALTER TABLE "hitl_request"
	ADD CONSTRAINT "hitl_session_fk" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "hitl_request"
	ADD CONSTRAINT "hitl_kind_check" CHECK ("kind" IN ('question', 'permission'));
--> statement-breakpoint
ALTER TABLE "hitl_request"
	ADD CONSTRAINT "hitl_status_check" CHECK ("status" IN ('pending', 'replied', 'rejected', 'closed'));
--> statement-breakpoint
ALTER TABLE "hitl_request"
	ADD CONSTRAINT "hitl_close_reason_check" CHECK ("close_reason" IS NULL OR "close_reason" IN ('instance-restart', 'shutdown', 'answered-delivered', 'decision-delivered'));
--> statement-breakpoint
DROP INDEX IF EXISTS "hitl_pending_idx";
--> statement-breakpoint
CREATE INDEX "hitl_pending_idx" ON "hitl_request" ("directory", "kind", "status", "lease_until");
--> statement-breakpoint
DROP INDEX IF EXISTS "hitl_session_idx";
--> statement-breakpoint
CREATE INDEX "hitl_session_idx" ON "hitl_request" ("directory", "session_id", "status");
--> statement-breakpoint
CREATE INDEX "hitl_retention_idx" ON "hitl_request" ("status", "time_updated");
