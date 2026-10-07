# Session MCP（会话级动态 MCP）— V2

> **V2 契约**：`/api/session/:sessionID/mcps`，payload `{name, config}`；`config` 为 tagged union（`Mcp.LocalConfig | SessionMcp.RemoteConfig`），**remote 必须显式 `oauth:false`**；`disabled` 取代 V1 `enabled`（语义反转）。契约定义 `packages/schema/src/session-mcp.ts`，服务实现 `packages/core/src/session/mcps.ts`（存储 + 连接 + reconcile 一体），HTTP 层 `packages/protocol/src/groups/session.ts` + `packages/server/src/handlers/session.ts`。

## V2 执行记录 2026-10-05（V1 对比借鉴：T22.21–T22.23）

> **背景**：对比 `feat/opencode-1.18.31`（V1 线上验证实现）与当前 V2 的 session-mcp 链路，识别出 V1 做得好、V2 确实缺失的点，按"先沉淀用例 → 复现 → 修复 → 复测"流程执行。

### V1 vs V2 关键差异结论

| 维度 | V1 | V2 | 评估 |
|------|----|----|------|
| 沙箱残留进程兜底 | 启动前 `pkill` 同端口 supergateway + stale pid 批量清理 | 仅 kill 自己 pid 文件内进程 | **V2 缺口，已修复（T22.21）** |
| 连接重试窗口 | 30 次 × 2s（~60s，适配慢启动/pod 回收） | 20 次 × 250ms（5s） | V2 过短，已修复（T22.22） |
| 工具发现总闸门 | `describeCodeMode` 外层 `Effect.timeout("30 seconds")` + 降级空对象 | 无总超时，reconcile 串行 connect 累积 | 已修复（T22.23，软闸门实现） |
| 配置漂移检测 | 无（缓存不校验配置变化） | reconcile + `isDeepStrictEqual` | V2 更好 |
| 子会话共享 | 无（按 sessionID 直查，子会话拿不到） | `SessionResourceOwner` 上溯共享 | V2 更好（行为差异，迁移用例注意） |
| 写后生效 | upsert 后 `clearSessionCache` 全量断开 | 下次 select reconcile 增量重建 | V2 更好 |
| endpoint 重解析 | 每次重试重新解析（防 pod 回收 URL 过期） | 循环内重新解析 | 等价（V2 已吸收） |

### T22.21 沙箱残留 supergateway 兜底清理（已修复）

**问题**：SaaS 服务重启后 `runtimes` 内存丢失，keep-alive/快照沙箱中旧 supergateway 仍占 9100 端口；新 bridge 同端口启动失败（nohup 后台启动 exitCode 恒 0，现有检查发现不了），且新 pid 文件覆盖后指向已死进程，后续 stop 永远 kill 不掉旧僵尸。

**修复**（`packages/core/src/session/mcps.ts` `bridgeStartCommand`，借鉴 V1 并加固）：
1. 启动前先按 pid 文件精确 kill；
2. `pkill -f 'supergatewa[y].*--port {port}( |$)'` 端口级兜底——`( |$)` 词边界防 9100 误杀 91001，字符类 `[y]` 防 pkill 匹配到启动 shell 自身命令行；
3. `sleep 0.5` 等 SIGTERM 异步生效（与 V1 线上参数一致）。

**测试**（`packages/core/test/session-mcps.test.ts` `SessionMcps stale bridge cleanup` 2 用例，先失败复现后修复通过）：断言生成命令含 pid kill / pkill 且均位于 `nohup` 之前、词边界存在、`bash -n` 语法通过；真实进程验证：本机起两个假 supergateway（`--port 9100` / `--port 91001`），执行生成命令中的 pkill 模式，9100 死、91001 活。

**E2E 状态**：执行中（场景：MCP 连上后 `docker restart` 服务容器模拟 runtimes 丢失，沙箱 keep-alive 保留 → 再 prompt → 断言工具可用、旧 bridge 被杀、仅剩 1 个进程、pid 文件一致）。已知执行器问题待修：`session.shell.ended` 事件 data 不含命令输出文本，shell 输出应从 `GET /api/session/:id/context` 的 shell part 读取（与 V1 `/exec` 直返 stdout 不同）。

### T22.22 连接重试窗口（已实现）

`bridgeRetryDelay(attempt)` 指数退避（250ms ×2，上限 2s），单 server 就绪预算 `BRIDGE_RETRY_BUDGET_MS = 60s`（对齐 V1 30×2s），deadline 驱动循环取代固定 20×250ms；`config.timeout.startup` 仍独立控制 SDK 单次连接超时（两层各司其职）。

### T22.23 reconcile 总闸门（已实现）

`RECONCILE_BUDGET_MS = 30s` 软闸门（V1 `describeCodeMode` 语义）——每个 connect 前 clamp `min(剩余, 60s)`，预算耗尽 logWarning + 跳过（下次 select 带新预算重试）。**取舍说明**：选择软闸门而非 V1 的 `Effect.timeout` 硬中断，因为硬中断会留下已 fork 未 close 的 scope 与半开 client（泄漏）；软闸门上界为"预算 + 最后一次 connect 的 SDK startup timeout"（~60s），仍远优于无闸门的串行无限累积。

**T22.22/T22.23 测试**（`SessionMcps connect retry cadence` 3 用例）：退避序列精确值（250/500/1000/2000/2000…）、60s 预算内 ≥30 次尝试（≥ V1）、`RECONCILE_BUDGET_MS ≤ BRIDGE_RETRY_BUDGET_MS` 分层关系防退化。

### 已知问题与限制（含验证结论，2026-10-08 更新）

