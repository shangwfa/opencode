# 会话级 Connector E2E 测试报告（2026-10-10）

- 被测：会话级 Connector（第三方连接关联到会话资源域，会话内经 MCP 使用）——工作区未提交实现（`packages/connector/`、`packages/core/src/connector/`、`packages/server/src/handlers/connector-connection.ts`、protocol/schema 等）
- 性质：**只做验证，未修改任何产品代码**；不执行 git commit；未触碰 packages/ai、docs/test-cases 既有未提交改动
- 复现脚本：`packages/connector/e2e/`（start-server.sh / migrate.ts / e2e.mjs / e2e-subsession.mjs / bypass-engine.mjs）

## 1. 环境与准备

| 项 | 值 / 结果 |
|---|---|
| PG | `postgresql://postgres:postgres@127.0.0.1:5432/opencode-v2-up`（postgres/postgres 可用，PG 14.19） |
| 引擎迁移 | 临时脚本调 `runPostgresMigrations`（migrationDirectory=`getConnectorAssetDirectory()+"/migrations"`，来自 `@oomol-lab/open-connector@1.8.0` 包内 assets） |
| 迁移结果 | `connector` schema 出现 16 张表，含 **connections**、**runtime_tokens**；`runtime_migrations` ledger 记录 0010–0017 共 8 个迁移 ✅ |
| 注意 | 引擎迁移 SQL **不含 `CREATE SCHEMA`**（上游假设 schema 已由部署创建）。未预建 schema 时首个迁移报 `no schema has been selected to create in`。需先 `CREATE SCHEMA IF NOT EXISTS connector;` 再跑迁移（部署脚本/文档需覆盖此步骤） |
| bun 版本 | 本机 bun 1.3.14 **无 `node:sqlite`**，而 open-connector 的 PG 路径仍静态 import sqlite store（`node-runtime-database.js` → `sqlite/runtime-store.js`），加载即失败（503 `Could not resolve "node:sqlite"`）。必须 bun ≥1.4.2（repo `packageManager`），且 `bun run dev` 嵌套调用 bun 时需把 1.4.2 的 bin 前置到 PATH |
| 服务启动 | `bun run dev -- serve --hostname 127.0.0.1 --port 14963`（4096 被本机其他 opencode 进程占用）；`OPENCODE_PASSWORD=ab123456` + 主库 PG + 5 个 connector 环境变量（见 start-server.sh）；`GET /api/info` → 200 ✅；启动时主库 drizzle 迁移自动应用 `20261010065601_connector_connection`（`connector_connection` 表含 PK、`engine_connection_id` 唯一索引、`session_id` 索引） |
| 测试服务 | `postmark`（open-connector 源码中 api_key 型且无 `credentialValidators`，连接创建不做真实凭据校验，假密钥即可建连；执行 action 才真正调外部 API） |

## 2. 用例总表

主套件 33 项 + 子会话套件 7 项 = 40 项；**37 通过 / 3 失败**（3 项失败均为下述产品 bug 的定向证据用例，非脚本问题）。

### 2.1 主流程（e2e.mjs）

| # | 步骤 | 预期 | 实际 | 结论 |
|---|---|---|---|---|
| a1/a2 | 创建会话 A/B（POST /api/session） | 200 + data.id | 200 | ✅ |
| b1 | 会话 A 经 API 创建连接（postmark/api_key） | 200 + id/engineConnectionID | **400** `{"message":"Engine request failed (404)."}` | ❌ **bug #1** |
| b1x | 旁路：引擎 `/v1` 建连 + 主库插行（模拟 associate 落库） | 成功 | engineId/connId 正常 | ✅（旁路） |
| b2 | PG `connector_connection` 落行 | session/engine/postmark/active | 一致 | ✅ |
| b3 | PG 引擎 `connector.connections` 落行 | 含该引擎连接 | 一致 | ✅ |
| c1 | 会话 A 列表（engineConnectionID 归属） | 200 且 1 条 | 200，返回 `engineConnectionID=4aff9e01…` | ✅ |
| c2 | 会话 B 列表为空（资源域隔离） | 200 且 0 条 | 200 / 0 | ✅ |
| d1 | attach（POST …/connector/mcp） | 200 + {name,config}，Bearer oct_ token | 200，name=connector，url=…/api/connector/mcp，`oct_…` | ✅ |
| d2 | `session.mcpDefinitions.create` 注册 | 200 | 200（smcp_…） | ✅ |
| d3 | `session.mcpDefinitions.list` 可见 | 含 connector | names=connector | ✅ |
| e0 | **合法引擎 token 经 SaaS `/api/connector/mcp`** | 200（MCP JSON-RPC） | **401** 空 body + `www-authenticate: Basic realm="Secure Area"` | ❌ **bug #2** |
| e1x–e4x | [旁路] initialize → initialized → tools/list → tools/call list_connections | 200/serverInfo；五工具；含 postmark | 全部符合：serverInfo=oomol-connect；工具=`execute_action,get_action_guide,list_apps,list_connections,search_actions`；list_connections 返回连接列表 | ✅（旁路） |
| f1 | [旁路] 伪造 `oct_` 随机串 tools/list | 401 | 401 `A valid local bearer token is required.` | ✅ |
| f1s | [SaaS] 伪造 token（被外层 Basic gate 拦） | 401 | 401 | ✅（当前由 bug #2 兜住） |
| f3 | 会话 B 删会话 A 连接 | 404 | 404 ConnectorNotFoundError | ✅ |
| f4 | Basic 凭据（非引擎 token）调 SaaS MCP 通道 | 401/403 | **500 空 body** | ❌ **bug #3 表现**（见 §3.3） |
| g1 | 删连接（DELETE …/connections/:id） | 204 | 204 | ✅ |
| g2 | 删后列表空 | 200/0 | 200/0 | ✅ |
| g3 | 删后 PG `connector_connection` 清行 | 0 | 0 | ✅ |
| g4 | 删后引擎 `connections` 清行 | 0 | 0 | ✅ |
| g5 | 无连接时 attach | 400 no_connections | 400 `The session has no active connector connections.` | ✅ |
| h1–h3 | 旁路重建连接 → 重新 attach → 删会话 | 200/200/204 | 符合；attach#2 token 与 #1 不同（轮换） | ✅ |
| h2x | [旁路] 旧 token 已被 rotate 回收 | 401 | 401 | ✅ |
| h4/h5 | 删会话后 PG `connector_connection` / 引擎 `connections` 清行 | 0/0 | 0/0 | ✅ |
| h6/h7 | 删会话后 runtime token 失效 / PG token 行回收 | 401 / 0 | 401 / 0 | ✅ |

### 2.2 子会话资源域（e2e-subsession.mjs）

| # | 步骤 | 预期 | 实际 | 结论 |
|---|---|---|---|---|
| s1 | 创建主/子会话（parentID） | 两个 id | ✅ | ✅ |
| s2 | 按 root=parent 落库 | 1 行 | ok | ✅ |
| s3 | 子会话列表可见主会话连接（resolveOwner(child)=parent） | 200 且 1 条 | 200/1 | ✅ |
| s4 | 主会话列表可见 | 200 且 1 条 | 200/1 | ✅ |
| s5 | 子会话 attach | 200 | 200 | ✅ |
| s6 | 子会话删同域连接（对照 f3 跨域 404） | 204 | 204 | ✅ |
| s7 | 删后引擎清行 | 0 | 0 | ✅ |

