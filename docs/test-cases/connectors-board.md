# 连接器板块（2026-10-20）

## 范围

在 hn-app 增加全局「连接器」板块，复用现有 `@opencode/connector` 服务能力；不新增“项目”实体，不接入 OOMOL 控制台。

当前结构：

- 全局导航 `/connectors`。
- 概览：已配置连接、可连接应用、分类、免配置应用；推荐连接、使用方式、我的连接。
- 应用连接：搜索、分类筛选、全部/已配置/免配置、分页加载，点击进入应用详情页。
- 应用详情 `/connectors/:service`：应用信息、官网、连接账号管理、MCP 接入指南、全部接口定义（读取/写入/危险操作分组、scope、复制 action ID、接口搜索）。
- MCP 接入指南：获取当前连接空间的 MCP 配置、查看注册请求、复制配置/请求；提示 token 轮换和沙箱可达性。
- MCP URL 由基础服务提供：`BASE_PUBLIC_URL/api/connector/mcp`。基础服务校验 Bearer 后转发到 SaaS，不让沙箱拿到 SaaS 内网地址。
- 连接弹窗：API Key、自定义凭据、OAuth 授权；已配置账号可移除、OAuth 可重新授权。
- OAuth 授权前展示服务商权限选项：必需项锁定，默认项预选，危险权限标记“高风险”，选择通过 `authorizationOptionIds` 传给引擎。GitHub 默认 OAuth。
- 同时支持 OAuth 与 API Key 的应用默认选 API Key（例如 GitHub），避免因平台未配置 OAuth Client 导致首次连接失败。
- OAuth 提示必须由平台预先配置该服务的 OAuth App；未配置时提示改用 API Key，不把引擎英文错误直接抛给用户。
- GitHub 复用现有 Git Provider 的 OAuth App：Connector OAuth Client 自动写入 Git 的 clientId/clientSecret，`redirectUri` 指向 `/api/git-providers/oauth/callback/github`；该 callback 收到 Connector 的 UUID state 时转发给 SaaS 引擎，Git 自身的签名 state 仍走原流程。

## 作用域设计

现有 Connector API 要求 `sessionID`，连接属于会话资源域。为避免再造“项目”实体，基础服务新增 `connector_scope` 表，为每个用户维护一个隐藏会话「连接器空间」：

- 隐藏会话不写 `relation_tuple`，不会出现在会话列表。
- 连接写入该隐藏会话的资源域，前端只使用 `/api/connectors/*`。
- 连接不属于任何应用，符合“个人连接空间”的产品口径。
- 会话删除/重建时，基础服务检测 SaaS 会话 404 并重建作用域；并发首建会丢弃多余的孤儿会话。

> 当前是个人作用域，不是团队共享作用域。团队共享需要 Connector 服务提供用户/组织级连接域，属于后续协议升级。

## 基础服务接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/connectors/providers` | 目录；支持 service/authType/category |
| GET | `/api/connectors/categories` | 分类及数量 |
| GET | `/api/connectors/connections` | 个人连接；无作用域时返回空列表，不创建隐藏会话 |
| POST | `/api/connectors/connections` | 创建 api_key/custom_credential 连接 |
| DELETE | `/api/connectors/connections/:id` | 删除连接，幂等 |
| POST | `/api/connectors/connections/:id/reconnect` | OAuth 重新授权 |
| POST | `/api/connectors/oauth/start` | 发起 OAuth |
| POST | `/api/connectors/oauth/:requestId/complete` | 完成/轮询 OAuth |
| POST | `/api/connectors/mcp` | 生成连接空间的 MCP 配置（会轮换 token；URL 指向基础服务） |
| POST | `/api/sessions/:id/mcp` | 将 MCP 配置注册到指定会话 |
| POST | `/api/connector/mcp` | 公开 MCP 网关；Bearer token 转发到 SaaS，不暴露 SaaS 内网地址 |
| GET | `/api/connectors/runs` | 动作执行记录（预留） |

创建连接前先探测 Connector 服务；未启用时返回 503，不创建隐藏会话。凭据只进入 Connector 服务，不写审计正文；审计只记录 service/authType。

## 目录

- 实时目录来自 Connector 服务；服务不可用时前端使用 `src/lib/connector-catalog.json` 快照。
- 快照由 `packages/connector/assets/catalog/apps-index.json` 生成：1604 个应用、37 个分类。
- 图标优先使用目录 `iconUrl`；没有时按 `homepageUrl` 域名请求 64px favicon，加载失败回退首字母色块，不阻塞列表。
- 快照只用于浏览/搜索；连接操作仍走实时接口，失败时在弹窗内提示。

## 验证