1. **并发 reconcile 无锁**：~~同一 session 并发 select 可能双连同一端口~~（**已修复**：reconcile 套 per-owner `KeyedMutex`，见 T22.25 修复项 4）；
2. **主/子会话端口冲突（2026-10-07 T22.25 实证并修复）**：`runtimes` 曾以 `session.id` 为 key、端口分配只看本会话 current——共享沙箱的主/子会话各自起 bridge 且都从 9100 分配，端口级 pkill 互杀，`SessionExpiredError` 无恢复路径。已修复：runtimes/锁/端口池按 resource owner 维度共享（单一 bridge 复用）、release owner-gated、`onSessionExpired`/`onClose` 驱逐 + call 透明重试。复跑三观察点全 PASS；
3. **nohup exitCode 恒 0**：`sandbox.run` 成功不代表 bridge 存活，实际失败靠轮询暴露（T22.21 的 pkill 兜底 + T22.31 的 call 全失败驱逐重试已覆盖）；
4. **孤儿端口泄漏（2026-10-08 T22.32 已修复，V1 借鉴项）**：SaaS 重启后 name→端口映射漂移的孤儿进程此前无人清理直到沙箱销毁。已实现沙箱级批量清扫（`bridgeSweepCommand`）——仅在本 owner 无任何带端口活 runtime 时执行（此刻沙箱内所有 supergateway 均为孤儿），较 V1 的每 session 盲杀更精确；T22.32 实证旧 pid 全清、新 bridge 重建、无孤儿；
5. **V1→V2 迁移注意**：ID 前缀 `smc_` → `smcp_`、`enabled` → `config.disabled` 语义反转、扁平列 → config jsonb；
6. **stop 幂等标记先于 Scope.close（2026-10-08 复核：非问题）**：Effect `Scope.close` 自身幂等（`scopeCloseUnsafe` 对 Closed 态 no-op，二次 close 安全），且 `Scope.fork(root)` 的子 scope 在服务停机时由 root 兜底关闭——中断窗口的最坏代价仅是运行期一个 client 对象延迟释放，停机时正确清理；
7. **evict 与重连的 pid 误杀窗口（2026-10-08 实证分析并修复）**：`bridgeStopCommand` 按 pid 文件**当前内容**杀进程，迟到的 evict 与同 name 重连交错时可能读到**新 runtime 覆写后的 pid** 而误杀新 bridge（窗口极窄，且有 T22.31 自愈兜底，故为低危）。已修复：evict 套 owner 锁——持锁期间 kill 完成时 pid 文件未被覆写（reconcile 排队其后）；fork 回调只排队不重入，无死锁。T22.31 复跑验证。可选加固（未做）：`bridgeStartCommand` 向 stdout 回显 pid、runtime 持真实 pid、kill 按 pid 精确执行，彻底不依赖 pid 文件；
8. **多 pod 固有限制**：runtimes/backoffs 为单实例内存态，跨 pod 不共享（V1 同样限制，Location 服务路由保证同一会话的请求落到同实例）。

## V2 执行记录 2026-09-27

> **环境**：Docker `opencode-saas-mcp-v2:local`（`localhost:14099`）、PostgreSQL `opencode-v2-up`、本地 OpenSandbox（`supergateway` 已内置于 sandbox 镜像）、`Yd-DeepSeek/deepseek-v4-flash`。
>
> **结果**：本文件 T22.1–T22.19 全部用例已按 V2 契约重跑，全部通过。Core Tool overlay 单测 40/40、Server CRUD API 单测 1/1（16 assertions）通过；Docker HTTP + PG、真实模型 remote/local MCP 调用均通过。

| 用例                         | 结果 | 证据                                                                                                                                             |
| ---------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| T22.1 local 创建             | ✅   | `command:["npx","shadcn@latest","mcp"]+environment` 返回 `type=local`、command 3 段、`disabled=true`；PG 一致                                    |
| T22.2 remote 创建            | ✅   | `url+headers:{Authorization:"Bearer test-token"}` 返回完整；PG 一致                                                                              |
| T22.3 列表                   | ✅   | local+remote 同列 count=2                                                                                                                        |
| T22.4 同名 upsert            | ✅   | local→remote 替换后单条记录、type 变更、command 清空                                                                                             |
| T22.5 删除                   | ✅   | DELETE 204，列表/PG 移除                                                                                                                         |
| T22.6 清空                   | ✅   | `DELETE /api/session/:id/mcps` 204，列表空                                                                                                       |
| T22.7 会话隔离               | ✅   | A/B 同名 `shared`，A=local、B=remote；PG 两条                                                                                                    |
| T22.8 Session 删除级联       | ✅   | 删 session 前 PG 1 条、删除后 0 条（FK ON DELETE CASCADE），DELETE 204                                                                           |
| T22.9 不存在 Session         | ✅   | create/list 均 404（V2 收紧了 V1 list=200 的特例）                                                                                               |
| T22.10 缺必填字段            | ✅   | 缺 name、缺 config 各 400                                                                                                                        |
| T22.11 完整字段持久化        | ✅   | headers `x-token/x-extra` 完整落 PG                                                                                                              |
| T22.12 disabled 持久化       | ✅   | `disabled:true` 持久化且不建立连接                                                                                                               |
| T22.13 remote 工具执行 E2E   | ✅   | 模型经 Code Mode 调用 `echo.echo`，`metadata.toolCalls` completed，输出 `ECHO:session-mcp-e2e`                                                   |
| T22.14 local 工具执行 E2E    | ✅   | sandbox 内经 `supergateway` 桥接，模型调用 `sandbox_everything.echo` 返回 `Echo: hello-sandbox-mcp`；第二轮 pid 不变（25），连接复用不再启动进程 |
| T22.15 多轮可用              | ✅   | 同 session 三轮 `ECHO:round-1/2/3` 均返回，工具注入在每轮 step 循环生效                                                                          |
| T22.16 local/remote 互斥校验 | ✅   | local 缺 command、command=[]、remote 缺 url、remote 未显式 `oauth:false`、非法 name 均 400，PG 无记录                                            |
| T22.17 environment 注入      | ✅   | `MCP_ENV_TEST=hello-env-value` 经 `env` 前缀进入 MCP 进程，`/tmp/mcp-env-test` 内容为 `hello-env-value`                                          |
| T22.18 shell 安全            | ✅   | 恶意 name `bad;touch /tmp/mcp-name-pwned;#` 被 Schema 拒绝 400；恶意 env key 经 quote 无注入（无 `ENV_PWNED`），`SAFE_MARKER` 正常写入           |
| T22.19 local 生命周期        | ✅   | 启动后存在 `pid_everything-9100.pid/.log`；`DELETE .../mcps/pid_everything` 后进程 `PROC_GONE`、pid/log 删除；删 session 204、PG count=0         |

### 执行中发现并修复的问题

1. **shell 转义错误导致 local MCP 桥接无法启动**：`shellQuote` 的引号替换串写反，`supergateway` 启动命令报 `unexpected EOF while looking for matching '`。已修正为标准 POSIX 转义并去掉 `sh -lc` 多余嵌套层。
2. **endpoint 策略不一致**：Session local MCP 桥接原先强制直连 endpoint；已改为 `SandboxConfig.useServerProxy` 策略（2026-10-05 起为 `mcpUseServerProxy`，A/B/C 部署矩阵）。
3. **运行时生命周期补强**：`remove/clear` 同步关闭已建连接并杀桥接进程/清 pid-log；`Session.remove` 在销毁 sandbox 前 `release` 全部 MCP 连接；端口分配避免冲突。
4. **测试夹具误判记录**：单 transport 夹具跨测试复用报 `Server already initialized` 被误判为产品缺陷；升级为按 `mcp-session-id` 路由的多会话夹具后通过。

## V2 设计约束

