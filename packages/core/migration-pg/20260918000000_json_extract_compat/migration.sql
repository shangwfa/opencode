-- sqlite 方言兼容层：v2 的运行时查询使用 sqlite 的 json_extract(text, '$.path')。
-- PG 没有该函数（用 -> / ->> 或 JSONPath），业务代码又是方言无关的 drizzle sql 模板，
-- 因此在 PG 侧提供同名函数，语义对齐 sqlite：
--   - 路径不存在 -> NULL（不报错）
--   - 非法 JSON   -> 报错（与 sqlite 一致）
--   - 返回 text（数字/布尔以文本形式返回，比较/聚合依赖 PG 隐式转换）
CREATE OR REPLACE FUNCTION json_extract(input text, path text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN input IS NULL OR input = '' THEN NULL
    ELSE jsonb_path_query_first(input::jsonb, path::jsonpath) #>> '{}'
  END
$$;