- `hn-app` / `hn-base-server` 类型检查通过。
- 前端连接器纯逻辑单测 8 项通过：搜索、分类、已配置优先、统计、认证文案、图标回退、推荐回退。
- 前端全量单测 514/515 通过；唯一失败为既有 `route-repo` 用例，本轮未修。
- 基础服务单测 76 项通过。
- 浏览器验证：
  - 导航「连接器」可见，概览统计 1604 应用 / 37 分类 / 25 免配置。
  - 推荐区和目录页品牌图标实际加载（`naturalWidth>0`），失败回退首字母。
  - 应用连接页搜索、分类筛选（Productivity 550）、免配置 25、GitHub 搜索 1 条、更多分类展开通过。
  - GitHub 详情页显示 147 个接口（读取 81）；权限弹窗默认 OAuth，勾选 read:user+repo，授权 URL scope 为 `read:user repo`。
  - 接口分组、scope 标签、搜索与复制按钮可见；详情页连接区可打开添加账号。
  - MCP 指南实测：获取配置返回 201，URL 为 `http://localhost:3201/api/connector/mcp`（基础服务），包含 `name=connector`、Bearer token；注册到临时会话返回 201（`smcp_...`）；随后删除临时会话清理。
  - 经基础服务 MCP 网关执行 `initialize` 返回 200，`tools/list` 返回 `execute_action` 等工具；基础服务再转发到 SaaS 的路径可用。
  - MCP 全链 10/10 通过：配置生成、注册临时会话、initialize、tools/list、list_connections、search_actions、get_action_guide、execute_action（GitHub `get_current_user` 只读）、清理。
  - `execute_action` 未传 connectionName 时曾返回 `connection_not_allowed`；使用 `list_connections` 返回的 connectionName 后成功。MCP 指南已补充该用法。
  - 页面提示 token 轮换和本机地址仅适合本地沙箱；远端部署需设置 `BASE_PUBLIC_URL` 为沙箱可访问的地址。
  - 连接弹窗可打开，展示认证方式和凭据提示；启用前点击 OAuth 能显示实际 503 原因。
  - GitHub OAuth start 返回 200，`redirect_uri` 为 Git Provider 回调，state 为 Connector UUID；模拟 `access_denied` 回调被转发到 Connector 引擎（返回引擎 `oauth_provider_error`，不是 Git 前端错误页），证明回调转发正确。真实 GitHub 授权完成未执行。
  - 失败创建不会留下 `connector_scope` 或隐藏会话。
- 2026-10-20 已在测试服务启用 Connector 引擎：
  - 根因是 Connector runtime 静态引用 `node:sqlite`，当前镜像 Bun 1.3.14 不提供该内置模块；即使设置 `OPENCODE_CONNECTOR_ENABLED=true` 也会 503。
  - 已将 `packages/connector/src/engine/server/storage/node-runtime-database.ts` 的 SQLite store 改为仅在 SQLite backend 下动态加载；PostgreSQL 路径不再加载 SQLite。
  - 使用独立容器验证后，将补丁复制进当前测试容器并启用 Connector 环境变量；旧容器保留为 `opencode-saas-shell-test-pre-connector`。
  - `GET /api/connector/providers` 返回 200，页面不再显示“服务不可用”，目录统计为 1604/37/25。
  - 使用 Postmark 测试 API Key（假密钥）创建连接：201，列表显示 `active` / `Postmark API Key`；删除返回 204，列表归零。未调用外部 API。
- 因此已在线验证 **目录、个人连接创建/列表/删除**；仍未验证 OAuth 真实授权、动作执行和会话内 Connector MCP 调用。
- GitHub 的 OAuth 报 `Configure an OAuth client for github first` 属于平台 OAuth Client 未配置；现在已通过复用 Git Provider 的 GitHub OAuth App 解决：发起 GitHub OAuth 前自动写入 clientId/clientSecret 和 Git callback，Connector 回调由 base-server 转发给引擎。GitHub 仍默认 API Key，OAuth 作为可选方式。

## 预留（后续按具体场景扩展，本轮不实现）

设计参考：[Gumloop 连接器调研](../research/gumloop-connectors.md)（账号归属/选择分离、写操作审批与条件规则、source 活动日志、角色×工具矩阵）。

- 团队/组织级共享连接。
- 会话自动注入 Connector MCP（当前连接保存在连接器空间，需手动注册到会话）。
- 连接使用量/团队调用统计（现有服务没有对应聚合 API）。
- deployment 归属的运行日志查询。
- Cursor/Codex 实际客户端兼容矩阵、远端 HTTPS、生产限流与负载基准。
- Connector 环境变量当前保存在本机临时 env 文件，生产部署应改用密钥管理。
