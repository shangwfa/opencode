# Session Plugins 测试用例（V2）

> **V2 化说明**：本文使用 V2 `/api` 路由、Basic Auth、camelCase 和 `{data: ...}` 响应。旧版 `/session/:id/plugins/create`、字符串 hook 和历史执行结论不再作为 V2 契约。
>
> **实现与验收状态（2026-10-09）**：V2 CRUD、PG schema、沙箱 Agent 和类型化 Hook 转发已迁移。本轮补齐 hook 域全覆盖（9 域桥回传 + generate/compact/title/context/permission 真实触发）、npm scoped 安装、spec 边界、configure 去重与 `/shutdown` 自愈，并修复 dispatch 合并回传时破坏 `tool.execute.after` typed error 的缺陷。API/PG 单测、主 E2E 全量、PVC/Snapshot 生命周期 **均已通过镜像级复测**（SaaS 镜像已用当前源码重建，含全部修复）。

## 范围

验证会话级 Plugin 定义的 CRUD、PG 持久化、资源 owner 共享、代码脱敏、沙箱内加载和 V2 类型化 hook 转发。Plugin 代码只在会话沙箱执行；SaaS server 不执行租户提交的代码。

> **协议边界**：当前 `source.type=code` / `npm` 是 SaaS 的 session hook-factory 格式，由沙箱 agent 执行并经 V2 类型化 hook 桥转发；它**不是** `packages/plugin/src/effect/plugin.ts` 的 `{id,effect}` 注册 API，也不是 Promise `{id,setup}` API。依赖官方 `context.session/tool/...` 注册域的插件当前不兼容；后续若需直接复用官方 Plugin API，必须另行设计沙箱 RPC Context 和 registration lifecycle。

## V2 契约

| 行为 | V2 请求/响应 | 断言要点 |
| --- | --- | --- |
| 列表 | `GET /api/session/:id/plugins` → `{data: Info[]}` | 按 name 排序；code source 只返回 `{type:"code"}`，不回显源码；npm 返回原始 spec |
| 创建/更新 | `POST /api/session/:id/plugins`，`{name,description,source}` → `{data: Info}` | 同名 upsert；ID/created 稳定、updated 严格递增 |
| 删除单个/全部 | `DELETE /api/session/:id/plugins/:name` / `DELETE /api/session/:id/plugins` → 204 | 幂等；Session 删除由 FK cascade 清理 |
| Source | `{type:"code",code}` 或 `{type:"npm",spec}` | inline code 上限 262144 UTF-8 字节，超限 413；不支持旧的 `enabled` 字段 |
| 资源域 | 内层子会话复用 parent owner；fork 创建独立 domain | 子会话写入父 owner 行；fork 不继承 |
| Hook | 类型化 `domain.name`，事件为单个可变对象 | 仅支持事件带 `sessionID` 且 JSON 可往返的 hook；修改后的 event 返回到 V2 hook 链 |
| 权限/错误 | 仅 `tool.execute.before` 可 veto；其他 Agent/hook 错误 fail-open | 禁止因 Plugin 加载或普通 hook 错误导致请求 500 |

### 首版 hook 范围

| V2 hook | Agent 路由 | 备注 |
| --- | --- | --- |
| `session.prompt` / `context` / `compaction` / `generate` / `title` / `model.request` | `/hook/session/{name}` | 请求事件含 sessionID |
| `tool.execute.before` / `tool.execute.after` | `/hook/tool/execute.{before\|after}` | before 可 veto；after 仅完成/错误事件 |
| `permission.evaluate` | `/hook/permission/evaluate` | 修改 effect/message 后由 core 消费 |

暂不支持 `shell.create.before`（事件无 sessionID）、HTTP Request/Response 活对象、`session.retry` 的 Error 对象、事件订阅、动态 tool 注册及 tool transform。分别由全局 shell、传输层对象序列化、Error 编码、事件总线订阅和 Session Tools/Location Plugin API 管理；不得把这些标成 session plugin 已覆盖。

## 前置条件

```bash
cd docs/test-cases
source ./test-env.sh 3
source ./test-lib.sh
```

组合 3 为本地 PG `opencode-v2-up` + 本地 OpenSandbox + SaaS 容器 `:14096`。所有 HTTP 请求使用 `api_curl`（Basic Auth）。执行任何模型用例时，必须另开 SSE 订阅 `GET /api/session/:sessionID/event`，按 [`skills/streaming-output-spec.md`](../skills/streaming-output-spec.md) 实时展示工具、文本、表单与执行状态。

## 一、API / 持久化

### T35.1 空状态、创建与脱敏

```bash
SID=$(new_session '{"title":"session-plugin-api"}')
api_curl "$BASE/api/session/$SID/plugins" | jexec "d['data']"
api_curl -X POST "$BASE/api/session/$SID/plugins" -H 'Content-Type: application/json' \
  -d '{"name":"marker","description":"test","source":{"type":"code","code":"export default async () => ({})"}}'
api_curl "$BASE/api/session/$SID/plugins" | jexec "d['data']"
```

