-- 打通业务审计与分布式追踪：记录写入时活跃 OTel span 的 trace_id
ALTER TABLE "exec_log" ADD COLUMN IF NOT EXISTS "trace_id" text;
