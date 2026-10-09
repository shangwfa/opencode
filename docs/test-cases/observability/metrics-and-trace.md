# 观测性：OTel Metrics 与 trace_id 关联（V2）

> 本文档验证观测性改造：分布式指标（HTTP RED / LLM token / 沙箱事件）经 OTLP 导出，以及业务审计表 `log` 通过 `trace_id` 与调用链关联。
>
> **前置条件**：SaaS 服务已启动（见 `docs/local-test-env.md`），本地 PG（组合 3）。
>
> **OTLP 前提**：Metrics / trace_id 的导出依赖服务端配置 `OTEL_EXPORTER_OTLP_ENDPOINT`（由部署注入容器环境变量）。未配置时导出层为空实现——服务必须照常工作（这是 T62.2/T62.7 的验证点）。
>
> **V2 迁移说明**：V1 的 `exec_log` 已由 `log` 表取代（迁移 `20261009065959_log_trace_id` 为其增加 `trace_id` 列）；端点全部换为 `/api` 前缀 + Basic Auth（`api_curl`）。指标语义与 V1 复测版一致，无迁移点。

## 指标语义（当前约定）

> 名称/属性遵循 OpenTelemetry 语义约定。Effect `Metric` API 不支持声明 `unit`，故单位为约定值（不随 OTLP 元数据导出）。

| 指标 | 类型 | 约定单位 | 属性 |
|------|------|---------|------|
| `http.server.request.duration` | Histogram | 秒 | `http.request.method`、`http.response.status_code`（字符串）、失败时 `error.type` |
| `gen_ai.client.token.usage` | Histogram | `{token}` | `gen_ai.token.type`（`input`/`output`）、`gen_ai.provider.name`、`gen_ai.request.model` |
| `sandbox.lifecycle.count` | Counter | `{event}` | `event`（`create`/`restore`/`oom`/`kill`） |

实现位置（V2）：
- 指标定义 `packages/util/src/observability/metrics.ts`；OTLP 导出（含 15s PeriodicExportingMetricReader 与 `OTEL_TRACES_SAMPLER_ARG` 头部采样）`packages/util/src/observability/otlp.ts`。
- HTTP RED 中间件 `packages/server/src/middleware/http-metrics.ts`（挂载于 `process.ts` serve 链，401/503 也计入）。
- LLM token 记录 `packages/core/src/session/runner/publish-llm-event.ts`（step-finish，同时向活动 span 写 `gen_ai.*` 语义属性）。
- 沙箱事件 `packages/core/src/sandbox/provider.ts`（create/restore/kill/oom 四处；快照延迟等健康警告不属于生命周期，不计数）。

## 验证标准

| 层级 | 方法 | 判定标准 |
|------|------|---------|
| 1. PG schema | 查 `information_schema.columns` | `log.trace_id` 列存在 |
| 2. PG 记录 | 查 `log.trace_id` | 无 OTLP 时为 NULL；有 OTLP 时为 32 位 hex |
| 3. OTLP 收集端 | 接收器探测指标名 | `http.server.request.duration` / `gen_ai.client.token.usage` / `sandbox.lifecycle.count` |
| 4. HTTP | `GET /api/info` 与业务接口 | 无 5xx，未配置 OTLP 时行为不变 |

---

## 六十二、Observability（Metrics + trace_id）

> 运行前先加载环境：`source test-env.sh 3 && source test-lib.sh`。以下用例直接用 `$BASE` `$PG_URL` `$MODEL` `$OPENCODE_PASSWORD`，不重复定义。

### 辅助函数

```bash
# 某 session 最近一条指定 source 的 log 的 trace_id（空则输出 <null>）
trace_of() {
  local sid=$1 source=$2
  pgval "SELECT coalesce(trace_id,'<null>') FROM log WHERE session_id='$sid' AND source='$source' ORDER BY time_created DESC LIMIT 1"
}

# 某 session 指定 source 的 log 条数
log_count() {
  local sid=$1 source=$2
  pgval "SELECT count(*) FROM log WHERE session_id='$sid' AND source='$source'"
}

# 探测服务端是否配置 OTLP
otlp_enabled() {
  docker exec opencode-saas-test printenv OTEL_EXPORTER_OTLP_ENDPOINT 2>/dev/null | grep -q . && echo "yes" || echo "no"
}

# 启动本地 OTLP 接收器（后台，默认 :4318）。OTLP/HTTP 为 protobuf 编码，
# 指标名与 trace id 在 payload 内是明文，可直接子串探测。
otlp_receiver_start() {
  kill $(lsof -ti :4318) 2>/dev/null
  nohup bun "$(dirname "${BASH_SOURCE[0]}")/../scripts/otlp-receiver.mjs" 4318 >/tmp/otlp-receiver.log 2>&1 &
  sleep 1 && curl -s http://127.0.0.1:4318/__seen >/dev/null && echo "receiver ready"
}

# 探测接收器是否收到含指定字符串的 OTLP payload（hits>0 即命中）
otlp_seen() {
  curl -s "http://127.0.0.1:4318/__probe?needle=$1" | jexec "d['hits']"
}

otlp_signals() {
  curl -s http://127.0.0.1:4318/__seen
}
```

