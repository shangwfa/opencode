CREATE TABLE IF NOT EXISTS "auth" (
  "provider_id" text PRIMARY KEY,
  "type" text NOT NULL,
  "data" jsonb NOT NULL,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL
);