1. `session_mcps` 只保存可序列化配置；连接、client、端口和进程均是 Location 运行时状态，绝不持久化。
2. Session MCP 不注册进 Location 全局 Tool registry。`SessionContext.select` 为当前 session 构造不可变 Tool overlay，以同一 `Tool.snapshot` 执行/权限路径注入，避免同工作目录不同 session 相互可见。
3. Session local MCP 在 SaaS Sandbox 启用时，经 session 自己的 Sandbox 以 `supergateway` stdio→Streamable HTTP 桥接；command、environment 和路径均逐值 shell quote，server name 限制为 `[A-Za-z0-9_-]{1,64}`（Tool namespace 安全）。
4. Session remote MCP 使用 V2 的 headers、timeout、protocol 和 codemode 语义，但**必须显式 `oauth: false`**。OAuth credential 和授权回调属于全局 Integration/Credential 域。
5. 子会话经 `SessionResourceOwner` 与主会话共享 MCP 定义（fork 除外）；`remove/clear` 即时断连并杀沙箱 bridge；session 删除时主/子会话各自 `release`，仅主会话销毁共享沙箱。

## 公共配置

```bash
# 环境：组合 3（本地 PG opencode-v2-up + 本地 OpenSandbox + SaaS 容器 :14096），见 docs/local-test-env.md
# 认证：Basic opencode:<OPENCODE_PASSWORD>（容器未显式设置时密码在 docker logs 的 "server password" 行）
# SSE 等无法带 header 的场景用 ?auth_token=base64(opencode:<password>)
```

```js
// 通用脚本模板（bun -e 或 .mjs 均可）
const BASE = "http://localhost:14096"
const PASSWORD = process.env.OPENCODE_PASSWORD ?? "<docker logs 抓取>"
const MODEL = { providerID: "Yd-DeepSeek", modelID: "deepseek-v4-flash" }
const H = { "Content-Type": "application/json", Authorization: "Basic " + Buffer.from(`opencode:${PASSWORD}`).toString("base64") }
const api = (path, init = {}) => fetch(BASE + path, { ...init, headers: { ...H, ...(init.headers ?? {}) } })

// 创建会话（V2 响应为 { data: { id } }，区别于 V1 顶层 id）
const { data: session } = await (await api("/api/session", { method: "POST", body: JSON.stringify({ title: "..." }) })).json()
const SID = session.id

// 沙箱执行命令（V2：POST shell 返回 204，输出从 context 的 shell part 读回；区别于 V1 /exec 直返 stdout）
await api(`/api/session/${SID}/shell`, { method: "POST", body: JSON.stringify({ command: "echo hi", timeoutSeconds: 120 }) })

// 轮询工具调用完成（prompt 为异步提交，V2 轮询 context；亦可用 POST /prompt_stream 的 SSE 流式等待）
const waitForTool = async (prefix, expected, timeoutMs = 120000) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const msgs = (await (await api(`/api/session/${SID}/context`)).json()).data ?? []
    for (const m of msgs)
      for (const p of m.parts ?? [])
        if (p.type === "tool" && p.tool?.startsWith(prefix) && p.state?.status === "completed") {
          const output = JSON.stringify(p.state)
          if (output.includes(expected)) return true
        }
    await new Promise((r) => setTimeout(r, 3000))
  }
  return false
}

// keep-alive（防沙箱回收，V2 路径在 /api/experimental 下）
await api(`/api/experimental/session/${SID}/keep-alive`, { method: "POST", body: JSON.stringify({ enabled: true }) })
```

**V2 API 速查**：

| 操作 | 端点 | payload/说明 |
|------|------|--------------|
| 列表 | `GET /api/session/:id/mcps` | `{data: Info[]}`，按 name 排序 |
| 创建/更新 | `POST /api/session/:id/mcps` | `{name, config}`，`(session_id,name)` upsert |
| 删除单个 | `DELETE /api/session/:id/mcps/:name` | 204，即时断连并杀沙箱 bridge |
| 清空 | `DELETE /api/session/:id/mcps` | 204 |
| local config | — | `{type:"local", command:string[], environment?, codemode?, timeout?}` |
| remote config | — | `{type:"remote", url, headers?, oauth:false, codemode?, timeout?, protocol?}` |

**PG 检查**（本地组合 3）：

```bash
psql 127.0.0.1:5432/opencode-v2-up -c "SELECT name, config, time_created, time_updated FROM session_mcps WHERE session_id='<SID>';"
```

---

### T22.1–T22.9 通用 CRUD 生命周期

> 按 [`00-preamble.md` 附录 A](./00-preamble.md) G1–G9 通用清单执行，资源路径 `/api/session/:id/mcps`，PG 表 `session_mcps`（列：`id(smcp_ 前缀)/session_id/name/config(jsonb)/time_created/time_updated`）。

| 用例  | 清单 | 资源参数                                                                                                                         | V2 特有期望                                                                                                       |
| ----- | ---- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| T22.1 | G1   | local：`{name:"sandbox-shadcn", config:{type:"local", command:["npx","shadcn@latest","mcp"], environment:{NODE_ENV:"production"}}}` | 返回 `config.type=local`、command 数组；PG config jsonb 一致                                                      |
| T22.2 | G1   | remote：`{name:"search-api", config:{type:"remote", url:"https://search.example.com/mcp", headers:{Authorization:"Bearer t"}, oauth:false}}` | 返回完整 remote config；PG 一致                                                                                   |
| T22.3 | G2   | 建 mcp-a(local) + mcp-b(remote)                                                                                                  | local/remote 同列表，count=2                                                                                      |
| T22.4 | G3   | my-mcp：local v1 → remote v2                                                                                                     | config 整体替换、列表 count=1、`time_updated` 单调递增（`max(now, old+1)`）                                       |
| T22.5 | G4   | 删 to-delete                                                                                                                     | DELETE 204，列表/PG 移除；沙箱 bridge 进程被杀、pid/log 清除                                                      |
| T22.6 | G5   | 建 m1/m2 后清空                                                                                                                  | DELETE 204，列表/PG 空                                                                                            |
| T22.7 | G6   | A/B 各建同名 shared（A=local，B=remote）                                                                                         | A 显示 local，B 显示 remote；PG 两条（会话隔离）                                                                   |
| T22.8 | G7   | 删除 session                                                                                                                     | DELETE session 204；PG 级联 COUNT=0（FK ON DELETE CASCADE）；此后 GET mcps 404（V2 无 V1 的 200 空列表特例）      |
| T22.9 | G8   | ses_NOTEXIST create/list/delete                                                                                                  | **三者均 404**（V2 收紧：V1 时代 create/list/delete 曾为 500/200/500，见历史记录）                                 |

### T22.10 输入校验：缺少必填字段

