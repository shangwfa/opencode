CREATE UNIQUE INDEX IF NOT EXISTS "rpa_app_version_one_active" ON "rpa_app_version" ("app_id") WHERE "status" = 'active';
