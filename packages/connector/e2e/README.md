# Connector e2e

会话级 Connector（创建会话 → 关联连接器 → MCP 使用）的端到端用例。**不依赖 mock**：真实 PG + 真实 open-connector 引擎 + HTTP 接口驱动。

## 前置条件

- 本地 PG（默认 `127.0.0.1:5432/opencode-v2-up`，postgres/postgres；经 `psql` 校验）
- bun ≥ 1.4.2（低版本缺 `node:sqlite`，服务启动 503）
- 服务用 `start-server.sh` 启动（或自备），需要的环境变量：
  - `OPENCODE_PASSWORD=ab123456`（Basic：opencode/ab123456）
  - `OPENCODE_CONNECTOR_ENABLED=true`、`OPENCODE_CONNECTOR_DATA_DIR`、`OPENCODE_CONNECTOR_PUBLIC_ORIGIN`
  - `OPENCODE_CONNECTOR_ENCRYPTION_KEY`、`OPENCODE_CONNECTOR_ADMIN_TOKEN`
  - `OPENCODE_CONNECTOR_PG_URL`（带 `?options=-c%20search_path%3Dconnector`）
  - `OPENCODE_CONNECTOR_MCP_URL=http://127.0.0.1:<port>/api/connector/mcp`
  - `OPENCODE_CONNECTOR_WEBHOOK_URL=https://<host>/connector/webhook`——trigger 回调基址（**引擎要求 HTTPS**，未配置时 createTrigger 拒绝 `webhook_url_missing`）
  - `OPENCODE_CONNECTOR_FILE_URL_BASE=http://127.0.0.1:<port>`——transit 文件下载 URL 重写基址（缺省回退相对路径 `/api/connector/files/:id`；也默认从 MCP_URL 推导）
- 引擎迁移：`migrate.ts`（自动 `CREATE SCHEMA IF NOT EXISTS connector`）
- 工具通道模式：`OPENCODE_CONNECTOR_MODE=mcp|native|both`（默认 `mcp`）。`native`/`both` 时注册 5 个原生工具（`connector_list_apps` / `connector_list_connections` / `connector_search_actions` / `connector_get_action_guide` / `connector_execute_action`，namespace `connector`）；原生执行用临时 scoped token（用完即吊销，绝不签发空白名单 token）

## 接口一览（除标注外均走 Basic auth）

**连接管理**
- `POST /api/session/:id/connector/connections`——api_key / custom_credential 直建
- `GET /api/session/:id/connector/connections` / `DELETE .../connections/:connectionID`（GET 返回每行合并引擎真实状态 `engineStatus`（active/reauth_required/error/disconnected）与 `accountLabel?`）
- `POST /api/session/:id/connector/connections/:connectionID/reconnect`——重新授权既有 oauth2 连接 → `{authorizationUrl, connectionRequestID}`，浏览器完成授权后走既有 oauth complete 端点收尾（幂等回到同一连接）
- `POST /api/connector/reconcile`——清扫孤儿引擎连接（无 SaaS 行引用的引擎连接；**OAuth 请求进行中勿调**，回调完成但未 complete 的连接会被误清）
- `GET /api/connector/runs?cursor=&limit=`——引擎动作执行记录分页透传（管理面，非会话域，返回 `{items, nextCursor?}`）

**Proxy / Transit 文件**
- `POST /api/connector/proxy/:service` `{sessionID, endpoint, method, query?, headers?, body?, connectionID?}`——provider 代理透传（endpoint 为 `/` 开头相对路径；连接定位规则同 executeAction：单连接自动、多连接须指定 connectionID、零连接走 no-auth 哨兵；临时 token 用完即吊销）。**⚠️ 当前受 bug#7 阻断**：临时 token 铸造硬编码 `allowedProxies: []`（`adapter/engine.ts` createRuntimeToken），引擎策略把显式空 proxy allowlist 判为全拒 → 端点 100% 返回 400 `"<service> proxy is not granted to this runtime token."`（证据见 docs/test-cases/connector-session-e2e-2026-10-10.md 无模型全场景章节）
- `POST /api/connector/files` `{sessionID, name, mimeType?, data(base64)}` → `{fileId, downloadUrl, sizeBytes, name, mimeType}`——上传引擎 transit 文件（multipart），downloadUrl 重写为 SaaS 端点
- `GET /api/connector/files/:fileID`——下载透传（Basic auth，字节流；引擎侧该路由本为公开，SaaS 侧统一收口在 Basic 后）