```js
// 缺 name
await api(`/api/session/${SID}/mcps`, { method: "POST", body: JSON.stringify({ config: { type: "local", command: ["echo"] } }) })   // expect 400
// 缺 config
await api(`/api/session/${SID}/mcps`, { method: "POST", body: JSON.stringify({ name: "no-config" }) })                              // expect 400
// 非法 config type
await api(`/api/session/${SID}/mcps`, { method: "POST", body: JSON.stringify({ name: "bad", config: { type: "invalid" } }) })       // expect 400
// 非法 name（schema 限制 [A-Za-z0-9_-]{1,64}）
await api(`/api/session/${SID}/mcps`, { method: "POST", body: JSON.stringify({ name: "bad;touch /tmp/pwned;#", config: { type: "local", command: ["echo"] } }) })   // expect 400
```

**期望**：以上均 400，PG 无记录。

### T22.11 完整字段持久化

```js
const res = await (await api(`/api/session/${SID}/mcps`, {
  method: "POST",
  body: JSON.stringify({
    name: "full-mcp",
    config: {
      type: "remote",
      url: "https://full.example.com/mcp",
      headers: { "x-token": "tok123", "x-extra": "extra456" },
      oauth: false,
    },
  }),
})).json()
console.log(res.name, res.config.type, res.config.url, JSON.stringify(res.config.headers))
```

**期望**：字段正确返回且完整落 PG（`config` jsonb 内 `headers.x-token/x-extra` 一致）；remote config 为 tagged union，仅接受 remote 专有字段。

### T22.12 disabled MCP 持久化

```js
const res = await (await api(`/api/session/${SID}/mcps`, {
  method: "POST",
  body: JSON.stringify({ name: "off-mcp", config: { type: "local", command: ["silent"], disabled: true } }),
})).json()
console.log(res.name, res.config.disabled, "(expect true)")
```

**期望**：`config.disabled=true` 持久化（V1 为顶层 `enabled=false`，V2 语义反转）；reconcile 跳过该 server，不建立连接、不启动沙箱进程。

### T22.13 Remote MCP 工具执行验证（E2E）

**前置**：宿主机起可从容器访问的 MCP server（`host.docker.internal:9105`）：

```bash
npx -y @modelcontextprotocol/server-everything &
npx -y supergateway --stdio "npx @modelcontextprotocol/server-everything" --port 9105 --outputTransport streamableHttp
```

```js
await api(`/api/session/${SID}/mcps`, {
  method: "POST",
  body: JSON.stringify({ name: "test-tools", config: { type: "remote", url: "http://host.docker.internal:9105/mcp", oauth: false } }),
})
await api(`/api/session/${SID}/prompt`, {
  method: "POST",
  body: JSON.stringify({ parts: [{ type: "text", text: "使用 test-tools 里的 echo 工具，echo 内容为 hello-mcp" }], model: MODEL }),
})
const ok = await waitForTool("test_tools_", "hello-mcp")
if (!ok) process.exit(1)
```

**期望**：Code Mode 下模型经 `execute` 内嵌调用 `test_tools_echo`，`metadata.toolCalls` 记录 completed，输出含 `hello-mcp`；`?codemode=false` 由客户端自动追加（服务器暴露原始工具）。

### T22.14 Local MCP 工具执行验证（Sandbox E2E）

**前置**：沙箱镜像内置 `supergateway`。

```js
await api(`/api/experimental/session/${SID}/keep-alive`, { method: "POST", body: JSON.stringify({ enabled: true }) })
// 沙箱安装 MCP server（输出从 context shell part 读回）
await api(`/api/session/${SID}/shell`, { method: "POST", body: JSON.stringify({ command: "npm install -g @modelcontextprotocol/server-everything 2>&1 | tail -1", timeoutSeconds: 240 }) })
await api(`/api/session/${SID}/mcps`, {
  method: "POST",
  body: JSON.stringify({ name: "sandbox-everything", config: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-everything"] } }),
})
await api(`/api/session/${SID}/prompt`, {
  method: "POST",
  body: JSON.stringify({ parts: [{ type: "text", text: "使用 sandbox-everything 里的 echo 工具，echo 内容为 hello-sandbox-mcp" }], model: MODEL }),
})
const ok = await waitForTool("sandbox_everything_", "hello-sandbox-mcp")
if (!ok) process.exit(1)
```

**期望**：
- 沙箱内经 supergateway 桥接（`/tmp/opencode-mcp/sandbox-everything-9100.{pid,log}`）启动成功；
- 工具调用 completed 输出含 `hello-sandbox-mcp`；
- 第二次调用复用 runtime（pid 不变，不再重启进程）——V2 reconcile 按 config 深比对，未变化不重连。

### T22.15 Session MCP 工具多轮持续可用

> 验证 V2 每个模型请求的 `SessionContext.select` 都注入 session MCP 工具（reconcile 每轮对账）。

```js
await api(`/api/session/${SID}/mcps`, {
  method: "POST",
  body: JSON.stringify({ name: "persist-tools", config: { type: "remote", url: "http://host.docker.internal:9105/mcp", oauth: false } }),
})
for (const text of [
  "使用 persist-tools 的 echo 工具 echo: round-1",
  "刚才用的是哪个 MCP 工具？确认它的名字。",
  "再次使用那个工具的 echo，echo: round-3",
]) {
  await api(`/api/session/${SID}/prompt`, { method: "POST", body: JSON.stringify({ parts: [{ type: "text", text }], model: MODEL }) })
}
const ok = (await waitForTool("persist_tools_", "round-1")) && (await waitForTool("persist_tools_", "round-3"))
if (!ok) process.exit(1)
```

**期望**：≥2 次 `persist_tools_echo` 调用成功，输出分别含 `round-1`、`round-3`（工具注入在每轮 step 循环生效）。

### T22.16 输入校验：local/remote 必填字段互斥

```js
const cases = [
  ["local missing command", { name: "bad-local-1", config: { type: "local" } }],
  ["local empty command", { name: "bad-local-2", config: { type: "local", command: [] } }],
  ["remote missing url", { name: "bad-remote-1", config: { type: "remote", oauth: false } }],
  ["remote missing oauth:false", { name: "bad-remote-2", config: { type: "remote", url: "https://x.example.com/mcp" } }],
]
for (const [label, body] of cases) {
  const res = await api(`/api/session/${SID}/mcps`, { method: "POST", body: JSON.stringify(body) })
  console.log(label + ":", res.status, "(expect 400)")
}
```

**期望**：全部 400，PG 无记录。remote 未显式 `oauth:false` 被 Schema 拒绝是 V2 新增校验（V1 无此约束）。

### T22.17 local MCP environment 真正注入到 sandbox 命令