> 容器访问宿主机接收器用 `OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318`。

---

### T62.1 log 表增加 trace_id 列

```bash
pgval "SELECT column_name FROM information_schema.columns WHERE table_name='log' AND column_name='trace_id'"
```

**期望**：输出 `trace_id`（迁移 `20261009065959_log_trace_id` 已应用）。

### T62.2 未配置 OTLP：审计写入不破坏主流程，trace_id 为 NULL

```bash
SID=$(new_session)
jq -nc '{id:"session/obs-agent",config:{description:"obs",mode:"primary"}}' \
  | api_curl -X POST "$BASE/api/session/$SID/agents" -H 'Content-Type: application/json' --data-binary @- >/dev/null

echo "log 条数: $(log_count "$SID" session.agentDefinition.create)"
echo "trace_id: $(trace_of "$SID" session.agentDefinition.create)"
```

**期望**：
- HTTP：无 5xx（审计 best-effort，绝不因遥测缺失而中断）
- PG：`session.agentDefinition.create` 至少 1 条
- PG：`trace_id` 为 `<null>`（未配置 OTLP 时）

### T62.3 配置 OTLP：trace_id 为 32 位十六进制且与收集端一致

> 前提：`otlp_enabled` 输出 `yes`，接收器已启动（`otlp_receiver_start`）。

```bash
SID=$(new_session)
jq -nc '{id:"session/obs-agent",config:{description:"obs",mode:"primary"}}' \
  | api_curl -X POST "$BASE/api/session/$SID/agents" -H 'Content-Type: application/json' --data-binary @- >/dev/null

TID=$(trace_of "$SID" session.agentDefinition.create)
echo "trace_id: $TID"
echo "traces 中命中: $(otlp_seen "$TID")"
```

**期望**：`$TID` 匹配 `^[0-9a-f]{32}$`，且 `otlp_seen` 输出 ≥1（该 trace 已导出到收集端）。

### T62.4 HTTP RED 指标导出

> 前提：`otlp_enabled` 为 `yes`，接收器已启动。指标按 15 秒周期批量导出，验证前需等待一个导出周期。

```bash
api_curl "$BASE/api/info" >/dev/null
sleep 16
echo "signals: $(otlp_signals)"
echo "duration 命中: $(otlp_seen "http.server.request.duration")"
echo "method 命中: $(otlp_seen "http.request.method")"
```

**期望**：
- 接收器出现 `http.server.request.duration`，attributes 含 `http.request.method`、`http.response.status_code`
- `GET /api/info` 对应 `200`；失败请求额外带 `error.type`（typed error 的 `_tag`），状态码归为 `500`

### T62.5 LLM token 指标导出

```bash
SID=$(new_session_with_model)
stream_prompt "$SID" "回复 ok 即可" >/dev/null
sleep 16
echo "token 命中: $(otlp_seen "gen_ai.client.token.usage")"
echo "gen_ai 属性命中: $(otlp_seen "gen_ai.token.type")"
```

**期望**：接收器出现 `gen_ai.client.token.usage`，attributes 含 `gen_ai.token.type`（`input`/`output`）、`gen_ai.provider.name`、`gen_ai.request.model`；活动 span 带同批 `gen_ai.*` 语义属性（traces payload 中可探测到 `gen_ai.usage.input_tokens`）。

### T62.6 沙箱生命周期指标导出

```bash
SID=$(new_session)
# boot=true 立即创建沙箱 → event=create
jq -nc '{keepAlive:true,boot:true}' \
  | api_curl -X POST "$BASE/api/experimental/session/$SID/keep-alive" -H 'Content-Type: application/json' --data-binary @- >/dev/null
# 销毁沙箱 → event=kill
api_curl -X POST "$BASE/api/session/$SID/kill-sandbox" >/dev/null
sleep 16
echo "lifecycle 命中: $(otlp_seen "sandbox.lifecycle.count")"
echo "create 命中: $(otlp_seen "event")"   # 属性键
```