**Trigger（协议 §5 简化切片）**
- `POST /api/session/:id/connector/triggers` `{service, triggerId, config?, connectionID?}`——建订阅：按服务解析连接 → 铸**每调度持久 token**（引擎订阅绑定 tokenId，不可用临时 token）→ 引擎 reconcile(active=true)（endpointUrl=`<WEBHOOK_URL>/<scheduleID>`，**HTTPS 强制**）→ 落 `connector_trigger_schedule` 行
- `GET /api/session/:id/connector/triggers`——列出本会话调度（含 `lastResult` 最近一次 read/receive 结果；**事件→会话投递本轮未做**）
- `DELETE /api/session/:id/connector/triggers/:triggerID`——取消：引擎 reconcile(active=false)（须回放原 endpointUrl/config）+ 吊销调度 token + 行置 cancelled；幂等
- `POST /connector/webhook/:scheduleID`（**公开**，不走 Basic）——webhook 入口：raw body/headers/query 原样转 receive（引擎校验 nonce+签名）；respond 类结果按 provider 要求回 challenge，其余回 JSON；**简化**：receive 结果与 SaaS checkpoint 镜像非原子（见下"简化项"）
- 周期调度：每 pod 60s 扫描到期行，lease CAS（`lease_epoch`/`lease_until`）保证多 pod 安全；wake_seq 字段预留未用

**OAuth 连接（三步）**
1. `PUT /api/connector/oauth/clients/:service`——配置 client（`{clientId, clientSecret, extra?, requestedScopes?}`），一次性前置
2. `POST /api/session/:id/connector/connections/oauth` `{service, alias?, authorizationOptionIds?}` → `{authorizationUrl, connectionRequestID, expiresAt}`——用户浏览器打开 authorizationUrl 完成授权；`authorizationOptionIds` 透传引擎预选授权项（如 workspace）
3. `POST /api/session/:id/connector/connections/oauth/:connectionRequestID/complete` `{alias?}` → `{status: initiated|connected|failed|expired, connection?}`——轮询直到 connected；引擎回调状态在 PG，任意 pod 可完成；幂等

> 上游无 `GET /api/oauth/connection-requests` 列表路由（仅有单条 `GET /v1/connection-requests/:id` 与 `POST /api/oauth/connection-requests/:id/sync`），`listConnectionRequests`/`GET /api/connector/oauth/requests` **跳过未实现**，待上游补路由。

**MCP / 工具通道**
- `POST /api/session/:id/connector/mcp`——attach（返回可直接注册的 SessionMcp 配置）
- `POST /api/connector/mcp`（**不走 Basic**，`authorization: Bearer <attach 返回的 token>`）——MCP JSON-RPC 透传；**仅 stateless JSON POST**，GET/SSE 长连接监听不支持（handleMcp 只解析 SSE 响应体里的 data 行）
- `OPENCODE_CONNECTOR_MODE=native|both` 启用原生工具（`connector_*` 五件套）
- **no_auth 独立通道**：会话**零连接**时 `apps`/`search_actions`/`get_action_guide`/`execute_action` 也可用——临时 token 用哨兵 `allowedConnections=["no-auth-only"]`（不匹配任何引擎连接 → 连接类 action 被拒；no_auth action 引擎跳过连接检查 → 放行）；有连接时仍用真实连接 id；attach 仍要求 ≥1 连接

**公开路径（不走 Basic）**
- `GET /connector/oauth/callback`——provider 回调透传（引擎侧校验 state）
- `POST /connector/webhook/:scheduleID`——trigger 回调入口（引擎侧校验订阅 nonce + provider 签名后才推进状态）

## 多 pod 与简化项

**多 pod**：SaaS 服务本身无状态——引擎状态在引擎 PG schema、SaaS 行在共享 PG（`connector_connection` / `connector_trigger_schedule`），任意 pod 可处理任意会话/回调/完成。调度无 leader 选举：每 pod 都跑 60s 扫描，领取靠 `lease_epoch`/`lease_until` CAS（SKIP LOCKED 语义），输者不写。