期望：初始 `data=[]`；创建和列表返回 `id/name/description/source/time`；任何响应不得包含 `export default` 或提交的完整源码。

### T35.2 同名 upsert、PG 行与严格时间戳

```bash
api_curl -X POST "$BASE/api/session/$SID/plugins" -H 'Content-Type: application/json' \
  -d '{"name":"marker","description":"v2","source":{"type":"code","code":"export default async () => ({})"}}'
pgval "SELECT count(*) FROM session_plugins WHERE session_id='$SID' AND name='marker'"
pgval "SELECT id,time_created,time_updated FROM session_plugins WHERE session_id='$SID' AND name='marker'"
```

期望：同名仅一行，ID 与 `time_created` 保持不变，`time_updated` 严格递增；响应仍脱敏。

### T35.3 输入边界与不存在 Session

覆盖缺字段、非法名称/类型、未知 source、非法 JSON、262144/262145 UTF-8 字节（含多字节字符）、不存在 Session 和删除不存在名称。

期望：schema 错误 400；超限 413 且已有行不变；不存在 Session 404；删除幂等 204；不产生孤立行。

### T35.4 Session 隔离与 owner 语义

在 A/B 创建同名但不同 source，验证各自列表隔离。再创建 `parentID` 子会话，通过子会话写入并从父读取；另用有消息的父会话执行 fork。

期望：A/B 不串数据；内层子会话映射到父 owner、PG 仅一条定义；fork 无继承且独立写入；删除 Session 后 owner 行按 FK 规则清理。

### T35.5 npm source 与脱敏

分别 POST `{"type":"npm","spec":"@scope/package"}` 与锁定版本 spec。

期望：记录原始 spec；list/create 不返回 code；npm 安装仅发生于对应 session sandbox。用受控 fixture 验证安装失败只使 Agent health 降级，不阻断 Session 请求。

## 二、Runtime / Hook

### T35.6 Hook 下游消费

注册 `session.prompt` hook，原地修改 prompt 的唯一 marker；发送一次模型请求，并检查 SSE、持久化消息和 provider request 可观测记录。

期望：修改后的值被下游消费；不能只以 HTTP 200 或沙箱日志判通过。检查未注册 Plugin 的对照 Session 不出现 marker。

### T35.7 Tool before/after 与 veto

用确定性 Session Tool fixture 验证 before 修改实际工具输入、after 修改返回结果。再令 before 抛出带唯一原因的错误。

期望：before/after mutation 到达真实工具/消息结果；veto 不执行工具，错误作为明确 tool failure 呈现；不得返回未处理的 500。

### T35.8 Runtime 更新、删除与 Agent 重启

同一会话先注册 marker V1、触发 hook；upsert 为 V2 后再触发；删除后再触发；最后重启 SaaS 进程并再次触发。

期望：V2 替换 V1，删除后无 hook；服务重启后从 PG 重建沙箱 Agent。检查 `/health` 的 plugin 数、hook 列表、错误数，并验证 Session A/B 隔离。

### T35.9 错误隔离与安全边界

覆盖工厂语法错误、工厂抛错、无合法导出、未知 hook、普通 hook 抛错、hook 超时及恶意文件/网络/子进程探针（仅在隔离安全环境执行）。

期望：坏插件被隔离且健康插件继续工作；普通 hook fail-open；只有 `tool.execute.before` 可 veto；动态代码权限边界必须以沙箱实测，不得以 allowlist 代替安全证明。

## 自动化覆盖与当前执行结果