**期望**：接收器出现 `sandbox.lifecycle.count`，attributes `event` 为 `create`（快照恢复时为 `restore`；OOM 归因时为 `oom`；沙箱销毁时为 `kill`）。

### T62.7 未配置 OTLP 时服务健康且无导出副作用

```bash
api_curl "$BASE/api/info"
docker logs opencode-saas-test 2>&1 | grep -ci "otlp\|opentelemetry.*error" || true
```

**期望**：`/api/info` 正常返回；启动日志无 OTLP 连接报错（导出层为空实现）。

---

## 验收汇总

| 用例 | HTTP 响应 | PG 持久化 | OTLP 收集端 | 结果 |
|------|----------|----------|------------|------|
| T62.1 trace_id 列存在 | — | 列存在 | — | ✅ |
| T62.2 无 OTLP 审计正常 | 无 5xx | 有记录，trace_id NULL | — | ✅ |
| T62.3 有 OTLP trace_id | 无 5xx | 32 位 hex | 与 trace 一致 | ✅ |
| T62.4 HTTP RED | 200 | — | duration 直方图存在 | ✅ |
| T62.5 LLM token | — | — | gen_ai token 指标存在 | ✅ |
| T62.6 沙箱事件 | — | — | sandbox.lifecycle.count 存在 | ✅ |
| T62.7 无 OTLP 健康 | /api/info 200 | — | 无报错 | ✅ |

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

> V2 复测记录（2026-10-09，本地 PG + 本地 OpenSandbox，镜像 `opencode-saas-sandbox-test:t1009-otel`，容器端口 14099，接收器 `scripts/otlp-receiver.mjs` :4318）：
> - **T62.1** ✅ `information_schema` 存在 `log.trace_id` 列（迁移 `20261009065959_log_trace_id`）。
> - **T62.2** ✅ 未注入 OTLP 的容器：`POST /api/session/:id/agents` 200，`log` 写入 1 条 `session.agentDefinition.create`，`trace_id` 为 NULL。
> - **T62.3** ✅ 注入 `OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318` 后，`log.trace_id` = 32 位 hex（`a36cec85…`），接收器 traces payload 中该 id 命中 5 次（审计与收集端一致）。
> - **T62.4** ✅ `GET /api/info` ×3 后两个导出周期内接收器命中 `http.server.request.duration` + 属性 `http.request.method` / `http.response.status_code`（`error.type` 语义由单测覆盖：失败归 500 + `_tag`）。
> - **T62.5** ✅ SSE 订阅（`GET /api/session/:id/event`，15 帧：step.started → text.started/delta/ended → step.ended → usage.updated×2）+ `prompt_stream`（Yd-GLM/glm-5.3）回复 ok；命中 `gen_ai.client.token.usage` + 属性 `gen_ai.token.type` / `gen_ai.provider.name` / `gen_ai.request.model`；traces payload 同时命中 `gen_ai.usage.input_tokens` / `output_tokens`（step usage 已关联 trace）。
> - **T62.6** ✅ `keep-alive boot:true`（返回 sandboxId `bdd10b69…`）+ `kill-sandbox` 200 后命中 `sandbox.lifecycle.count`，payload 含 `create` / `kill` 属性值（`event` 属性语义由单测精确断言；`restore`/`oom` 需快照/内存压力场景，留待对应专项）。
> - **T62.7** ✅ 无 OTLP 容器 `/api/info` 200，启动日志无 OTLP 报错（0 条 grep 命中）。
> - 补充证据：接收器最终统计 `{"signals":{"metrics":11,"traces":15,"logs":12},"requests":38}`——OTLP 三类信号导出通道在 V2 全部打通。
> - 单测：`packages/util/test/observability-metrics.test.ts`（7 用例：三指标语义 + `currentTraceId` 三态）、`packages/server/test/http-metrics.test.ts`（3 用例：200 记录 / 失败归 500+error.type / Error name）、`packages/core/test/log.test.ts`（+2 用例：OTLP+span 写 32hex / 无 OTLP 为 NULL）全绿。
> - 文档用例全量复跑（同日第二遍，按本文档脚本逐条执行）：**7/7 PASS**。
