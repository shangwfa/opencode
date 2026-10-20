# 应用级 MCP 实施与验证记录

## 当前状态

已实现简化版主链：PG 持久化、单有效 hash 凭据、管理 API、独立 MCP transport、基础服务透明网关和详情页工具选择。已在隔离 Docker、专用 PG 和真实浏览器验证，不代表已切换原有开发环境或上线。

未改动现有真实连接和凭据，未启动/切换原有开发 SaaS 容器。测试另建 `opencode-connector-mcp-verify-20261020`，监听 14100，使用 `opencode-connector-mcp-test` 数据库；基础服务测试使用 `hn_mcp_verify` schema、3202，前端 3003。测试身份保留在隔离 schema 中，测试 MCP 已删除。未清理 Docker 构建缓存。

## 已实现

- `packages/connector/src/adapter/app-mcp-tools.ts`：显式 action 选择、固定工具名称、契约指纹、数量/字节配额校验。配额由调用方提供，不编造生产默认值。
- `packages/connector/src/adapter/app-mcp-transport.ts`：复用已安装 MCP SDK 的标准 HTTP transport，直接暴露业务工具，保留输入 JSON Schema 校验和标准 JSON-RPC 响应。认证及调用前重新授权由未来 host 层提供；此模块没有自行开放 HTTP 监听端口。
- `packages/connector/src/engine/server/actions/scoped-action.ts`：进程内精确 action/连接授权，复用部署/运行策略和 ActionRunner，不按次创建内部 runtime token。
- `connect-app.ts` / `connector-runtime.ts`：暴露可信宿主调用入口，不新增公开 grant 接口；关闭时追踪、取消并等待内部执行。
- `packages/connector/src/adapter/app-mcp.ts`：Effect 服务，owner 隔离、固定连接、白名单、契约确认、CAS 更新、轮换/删除与调用前重新校验。
- `packages/core/src/connector/mcp-store.ts`：PG 持久化；owner 事务锁保证多 pod 创建配额；revision CAS 防止旧更新覆盖轮换/删除。
- `packages/core/src/connector/sql.ts`：简化范围采用单表保存 deployment、选择的工具快照 JSON 和当前 token hash，避免三表协调；API 不暴露 hash。完整迁移、注册、快照、schema.gen 和 pg-schema.sql 已生成。
- `packages/schema/src/connector-mcp.ts`、protocol/handler：管理契约与 raw MCP 响应；POST/GET `/api/connector/mcp/:deploymentId`，不包 `{status,body}`。
- `packages/hn-base-server`：登录管理 API、专用 Bearer transport、公共地址；普通 saasFetch 恢复强制服务身份，避免透传外部 Authorization 到任意 API。
- `packages/hn-app/src/components/connectors/app-mcp-panel.tsx`：创建、账号选择、搜索/筛选/勾选、编辑、停用、轮换、删除和一次性配置显示。详情页只展示新应用 MCP；旧通用后端接口暂保留，不自动迁移或轮换旧凭据。

## 验证

在 `packages/connector` 执行：

- `bun test test/app-mcp.test.ts test/app-mcp-transport.test.ts`：底层 12 项。
- Connector 全量 `bun test`：116 通过，0 失败；最新公开连接收紧另重跑底层 9 项通过。
- 新增服务测试 9 项：owner/路径隔离、hash、配额、CAS、轮换、停用删除、下架/契约变化与官方客户端执行。
- Core store：SQLite 4 项通过；真实 PG 后增补连接删除用例，共 5 项通过（`opencode-v2-test`，不使用共享开发库跑恢复扫描）。
- Server 完整路由 1 项通过：Bearer 认证委托、原始状态/协议头/正文、202 空通知和管理路由仍需服务认证。
- 基础服务全量 80 项通过，包含专用 MCP 通道 4 项；前端 build 通过。
- Core、Connector、Server、基础服务、前端类型检查通过；migration --check 通过，PG schema dump 已更新。
- `bun run typecheck`：通过。

模块测试用官方 Client + StreamableHTTPClientTransport 经自定义 fetch 对接 SDK handler；另已执行下述真实 Docker HTTP 测试，不能将这些测试扩大为 Cursor/Codex 桌面客户端已经验收。

实际 SDK 在 JSON responseMode 下仍可能为其自动订阅请求返回 event-stream。测试按响应 Content-Type 区分，而不是假定全部响应均为 JSON；官方客户端能完成调用。SDK 会输出 JSON 模式丢弃中途通知的提示，目前不承诺任务进度通知或持久订阅能力。

## Docker API 与 PG 验收

`packages/connector/e2e/app-mcp.ts`：12/12 通过。官方 SDK 通过 HTTP 连接 Docker 服务，真实执行 Hacker News get_item（只读），检查输入拒绝、owner/路径隔离、隐藏工具拒绝、过期 revision、旧 token 失效、停用和清理。PG 断言 token 仅 hash、run 已落盘、执行不新增内部 runtime token、删除后状态及 hash 正确。

