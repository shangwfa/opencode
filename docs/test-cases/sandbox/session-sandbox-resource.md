# Session Sandbox Resource（会话级沙箱资源配置，V2）

> 创建会话时通过 `sandbox: { cpu, memory }` 指定沙箱资源；创建沙箱时从会话信息读取该配置并传入 OpenSandbox SDK。本文为 V2 版：API 前缀 `/api/...`，PG 投影表为 `session_v2`。
>
> 实现依据：`packages/schema/src/session-sandbox-resource.ts`（格式 schema）、`packages/protocol/src/groups/session.ts`（create/patch 的 `sandbox` 字段）、`packages/core/src/sandbox/provider.ts`（`resource: session?.sandbox ?? config.resource`）、`packages/core/src/sandbox/config.ts`（`OPENCODE_SANDBOX_CPU`/`OPENCODE_SANDBOX_MEMORY` 兜底，默认 `2` / `4Gi`）。
>
> 环境：按 `docs/local-test-env.md` 启动 SaaS + PG + OpenSandbox；`source docs/test-cases/test-env.sh 3` 提供 `BASE`/`PG_URL`/`OPENCODE_PASSWORD`。

## 格式校验规则

| 字段 | 正则 | 合法示例 | 非法示例 |
|------|------|---------|---------|
| cpu | `/^\d+(\.\d+)?m?$/` | `1`, `0.5`, `500m`, `0.25` | `abc`, `-1`, `1.5.5`, `.5`, `5.` |
| memory | `/^\d+(Ki\|Mi\|Gi\|Ti\|K\|M\|G\|T)$/` | `2Gi`, `512Mi`, `1G` | `8gb`, `1024`, `-1Gi`, `1.5Gi`, `2 G` |

## 一、会话创建 — sandbox resource 写入验证

公共辅助：

```bash
source docs/test-cases/test-env.sh 3
api_curl() { curl -sS --fail-with-body -u "opencode:$OPENCODE_PASSWORD" "$@"; }
api_raw()  { curl -sS -u "opencode:$OPENCODE_PASSWORD" "$@"; }
```

### T29.1 创建带 sandbox resource 的会话 — API + PG 双重验证

```bash
RESP=$(api_raw -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
  -d '{"model":{"providerID":"Yd-DeepSeek","id":"deepseek-v4-flash"},"sandbox":{"cpu":"2","memory":"4Gi"}}')
SID=$(printf '%s' "$RESP" | jq -er .data.id)
printf '%s' "$RESP" | jq -e '.data.sandbox == {"cpu":"2","memory":"4Gi"}'
psql "$PG_URL" -At -c "select sandbox from session_v2 where id='$SID'"
# 期望：API .data.sandbox 与 PG session_v2.sandbox 均为 {"cpu":"2","memory":"4Gi"}
api_raw -X DELETE "$BASE/api/session/$SID" -o /dev/null
```

### T29.2 不传 sandbox → 省略（创建沙箱时使用 env 兜底）

```bash
RESP=$(api_raw -X POST "$BASE/api/session" -H 'Content-Type: application/json' -d '{"model":{"providerID":"Yd-DeepSeek","id":"deepseek-v4-flash"}}')
SID=$(printf '%s' "$RESP" | jq -er .data.id)
printf '%s' "$RESP" | jq -e '.data.sandbox == null'
psql "$PG_URL" -At -c "select sandbox is null from session_v2 where id='$SID'"   # t
api_raw -X DELETE "$BASE/api/session/$SID" -o /dev/null
```

期望：响应与 PG 均无 `sandbox`；创建沙箱时使用 `OPENCODE_SANDBOX_CPU`/`OPENCODE_SANDBOX_MEMORY`（默认 `2`/`4Gi`）。

### T29.3 无效 cpu → 400

```bash
api_raw -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
  -d '{"model":{"providerID":"Yd-DeepSeek","id":"deepseek-v4-flash"},"sandbox":{"cpu":"abc","memory":"4Gi"}}'
# 期望：400
```

### T29.4 无效 memory → 400

```bash
api_raw -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
  -d '{"model":{"providerID":"Yd-DeepSeek","id":"deepseek-v4-flash"},"sandbox":{"cpu":"2","memory":"8gb"}}'
# 期望：400（小写 gb 不合法）
```

### T29.5 多资源格式组合

```bash
for r in '{"cpu":"1","memory":"2Gi"}' '{"cpu":"0.5","memory":"1Gi"}' '{"cpu":"500m","memory":"512Mi"}' \
         '{"cpu":"0.25","memory":"256Mi"}' '{"cpu":"100m","memory":"128Mi"}' '{"cpu":"4","memory":"16Gi"}'; do
  RESP=$(api_raw -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
    -d "{\"model\":{\"providerID\":\"Yd-DeepSeek\",\"id\":\"deepseek-v4-flash\"},\"sandbox\":$r}")
  SID=$(printf '%s' "$RESP" | jq -er .data.id)
  printf '%s -> %s\n' "$r" "$(printf '%s' "$RESP" | jq -c .data.sandbox)"
  api_raw -X DELETE "$BASE/api/session/$SID" -o /dev/null
done
# 期望：每组响应回显与请求一致
```

## 二、从会话读取 resource 创建沙箱 — cgroup 验证

