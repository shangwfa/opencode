CREATE TABLE "user_skill" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"content" text NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "user_skill_user_idx" ON "user_skill" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_skill_user_name_idx" ON "user_skill" ("user_id","name");