## 3. 发现的问题（均附复现证据）

### bug #1（阻断创建）：`engine.ts` createConnection 路径前缀错误 —— `/api` 应为 `/v1`

- 位置：`packages/connector/src/engine.ts:147-148` 请求 `POST ${base}/api/connections/${service}/connect/api-key`（custom-credential 同）
- 引擎 1.8.0 实际挂载：`connect-server.ts:254` `app.route("/v1", createConnectionRoutes(...))` → 真实路径 **`/v1/connections/:service/connect/api-key`**（`/api/connections/:service` 的 DELETE 是另一条路由，存在且正确）
- 复现：`POST /api/session/:id/connector/connections` `{service:"postmark",authType:"api_key",values:{apiKey:"fake"}}` → 400 `{"_tag":"InvalidRequestError","message":"Engine request failed (404)."}`（引擎 404 被 `engine.ts` 的 status≥400 分支包装）
- 影响：**所有经 API 的连接创建 100% 失败**，主流程阻断
- 佐证：旁路脚本直连引擎 `/v1/connections/postmark/connect/api-key` → 200，响应 `{id, alias, authType:"api_key", …}`，与 `engine.ts` 的字段映射假设（`engineConnectionName=data.alias`）吻合

### bug #2（阻断 MCP 通道）：外层 `ServerProcess` Basic gate 未豁免 `/api/connector/mcp`

- 位置：`packages/server/src/process.ts:200-205`——外层 HTTP 入口只豁免 PTY ticket URL；带 `Bearer oct_…`（非 Basic）的请求在 `credentialFromRequest` 得空凭据 → `unauthorized()`（401 空 body + `www-authenticate: Basic realm="Secure Area"`，与实测响应头逐字节吻合）
- 本次功能只豁免了内层 `middleware/authorization.ts:57`（effect httpapi 层），漏了外层 gate
- 复现：attach 拿到合法 token 后 `curl -X POST …/api/connector/mcp -H "authorization: Bearer oct_…"` → 401 空 body + www-authenticate
- 影响：**MCP 通道完全不可用**；`session.mcpDefinitions.create` 注册的 remote MCP（headers.authorization=Bearer oct_…）在 AI 会话内同样无法连接。附带：`POST /api/connector/mcp` 的引擎 token 鉴权语义（不走 Basic）实际上从未被执行到

### bug #3（MCP 响应解析）：`handleMcp` 用 `JSON.parse` 解析引擎的 SSE 响应，必然抛错

- 位置：`packages/connector/src/engine.ts:204`（`body: text ? JSON.parse(text) : null`）
- 引擎 `/mcp` 是 Streamable HTTP transport（MCP 规范）：accept 必须同时含 `application/json, text/event-stream`（否则 406，实测），满足时 **content-type 恒为 `text/event-stream`**，body 形如 `event: message\ndata: {…}`（实测矩阵见 `probe-mcp-format` 输出）
- 实测：对 SSE 文本 `JSON.parse` 抛 `Unexpected identifier "event"` → `EngineError("engine_unavailable")`
- f4 用例的 500 即其表现：Basic 凭据过外层 gate 后（引擎在 `runtime_tokens` 空时匿名放行，返回 200+SSE），SaaS 侧返回 **500 空 body**（而非 failure() 映射的 503；500 与 503 的差异未进一步定位，如实记录）
- 影响：即使修复 bug #2，MCP 通道对一切成功响应仍会失败。修复方向：SaaS 端点需按 Streamable HTTP 语义透传（含 SSE），或引擎侧提供纯 JSON stateless transport

### 风险 #4（安全，设计层）：引擎在 `runtime_tokens` 表为空时对 `/mcp` 完全无认证

- 引擎认证模型（`api/auth.ts` `hasValidToken`）：未配置静态 runtimeToken/JWT 时，仅当 PG 存在 runtime token 行才开启校验；`runtime_tokens=0` 行时任何请求（含无 authorization 头）放行
- 实测：清空状态（所有会话已删）下，无凭据 POST 引擎 `/mcp` → **200 + 完整工具列表**
- 与 SaaS 的组合风险：会话清理（`revokeSessionTokens`）会把 token 行删到 0——即**每次所有会话删除后，MCP 通道回到无认证状态**。当前被 bug #2 的 Basic gate 意外挡住；修复 #2 时必须同步考虑（例如为嵌入模式配置静态 runtimeToken，或在 SaaS 层校验 Bearer 后再转发）

### 环境问题（非产品 bug，但会阻断部署/测试）

1. bun 1.3.14 无 `node:sqlite`，open-connector 静态引用导致加载失败（503 `Could not resolve "node:sqlite"`）；repo 声明 bun@1.4.2，现有本地/旧镜像（1.3.14）均需升级，且 `bun run dev` 嵌套调用需 PATH 前置
2. 引擎迁移不含 `CREATE SCHEMA connector`，部署迁移 job 需先建 schema（首次迁移否则报 `no schema has been selected to create in`）

## 4. 判定（结果 / 过程 / PG 三方面）

- **结果**：创建（bug #1）与 MCP 通道（bug #2/#3）两条主链路不可用；列表、attach、session MCP 注册、删除、会话清理、资源域隔离、token 轮换与回收、子会话共享资源域均符合预期
- **过程**：删除路径引擎侧（`/api/connections/:service` DELETE）与 attach/token 系列引擎路由（`/api/runtime-tokens`）路径正确可用；仅 connect 前缀错误；外层 Basic gate 豁免缺失只影响 `/api/connector/mcp`
- **PG**：SaaS `connector_connection` 与引擎 `connector` schema 双侧行的写入/清理（单删、会话删、token revoke）全部与预期一致；结束时三表均回零

## 5. 遗留项

1. 修复 bug #1 后需重跑 b1 正向（含补偿分支：engine 建连成功但主库插入失败时回滚引擎连接——本次未能经 API 触达）
2. 修复 bug #2/#3 后重跑 e0–e4（经 SaaS 通道的 initialize/tools/list/tools/call），并验证注册到 `session.mcpDefinitions` 后 AI 会话内真实调用 connector 工具（本次无 AI 驱动用例，未订阅 SSE 事件流——纯 API 操作不产生会话事件）
3. 风险 #4 的处置决策（静态 runtimeToken / SaaS 层 Bearer 校验）落地后补「`runtime_tokens` 空态 + 无凭据 → 401」负向用例
4. f4 的 500 与预期 503 的差异定位（低优先级，随 bug #3 一并看）
5. OAuth 型连接、custom_credential 型连接、execute_action 真实执行（需真实凭据）未覆盖

## 6. 环境清理记录

- 服务进程已停止；PG 终态：`connector_connection`=0、`connector.connections`=0、`connector.runtime_tokens`=0（迁移产生的 schema/表保留）
- 临时目录：bun 1.4.2 安装于 `/private/var/folders/…/T/opencode/connector-e2e/bun142`（可删）；服务日志 `/tmp/opencode-connector-e2e-server.log`；脚本已沉淀至 `packages/connector/e2e/`（仓库内 `.tmp-e2e/` 工作副本可删）

