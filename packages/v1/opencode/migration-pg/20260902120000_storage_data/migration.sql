CREATE TABLE IF NOT EXISTS "storage_data" (
  "key" text PRIMARY KEY,
  "data" jsonb NOT NULL,
  "time_updated" bigint NOT NULL
);
