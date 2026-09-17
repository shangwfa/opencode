CREATE TABLE "account_state" (
	"id" integer PRIMARY KEY,
	"active_account_id" text,
	"active_org_id" text
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY,
	"email" text NOT NULL,
	"url" text NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"token_expiry" integer,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_state" ADD CONSTRAINT "account_state_active_account_id_account_id_fkey" FOREIGN KEY ("active_account_id") REFERENCES "account"("id") ON DELETE SET NULL;