> 核心链路：`POST /api/session` 写入配置 → 首次 shell/keep-alive boot 创建沙箱时 `provider.createSandbox` 读取 `session_v2.sandbox` → `Sandbox.create({ resource })` → 沙箱内读 cgroup 验证实际限制。

### T29.6 从会话读取 resource → 创建沙箱 → cgroup 验证（V2）

```bash
SID=$(api_raw -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
  -d '{"model":{"providerID":"Yd-DeepSeek","id":"deepseek-v4-flash"},"sandbox":{"cpu":"2","memory":"4Gi"}}' | jq -er .data.id)
api_raw -X POST "$BASE/api/session/$SID/shell" -H 'Content-Type: application/json' \
  -d '{"command":"cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us /sys/fs/cgroup/memory/memory.limit_in_bytes"}' -o /dev/null
# 等 shell exited 后从 session_message 读输出：
psql "$PG_URL" -At -c "select data::jsonb->'output'->>'output' from session_message
  where session_id='$SID' and type='shell' and data::jsonb->>'status'='exited'
  order by seq desc limit 1"
api_raw -X DELETE "$BASE/api/session/$SID" -o /dev/null
```

期望（cgroup v2）：`cpu.max` 首列为 `200000 100000`（2 核），`memory.max` 为 `4294967296`。cgroup v1 沙箱对应 `cpu.cfs_quota_us=200000`、`memory.limit_in_bytes=4294967296`。

### T29.7 不传 sandbox → 默认 resource → cgroup 验证

同 T29.6，但不带 `sandbox` 字段；期望 cgroup 反映部署默认（本地默认 `2`/`4Gi`，即 `cpu.max=200000 100000`、`memory.max=4294967296`；以实例 env 为准）。

### T29.8 多资源组合 → cgroup 精确验证

对 T29.5 的规格抽样（如 `500m`/`512Mi` → `cpu.max=50000 100000`、`memory.max=536870912`）按 T29.6 流程验证。

### T29.16 PATCH + recreate（资源变更重建）

```bash
SID=$(api_raw -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
  -d '{"model":{"providerID":"Yd-DeepSeek","id":"deepseek-v4-flash"},"sandbox":{"cpu":"2","memory":"4Gi"}}' | jq -er .data.id)
# 触发创建沙箱
api_raw -X POST "$BASE/api/session/$SID/shell" -H 'Content-Type: application/json' -d '{"command":"echo boot"}' -o /dev/null
sleep 5
# PATCH 为小规格（SandboxResourceUpdated 事件；旧沙箱销毁，按需重建）
api_raw -X PATCH "$BASE/api/session/$SID" -H 'Content-Type: application/json' \
  -d '{"sandbox":{"cpu":"1","memory":"512Mi"}}' -o /dev/null -w 'patch=%{http_code}\n'
# 再次触发创建并读 cgroup（期望 quota 100000 / memory 536870912）
api_raw -X POST "$BASE/api/session/$SID/shell" -H 'Content-Type: application/json' \
  -d '{"command":"cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max"}' -o /dev/null
sleep 3
psql "$PG_URL" -At -c "select data::jsonb->'output'->>'output' from session_message
  where session_id='$SID' and type='shell' and data::jsonb->>'status'='exited'
  order by seq desc limit 1"
api_raw -X DELETE "$BASE/api/session/$SID" -o /dev/null
```

### T29.17 PATCH 不带 recreate

PATCH 后 GET 会话返回新配置，且不强制销毁运行中沙箱（下次重建才应用新规格）；用 `GET /api/session/:id` 与 `GET /api/session/:id/sandbox` 观察配置与沙箱实例的分离。

## 继承逻辑

- **子会话**：不传 `sandbox` 时沿 parent 链解析继承（Server 集成测试覆盖父/子/导入 fork 三类继承）。
- **fork**：继承原会话配置。
- **默认值**：会话与 env 均无配置时使用 `OPENCODE_SANDBOX_CPU`/`OPENCODE_SANDBOX_MEMORY`（默认 `2`/`4Gi`）。

## 历史实测记录

### 2.0 分支实测（2026-09-24）

| 验证 | 结果 | 实测 |
|------|------|------|
| API + PG 持久化 | PASS | `POST /api/session` 返回并写入 `{"cpu":"2","memory":"4Gi"}` |
| 无配置 / 格式校验 | PASS | 不传配置时响应省略 `sandbox`；非法 CPU、memory 均 HTTP 400 |
| 沙箱资源生效 | PASS | SDK 读取 cgroup：CPU quota `200000`、内存 `4294967296` |
| PATCH + recreate | PASS | PATCH 为 `1 CPU / 512Mi` 后旧实例销毁；重建 cgroup 为 quota `100000`、内存 `536870912` |
| 子会话 / fork 继承 | PASS | Server API 集成测试覆盖父会话、子会话、导入 fork 的配置继承 |
| 单元 / API 集成 | PASS | Schema、格式校验、持久化、继承、更新及默认不配置测试通过 |

当日遗留：远端沙箱 Pod Pending 导致 T29.6–T29.8、T29.14–T29.17 的 cgroup 复核未在当日完成（旧版 `signal/oomSuspected` 字段不属于 V2 验收项）。