```js
await api(`/api/session/${SID}/mcps`, {
  method: "POST",
  body: JSON.stringify({
    name: "env-everything",
    config: {
      type: "local",
      command: ["sh", "-lc", 'printf "$MCP_ENV_TEST" >/tmp/mcp-env-test && npx -y @modelcontextprotocol/server-everything'],
      environment: { MCP_ENV_TEST: "hello-env-value" },
    },
  }),
})
await api(`/api/session/${SID}/prompt`, { method: "POST", body: JSON.stringify({ parts: [{ type: "text", text: "列出并使用 env-everything 的 echo 工具 echo hello" }], model: MODEL }) })
// 等连接建立后读回文件
await api(`/api/session/${SID}/shell`, { method: "POST", body: JSON.stringify({ command: "cat /tmp/mcp-env-test 2>/dev/null || true" }) })
// 从 context shell part 读输出，期望 hello-env-value
```

**期望**：`/tmp/mcp-env-test` 内容为 `hello-env-value`（environment 经 `env` 前缀逐值 quote 后进入 MCP 进程）。

### T22.18 shell 安全：恶意 name/command/env 不应产生命令注入

```js
// 恶意 name：被 Schema 拒绝（[A-Za-z0-9_-]{1,64}）
const res = await api(`/api/session/${SID}/mcps`, {
  method: "POST",
  body: JSON.stringify({
    name: "bad;touch /tmp/mcp-name-pwned;#",
    config: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-everything"] },
  }),
})
console.log("malicious name:", res.status, "(expect 400)")

// 恶意 env key + 正常 value：name 合法（safe_name），env key 含注入载荷
await api(`/api/session/${SID}/mcps`, {
  method: "POST",
  body: JSON.stringify({
    name: "safe_name",
    config: {
      type: "local",
      command: ["sh", "-lc", "printf safe >/tmp/mcp-safe-marker && npx -y @modelcontextprotocol/server-everything"],
      environment: { SAFE_VALUE: "a b c ' quote", "BAD-ENV;touch /tmp/mcp-env-pwned": "x" },
    },
  }),
})
// prompt 触发连接后检查：SAFE_MARKER 存在、无 NAME_PWNED/ENV_PWNED
await api(`/api/session/${SID}/shell`, {
  method: "POST",
  body: JSON.stringify({ command: "test -f /tmp/mcp-safe-marker && echo SAFE_MARKER; test -f /tmp/mcp-env-pwned && echo ENV_PWNED; test -f /tmp/mcp-name-pwned && echo NAME_PWNED" }),
})
```

**期望**：恶意 name 400；输出含 `SAFE_MARKER`，不含 `NAME_PWNED`/`ENV_PWNED`（env key/value 均经 shellQuote）。单测层面由 `packages/core/test/session-mcps.test.ts` 的 quoting 用例固化（bash 双层解析 round-trip）。

### T22.19 local MCP lifecycle：pid/log 文件与清理（V2 语义）

> V2 的清理时机与 V1 不同：`DELETE /mcps/:name` 与 `DELETE /mcps` **即时**断连并杀 bridge；session 删除时主/子会话各自 `release`，仅主会话销毁沙箱。不再依赖 V1 的 abort + idle 回收路径。

```js
await api(`/api/experimental/session/${SID}/keep-alive`, { method: "POST", body: JSON.stringify({ enabled: true }) })
await api(`/api/session/${SID}/mcps`, {
  method: "POST",
  body: JSON.stringify({ name: "pid-everything", config: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-everything"] } }),
})
await api(`/api/session/${SID}/prompt`, { method: "POST", body: JSON.stringify({ parts: [{ type: "text", text: "使用 pid-everything 的 echo 工具 echo pid" }], model: MODEL }) })
await waitForTool("pid_everything_", "pid")

// 启动后：pid/log 存在、进程活着
await api(`/api/session/${SID}/shell`, { method: "POST", body: JSON.stringify({ command: "ls /tmp/opencode-mcp/pid-everything-9100.pid /tmp/opencode-mcp/pid-everything-9100.log; kill -0 $(cat /tmp/opencode-mcp/pid-everything-9100.pid) && echo ALIVE" }) })

// 删除单个 MCP → 即时清理
await api(`/api/session/${SID}/mcps/pid-everything`, { method: "DELETE" })
await api(`/api/session/${SID}/shell`, { method: "POST", body: JSON.stringify({ command: "ls /tmp/opencode-mcp/pid-everything-9100.* 2>/dev/null || echo FILES_GONE; kill -0 $(cat /tmp/opencode-mcp/pid-everything-9100.pid) 2>/dev/null && echo PROC_ALIVE || echo PROC_GONE" }) })
// 从 context 读回：期望 FILES_GONE + PROC_GONE

// 删 session → 204，PG 级联 0
await api(`/api/session/${SID}`, { method: "DELETE" })
```

**期望**：启动后 `pid-everything-9100.pid/.log` 存在且进程 ALIVE；删除 MCP 后 FILES_GONE + PROC_GONE；删 session 204 且 PG count=0。

### T22.21 沙箱残留 bridge 清理（服务重启场景，新增）✅ E2E 已执行（2026-10-07）

**场景**：MCP 连接建立后 SaaS 服务重启（`runtimes` 内存丢失），keep-alive 沙箱内旧 supergateway 仍占端口。

**执行结果**（r1 建立连接、bridge pid 55 → `docker restart` → r2）：

| 断言 | 结果 |
|---|---|
| round-1 工具成功（restart 前） | ✅ `Echo: round-1` |
| round-2 工具成功（restart 后） | ✅ `Echo: round-2` |
| 旧 bridge（55）被杀 | ✅ 进程消失 |
| 恰好一个 bridge + pid 文件一致 | ✅ 新 bridge pid 175 唯一存活 |

**执行注记**：restart 后存在 PG 转发的暂态 reconnect 窗口（本地组合 3 的 `host.docker.internal:15432` 转发特有；生产直连 PG 无此问题），脚本需在该窗口后重试；探测正则须避开 shell part 的 `command` 字段（输出以 `Q<n> /tmp/opencode-mcp/` 路径文本为特征，命令文本只含 `$f` 变量）。✅ PASS（4/4）

### T22.22 / T22.23 连接重试节奏与 reconcile 总闸门（新增，单测固化）

> 这两项为纯时序行为，以单测固化（`packages/core/test/session-mcps.test.ts` `SessionMcps connect retry cadence`），不依赖真实环境：

- 退避序列：`bridgeRetryDelay(0..3,10) = 250/500/1000/2000/2000` ms；
- 单 server 预算 `BRIDGE_RETRY_BUDGET_MS=60s` 内退避尝试次数 ≥ 30（对齐 V1）；
- 分层关系 `RECONCILE_BUDGET_MS(30s) ≤ BRIDGE_RETRY_BUDGET_MS(60s)` 防退化。

E2E 可观测点：慢启动 server（如 `npx` 冷启动 >5s）在 V2 下首次连接应成功（V1 同款 60s 窗口）；日志出现 `session MCP reconcile budget exhausted; deferring server` 时，被跳过的 server 在下一次请求重试。

