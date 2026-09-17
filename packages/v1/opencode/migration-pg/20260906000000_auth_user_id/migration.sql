-- Personal credentials keep provider_id namespaced as "user_id/provider_id"
-- so the primary key on provider_id is untouched. Old code keeps working:
-- namespaced rows miss the provider catalog and are ignored, and INSERTs
-- without user_id fall back to the default ''.
ALTER TABLE "auth" ADD COLUMN IF NOT EXISTS "user_id" text NOT NULL DEFAULT '';
