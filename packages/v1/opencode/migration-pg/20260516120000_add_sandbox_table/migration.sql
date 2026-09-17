CREATE TABLE IF NOT EXISTS "sandbox" (
  "id" text PRIMARY KEY,
  "session_id" text NOT NULL UNIQUE,
  "host" text NOT NULL,
  "state" text NOT NULL,
  "keep_alive" boolean NOT NULL DEFAULT false,
  "command_session_id" text,
  "time_created" bigint NOT NULL,
  "time_updated" bigint NOT NULL
);
