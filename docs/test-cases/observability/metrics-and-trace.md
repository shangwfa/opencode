# 观测性：OTel Metrics 与 trace_id 关联

> 本文档验证观测性改造：分布式指标（HTTP RED / LLM token / 沙箱事件）经 OTLP 导出，以及业务审计表 `exec_log` 通过 `trace_id` 与调用链关联。
>
> **前置条件**：SaaS 服务已启动（见 `docs/local-test-env.md`），PG 模式。
>
> **OTLP 前提**：Metrics / trace_id 的导出依赖服务端配置 `OTEL_EXPORTER_OTLP_ENDPOINT`（由部署注入容器环境变量）。未配置时导出层为空实现——服务必须照常工作（这是 T62.2/T62.7 的验证点）。
>
> **通用清单映射**：T62.1-T62.3 覆盖 `exec_log.trace_id` 关联；T62.4-T62.6 覆盖指标导出；T62.7 覆盖无 OTLP 时的零副作用。

## 指标语义（当前约定）

> 名称/属性遵循 OpenTelemetry 语义约定。Effect `Metric` API 不支持声明 `unit`，故单位为约定值（不随 OTLP 元数据导出）。

| 指标 | 类型 | 约定单位 | 属性 |
|------|------|---------|------|
| `http.server.request.duration` | Histogram | 秒 | `http.request.method`、`http.response.status_code`（字符串）、失败时 `error.type` |
| `gen_ai.client.token.usage` | Histogram | `{token}` | `gen_ai.token.type`（`input`/`output`）、`gen_ai.provider.name`、`gen_ai.request.model` |
| `sandbox.lifecycle.count` | Counter | `{event}` | `event`（`create`/`restore`/`oom`/`kill`） |

### 相对早期实现的变化（迁移点）

- HTTP duration 由**毫秒改为秒**；属性 `method`/`status` 改为 `http.request.method`/`http.response.status_code`，失败请求状态归为 `500` 并附 `error.type`。
- 删除 `http.server.request.count`，请求数改用 `http.server.request.duration` 的 `_count`。
- `gen_ai.client.token.usage` 由 Counter 改为 Histogram，属性改为 `gen_ai.*`；token 维度收敛为 `input`/`output`（不再单列 `reasoning`/`cache_*`）。
- 沙箱事件新增 `kill`（`create`/`restore`/`oom`/`kill`）。
- 采样：`OTEL_TRACES_SAMPLER_ARG`（0..1）启用头部按比例采样；未设置时沿用 SDK 默认（always-on）。

## 验证标准

| 层级 | 方法 | 判定标准 |
|------|------|---------|
| 1. PG schema | 查 `information_schema.columns` | `exec_log.trace_id` 列存在 |
| 2. PG 记录 | 查 `exec_log.trace_id` | 无 OTLP 时为 NULL；有 OTLP 时为 32 位 hex |
| 3. OTLP 收集端 | 在 collector/后端查询指标名 | `http.server.request.*` / `gen_ai.client.token.usage` / `sandbox.lifecycle.count` |
| 4. HTTP | `/global/health` 与业务接口 | 无 5xx，未配置 OTLP 时行为不变 |

---

## 六十二、Observability（Metrics + trace_id）

> 运行前先加载环境：`source test-env.sh [1|2|3] && source test-lib.sh`。以下用例直接用 `$BASE` `$PG_URL` `$MODEL`，不重复定义。

### 辅助函数

```bash
# 某 session 最近一条指定 source 的 exec_log 的 trace_id（空则输出 <null>）
trace_of() {
  local sid=$1 source=$2
  pgval "SELECT coalesce(trace_id,'<null>') FROM exec_log WHERE session_id='$sid' AND source='$source' ORDER BY time_created DESC LIMIT 1"
}

# 某 session 指定 source 的 exec_log 条数
exec_log_count() {
  local sid=$1 source=$2
  pgval "SELECT count(*) FROM exec_log WHERE session_id='$sid' AND source='$source'"
}

# 探测服务端是否配置 OTLP（容器部署时用其容器名替换 <container>）
otlp_enabled() {
  docker exec <container> printenv OTEL_EXPORTER_OTLP_ENDPOINT 2>/dev/null | grep -q . && echo "yes" || echo "no"
}
```

---

### T62.1 exec_log 增加 trace_id 列

```bash
pgval "SELECT column_name FROM information_schema.columns WHERE table_name='exec_log' AND column_name='trace_id'"
```

**期望**：输出 `trace_id`（迁移 `20260913000000_exec_log_trace_id` 已应用）。

### T62.2 未配置 OTLP：审计写入不破坏主流程，trace_id 为 NULL

```bash
SID=$(new_sid)
curl -s -X POST "$BASE/session/$SID/agents/create" -H 'Content-Type: application/json' \
  -d '{"name":"obs-agent","description":"obs","mode":"primary","prompt":"x"}' >/dev/null

echo "exec_log 条数: $(exec_log_count "$SID" agent-create)"
echo "trace_id: $(trace_of "$SID" agent-create)"
```

