CREATE TABLE IF NOT EXISTS "saas_project" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"description" text NOT NULL DEFAULT '',
	"status" text NOT NULL DEFAULT 'active',
	"repository_provider" text NOT NULL,
	"repository_url" text NOT NULL,
	"repository_host" text NOT NULL,
	"repository_path" text NOT NULL,
	"repository_default_branch" text,
	"repository_auth_type" text NOT NULL,
	"repository_credential" jsonb,
	"repository_verified_at" bigint NOT NULL,
	"repository_last_checked_at" bigint NOT NULL,
	"repository_connection_status" text NOT NULL DEFAULT 'verified',
	"metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL,
	"time_archived" bigint,
	CONSTRAINT "saas_project_status_check" CHECK ("status" IN ('active', 'archived')),
	CONSTRAINT "saas_project_repository_provider_check" CHECK ("repository_provider" IN ('github', 'gitlab', 'generic')),
	CONSTRAINT "saas_project_repository_auth_type_check" CHECK ("repository_auth_type" IN ('none', 'oauth', 'token', 'basic', 'ssh')),
	CONSTRAINT "saas_project_repository_connection_status_check" CHECK ("repository_connection_status" IN ('verified', 'unreachable', 'unauthorized')),
	CONSTRAINT "saas_project_repository_credential_check" CHECK (("repository_auth_type" = 'none' AND "repository_credential" IS NULL) OR ("repository_auth_type" <> 'none' AND "repository_credential" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saas_project_status_idx" ON "saas_project" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saas_project_repository_host_idx" ON "saas_project" ("repository_host");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"mode" text NOT NULL DEFAULT 'all',
	"prompt" text,
	"permission" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"model" jsonb,
	"temperature" real,
	"top_p" real,
	"steps" bigint,
	"color" text,
	"variant" text,
	"options" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL,
	CONSTRAINT "agent_mode_check" CHECK ("mode" IN ('primary', 'subagent', 'all'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_project_idx" ON "agent" ("project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_project_name_idx" ON "agent" ("project_id", "name");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skill" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"content" text NOT NULL,
	"resources" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_project_idx" ON "skill" ("project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skill_project_name_idx" ON "skill" ("project_id", "name");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"command" jsonb,
	"url" text,
	"enabled" boolean NOT NULL DEFAULT true,
	"timeout" bigint,
	"environment_keys" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"header_keys" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"secrets" jsonb,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL,
	CONSTRAINT "mcp_type_check" CHECK ("type" IN ('local', 'remote')),
	CONSTRAINT "mcp_transport_check" CHECK (("type" = 'local' AND "command" IS NOT NULL AND "url" IS NULL) OR ("type" = 'remote' AND "command" IS NULL AND "url" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_project_idx" ON "mcp" ("project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_project_name_idx" ON "mcp" ("project_id", "name");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_agents_md" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"content" text NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_agents_md_project_idx" ON "project_agents_md" ("project_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_command" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"template" text NOT NULL,
	"agent" text,
	"model" text,
	"subtask" boolean,
	"hints" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_command_project_idx" ON "project_command" ("project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_command_project_name_idx" ON "project_command" ("project_id", "name");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_tool" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"code" text NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_tool_project_idx" ON "project_tool" ("project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_tool_project_name_idx" ON "project_tool" ("project_id", "name");