### T22.24–T22.30 补充用例（2026-10-07 覆盖度分析新增）

> 对照 `mcps.ts` 实现逐特性核查后补齐的缺口：V2 的三个核心新行为（reconcile 漂移检测、子会话共享、多 MCP 端口分配）此前无用例。

#### T22.24 配置变更热更新（reconcile 漂移检测）— 高优 ✅ 已执行（2026-10-07）

> V2 核心优势（V1 缺失）：同名 upsert 修改 config 后，下一次请求自动断开旧连接、重启 bridge——`isDeepStrictEqual` 深比对。

**执行结果**（upsert 修改 mcp-b 的 command+environment）：漂移后旧 bridge（pid 93）被 stop（进程亡+pid 文件清除），新 bridge（pid 293）启动，新环境变量真实注入（`/tmp/mcp-rev`=`v2-drift`），echo 恢复成功；`time_created` 不变、`time_updated` 单调递增。✅ PASS（执行器初判 FAIL 系判定 bug：JSON 转义 `\n` 未剥离，已复核修正）。

#### T22.25 子会话共享 MCP（SessionResourceOwner）— 高优 ✅ 已执行并修复（2026-10-07）

> V2 关键行为差异：子会话沿 parentID 上溯共享主会话 MCP 定义（`stored()` 经 `SessionResourceOwner.id` 查表）。覆盖度分析发现：`runtimes` 原以 `session.id` 为 key（`mcps.ts` reconcile），端口分配只看本会话 current——子会话与主会话共享同一沙箱却各自起 bridge、均从 9100 分配 → 端口冲突；端口级 pkill 兜底杀掉主会话 bridge，且被杀方 reconcile 不恢复（config 未变、runtime 仍在 map）。

**首次执行（修复前）——缺陷实证**：

| 观察点 | 结果 | 证据 |
|---|---|---|
| 1. 子会话共享定义 | ✅ PASS | child round `Echo: round-child` completed |
| 2. 主会话不回归 | ❌ **FAIL** | child 连接后 parent 的 `sandbox_everything_echo` 报 **`MCP server session expired: sandbox-everything`**；旧 bridge（pid 54）已死、存活进程为子会话起的 pid 151（同端口 9100、stateful） |
| 3. 删子会话后恢复 | ❌ FAIL | 删除 child 204 后 parent 工具路由仍不可用 |

**缺陷机制**：子会话 bridgeStartCommand 的端口级 pkill 杀掉主会话 bridge → 主会话 Mcp-Session-Id 在新 bridge 上失效 → `SessionExpiredError` 无重连路径、reconcile 因 config 未变不重连 → 主会话 MCP 工具永久不可用。

**修复（2026-10-07，`mcps.ts` 单文件，按全局 MCP 服务的已验证模式）**：
1. `runtimes` key 改为 resource owner id——子会话直接复用主会话 runtime，单一 bridge 服务整个资源域；
2. `release` owner-gated——子会话删除 no-op（不误杀共享连接），主会话删除统一收口；
3. `remove`/`clear` 在 per-owner 锁内 stop 共享 runtime，与行删除语义一致；
4. reconcile 套 `KeyedMutex.withLock(ownerID)`（bus.ts 先例）——关闭并发 select 双连互杀缺口；
5. connect 后订阅 `client.onSessionExpired`/`onClose`（client 预留钩子，全局 MCP 同款 watch 模式）→ fork 驱逐死 runtime，下次 select 重建；
6. `call` 的 `MCP.SessionExpiredError` → 驱逐 + 重连 + 透明重试一次（`recovering()` 模式），调用方无感自愈。

**复跑（修复后，镜像 `opencode-saas-mcp-t1025:local`，`Yd-GLM/glm-5.3-flash`）**：

| 观察点 | 修复前 | 修复后 |
|---|---|---|
| 1. 子会话共享定义 | ✅ | ✅ `Echo: round-child` |
| 2. 主会话不回归 | ❌ session expired | ✅ `Echo: round-2` |
| 3. 删子会话后保持 | ❌ 永久失效 | ✅ `Echo: round-3` |
| bridge 进程 | 54 被杀 → 151 顶替 | **pidfile 全程 54 单一 bridge 复用** |

**执行器判定经验（复跑须知）**：① V2 context 消息是扁平 part 结构（assistant 消息的 `content[]` 内 `{type:"tool"}`），无 `parts` 数组；② Code Mode 下 MCP 工具经 `execute` 内嵌调用，判定须匹配工具真实输出（`Echo: <marker>`）而非 `sandbox_everything_*` part 名；③ `session.tool.success` 事件不含工具名，模型的 bash 兜底输出会误判；④ prompt payload 为 V2 扁平 `{text, model}`（`model.id` 非 `modelID`）；⑤ 沙箱无 `ps`，进程探测用 `/proc` 遍历；⑥ context 累积历史 shell part，标记提取取最后一次匹配。

#### T22.26 多 local MCP 端口连续分配 — 高优 ✅ 已执行（2026-10-07）

> V2 端口策略为 9100 起连续 +1（`BASE_PORT` + `while (usedPorts.has(port)) port += 1`），区别于 V1 步长 100。

**执行结果**：
- 双 MCP 并存：`mcp-a-9100.pid`(55) + `mcp-b-9101.pid`(93) 两 bridge ALIVE，两个 echo 均成功；
- 删 mcp-a：其 bridge 进程死亡、pid 文件清除，mcp-b 在 9101 不受影响（echo b-2 成功）；
- 新增 mcp-c：**回收复用 9100**（新 pid 217），与 mcp-b(9101) 并存，echo c-1 成功。
- ✅ PASS

#### T22.27 disabled ↔ enabled 切换 — 中优 ✅ 已执行（2026-10-07）

**执行结果**：`disabled:true` 后 bridge 进程消失、pid 文件清除、工具从目录移除（模型确认不可见）；upsert `disabled:false` 后新 bridge（pid 406）启动、echo 恢复成功。三态切换均即时生效（下一次 select）。✅ PASS

#### T22.28 连接失败降级不阻塞请求 — 中优 ✅ 已执行并修复（2026-10-07）

> reconcile 的 catch 路径：连接失败仅 logWarning 不拖死请求；同时验证 T22.23 软闸门是否饿死排在坏 server 之后的好 server。

**首次执行——软闸门设计缺陷实证**（坏 local `aaa-broken`（command 不存在，name 排序在前）+ 好 local `mcp-good`）：
- a. **饿死**：坏 server 每次吃光 30s 预算，好 server 每轮被 defer，永久不可用（模型查 47 个工具无任何 MCP）；
- b. **每请求 30s 税**：坏 server 无失败记忆，每个 select 同步重试 ~30s（r1 37s 中 ~30s 是 reconcile 等待）。

