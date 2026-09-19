-- v1 session.app_id 的 v2 侧迁移（业务侧 appId，按业务维度聚合会话）。
-- 可空、无外键（与 v1 的 app_id 列语义一致）；查询走全表扫描，量大时再加索引。
ALTER TABLE "session_v2" ADD COLUMN "app_id" text;
