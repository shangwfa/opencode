CREATE TABLE IF NOT EXISTS "saas_task" (
	"id" text PRIMARY KEY,
	"title" text NOT NULL,
	"description" text NOT NULL DEFAULT '',
	"project_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saas_task_time_idx" ON "saas_task" ("time_created");
--> statement-breakpoint
ALTER TABLE "agent" ALTER COLUMN "project_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "skill" ALTER COLUMN "project_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "mcp" ALTER COLUMN "project_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "project_agents_md" ALTER COLUMN "project_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "project_command" ALTER COLUMN "project_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "project_tool" ALTER COLUMN "project_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN IF NOT EXISTS "task_id" text;
--> statement-breakpoint
ALTER TABLE "skill" ADD COLUMN IF NOT EXISTS "task_id" text;
--> statement-breakpoint
ALTER TABLE "mcp" ADD COLUMN IF NOT EXISTS "task_id" text;
--> statement-breakpoint
ALTER TABLE "project_agents_md" ADD COLUMN IF NOT EXISTS "task_id" text;
--> statement-breakpoint
ALTER TABLE "project_command" ADD COLUMN IF NOT EXISTS "task_id" text;
--> statement-breakpoint
ALTER TABLE "project_tool" ADD COLUMN IF NOT EXISTS "task_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_task_idx" ON "agent" ("task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_task_idx" ON "skill" ("task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_task_idx" ON "mcp" ("task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_command_task_idx" ON "project_command" ("task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_tool_task_idx" ON "project_tool" ("task_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_task_name_idx" ON "agent" ("task_id", "name") WHERE "task_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skill_task_name_idx" ON "skill" ("task_id", "name") WHERE "task_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_task_name_idx" ON "mcp" ("task_id", "name") WHERE "task_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_md_task_idx" ON "project_agents_md" ("task_id") WHERE "task_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "command_task_name_idx" ON "project_command" ("task_id", "name") WHERE "task_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tool_task_name_idx" ON "project_tool" ("task_id", "name") WHERE "task_id" IS NOT NULL;