**修复（2026-10-07，方案 A：失败负缓存，`mcps.ts`）**：
- connect 失败记入 per-owner 负缓存（与 runtimes 同锁），退避 `connectBackoffMs(failures) = min(30s × 2^(n-1), 5min)`；
- 退避期内 reconcile 静默跳过（不占软闸门预算，好 server 获全额预算）；
- **config 深比对作为缓存有效性键**：upsert 修复定义后立即重试，不等 TTL（与漂移检测同构闭环）；
- 连接成功清除计数；`remove`/`clear` 清除对应缓存项；
- 失败时 logWarning 一条含 `failures`/`retryInMs`，跳过轮次静默（不刷屏）。

**复跑（修复后）**：

| 观察点 | 修复前 | 修复后 |
|---|---|---|
| 1. 坏 server 不阻塞请求 | ✅ 37s | ✅ 37s（首遇付一次 30s，预期内） |
| 2. 好 server 不被饿死 | ❌ 永久不可用 | ✅ r2 14.3s `Echo: good-1`（坏 server 被跳过，good 获预算） |
| 3. 修复定义立即生效 | —（无此路径） | ✅ r3 upsert 修复后 13.6s `Echo: fixed-1`（config 变更清除负缓存，无退避等待） |

单测：`SessionMcps connect failure backoff` 2 用例（退避序列 30/60/120/240/300s 封顶、首次退避 ≥ 一个完整预算窗口）。✅ PASS（3/3）

#### T22.29 codemode:false 的路由隔离 — 中优 ✅ 已执行并修复（2026-10-07）

> **语义修正**（原预期写反）：`codemode:false` 不是"工具不可见"，而是**绕过 Code Mode 执行平面、作为原生 direct 工具直接暴露**（`tool.ts:249/316`：`options.codemode === false` 的工具进 `direct` 列表，其余进 execute catalog）。

**缺陷实证**：首跑发现 `codemode:false` 完全无效——工具仍经 execute catalog 调用。根因：`codemode` 字段在 config 上而非 `McpClient.Tool` 上（client 仅用它做 `?codemode=false` URL 注入），SessionMcps 的 `tools()` 展开时只附加 `server` 漏了 `codemode` → `McpTool.create` 的 `tool.codemode !== false` 恒真。全局 MCP 无此问题（`mcp/index.ts:292-296` 的 `toTool` 显式附加）。

**修复**（`mcps.ts` `tools()`，对照全局 MCP 的 toTool 模式）：
```ts
runtime.tools.map((tool) => ({
  ...tool,
  server,
  ...(runtime.config.codemode === undefined ? {} : { codemode: runtime.config.codemode }),
}))
```

**验证**（修复后）：cm-on（默认）经 execute 路径（`Echo: on-marker` ✓）；cm-off（codemode:false）的调用变为**顶层原生工具 part（name=`cm-off_echo`，completed，`Echo: path-verify`）**——direct 路径实证，不再走 execute。✅ PASS（含 1 个缺陷修复）

#### T22.30 契约边界小项 — 低优 ✅ 已执行（2026-10-07，纯 API）

**执行结果**：name 64 字符 200 / 65 字符 400（schema 边界正确）；`time_created` upsert 后稳定、`time_updated` 单调递增；remove 后同名重建 200 且列表恢复。✅ PASS（3/3）

#### T22.31 bridge 死亡后的自愈（2026-10-07 新增，✅ 已执行并修复）

> 构造性验证：连接中杀死沙箱 bridge 进程 → 再次调用工具，模型必须无感知。覆盖 evict-onClose 与 call 重试两条自愈路径的分工。

**首跑——第 4 个缺陷实证**：杀 bridge 后工具**永久不可用**（r2/r3 均失败）。根因：ECONNREFUSED 类连接失败（1）不触发 `onClose`/`onSessionExpired`（无活跃 SSE 流时 transport 无感知）；（2）不匹配 `SessionExpiredError`（那需要 404/400 响应）→ call 重试不触发 → runtime 僵尸在 map（config 未变，reconcile 跳过）。`endpoint-resolved=0` 证明从未重连。

**修复**（`mcps.ts` `call`）：catchIf 从"仅 SessionExpiredError"扩展为**全部 callTool 失败**。安全性依据：`client.ts` 的调用约定中，工具业务错误走成功路径的 `CallToolResult.isError`，**任何 Effect failure 都是连接/协议级**——驱逐+单次重试是安全且正确的响应；重试路径补 logWarning（含原错误）。

**复跑（修复后）**：

| 断言 | 结果 | 证据 |
|---|---|---|
| kill 前工具可用 | ✅ | `Echo: before-kill`（bridge pid 54） |
| kill 后工具透明恢复 | ✅ | r2 `Echo: after-kill`，服务日志 `evicted and retrying` ×1、`endpoint-resolved` ×1（新 bridge pid 160） |
| 单一存活 bridge | ✅ | 旧 54 已死、pid 文件更新为 160、按 pid 去重后唯一（执行器断言需按 pid 去重——context 序列化同条目出现两次） |

#### T22.32 沙箱级 stale 批量清扫（V1 借鉴项，2026-10-08 新增）✅ 已执行并验证

> V1 `mcpCleanedSessions` 语义的升级实现：SaaS 重启后内存 runtimes 丢失，keep-alive 沙箱仍持有旧 bridge——含端口漂移孤儿（per-port 清理永远够不到的场景）。V2 的精确化：**仅当本 owner 当前无任何带端口的活 runtime 时**（此时沙箱内所有 supergateway 按定义都是孤儿）执行全量清扫，避免 V1 全目录盲杀在并发场景的误伤风险。

**实现**（`mcps.ts`）：`bridgeSweepCommand()`（pid 文件逐个 kill + 清除 + `pkill -f 'supergatewa[y].*--stdio'` 自匹配防护兜底）；reconcile 锁内、首个 local 连接前触发一次（per-owner `swept` 集合，服务重启自然重置——正是目标场景）。

**执行结果**（双 MCP：A=9100、B=9101 → `docker restart` → 再调用）：

| 断言 | 结果 | 证据 |
|---|---|---|
| restart 前双工具可用 | ✅ | `Echo: a-1` / `Echo: b-1`（bridge 59/97） |
| restart 后双工具恢复 | ✅ | `Echo: a-2` / `Echo: b-2`（sweep 后重建） |
| 旧 bridge 全部被清扫 | ✅ | pid 59/97 → **全新 228/266**，无 DEAD 残留 |
| 恰好 2 个 bridge、无孤儿 | ✅ | pid 文件恰 2 个且全 ALIVE、与存活进程一致 |

单测：sweep 命令 quoting（pid 文件遍历 + 清除 + `[y]` 防自匹配）。✅ PASS（4/4 行为断言）