**期望**：
- HTTP：无 5xx（审计 best-effort，绝不因遥测缺失而中断）
- PG：`agent-create` 至少 1 条
- PG：`trace_id` 为 `<null>`（未配置 OTLP 时）

### T62.3 配置 OTLP：trace_id 为 32 位十六进制

> 前提：`otlp_enabled` 输出 `yes`，且 agent-create 请求落在某个 Effect span 内。

```bash
SID=$(new_sid)
curl -s -X POST "$BASE/session/$SID/agents/create" -H 'Content-Type: application/json' \
  -d '{"name":"obs-agent","description":"obs","mode":"primary","prompt":"x"}' >/dev/null

trace_of "$SID" agent-create
```

**期望**：匹配 `^[0-9a-f]{32}$`，且与收集端该次 trace 的 `trace_id` 一致。

### T62.4 HTTP RED 指标导出

> 前提：`otlp_enabled` 为 `yes`，收集端可查询（collector debug exporter 日志 / 后端指标浏览器）。

```bash
curl -s "$BASE/global/health" >/dev/null
```

**期望**：收集端出现
- `http.server.request.duration` 直方图（单位秒），attributes `http.request.method`、`http.response.status_code`（如 `GET`/`200`）
- 失败请求（defect / typed error）额外带 `error.type`（如 `Error`），状态码归为 `500`

### T62.5 LLM token 指标导出

```bash
SID=$(new_sid)
curl -s -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"hi\"}],\"model\":$MODEL}" >/dev/null
```

**期望**：收集端出现 `gen_ai.client.token.usage` 直方图（单位 `{token}`，每次请求用量），attributes `gen_ai.token.type`（`input`/`output`）、`gen_ai.provider.name`、`gen_ai.request.model`。

### T62.6 沙箱生命周期指标导出

```bash
SID=$(new_sid -kb)
```

**期望**：沙箱创建/恢复后，收集端出现 `sandbox.lifecycle.count`，attributes `event` 为 `create`（或快照恢复时的 `restore`）；OOM 归因时为 `oom`；沙箱销毁时为 `kill`。

### T62.7 未配置 OTLP 时服务健康且无导出副作用

```bash
curl -s "$BASE/global/health"
```

**期望**：返回 `{"healthy":true,...}`；启动日志无 OTLP 连接报错（导出层为空实现）。

---

## 验收汇总

| 用例 | HTTP 响应 | PG 持久化 | OTLP 收集端 | 结果 |
|------|----------|----------|------------|------|
| T62.1 trace_id 列存在 | — | 列存在 | — | |
| T62.2 无 OTLP 审计正常 | 无 5xx | 有记录，trace_id NULL | — | |
| T62.3 有 OTLP trace_id | 无 5xx | 32 位 hex | 与 trace 一致 | |
| T62.4 HTTP RED | 200 | — | duration 直方图存在 | |
| T62.5 LLM token | — | — | gen_ai token 指标存在 | |
| T62.6 沙箱事件 | — | — | sandbox.lifecycle.count 存在 | |
| T62.7 无 OTLP 健康 | healthy | — | 无报错 | |

---

> 复测记录（2026-09-13，本地 PG + 远程沙箱，镜像 `opencode-saas-sandbox-test:t0913-observability`）：
> - **T62.1** ✅ `information_schema` 存在 `exec_log.trace_id` 列（local / app 用户）。
> - **T62.2** ✅ 容器未注入 OTLP 时服务健康 `{"healthy":true,"version":"local"}`，审计照常写入。
> - **T62.3** ✅ 容器注入 `OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318` 后，`exec_log.trace_id` 非空（6/97，覆盖 `session-create`/`agent-create`/`keep-alive`/`session-prompt`）。
> - **T62.4** ✅ 宿主机 OTLP 接收器收到 `http.server.request.duration`（当时实现还导出 `http.server.request.count`，此后已按 semconv 收敛，见「指标语义」）。
> - **T62.5** ✅ 发一条消息后收到 `gen_ai.client.token.usage`。
> - **T62.6** ✅ `keep-alive boot` 后收到 `sandbox.lifecycle.count`。
> - **T62.7** ✅ 无 OTLP 时启动日志无连接报错。
> - 补充证据：接收器同时收到 traces（7）与 logs（7）请求，`service.name` 出现在全部 resource 中，证明 OTLP 三类信号导出通道打通。
> - **新语义复验（同日，镜像 `t0913-semconv`）** ✅ 接收器命中 `http.server.request.duration` + 属性 `http.request.method`/`http.response.status_code`、`gen_ai.client.token.usage` + 属性 `gen_ai.token.type`/`gen_ai.provider.name`/`gen_ai.request.model`、`sandbox.lifecycle.count`（含 `kill`）；已删除的 `http.server.request.count` 未出现（0）；`exec_log.trace_id` 19/112。