执行需要 MCP_VERIFY_PASSWORD、MCP_VERIFY_PG_URL（强制库名以 -test 结尾）；MCP_VERIFY_URL 默认 14100，MCP_VERIFY_OUTPUT 可保存仅含结论的报告。原始 token 不写报告。隔离镜像由 `docs/test-cases/connector-mcp-runtime.Dockerfile` 构建，不修改运行容器文件。

一次收紧公开身份后的重跑发现：虚拟 public ID 不在真实 credential 表，原引擎按 stored ID 查询导致动作失败。已在 connection-service 中补精确 `${service}:default` 虚拟 ID 解析，仅适用于 no_auth 服务；固定 public ID 后不会回退新配置的默认账号。修复后重新构建镜像、重跑 12/12 通过。

## 浏览器与基础服务网关

真实浏览器在 3003 创建隔离用户，访问 Hacker News 详情：搜索并仅勾选 get_item、创建、一次性凭据显示、网关 initialize/tools/list/tools/call（200，标准 jsonrpc，1 个直接工具，isError=false）通过。随后编辑为两个工具、保存影响确认、停用和删除均通过。

凭据弹窗未截图或输出原始 token。窗口最小化导致截图不可用，采用语义 DOM 和实际 API 验证；不声称完成像素级视觉审查。

基础服务旧 `/api/connectors/runs` 因上游为全局管理视图，已暂时关闭（503），防止跨用户泄露。引擎仍记录动作执行，但尚未提供 deployment 归属的运行日志查询。

## OpenCode SaaS 会话内模型验收

隔离 SaaS + 远端 OpenSandbox 环境完成真实模型轮次，5/5 通过。执行器 `packages/connector/e2e/app-mcp-session.mjs` 在后台运行；另用 `session-sse-watch.mjs` 实时观察同一会话的 `GET /api/session/:sessionID/event`，没有等整轮结束才汇报。

实际 SSE 轨迹：

- `think`：模型识别需要通过 Code Mode 调用已注册 MCP。
- `tool ◇ execute` → `tool ✓`：Code Mode 执行成功，返回真实 Hacker News item 8863 数据。
- `text`：回复包含 `APP_MCP_SESSION_OK`、`id=8863` 和真实标题 `My YC app: Dropbox - Throw away your USB drive`。
- `exec ✔`：轮次执行成功。

断言覆盖：模型轮次成功、Code Mode 工具实际出现、成功标记与真实标题、SSE 中应用 MCP 工具调用成功、PG 新增 `hackernews.get_item` MCP 执行记录，且 deployment 的 owner/service/工具快照/token hash 正确。验证会话已注册 `app_mcp_verification` remote MCP，`oauth:false`；工具仅开放 `get_item`。

第一次尝试在 `Sandbox.create` 阶段失败：本机 30040 TCP 转发缺失，远端 `172.18.32.15:30040` 本身可达。恢复文档所述 TCP 转发后，用新隔离会话重跑通过；未将失败尝试计为成功。首次执行器还发现一个测试脚本问题：`prompt_stream` 读到终止事件后未立即停止，已先修复执行器再重试，并停止残留的旧执行器进程。

验收后清理：

- 删除测试 deployment、成功/失败测试会话和连接空间 owner 会话，删除请求均返回 204。
- PG 后检：三个测试会话行均为 0；deployment 保留软删除审计，`status=disabled`、`token_hash` 已清空、revision=3。
- 未删除真实连接、用户容器或 Docker 构建缓存。

运行参数：`MCP_VERIFY_SESSION_ID`、`MCP_VERIFY_OWNER_ID`、`MCP_VERIFY_DEPLOYMENT_ID`、`MCP_VERIFY_PG_URL`（强制 `-test` 库）、`MCP_VERIFY_SESSION_OUTPUT`。SSE 进程用短窗口观察，禁止在前台长跑执行器。

## 配置与尚未验收项

应用 MCP 四项配额为必填，无配置时请求返回明确错误，不影响无关 SaaS 路由：

- OPENCODE_CONNECTOR_MCP_MAX_DEPLOYMENTS
- OPENCODE_CONNECTOR_MCP_MAX_TOOLS
- OPENCODE_CONNECTOR_MCP_MAX_TOOL_BYTES
- OPENCODE_CONNECTOR_MCP_MAX_TOTAL_BYTES

隔离测试值分别为 20、200、131072、2097152，仅为本次测试配置，不是生产容量承诺。BASE_PUBLIC_URL 指向可达基础服务；测试为 localhost:3202，远端沙箱不能据此直接接入。引擎 PG 使用独立 connector search_path，并先执行 bundled engine migrations。

预留（后续按具体场景再扩展，本轮不实现）：Cursor/Codex 实际客户端、远端 HTTPS 地址、真实 OAuth 账号的新链路验证、生产限流/并发与响应体上限、规模负载、deployment 运行日志归属及查询。另参考 [Gumloop 连接器调研](../research/gumloop-connectors.md) 预留设计输入：账号归属/选择分离（个人/团队/agent-owned）、写操作审批与条件规则、source 维度活动日志、角色×工具矩阵。OpenCode 会话内模型/SSE/Code Mode 已在隔离环境通过。未切换原有开发服务，未提交或推送代码。预留项在真正生产上线前仍需补齐。