**执行注记**：restart 后重抓密码须在就绪循环内（服务打印密码晚于容器就绪，过早读取拿到旧密码导致 401）；`/proc` cmdline 探测的 pattern 不可含字面空格（cmdline 为 NUL 分隔），pid 文件 + `/proc/<pid>` 存在性检查是更可靠的活性证据。

#### 可选补充（暂不展开正文）

- fork 会话不共享 MCP（`forkSessionID` 断链，`resource-owner.ts:46`）；
- session 删除时主会话 `release` 后销毁沙箱、子会话仅 release（`session.ts:493-544`，部分被 T22.25 步骤 6 覆盖）；
- 资源链跨 project/directory 的防御性 die（`resource-owner.ts:44-45`，内部防御，API 层难以构造）。

## 结果汇总

> **编号说明**：T22.20 与 T22.9 完全重复，2026-07-17 去重删除，编号保留断栏。
>
> **2026-10-07 修复后回归**（代码含 owner 共享/锁/release owner-gate/负缓存/codemode 传播全部修改，纯 API+PG 断言）：T22.5（remove 单个：204、列表/PG 清零）、T22.6（clear：204、列表/PG 空）、T22.8（级联：删 session 204 → PG 0 → list 404）、T22.9（不存在 session create/list/delete/clear 均 404）、T22.10（缺 name/config、非法 type 均 400 且 PG 无行）、T22.16（local 缺 command/空 command、remote 缺 url/oauth 均 400）、T22.11（remote 字段 API 与 PG config jsonb 一致）——**7/7 PASS**。
> ⚠️ 执行注记：session 创建后的沙箱异步拉起窗口内删除会返回 409（`Sandbox cleanup is incomplete; session and recovery points retained`），session 保留以便恢复——**既有设计行为，与 MCP 无关**（无 MCP 的 session 立即删同样 409，等待就绪后删 204）。回归脚本已按"等待就绪后删除"适配。


| 用例 | 状态 | 备注 |
| ---- | ---- | ---- |
| T22.1–T22.9 | ✅ | CRUD 生命周期（2026-09-27 全量重跑；2026-10-07 修复后回归 T22.5/6/8/9 PASS） |
| T22.10 | ✅ | 缺 name/缺 config/非法 type/非法 name → 400（10-07 回归 PASS） |
| T22.11 | ✅ | remote 完整字段持久化（headers 落 PG；10-07 回归 PASS） |
| T22.12 | ✅ | `config.disabled=true` 持久化且不建立连接 |
| T22.13 | ✅ | remote E2E：code-mode `execute` 内嵌调用，输出 `ECHO:session-mcp-e2e` |
| T22.14 | ✅ | local E2E：supergateway 桥接 + 连接复用（pid 不变） |
| T22.15 | ✅ | 多轮 3/3 可用（每轮 select 注入） |
| T22.16 | ✅ | local 缺 command/空 command、remote 缺 url、remote 缺 `oauth:false` → 400（10-07 回归 PASS） |
| T22.17 | ✅ | environment 经 quote 注入（`/tmp/mcp-env-test`） |
| T22.18 | ✅ | 恶意 name 400；env key 无注入（SAFE_MARKER 存在） |
| T22.19 | ✅ | pid/log 生命周期：remove 即时清理（FILES_GONE + PROC_GONE） |
| T22.21 | ✅ 单测 + E2E | 残留 bridge 清理（2026-10-05 修复；E2E 4/4：旧 pid 被杀、单一 bridge、工具恢复，2026-10-07） |
| T22.22 | ✅ | 重试退避 + 60s 预算（单测 3 用例） |
| T22.23 | ✅ | reconcile 30s 软闸门（单测分层关系） |
| T22.24 | ✅ 已执行 | 配置热更新：旧 bridge stop+pid 清除、新 bridge+env 注入、time 语义正确（2026-10-07） |
| T22.25 | ✅ 已执行并修复 | 首跑实证缺陷（session expired 不恢复）；修复后复跑三观察点全 PASS、单一 bridge 复用（2026-10-07） |
| T22.26 | ✅ 已执行 | 9100/9101 双 bridge、删除回收、9100 复用（2026-10-07） |
| T22.27 | ✅ 已执行 | disabled↔enabled 三态即时生效（2026-10-07） |
| T22.28 | ✅ 已执行并修复 | 首跑实证软闸门饿死+30s 税缺陷；负缓存修复后复跑 3/3 PASS（含修复定义立即生效）（2026-10-07） |
| T22.29 | ✅ 已执行并修复 | 语义修正（direct 而非隐藏）+ codemode 传播丢失缺陷修复，cm-off 走原生工具路径（2026-10-07） |
| T22.30 | ✅ 已执行 | name 64/65 边界、time_created 稳定、删后重建（2026-10-07） |
| T22.31 | ✅ 已执行并修复 | bridge 死亡自愈：第 4 缺陷（ECONNREFUSED 无自愈路径）实证，call 全失败驱逐+重试修复，透明恢复（2026-10-07） |
| T22.32 | ✅ 已执行并验证 | 沙箱级 stale 批量清扫（V1 借鉴项）：旧 bridge 全清、新 bridge 重建、无孤儿（2026-10-08） |

## 单元测试覆盖（V2）

- `packages/core/test/session-mcps.test.ts`：bridge 命令 quoting（含注入 round-trip）、stale cleanup（2）、retry cadence（3）、endpoint 模式 A/B/C —— 当前 8 用例全过；
- `packages/server/test/session-mcps.test.ts`：CRUD API 全链路 1 用例（16 assertions）；
- `packages/core/test/session/resources-pg.test.ts`：PG 资源归属（需 `OPENCODE_DATABASE_URL` 标记）。

## 历史记录（V1 时代，已归档）

- **2026-08-02 修复**：env key 未 `shellQuote` 导致沙箱内命令注入；name 未 sanitize 导致 pid/log 路径破坏（V1 `packages/opencode/src/mcp/index.ts`）。V2 已在 Schema 层拒绝非法 name，quoting 由单测固化。
- **2026-09-06 记录**：V1 对不存在 session 的 create/delete 落 500（requireSession 错误映射偏差），list 落 200。**V2 已收紧为统一 404**（T22.9）。
- **2026-08-08 / 2026-08-21 / 2026-09-15 重跑记录**：V1 契约（`/session/:id/mcps/create`、`enabled` 字段）下全量通过；含 `CODE_MODE=mcp` 环境说明（MCP 工具经 code-mode `execute` 嵌套调用，非顶层 part）。原始逐步脚本见 git 历史。
- **V1 端口说明**：V1 local 端口 `SANDBOX_MCP_BASE_PORT=9100` 步长 100；V2 为 9100 起连续 +1。