| 验证 | 位置 | 当前状态 |
| --- | --- | --- |
| Schema / wire contract | `packages/schema/src/session-plugin.ts`、`packages/protocol/src/groups/session.ts` | 已实现，类型检查通过 |
| API CRUD、脱敏、边界、owner/fork/cascade | `packages/server/test/session-plugins.test.ts` | 已执行：5 pass、50 assertions；含精确 ASCII/多字节 UTF-8 上限、child/fork 资源域和 API 隔离 |
| PG migration / 持久化 | migration、`packages/core/test/session/session-plugins-pg.test.ts` | migration check 通过；PG/resource-owner 测试 8 pass、15 assertions；FK cascade 用 PG 删除 Session 验证 |
| npm / 错误隔离 | `session-plugins-v2-e2e.mjs` | 有效 `debug@4.4.1` 加载；无效 spec、语法错、工厂抛错、无导出隔离；普通 Hook 错误和 5s 超时 fail-open，SSE 请求成功 |
| Hook / Tool / 会话隔离 | `session-plugins-v2-e2e.mjs` | 主 E2E 通过：prompt 消费及持久化消息、未安装插件对照、before/after 实际结果 mutation、before veto、独立 Session marker 隔离 |
| Hook 域全覆盖 | `session-plugins-v2-e2e.mjs` | 9 个类型化 hook 的 Agent 桥回传逐一通过；`session.generate`/`model.request`（generate API）、`session.compaction`（compact API）、`session.title`+`session.context`（untitled 会话首轮）真实派发通过；`permission.evaluate` 经内置 glob 工具 deny（`permission.rejected` + hook message）通过 |
| dispatch typed-error 修复 | `packages/core/src/session/plugins.ts`、`session-plugins-perm-deny-fix-v2.mjs` | 修复：Agent 回传 event 合并曾把 `tool.execute.after` 的 `error` 实例覆盖为 JSON 普通对象，导致 `yield* afterEvent.error` 崩溃（错误 `undefined is not a function`）。现合并时保留 server 侧 typed error。针对性回归脚本在源码服务上通过 |
| npm 覆盖 | 单测 + `session-plugins-v2-e2e.mjs` | spec 512/513 边界（200/400）；scoped 包 `@npmcli/fs` 完成解析+安装+模块加载（其 default export 为 `fs.cp`，被当 factory 调用报 TypeError 并隔离——预期行为，非缺陷）；无效 spec 隔离 |
| Agent configure/shutdown | `session-plugins-v2-e2e.mjs` | 相同代次 `/configure` 不重载（loaded 行数不变）、变化代次重载；`/shutdown` 后 Agent 退出且下一次 Hook 触发自愈恢复 marker |
| Agent 重启、热更新、删除及并发 | `session-plugins-v2-e2e.mjs` | SaaS 容器重启、Agent PID 重启恢复通过；热更新/删除清除通过；两 Pod 12 个并发 upsert 后，运行时消费 PG 中最终 winner。该结果不证明严格线性化 |
| 安全探针 | `session-plugins-v2-e2e.mjs` | 沙箱内 `/tmp` 文件、子进程、loopback 探针通过；Docker inspect 确认非 privileged、no-new-privileges、SYS_ADMIN/NET_ADMIN 已 drop。仅为边界探针，不构成完整隔离安全证明 |
| PVC / Snapshot 生命周期 | `session-plugins-persistence-v2-e2e.mjs` | PVC 与 Snapshot 均通过（含镜像级复测）：回收后 workspace 文件和插件 Hook 改写的持久化 prompt 恢复；PG 中快照被消费（`stale|1|restored`） |
| 官方 Plugin API 兼容 | 沙箱 Agent | 未实现/未测试；不承诺 `{id,effect}` 或 `{id,setup}` 插件兼容 |

真实接口执行器：`docs/test-cases/scripts/session-plugins-v2-e2e.mjs`。设置 `BASE`、`BASE_SECOND`、`OPENCODE_PASSWORD`、`PG_URL`、`MODEL`、`SANDBOX_IMAGE` 后执行；Snapshot/PVC 生命周期使用 `docs/test-cases/scripts/session-plugins-persistence-v2-e2e.mjs`（支持 `PERSIST_MODES`）；dispatch 修复回归使用 `docs/test-cases/scripts/session-plugins-perm-deny-fix-v2.mjs`。模型轮次前订阅 GET Session SSE。2026-10-09：SaaS 镜像以当前源码重建（根目录 `Dockerfile` 源码镜像，`docker build -t opencode-saas-session-plugin-verify:local .`）后，镜像模式主 E2E（两个 SaaS 容器 + SaaS 容器重启用例）与 PVC/Snapshot 生命周期 E2E 全量通过。

**未完成/限制项**：多 Pod 并发测试验证最终 PG winner 被消费，不覆盖“旧请求晚到覆盖新版本”的竞态；安全探针不涵盖外网/路径逃逸，不能视为完整沙箱安全认证。`description` 字段实现与文档均无长度上限约定。npm 安装 120s 超时分支无用例。注意：镜像级复测时外部模型网关（`claude.shadow-rpa.net`）曾短暂 TLS 不可达，等待恢复后通过；该故障与本功能无关。

运行：

```bash
cd packages/server && bun test test/session-plugins.test.ts
bun run --cwd packages/schema typecheck
bun run --cwd packages/protocol typecheck
bun run --cwd packages/core typecheck
bun run --cwd packages/server typecheck
cd packages/core && bun run migration -- --check
```

## 已知实现风险（不可忽略）

1. agent 启动使用沙箱文件锁单例；每个 hook 从 PG 读取 owner rows 并发送配置。并发更新已通过最终 winner 消费测试，但旧快照晚到时的线性化仍未保证。
2. 删除 Session 的 Sandbox 生命周期清理及 agent `dispose` 尚未接入专用释放路径。PVC/Snapshot 回收重建与发布镜像均已验证。
3. HTTP hook event 必须 JSON 往返。安全探针已覆盖沙箱内文件、子进程和 loopback；尚未覆盖非 JSON/超大/cyclic payload、外网拒绝、路径逃逸及敏感日志检查，不能视为完整隔离证明。

## V1 历史

旧版 T35.1–T35.64 使用 `/session/:sid/plugins/create`、PG `session_plugins` V1 schema 与字符串 Hook 名（如 `chat.params`）。其 2026-07 至 2026-09 执行记录仅说明 V1 当时的行为，不能作为 V2 验收证据；历史版本可从 Git 记录查阅。