---

# 复测（2026-10-10 下午）：4 项修复 + 迁移增强的验证

修复内容（产品侧）：#1 `engine.ts` connect 路径改 `/v1`；#2 `process.ts` 外层 Basic gate 豁免 `/api/connector/mcp`（ready 时直进路由）；#3 `handleMcp` 解析 SSE（`parseMcpBody`：SSE 提取 `data:` 行取最后带 id 的消息，json 直接 parse）；#4 引擎启动注入 per-boot 随机 `runtimeToken`（空 token 表不再无认证）；#5 `migrate.ts` 迁移前自动 `CREATE SCHEMA IF NOT EXISTS`。

## R1. 迁移与环境

| 项 | 结果 |
|---|---|
| 迁移幂等重跑（含修复 #5 的自动建 schema） | ✅ 无新迁移应用、无报错（`migrations done (idempotent re-run)`），`runtime_migrations`=8 |
| 服务重启（引擎配置变化后） | ✅ `/api/info` 200 |
| 复测前 PG 三表状态 | ✅ 0/0/0（干净基线） |

## R2. 复测用例表（30 项，`e2e-retest.mjs`；创建连接全部走真实 API，不再旁路）

| # | 步骤 | 预期 | 实际 | 结论 |
|---|---|---|---|---|
| r-b1 | **[修复#1] 经 API 创建连接** | 200 且 `ccon_` id+engineConnectionID | 200，`ccon_09f1c2e…`/`33bf30bc…` | ✅ **修复生效** |
| r-b2/r-b3 | 双侧 PG 落行 | session/engine/postmark/active；引擎 1 行 | 一致 | ✅ |
| r-c1/c2 | 列表；**[回归] 会话 B 隔离** | 1 条 / 0 条 | 1 / 0 | ✅ |
| r-d1/d2 | attach + session MCP 注册可见 | 200 + oct_ token；注册可见 | 一致 | ✅ |
| r-e1–e4 | **[修复#2#3] SaaS 通道 initialize→initialized→tools/list→tools/call** | 200 全链 | **全部 500 空 body（0 字节）** | ❌ **新 bug #5**（见下） |
| r-f1 | 伪造 oct_ 经 SaaS | 401 | 500 | ❌ bug #5 |
| r-n1 | **[修复#4 关联] 无 authorization 头** | 被拒 | **400** `InvalidRequestError kind=Headers`（effect 层 headers 校验拦截，未到引擎） | ✅（被拒达成；401 形态需 bug #5 修复后由引擎产生） |
| r-f4 | Basic 凭据调 MCP | 401/403 或 200+status401 | 500 | ❌ bug #5 |
| r-f3 | **[回归] 跨域删** | 404 | 404 | ✅ |
| r-g1–g3 | **[回归] 删连接双侧清行** | 204/空/0+0 | 一致 | ✅ |
| r-h0–h3 | 重建连接、**attach 轮换**、删会话 | 200/新token≠旧/204 | 一致 | ✅ |
| r-h2b | [旁路] 旧 token 已回收 | 401 | 401 | ✅（token 轮换在引擎侧真实生效） |
| r-h4 | **[回归] 删会话双侧清行** | 0/0 | 0/0 | ✅ |
| r-h5 | 删会话后 token 表 | 0 | **0**（初测显示 1 为上一轮探针会话残留，清理该会话后三表归零复核通过） | ✅ |
| r-h6 | [旁路] 空表+伪造 token 直连引擎 | 401 | 401 | ✅（引擎侧 token 校验开启） |
| r-s1–s3 | 子会话建连、**[回归] 主会话可见/可删**（真实 API） | 200/1条/204 | 一致 | ✅ |

**结果：23/30 通过；7 项失败中 6 项为同一新 bug（#5），1 项（r-h5）复核后为通过。**

## R3. 新发现问题

### bug #5（阻断 MCP passthrough）：`ConnectorEngine.Service` 未注册进应用服务图 → handler 每次调用 die → 500 空 body

- 现象：`POST /api/connector/mcp` 对一切到达 handler 的请求（合法 token/伪造 token/Basic/null payload）返回 **500 + 0 字节 body**；无 authorization 头时 400（effect headers 校验，在 die 之前）；`content-type: text/plain` 时 415（payload 分发层正常）。即 defect 精确发生在「payload 合法解码之后」的 handler 执行环节
- **root cause（铁证）**：`packages/server/src/handlers/connector-connection.ts` 的 `connector.mcp.call` handler 内 `yield* ConnectorEngine.Service`；而 `packages/core/src/connector/node.ts` 中 `engineLayer` 只是 `Connector.layer` 的**私有 provide 依赖**（`Connector.layer(...).pipe(Layer.provide(engineLayer))`），`ConnectorNode.node` 仅向全局暴露 `Connector.Service`。对 routes 的完整 application layer 构建后探测：`Connector.Service: 存在 ✅` / `ConnectorEngine.Service: 缺失 ❌ (Service not found: @opencode/ConnectorEngine)`（复现脚本 `Layer.build(createRoutes(...))` + `Context.get` 探测）
- 连带结论：上一轮 f4 的 500 **主因即此**（ServiceNotFound 一直存在），JSON.parse SSE 是叠加缺陷——修复 #3 本身正确且必要（`handleMcp` 直调实测：垃圾 token → `{status:401,body:{error…}}`、SSE parse 正常），但被 #5 掩盖
- 已排除项（均有直测证据）：外层 gate 豁免（#2）生效（不再 401）；`parseMcpBody`（#3）正常；`McpCallResult` 原生与 `toCodecJson` 变换后的 encode、`Schema.Json` payload decode 均正常；引擎侧语义（initialize/五工具/tools/call/token 回收）经旁路全部正常
- 修复方向建议（未改代码）：将 `ConnectorEngine.layer` 提升为独立 global node（如 `ConnectorNode.engineNode`）并加入 `routes.ts` 的 `applicationServiceNodes`；或让 `Connector.Service` 暴露 `handleMcp` 代理，handler 不再直接依赖 engine 服务
- 修复 #4 的验证现状：无头请求被 effect 层 400 拦截（到不了引擎）；「无凭据 401」的正向确认依赖 bug #5 修复后重测。旁路对照（r-h6）已证明引擎在 token 表空时对伪造 token 401——结合引擎源码（静态 runtimeToken 配置后 `hasValidToken` 走校验），per-boot token 机制方向正确，端到端实证待 #5 修复

### 遗留观察（非阻断）

- 500 空 body 无任何服务端日志（defect 被 HttpEffect 兜底为 `Response.empty({status:500})`，`EFFECT_LOG_LEVEL=all` 也不打印），排障成本高；建议产品侧在 routes 层加 defect 日志中间件（仅记录，不改变行为）

## R4. 复测结论

- **修复 #1 ✅ 完全验证**：API 创建连接 200，双侧 PG 落行正确（补偿分支无法黑盒触发，已有单测覆盖：`connector.test.ts` "compensates by deleting the engine connection when persistence fails"）
- **修复 #2 ✅ 生效**（豁免后不再 401 Basic gate）但端点被 bug #5 接管为 500
- **修复 #3 ✅ 逻辑正确**（直调验证 SSE/json 双路径），端到端待 #5
- **修复 #4 ◐ 方向正确**：无头被拒（400）；引擎侧空表校验实证 401；「无凭据→引擎 401」端到端待 #5
- **修复 #5（迁移自动建 schema）✅ 幂等重跑通过**
- 回归全部通过：隔离、删除、会话清理、attach 轮换、子会话资源域、PG 双侧一致性
- **MCP passthrough 端到端仍不可用**，唯一阻断点 = bug #5（服务装配缺陷，一行 root cause 已定位并附探测证据）

## R5. 遗留项（更新）

1. bug #5 修复后重跑 `e2e-retest.mjs` 的 r-e1–e4/r-f1/r-f4/r-n1（预期全绿），并补「空 token 表 + 无凭据 → 401」端到端正向
2. AI 会话内真实 MCP 调用（agent 经注册的 session MCP 执行 action）本轮仍不可行：其一 bug #5 阻断通道，其二无真实第三方凭据——双原因，明确列为遗留
3. OAuth 型 / custom_credential 型连接、execute_action 真实执行、多 pod 场景（多 SaaS 实例共享 PG 引擎）未覆盖
4. defect 静默问题（R3 遗留观察）建议加日志中间件

---

# 最终复测（2026-10-10 傍晚）：bug #5 修复验证 —— 全链路打通

修复内容（产品侧）：`core/src/connector/node.ts` 新增 `engineNode`（`ConnectorEngine.Service` 独立全局节点，deps: []），`routes.ts` 加入 `applicationServiceNodes`，Connector 节点改为 `deps: [ConnectorStore.node, engineNode]`。脚本：`e2e-final.mjs`。

## F1. 用例结果（11 项 + 1 项复核，全部通过）

| # | 步骤 | 预期 | 实际 | 结论 |
|---|---|---|---|---|
| f-p0/f-p1 | 准备：会话+连接+attach | 200 + oct_ token | 一致 | ✅ |
| **f-e1** | **MCP initialize（经 SaaS 通道）** | 200 且 serverInfo | `{"status":200,"body":{"result":{…"serverInfo":{"name":"oomol-connect","version":"0.1.0"}…}}}` | ✅ |
| f-e2 | notifications/initialized | 2xx | 200 | ✅ |
| **f-e3** | **tools/list 五工具** | 五个工具名 | `execute_action,get_action_guide,list_apps,list_connections,search_actions` | ✅ |
| **f-e4** | **tools/call list_connections** | 200 且含 postmark 连接 | `{"status":200,"body":{"result":{"content":[{"type":"text","text":"{…ok:true,data:[…postmark…]}"…` | ✅ |
| **f-f1** | 伪造 oct_ token | 引擎 401 | HTTP 200 + `body.status=401`（`{"error":{"code":"unauthorized"…}}`） | ✅ |
| **f-f4** | Basic 凭据（非引擎 token） | 引擎 401 | 同上 | ✅ |
| f-pre | 删会话后 token 表为空 | 0 | 0（初测显示 1 为脚本外 curl 探针会话残留，删除该会话后三表归零复核） | ✅ |
| f-n1 | 空 token 表 + 无 authorization 头 | 被拒 | **400** `InvalidRequestError kind=Headers`（effect 层拦截） | ✅ |
| **f-n2** | **空 token 表 + 空 Bearer（头存在）→ 引擎 401** | 引擎 401 | HTTP 200 + `body.status=401` | ✅ **修复 #4 端到端实证** |
| 探测 | 应用层服务解析 | 双服务存在 | `Connector.Service: 存在 ✅` / `ConnectorEngine.Service: 存在 ✅`（上轮后者缺失） | ✅ **bug #5 修复实证** |

**语义说明（非缺陷）**：`/api/connector/mcp` 为 passthrough 端点——HTTP 状态恒 200，引擎状态在响应体 `status` 字段（`McpCallResult = {status, body}` 契约）。伪造/空/Basic 凭据的拒绝形态 = HTTP 200 + `body.status=401` + 引擎错误体。首轮脚本曾因（a）未解析 Response 对象、（b）断言少了外层 `{status,body}` 包装而误报失败，以原始 curl 响应修正后全绿。

## F2. 结论

- **bug #5 ✅ 修复验证**：服务探测双服务存在；MCP passthrough 全链（initialize → initialized → tools/list 五工具 → tools/call）经 SaaS 通道端到端打通
- **修复 #4 ✅ 端到端实证**：空 token 表状态下，无头被 effect 层 400 拒绝、空 Bearer 被引擎 401 拒绝——无认证窗口关闭
- 修复 #1/#2/#3/#5(迁移) 维持上轮验证结论；回归项（隔离/清理/轮换/子会话）上轮已全绿，本轮未重跑（无相关改动）
- **无剩余阻断问题**

## F3. 遗留项（最终）

1. AI 会话内真实 MCP 调用（agent 经注册的 session MCP 执行 action）：通道已通，仅缺真实第三方凭据（postmark 假密钥无法通过 execute_action 的外部 API 校验），列为环境依赖遗留
2. OAuth 型 / custom_credential 型连接、execute_action 真实执行、多 pod 共享 PG 引擎场景未覆盖
3. defect 静默观察（500 时代无日志）随 bug #5 消失，但建议保留加日志中间件的改进项
4. 部署清单仍需包含：bun ≥1.4.2（node:sqlite）、connector 迁移前 PG 可达（自动建 schema 已由修复 #5 覆盖）

---

# execute_action 真实执行（2026-10-10）

脚本：`packages/connector/e2e/e2e-execute-action.mjs`（`bun <bun142> packages/connector/e2e/e2e-execute-action.mjs http://127.0.0.1:14963`）。用 arxiv（no_auth 公开 API）绕开凭据依赖，验证「SaaS MCP 通道 → 引擎 → 第三方真实 HTTP」全链。服务经 `packages/connector/e2e/start-server.sh` 启动（修复了其 `cd` 层级错误：`../../../..` → `../../..`）。

## 脚本排障记录（均为脚本问题，非产品 bug）

1. 会话创建端点写死 `POST /api/session/create` → 404。实测对照：`/api/session/create` 404、`POST /api/session` 200（与 protocol `session.create` 一致），已改
2. `api()` 响应解析缺陷：`await res.text()` 之后再 `await res.json()`，body 已被消费必然 throw → catch 返回字符串 → `body.data.id` 取不到（ea-1 恒 false）。改为 `JSON.parse(text)`

## 用例结果（8/8 全过）

| # | 步骤 | 预期 | 实际 | 结论 |
|---|---|---|---|---|
| ea-1 | 创建会话（POST /api/session） | 取得 sessionID | ✅ | ✅ |
| ea-2 | 关联 postmark 假 key 连接（attach 前置） | 200 | 200 | ✅ |
| ea-3 | attach 取得 Bearer | 200 | 200 | ✅ |
| ea-4 | MCP initialize | serverInfo | ✅ | ✅ |
| ea-5 | get_action_guide(arxiv.search_papers) | 指南含 query 输入 | inputSchema：`query`(必填 string)、`start`、`maxResults`、`sortBy`、`sortOrder`；连接=arXiv Public/no_auth；策略 allow_match | ✅ |
| **ea-6** | **execute_action arxiv.search_papers（真实 HTTP）** | 真实结果 | **真实 arxiv 响应**（见下） | ✅ |
| ea-7 | 删除连接 | 204 | 204 | ✅ |
| ea-8 | 删除会话 | <500 | ✅ | ✅ |

## ea-6 实际响应摘要（真实 arxiv 结果证据）

`execute_action {actionId: "arxiv.search_papers", input: {query: "effect systems", maxResults: 2}}` 返回 `ok: true`：

```json
{
  "ok": true,
  "data": {
    "totalResults": 1377077,
    "startIndex": 0,
    "itemsPerPage": 2,
    "papers": [
      {
        "id": "1808.02010v6",
        "baseId": "1808.02010",
        "version": 6,
        "title": "Polymorphic Iterable Sequential Effect Systems",
        "summary": "Effect systems are lightweight extensions to type systems that can verify a wide range of important properties with modest developer burden. ..."
      }
    ]
  }
}
```

`totalResults: 1377077` 与论文 `1808.02010v6`（Polymorphic Iterable Sequential Effect Systems）均为 arxiv 官方 API 实时返回，非 mock 数据——证明引擎经真实第三方 HTTP 完成执行。`isError` 未置位（成功路径），返回为结构化 arxiv 分页结果。

## 结论

- F3 遗留项 1 的「无真实凭据」部分对 no_auth 类 provider 已可验证：**AI 会话内经 MCP 的 action 真实执行链路全通**（本用例即模拟了该路径的 MCP 调用形态）。带凭据 provider（api_key/oauth）的真实执行仍需有效凭据，维持遗留
- 遗留项 2 的「execute_action 真实执行」**已覆盖**（no_auth 类）；OAuth 型连接、多 pod 场景仍遗留

---

# OAuth 全流程（2026-10-10）

脚本：`packages/connector/e2e/e2e-oauth.mjs`（`bun <bun142> packages/connector/e2e/e2e-oauth.mjs http://127.0.0.1:4096 <clientId> <clientSecret>`，凭据仅命令行传参不落文件）。服务固定端口 4096（OAuth App 回调注册为 `http://127.0.0.1:4096/connector/oauth/callback`）；为此停掉了占用 4096 的 Zed opencode ACP 代理（PID 95754，无外部活跃连接，Zd 可按需重启）。

## 授权页实际过程

脚本 `open` 授权 URL 拉起本机默认浏览器（用户 Chrome，已登录 GitHub）。该 OAuth App 此前已授权过，GitHub 对已授权 App + 已登录浏览器**直接 302 回调**（无 Authorize 按钮页），回调 `?code=…&state=…` 到 `:4096/connector/oauth/callback`，引擎完成 token 交换，complete 轮询即 connected。全程未出现 GitHub 登录页/凭据输入，agent-browser 未实际介入（准备好用于无登录态场景）。注：共触发 4 次授权，其中 1 次因授权页未及时处理而 failed（state 过期路径），其余 3 次 connected——失败路径行为符合预期。

## 脚本排障记录（脚本问题，非产品）

1. 第 8 行对象字面量裸三元表达式语法错误（缺 `actual:` 键）→ SyntaxError
2. actionId 写 `github.get_authenticated_user`——引擎 github provider 实际为 **`github.get_current_user`**（providers/github/actions.ts），unknown_action 导致首轮 oa-6 false
3. 排障探针 `oa6-probe.mjs`（已删）用于三侧 ID 对照定位 oa-6 根因

## 用例结果（7/8；oa-6 失败 = 产品缺陷，见下）

| # | 步骤 | 预期 | 实际 | 结论 |
|---|---|---|---|---|
| oa-1 | 配置 OAuth client（PUT /api/connector/oauth/clients/github） | 204 | 204 | ✅ |
| oa-2 | 创建会话 | 成功 | ✅ | ✅ |
| oa-3 | 发起 OAuth（authorizationUrl + connectionRequestID） | github.com/login/oauth/authorize + 回调指向 :4096 | 一致 | ✅ |
| oa-4 | complete 轮询 → connected | connected | connected（含 oauth2 connection） | ✅ |
| oa-5 | oauth2 连接关联（authType=oauth2, status=active） | ✅ | ✅ | ✅ |
| **oa-6** | **execute 不带 connectionName（AI 默认形态）** | 真实 GitHub 响应 | **connection_not_allowed** | ❌ **产品缺陷（bug #6）** |
| **oa-6b** | **execute 带引擎 connectionName** | 真实 GitHub 响应 | **`ok: true, login: "shangwfa"`**（真实 API） | ✅ |
| oa-7 | 清理（删连接+会话） | ✅ | ✅ | ✅ |

## oa-6b 响应摘要（真实 GitHub API 证据）

`execute_action github.get_current_user {connectionName: <引擎UUID>}`：

```json
{ "ok": true, "data": {
    "login": "shangwfa", "id": 7278589,
    "node_id": "MDQ6VXNlcjcyNzg1ODk=",
    "avatar_url": "https://avatars.githubusercontent.com/u/7278589?v=4",
    "url": "https://api.github.com/users/shangwfa", ... } }
```

## bug #6（产品缺陷，阻断 AI 默认调用形态）：OAuth 连接不是 default 连接 → 不带 connectionName 的 execute_action 必然 connection_not_allowed

- 现象：oa-6 返回 `{"ok":false,"error":{"code":"connection_not_allowed","message":"The selected connection is not granted to this runtime token."}}`（HTTP 200，isError: true）
- **根因链（逐环实证）**：
  1. OAuth 连接在引擎侧 connectionName 为**随机 UUID**（如 `3796af33-…`），SaaS complete 落库的 engine_connection_name 同值；引擎 `list_connections` 显示 `"default": false`
  2. execute_action 不带 connectionName 时引擎 `normalizeConnectionName(undefined)` → **`"default"`**（connection-service.ts:27），`store.get("github", "default")` **落空**（无此名连接）
  3. `resolveForExecution` 解析出 connectionId=**undefined**（github 非 no_auth，无 marketplace）
  4. token 白名单校验 `evaluateConnection(undefined)`（action-policy.ts:240）：allowedConnections 非空但 undefined 不在其中 → 拒绝；**message 无 id 的形态**（"The selected connection…"）与实测逐字一致
- **排除项**：三侧 ID 完全一致（SaaS 行 `engine_connection_id` = 引擎 connections.id = token `allowed_connections`，PG 实查）；MCP list_connections 能列出该连接（含 grantedScopes）；带引擎 connectionName 的 execute 成功返回真实 GitHub 用户（oa-6b）——**凭据、token、白名单、引擎执行链全部正常，唯一断点是 default 连接名解析**
- 影响：AI 经 MCP 使用连接器时按工具描述「Omit connectionName to use the default connection」的默认形态**对 OAuth 连接必然失败**；api_key/custom_credential 连接同样是非 default 名（postmark 响应 `isDefault: false`），**同类风险**（此前 e2e 未覆盖 execute，未暴露）
- 修复方向建议（未改代码）：complete/connect 成功且该 service 无 default 连接时，将连接以 `default` 名落引擎（或引擎侧 selectStoredConnection 在仅有一连接且在白名单时回退选中）；或在 SaaS MCP 透传层为单连接会话自动补 connectionName

## 结论与遗留

- **OAuth 三步流程（client 配置 → 授权 → complete 关联）与凭据真实性全部验证通过**；唯一失败项 oa-6 为 bug #6（产品缺陷，证据链完整）
- 遗留：bug #6 修复后 oa-6 应转绿；多 pod 下 OAuth 回调（任意 pod 完成）未覆盖

---

# 全量回归 2026-10-11（基线：typecheck 0 错误 / connector 79 测试全绿 / 源码收编 src/{adapter,engine}）

## R4. 汇总表

| 层 | 项 | 预期 | 实际 | 结论 |
|---|---|---|---|---|
| A 静态 | typecheck connector | 0 错误 | 退出码 0 | ✅ |
| A 静态 | typecheck core | 0 错误 | 退出码 0 | ✅ |
| A 静态 | typecheck protocol | 0 错误 | 退出码 0 | ✅ |
| A 静态 | typecheck server | 0 错误 | 退出码 0 | ✅ |
| A 单测 | packages/connector | 79 pass | 79 pass / 0 fail | ✅ |
| A 单测 | packages/schema | 83 pass | 83 pass / 0 fail | ✅ |
| A 单测 | packages/protocol | 8 pass | 8 pass / 0 fail | ✅ |
| A 单测 | packages/server | 仅既有环境失败 | 121 pass / 6 skip / 1 fail（fetch.test.ts "routes pending requests"，AGENTS.md:13 记载的既有失败，与 connector 无关） | ✅（connector 相关 0 失败） |
| B 迁移 | core `migration.ts --check` | 无漂移 | "No schema changes"（退出 0） | ✅ |
| B 迁移 | 引擎迁移幂等（migrate.ts ×2） | 两遍退出 0、表数/记账不变 | 16 表、runtime_migrations 8 条（0010–0017）两遍一致 | ✅ |
| C e2e | 服务启动（bun142 :14963） | /api/info 200 | 200（Basic opencode:ab123456；Bearer 形式 401 属预期认证形态） | ✅ |
| C e2e | e2e-final.mjs（bug#5 全链） | 11/11 | 11/11 | ✅ |
| C e2e | e2e-execute-action.mjs（arxiv 真实执行） | 8/8 | 首轮 7/8（ea-6 第三方 HTTP 偶发）→ 手动重放成功 + 重跑 8/8 | ✅（偶发已复现通过） |
| C e2e | e2e-subsession.mjs（子会话资源域） | 7/7 | 7/7（修复测试脚本 bypass-engine.mjs 旧模块路径后） | ✅ |
| C e2e | e2e-retest.mjs | 30 项 | 23 过 / 7 失败，7 项全部定因为**脚本断言过时/脚本缺陷**，产品无回归（定因见 R6） | ⚠️ 脚本待修，产品 ✅ |
| C e2e | e2e.mjs（bug 取证脚本） | — | 25 过 / 8 失败，8 项全部定因为**取证断言过时/前置不满足**（多数正是修复#1/#2 生效的证据），产品无回归（定因见 R6） | ⚠️ 脚本待修，产品 ✅ |
| C e2e | GET /api/connector/providers | 1604 个；aisa/semrush 存在且 authTypes 正确 | 200，total=1604；aisa→[api_key]、semrush→[api_key] | ✅ |
| C 回归 | bug#1 连接创建 /v1 前缀 | API 建连 200 + 双侧落行 | r-b1 200（ccon_ + engineConnectionID）、r-b2/r-b3 落行 1/1 | ✅ |
| C 回归 | bug#2 MCP Basic 豁免 | oct_ token 经 SaaS 通道可用；Basic 凭据被引擎拒 | e2e-final f-e1~e4 全过；f-f4 引擎 401 | ✅ |
| C 回归 | bug#5 引擎节点注册 | MCP passthrough 全链 | e2e-final 11/11 | ✅ |
| C 回归 | bug#6 单连接免指定 connectionId | 默认连接解析生效 | 单测 connector.test.ts:543 绿；e2e 重放 execute_action 不带 connectionName 成功选中默认连接（arxiv:default） | ✅ |
| C 回归 | 孤儿清扫 reconcile | 引擎孤儿被清 | **非 default 命名孤儿永久滞留；removed 计数虚高** | ❌ 新发现产品 bug（R5） |
| C e2e | e2e-oauth.mjs | 需真实 GitHub 凭据+人工授权 | — | ⏭️ 跳过（本轮标注） |
| D 清理 | 停服务 / PG 清零 / 删测试会话 | 全清 | 服务 SIGINT 停止；connector 会话态表全 0（migrations 8 条与 16 表结构保留）；5 个残留测试会话经 API 204 删除；public.connector_connection=0 | ✅ |

## R5. 新发现产品 bug（connector 相关，未修代码，附复现证据）

### 新 bug：`reconcileOrphans` 字段名错位（alias vs connectionName）→ 非 default 命名的引擎孤儿永远清不掉

- 位置：`packages/connector/src/adapter/engine.ts:341` —— `engineConnectionName: data.alias ?? ""`。引擎 `GET /api/connections` 返回的 `ConnectionSummary`（`engine/connection-service.ts:33`）**只有 `connectionName` 字段、没有 `alias`**，取值恒为空串；引擎 `normalizeConnectionName("")` → `"default"`（connection-service.ts:1059），于是每次删除的都是 `(service, "default")`。
- 复现证据（2026-10-11 实测，服务 :14963）：
  1. bypass 引擎侧建连接（connection_name=随机 UUID `b70e20af-…`，PG connector_connection 无对应行）→ 人工孤儿；
  2. `POST /api/connector/reconcile` → `{"removed":26}`，但该孤儿仍在（`connector.connections` 仅剩此 1 行）；
  3. 对照实验：再插 `(postmark, default)` 与 `(semrush, named-orphan-1)` 两行孤儿 → reconcile `{"removed":28}` → **仅 `(postmark, default)` 被删**，UUID 名与 `named-orphan-1` 均滞留——「只有 default 名可清」与代码推导完全一致；
  4. removed 虚高机理：引擎 listConnections 返回**按 catalog 动态生成的虚拟条目**（no_auth/marketplace，`virtual: true`，不占物理行），reconcile 对它们逐个调 DELETE（引擎对不存在的物理行幂等成功）并计数——26→28 反复出现、实际删 0 行。
- 影响：异常路径孤儿（OAuth / bypass 等引擎随机 UUID 命名的连接，**含加密凭据**）永久滞留引擎表；`removed` 返回值不可信。正常删会话链路不受影响（r-h4 双侧清行 0/0 已验证——deleteSession 走 adapter 持有的正确 engineConnectionName）。
- 为什么 79 单测没抓到：`connector.test.ts:620` 起的 reconcileOrphans 用 fake engine，其 listConnections 返回的 `EngineConnection` 由测试自构造（engineConnectionName 非空），字段错位只在真实引擎集成时暴露。
- 修复方向建议：`engine.ts:341` 改取 `data.connectionName`；并建议 reconcile 跳过 `virtual: true` 条目（免无效 DELETE 与虚计数）。

## R6. e2e-retest.mjs（7 失败）/ e2e.mjs（8 失败）定因明细（均为脚本侧，产品无回归）

- **e2e-retest.mjs**
  - r-e1/r-e3/r-e4：脚本 `mcp()` 返回原始 `Response` 未解析 body，`.body` 是 ReadableStream → stringify 为 `{}` → 断言必败；同场景在 e2e-final.mjs（正确解析 `body.body.result`）全过。
  - r-f1/r-f4/r-h2x：断言停留在 bug#5 修复前的裸 HTTP 401 形态；实际为 **HTTP 200 + 包装 `{"status":401,"body":{...unauthorized...}}`**（passthrough 预期形态，本轮 curl 直证），e2e-final f-f1/f-f4 以正确断言验证通过。
  - r-h6：旁路进程（bypass-engine.mjs）自建 runtime 未传 `runtimeToken` → 引擎开放模式（表空放行，上游设计）；**生产暴露面已封堵**——SaaS 适配层注入 per-boot 静态 token（`adapter/engine.ts:233-236` 注释明言堵此洞），实测经 SaaS 用伪造/已回收 token → 包装 401。
- **e2e.mjs**（bug#1/#2 修复前的取证脚本，自声明"3 项为产品 bug 定向证据用例"）
  - b1/c1：修复#1 生效 → API 建连 200 + ccon_ id（旧取证断言与"仅旁路 1 条连接"的前置假设崩塌）——失败本身即修复生效的证据。
  - e0/f1s/f4：修复#2 生效 → Basic 豁免 + 引擎包装 401（断言过时）。
  - g2：旁路连接残留（count=1，脚本未清理自建旁路连接）。
  - g5：前置不满足（旁路连接残留，非"无连接"）；独立复验：新建 0 连接会话 attach → **400 "The session has no active connector connections."** ✅。
  - h6：同 r-h6。

## R7. 本轮测试脚本侧修复（非产品代码）

- `packages/connector/e2e/bypass-engine.mjs`：模块路径 `../src/server/connector-runtime.ts` → `../src/engine/server/connector-runtime.ts`（源码收编后脚本未跟上；曾致 e2e-subsession.mjs 在 bypassCreate 处 JSON Parse EOF 崩溃）。

## R8. 环境备注

- 服务认证：`Authorization: Basic base64(opencode:ab123456)`；`Bearer ab123456` 对 /api/info 是 401（预期形态）。
- ea-6 首轮失败为 arxiv 第三方 HTTP 偶发（ok:false），同环境手动重放与整套重跑均成功——记录为偶发，不判产品问题。
- 所有 e2e 脚本端口硬编码 14963，与实际服务端口一致，未改常量。

## R9. 结论

- 四包 typecheck 0 错误；单测 connector 79 / schema 83 / protocol 8 全绿，server 除 AGENTS.md 记载的既有环境失败外全过（connector 相关 0 失败）。
- 迁移幂等与 16 表 + 8 条记账核对通过。
- e2e 主链（final/execute-action/subsession）26/26 全过；providers 目录 1604 达标；bug#1/#2/#5/#6 回归全部通过。
- **唯一新发现：reconcileOrphans 字段错位 bug（R5）**，建议修复后补一条「非 default 名孤儿清扫」集成用例。
- e2e-retest.mjs / e2e.mjs 的 15 个失败全部为脚本断言过时/缺陷（R6），建议后续按 e2e-final.mjs 的形态刷新断言或归档下线。

---

# 无模型全场景 2026-10-11（`e2e-no-model.mjs`，纯 HTTP API 驱动）

**主题**：不使用模型（无 AI 会话/agent 参与；MCP 均为 JSON-RPC 直调）如何使用 connector 的全场景验证。脚本：`packages/connector/e2e/e2e-no-model.mjs`（57 项）+ 新增旁路 `bypass-actions.mjs`（引擎 /v1/actions 直调）/ `bypass-raw.mjs`（引擎任意路由直调）。

## N1. 环境与方法

| 项 | 值 |
|---|---|
| 服务 | `BUN_E2E=<bun142> sh start-server.sh 14963`（**注意：不带 BUN_E2E 时 `bun run dev` 嵌套调用系统 bun 1.3.14，缺 node:sqlite → connector 路由 503**） |
| 方法 | 全部经 SaaS HTTP API（Basic opencode:ab123456）；MCP 通道 = `POST /api/connector/mcp` + attach 返回的 `oct_` token（JSON-RPC 直调，不经模型/原生工具） |
| 旁路 | bypass-actions.mjs（幂等验证）、bypass-raw.mjs（引擎侧取证），均独立进程 runtime 同 PG/dataDir/密钥 |
| 终态 | 57/57 通过（exit 0）；测试后 truncate 会话态数据全 0（connections/runtime_tokens/connection_requests/runs/idempotency_records/主库 connector_connection 与 ledger），表结构与 migrations 记账保留 |

## N2. 用例总表（57 项，按场景）

| 场景 | 用例（通过/总数） | 要点 |
|---|---|---|
| 准备 | nm-p1/p2（2/2） | /api/info 200；5 个测试会话创建 |
| 1 目录发现 | nm-1a..1e（5/5） | 全量 **1604**（与基线一致）；`?service=postmark` 命中 1 条含 api_key；`?authType=custom_credential` 112 条全部匹配；负向：不存在服务 → 200 空列表、非法 authType → 400 |
| 2 连接生命周期 | nm-2a..2h（8/8） | postmark api_key 假 key 建连 200（宽松校验）；**custom_credential 建连成功（cloudflare_docs，auth fields 为空且无 credentialValidators，空 values 即可）**；列表含 engineStatus（全部 active）/accountLabel 字段、alias 回显；负向：不存在服务 4xx、oauth2 直建 400；删除后列表归位；PG 双侧落行 1/1 |
| 3 会话域隔离 | nm-3a..3d（4/4） | 会话 ISO 列表 0 条；ISO 删 MAIN 连接 404；**子会话（parentID）列表可见主会话连接且 id 相同**（共享资源域）；对照 MAIN 不受影响 |
| 4 no_auth 通道 | nm-4a..4e（5/5） | 零连接会话 attach → 400 no_connections（现状：MCP 通道需 ≥1 连接）；有连接会话 MCP 直调 list_apps/search_actions/execute_action（**arxiv.search_papers 真实第三方调用成功**，isError=false 有论文数据） |
| 5 执行语义 | nm-5a..5i（9/9） | 多连接未指定 → 400 `connection_required`（提示 specify connectionID）；不存在 connectionID → 404；单连接免指定/指定后成功两例为 **bug#7 取证**（见 N3）；**idempotencyKey**：SaaS 无 HTTP execute 端点（/openapi.json 166 条 path 实证，仅 proxy/mcp/files 等），经旁路直连引擎 `/v1/actions/arxiv.search_papers` 同 key ×2 → 两次 200 且 data 全等、`idempotency_records` 仅 +1 行（引擎幂等回放 ✅）；SaaS 侧 key 透传仅存在于原生工具通道（本轮不覆盖） |
| 6 MCP 手工使用 | nm-6a..6g（7/7） | attach 轮换（新 token≠旧）；initialize（serverInfo=oomol-connect）→ notifications/initialized → tools/list 五工具 → tools/call list_connections（含 nm-postmark）+ get_action_guide；伪造 oct_ token → 包装 401 |
| 7 proxy 透传 | nm-7a/7b（2/2） | 两例均为 **bug#7 取证**：no_auth（arxiv 零连接哨兵）与需凭据（postmark）路径全部 400 `proxy is not granted to this runtime token.` |
| 8 runs 审计 | nm-8a/8b（2/2） | GET /api/connector/runs 有 `service=arxiv + actionId=arxiv.search_papers` 记录；`limit=1` + nextCursor 翻页第二页与第一页 id 不重叠 |
| 9 孤儿清扫 | nm-9a..9c（3/3） | bypass 建引擎 UUID 名孤儿（无 SaaS 行）→ reconcile `{"removed":1}` 且孤儿行已删；**removed == 物理行差（2→1），不含 virtual 占位虚计数**——确认 R5 的 connectionName 字段修复已生效（修复前 removed=26~28 虚高且孤儿滞留） |
| 10 OAuth 无人工态 | nm-10a..10e（5/5） | PUT client 204；start 返回 authorizationUrl（github.com/login/oauth/authorize）+ requestID + expiresAt；未授权 complete 为 **bug#8 取证**（500，见 N3）；`GET /api/session/:id/connector/oauth/requests` → 404（上游无列表路由，与 README 注记一致）；PG 双侧停留 initiated（主库 ledger + 引擎 connection_requests） |
| 11 reconnect | nm-11a（1/1） | 对 api_key 连接 reconnect → **400 `{"_tag":"InvalidRequestError","message":"postmark does not support oauth2."}`**（基线：引擎按 authType 明确拒绝，语义正确） |
| 12 transit 文件 | nm-12a..12c（3/3） | 上传 28B 文本 → fileId/downloadUrl（指向 SaaS 端点）/sizeBytes/name/mimeType 全对；下载字节一致；不存在 fileId → 404 |
| 清理 | nm-c1（1/1） | 删全部 6 个会话（含子会话）后主库 connector_connection=0、引擎 connections=0、runtime_tokens=0 |

**跳过项**：无（custom_credential 候选服务 cloudflare_docs 在目录内且建连成功，未触发跳过分支）。

**明确不覆盖**（按任务口径）：原生工具通道（connector_* 五件套必须经模型触发）、trigger（用户暂停）、OAuth 真实授权（需人工浏览器操作，本轮仅验证到无人工态基线）、多 pod。

## N3. 新发现产品 bug（未修代码，均附复现证据）

### bug #7（阻断 proxy 端点）：SaaS 临时 token 硬编码 `allowedProxies: []` → `POST /api/connector/proxy/:service` 100% 被引擎策略拒绝

- 位置：`packages/connector/src/adapter/engine.ts` createRuntimeToken（`allowedProxies: []`）+ 引擎 `engine/core/action-policy.ts:171-182`（token 层存在且空 allowlist → `proxy_not_allowed`）。
- 机理：SaaS proxy 端点经 `withEphemeralToken`（adapter/connector.ts:996）铸临时 token；该铸造函数对所有用途统一 `allowedActions:["*"], allowedProxies:[]`。actions 因 `"*"` 通配放行（executeAction 正常），proxies 空列表被引擎解释为"不允许任何 proxy"。
- 复现证据（2026-10-11，服务 :14963）：
  1. 单连接会话 `POST /api/connector/proxy/postmark {sessionID,endpoint:"/server",method:"GET"}` → 400 `{"_tag":"InvalidRequestError","message":"postmark proxy is not granted to this runtime token."}`（nm-5b）；
  2. 同请求带合法 connectionID → 同样 400（nm-5e）；
  3. 零连接会话 no_auth `POST /api/connector/proxy/arxiv {...endpoint:"/query"...}` → 400 `arxiv proxy is not granted…`（nm-7a，哨兵路径同样被拦）；
  4. 对照：同一 withEphemeralToken 走 executeAction/arxiv 真实执行成功（nm-4e/nm-5g），证明仅 proxy 授权缺失。
- 影响：README 声称的 provider 代理透传端点完全不可用（单连接自动注入、多连接 connection_required、no_auth 哨兵三条路径全部到不了连接解析/转发层）。nm-5d 的 connection_required 判定发生在 SaaS 侧（adapter），先于引擎调用，故仍可验证。
- 修复方向：`allowedProxies: ["*"]`（与 allowedActions 对齐），或按请求的 service 铸精确授权。修复后翻转 nm-5b/5e/7a/7b 断言（预期改为 SaaS 200 + 透传第三方凭据级 4xx / arxiv XML feed）。

### bug #8（阻断 OAuth 轮询）：未授权状态下调 complete 必 500（引擎 errorCode:null 直传 schema optional 字段）

- 位置：`packages/connector/src/adapter/connector.ts:892-895`（`OAuthComplete.make({ status, errorCode: request.errorCode })`）。
- 机理：引擎 `GET /v1/connection-requests/:id` 对 initiated 请求返回 `errorCode: null`；schema `OAuthComplete.errorCode` 为 `Schema.String.pipe(optional)`，不接受 null → `make` 抛 "Schema validation failed" → handler die → HTTP 500 空 body。
- 复现证据（三层实证）：
  1. bypass 直连引擎：`GET /v1/connection-requests/:id` → 200 `{status:"initiated", appId:null, errorCode:null, …}`；
  2. bun -e 最小实验：`OAuthComplete.make({status:"initiated", errorCode:null})` 抛 `Error: Schema validation failed`，省略 errorCode 则 OK；
  3. SaaS 端到端：start 后立即 `POST …/oauth/:requestID/complete` → HTTP 500 空 body（nm-10c）。
- 影响：用户未在浏览器完成授权期间，任何 complete 轮询（e2e-oauth.mjs 的轮询循环、客户端定时查询）都收到 500 而非 `{status:"initiated"}`；已授权路径不受影响（connected 分支不传 errorCode，历史 e2e-oauth 全流程因此未暴露）。
- 修复方向：`errorCode: request.errorCode ?? undefined`。修复后翻转 nm-10c 断言（预期 200 + status=initiated）。

## N4. 本轮结论

- 无模型（纯 HTTP）路径下 connector 的**连接管理、会话域隔离/共享、MCP JSON-RPC 直调、no_auth 真实执行、runs 审计、孤儿清扫（R5 修复确认）、reconnect 拒绝语义、transit 文件**全部按契约工作，57/57 通过。
- **新发现 2 个产品 bug：#7（proxy 端点全路径不可用）、#8（OAuth initiated 态 complete 500）**，均为"单测用 fake engine/未覆盖的中间态"导致的集成缝隙，已留取证用例待修复后翻转。
- 运维注记：跑 e2e 必须带 `BUN_E2E`（bun142）起服务；本机 shell 的 http_proxy 环境会干扰 curl 对 127.0.0.1 的探测（bun fetch 不受影响），排障时注意 NO_PROXY。
