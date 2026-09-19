-- Session-level sandbox resource spec stored on the workspace row;
-- consumed by the opensandbox driver at sandbox create time.
ALTER TABLE "workspace" ADD COLUMN IF NOT EXISTS "resource" text;
