-- exec_log 审计扩展：permission 拒绝记录（status="denied"）与命中规则
ALTER TABLE "exec_log" ADD COLUMN IF NOT EXISTS "rule" text;