**按协议文档仍是 TODO 的简化项**（引用 `docs/design/connector-trigger-protocol.md` / `connector-engine-adapter-spec.md`）：
- **§1/§2 受管 journal**：receive/read 的 checkpoint 由引擎在 receive 内先存，SaaS 侧 `saveCheckpoint` 镜像 + `last_result` 记录是独立事务，**非原子**；无引擎侧 durable receipt journal 前不启生产投递
- **§5 working-state**：poll 未实现显式 checkpoint revision 传参校验页级读取记录，仅 lease epoch CAS 围栏；空页/退避/jitter 按最简处理（固定 60s 间隔）
- **§6 会话投递**：事件不进 inbox/outbox，仅在 `lastResult` 供 listTriggers 查看最近事件
- **adapter-spec §2 凭证管理**：每调度引擎 token 明文存 `engine_trigger_schedule.engine_token`（TODO 加密 + 凭证生命周期表）；proxy/action 仍用临时 token 而非策略槽复用
- **wake/listener**：`wake_seq` 列预留未用；trigger token 不随连接集变化刷新（新连接上的新 trigger 铸新 token，旧订阅绑定旧 token 不受影响）
- OAuth connection-requests 列表：上游无路由，未实现（见上）

## 脚本与覆盖（按执行顺序）

| 脚本 | 覆盖 |
|---|---|
| `migrate.ts` | 引擎 PG 迁移 + schema 幂等创建 |
| `start-server.sh` | 启动 SaaS 服务（写日志到 /tmp） |
| `e2e.mjs` | 主套件：会话创建/关联连接（含 /v1 前缀修复验证）/列表归属/attach/注册 session MCP/隔离负向/删除清理 |
| `e2e-subsession.mjs` | 子会话资源域共享（list/attach/删） |
| `e2e-retest.mjs` | 修复复测：MCP 通道（initialize→tools/list 五工具→tools/call）、无凭据 401、回归抽查 |
| `e2e-final.mjs` | 最终复测（建议日常回归用这个）：全链 + 空 token 表无认证窗口关闭验证 |
| `e2e-execute-action.mjs` | execute_action 真实执行：arxiv（no_auth 公开 API）get_action_guide → 真实搜索 `effect systems`，验证引擎→第三方 HTTP 全链 |
| `e2e-no-model.mjs` | **无模型全场景**（纯 HTTP API 驱动，MCP 为 JSON-RPC 直调）：目录发现/连接生命周期/会话域隔离/no_auth/执行语义（连接定位+幂等）/MCP 手工/proxy 透传/runs 审计/孤儿清扫/OAuth 无人工态/reconnect/transit 文件，57 项；含 bug#7（proxy token 空 allowedProxies）与 bug#8（complete 对 initiated 500）定向取证用例 |
| `e2e-oauth.mjs` | OAuth 全流程：client 配置→发起→（浏览器授权）→complete 轮询→oauth2 连接关联→真实 GitHub API 执行（oa-6 默认形态当前暴露 bug #6，oa-6b 带 connectionName 验证凭据） |
| `bypass-engine.mjs` | 旁路进程直连引擎 /mcp（对照引擎侧行为，排障用） |
| `bypass-actions.mjs` | 旁路直连引擎 runtime API `/v1/actions/:id`（带 token 与 idempotency-key），验证引擎动作执行与幂等回放（SaaS 无 HTTP execute 端点时的引擎能力对照） |
| `bypass-raw.mjs` | 旁路任意 method/path 直调引擎（admin token 或指定 bearer），排障用 |

## 运行

```bash
bun packages/connector/e2e/migrate.ts        # 1. 迁移
sh packages/connector/e2e/start-server.sh    # 2. 起服务
bun packages/connector/e2e/e2e-final.mjs     # 3. 跑用例
```

或 `cd packages/connector && bun run test:e2e`。

## 环境差异说明

脚本顶部常量（`BASE` 端口、`BUN` 路径、PG 凭据）为当次执行环境的历史值，换环境时改脚本头部常量即可；完整判定口径见 `docs/test-cases/connector-session-e2e-2026-10-10.md`（含用例表与历次修复记录）。
