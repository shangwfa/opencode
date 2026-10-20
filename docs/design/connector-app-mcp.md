# 应用级 MCP 接入技术方案

状态：简化版首期主链已实现，隔离 Docker/API/PG、浏览器及 OpenCode 会话内模型验收通过；尚未达到生产上线门槛。具体已验证项与未验证项见 [实施验证记录](../test-cases/connector-app-mcp.md)，下文历史设计不代表全部已实现。

## 当前实施范围（以本节为准）

根据最新范围决定，首期只实现“连接器侧创建标准 MCP，各端按标准配置使用”。本节覆盖下文与之冲突的早期设计；下文多客户端凭据、托管注册等内容仅是历史讨论，不纳入开发和验收，不作为未来必须实现的承诺。

### 用户流程

在应用连接器详情选择已授权账号、勾选开放 actions、创建 MCP，获得独立地址和一次性显示的 Bearer token。OpenCode SaaS、Codex、Cursor 使用相同服务地址和凭据；配置格式按实际客户端分别生成，是否兼容以标准 SDK 和真实客户端测试为准。

### 数据与接口

- deployment：保存当前用户归属、应用、固定连接、名称、状态和配置 revision。沿用现有个人连接空间映射，不新增资源空间或消费者实体。
- tool：保存明确选择的 action、稳定 tool_name、确认后的 contract_hash；新增目录动作不自动开放。
- token：每份 MCP 只保留一个当前有效凭据，认证表仅保存 hash。手动轮换原子撤销旧凭据，影响所有使用者；查询不返回历史明文，不自动轮换。
- 创建 deployment 时一并签发凭据；管理接口仅包含列表、详情、创建、修改名称/工具/状态、轮换 token、删除和已隔离的运行记录。轮换放在 deployment 级，不建设多 key 管理接口。
- 运行时 URL 为 `{BASE_PUBLIC_URL}/api/connector/mcp/:deploymentId`。服务端检查用户归属、固定账号、工具白名单；外部凭据不允许在旧通用 MCP/proxy 端点复用。

### 执行与生命周期

actions 直接作为 MCP tools，不要求客户端传 actionId 或 connectionName。tools/list 和 tools/call 均强制工具白名单；认证连接失效立即拒绝，不回退 default。使用内部 scoped execution 复用引擎策略和 ActionRunner，不按次创建 runtime token。

应用和账号绑定创建后不可更换；更换账号另建 MCP。工具配置变化影响全部使用端，扩大权限和轮换前明确提示影响范围。MCP 生命周期独立于消费会话，删除消费会话不删除或撤销共享 MCP；删除连接则停用关联 MCP。个人隐藏连接空间不是消费会话，不得由消费会话清理逻辑误删。

OpenCode SaaS 仅作为普通 MCP 客户端，用户按现有会话 MCP 配置方式手动接入；不创建会话专属 token、不引入一键托管注册操作。客户端确需保存 token 时，应使用其已有受保护配置存储；服务端普通查询、日志和模型提示不返回凭据。现有存储安全性仍需核查，不能以简化范围为由省略。

### 保留的上线要求

标准 MCP JSON-RPC/HTTP 正文与状态、静态 Bearer、HTTPS 公共可达地址、PG 持久化及多 pod 授权、连接 fail-closed、契约变更确认、资源配额、独立用户隔离、日志脱敏与运行记录归属均保留。资源配额首期只覆盖 deployment 数、工具/清单体积、请求/响应、速率与并发，不增加多凭据/托管注册配额。

验证官方 SDK 握手/工具发现/动作执行，再验证实际支持相同 transport 和鉴权方式的客户端。OpenCode 会话验收开启 Code Mode 并实时订阅 SSE，检查执行过程与 PG 数据；不能把直接 HTTP 成功当成所有端通过。

### 暂不建设

多客户端独立凭据、消费者/接入授权实体、新资源空间模型、会话专属 token、托管注册状态机及跨服务补偿、OAuth MCP 授权服务器、自动 Harness 注入均不实现。后续只根据具体使用场景和已复现问题扩展，不预先搭建这些机制。相关设计输入（账号归属/选择分离、审批层、活动日志、角色×工具矩阵）见 [Gumloop 连接器调研](../research/gumloop-connectors.md)，仅作预留记录。

已知取舍：共用 token 无法单独撤销一个使用端；轮换影响所有使用者；工具扩权影响全部使用端。需要不同权限或独立撤销时，首期创建另一份 MCP。

---

以下保留早期详细讨论作为参考。实施中仅复用不与上述范围冲突的协议、安全、执行和测试要求。

## 1. 目标与边界

为 OpenCode SaaS、Codex、Cursor 等标准 MCP 客户端提供单应用 MCP。用户选择应用、已授权账号和可见工具，生成独立接入配置。模型直接调用业务工具，不传 actionId、connectionName，也不能自行切换账号。

核心模型：一个应用可以有多个连接；一个连接可以有多份 MCP 接入配置（下称 deployment）。每份 deployment 只绑定一个应用、一个连接、一份工具白名单，有独立生命周期；同一 deployment 可以为不同客户端签发独立凭据，无需复制工具配置。

首期支持标准 Streamable HTTP、静态 Bearer 鉴权、工具选择、停用、轮换、撤销、手动配置和 OpenCode 会话注册。暂不增加跨应用工具集合、资源级策略 DSL、每次写操作人工审批、外部客户端 OAuth 授权服务器、传统 HTTP+SSE transport。仅支持 OAuth 的客户端不宣称兼容。

无认证应用可以创建不绑定凭据的 deployment，但必须由服务目录明确标记为 no_auth；禁止借此绕过需要认证的应用。

## 2. 现状依据与需要修正之处

- `packages/connector/src/adapter/connector.ts:773`：attachMcp 为整个 owner 的 active 连接发 token，每次生成配置会撤销该 owner 旧 token；不适合独立接入配置。
- 同文件 executeAction 已明确记录：引擎缺省连接名为 default，而 SaaS 使用系统生成名称。因此“默认连接失败”不是账号不存在，而是解析规则不匹配。新链路必须强制绑定稳定连接 ID。
- `packages/connector/src/adapter/engine.ts`：已有 provider、runtimeCall、runtime token 接口。适配层 createRuntimeToken 尚未暴露 allowedActions，但引擎 runtime-token-service 已有该字段。
- `packages/hn-base-server/src/routes/connectors.ts`：管理 API 按用户隐藏 session 定位个人连接，MCP URL 重写到基础服务。
- 现有 MCP 是五元工具模式，不是 action 直接作为 tool。
- 之前验收脚本读取 `response.body.result`，实际返回存在 `{status, body}` 包装。HTTP 200、手工调用成功不等于标准 MCP 客户端通过；新接口必须修正真实 HTTP 状态与 JSON-RPC 正文。
- `/connectors/runs` 当前转发全局记录，不能直接用于新接入的用户级运行日志，需先补授权过滤。

上游 open-connector 的 `examples/openai-tools` 可借鉴 action→tool 名称映射，但没有可直接启用的应用级 MCP Server。竞品目前只核实了 Zapier 创建 server、选择应用和勾选工具的公开流程，不能把其他产品的未核实行为当作实现依据。

## 3. 架构与职责

链路：客户端 → 基础服务公共 MCP 网关 → SaaS 应用级 MCP handler → Connector 引擎现有 ActionRunner → 第三方 API。

基础服务负责用户登录、个人空间映射、管理权限、公共地址和透明代理。SaaS 负责 deployment、token、工具授权、MCP 协议及审计。引擎保留凭据管理、scope/策略校验、provider 调用和执行记录。

不在基础服务另建一套连接器凭据或运行时策略，不复制 provider 业务代码。SaaS 使用现有 Effect v4 Service/Layer、PG store、schema/protocol/handler 分层。基础服务继续 REST，不引入 SDK。

多 pod：所有授权状态存 PG；不能依赖内存 token 表、MCP 长连接或 pod 亲和性。首期每个 HTTP 请求独立处理，不设置 Mcp-Session-Id，不维持通知连接。

## 4. 数据模型

在 SaaS 所有的 PG schema 按项目迁移规范新增：

### connector_mcp_deployment

- id：不可预测 ID，主键。
- owner_session_id：个人连接空间的 owner，必填。
- service：目录中的稳定服务标识。
- connection_id：SaaS connector connection ID；仅 no_auth 可空。
- name：用户名称，1–100 字符。
- status：active / disabled / deleted。
- revision：配置乐观锁版本。
- created_at、updated_at、deleted_at。

### connector_mcp_tool

- deployment_id、action_id：联合主键。
- tool_name：该 deployment 内唯一，首次生成后稳定。
- contract_hash：用户确认时的执行契约指纹，覆盖 service、actionId、输入 schema、必需 scope/权限、操作类型和执行版本（目录提供时）。对象键规范化、排除纯展示描述后计算；数组仅在语义明确无序时排序。不声称该指纹能自动判断变更兼容性。

记录显式 action 快照，不持久化 `all=true` 这类动态通配授权。“全选”只是保存当前全部可选 action；目录未来新增 action 不自动获得权限。

### connector_mcp_token

- id、deployment_id。
- client_name：用户可辨识的客户端名称，例如 Cursor、Codex 或某个 SaaS 会话。
- managed_session_id：可空；SaaS 托管凭据绑定的消费会话，不替代 deployment 的 owner。
- revision：凭据轮换乐观锁版本。
- status：pending / active / revoked；外部手动签发直接 active，托管注册先 pending。
- registration_operation_id：托管注册操作的幂等关联，普通外部客户端凭据为空。
- token_hash：高熵随机 token 的 SHA-256，唯一；不存明文。
- token_prefix：脱敏展示，不足以认证。
- created_at、expires_at（可空）、revoked_at。

每个客户端使用独立 token。同一 deployment 下允许多个有效 token；轮换只原子撤销目标 token 并签发替代项，不影响其他客户端。停用或删除 deployment 则使全部凭据失效。创建/轮换返回的明文只显示一次，查询不恢复明文。轮换必须校验凭据 revision，避免并发签发多个替代项。

认证表只保存 hash。SaaS 托管客户端需要使用明文发起认证，因此会话敏感配置可以保存凭据密文；该存储与认证表职责不同。密文必须使用服务端托管密钥和现有可用加密机制，读权限仅限 MCP 运行时，普通查询只返回已配置状态。实现前核查现有加密能力，不得假定当前 session MCP 存储已经满足要求。

托管注册操作复用已有可持久化操作记录；若没有则新增最小记录，保存 operation_id、owner、deployment、目标 session、幂等键、pending token ID、原注册引用、状态和截止时间。owner+幂等键唯一，记录中不放凭据明文。凭据密文在 pending 阶段即写入受保护存储，支持 pod 重启后继续或补偿；操作完成后清理不再需要的暂存密文。

执行记录复用引擎 run，并关联 deployment_id、token_id、owner_session_id、连接 ID、actionId、requestId、结果和耗时；不复制大体积输入输出。若现有表无法直接扩展，新增以 run ID 为唯一键的归属关联表。审计不可包含 token、OAuth secret、完整个人资料。

索引覆盖 owner+status、token_hash、deployment+action 和 owner+run 时间分页。连接删除采用同事务停用关联 deployment、撤销 token；后台再清理远端凭据。不靠级联删除抹掉审计。

## 5. 对外与内部 API

基础服务登录管理接口：

- GET /api/connectors/mcp-deployments：当前用户列表，可按 service 筛选。
- POST /api/connectors/mcp-deployments：创建，输入 name、service、connectionId、actionIds；返回 deployment、首次明文 token 和接入配置。
- GET /api/connectors/mcp-deployments/:id：元信息及已选工具，不返回旧 token。
- PATCH /api/connectors/mcp-deployments/:id：更新名称、状态、工具集合；必须提交 revision，冲突返回 409。
- GET /api/connectors/mcp-deployments/:id/tokens：凭据元信息列表，不返回明文/hash。
- POST /api/connectors/mcp-deployments/:id/tokens：为一个客户端签发独立凭据，返回一次性明文和接入配置。
- POST /api/connectors/mcp-deployments/:id/tokens/:tokenId/rotate：提交凭据 revision，轮换该客户端凭据，只返回这次的新明文。
- DELETE /api/connectors/mcp-deployments/:id/tokens/:tokenId：只撤销该客户端凭据，幂等。
- DELETE /api/connectors/mcp-deployments/:id：撤销并软删除，重复删除幂等。
- GET /api/connectors/mcp-deployments/:id/runs：仅授权归属范围内的运行记录。

每个管理请求都重新从登录用户解析 connector owner，SaaS 再以 owner+deployment ID 查询；不得接受请求体声明的 userId 或 owner。跨用户 ID 返回 404。

SaaS 管理 API 放在 `/api/session/:id/connector/mcp-deployments` 资源下，沿用 session owner 解析。运行时地址：

`https://<BASE_PUBLIC_URL>/api/connector/mcp/:deploymentId`

采用 deployment ID 而非 `/github`，因为同一 GitHub 账号可以有只读、开发两份配置。服务名可在 UI 展示，不承担授权。URL 不包含 token；请求头为 Authorization: Bearer <token>。

基础服务 runtime 网关不要求网页登录，但必须将 Bearer 交给 SaaS 实际校验；限制方法、请求体和超时，只转发必要协议头。不允许客户端控制上游 URL。复用服务身份认证通道并另传连接器凭据，避免全局 saasFetch 的 Authorization 语义被改变；内部专用头必须由网关覆盖，不能信任外部同名头。

## 6. action 到 MCP tool 的映射

tools/list 只返回该 deployment 明确选择且仍有效的 actions，不暴露 list_apps 等五元工具。

工具名采用兼容字符 `[A-Za-z0-9_-]`，不超过 64 字符，例如 github__get_current_user。转换使用持久映射，不靠双下划线反向推导 actionId；长名称截断后附 actionId 的确定性短 hash，创建时校验冲突。

工具描述、inputSchema 来自可信 provider catalog。工具输入就是 action 的业务参数，不注入 actionId、connectionName 或连接凭据。调用时由 deployment 补入绑定的 service 和稳定 engine connection ID。

必须验证 schema 是该 MCP SDK 支持的对象输入 schema；保留必填、嵌套、枚举等约束，不用宽松 record 代替。无法支持的 schema 明确标记不可发布，不静默丢约束。输出首期使用标准 text content 承载 JSON，不宣称未经验证的 outputSchema。

提供 readOnlyHint、destructiveHint、openWorldHint 等工具注解，但这些只是模型提示，不是授权边界；未知风险类型显示“未分类”，不能默认当只读。

首期采用保守规则：当前 contract_hash 与确认值不同，或动作下架，即从 tools/list 排除该工具、拒绝 tools/call，并在管理页提示重新确认。不自动判断是否破坏性变化；即使新增可选参数也需确认。纯展示描述变更不改变指纹；目录未提供执行版本时，无法检测 schema/权限未变的实现语义变化，升级前必须评估并必要时主动使契约失效。重新确认需要用户查看差异并以 revision 提交，不能通过一次普通保存自动认可全部变更。

工具集合较大时按 SDK 支持实现 cursor 分页，cursor 绑定 deployment revision 和当前工具目录版本；目录变化使旧 cursor 失效。客户端仍可能加载全部工具，分页不等于减少上下文。

## 7. 认证与执行授权

新增外部 deployment token 与引擎 runtime token 分离，防止外部 token 被拿去调用旧通用 MCP 或 proxy 绕过白名单。

每次 tools/call 固定顺序：

1. 校验 Bearer 格式和 hash，token 状态为 active、未撤销、未过期，属于路径 deployment。
2. 读取 deployment 当前状态和 revision。
3. 校验工具在当前白名单，action 属于 service，映射及 schema 未失效。
4. 校验绑定连接归属 owner、服务匹配、状态可用；认证应用必须解析到唯一、非空的稳定 engine connection ID，否则立即拒绝，不回退 default 或任意其他账号。
5. 验证参数，再调用引擎；连接由服务端指定，不允许输入覆盖。
6. 引擎照常验证 action policy、OAuth scope、connection grant，执行并记录。

在引擎适配层新增仅供内部调用的 scoped execution 接口，接收经过 SaaS 验证的 action、固定连接及审计上下文，调用现有 ActionRunner 和同一 action-policy evaluator。scope grant 由可信内部适配层构造，action/连接为精确单项，不接受通配规则；外部请求只能传业务参数，不能提供 grant 或覆盖目标。禁止通过 admin action 路径绕过策略校验。

不为每次调用创建、存储、撤销内部 runtime token，也不新增其过期回收机制。scoped execution 必须通过进程内引擎接口或已有受服务身份认证保护的内部通信进入；不得注册为只凭用户 Bearer 即可调用的公开 grant 接口。审计直接关联已校验的外部 token ID，不虚构内部 token 记录。实现前核实 ActionRunner 的 grant/tokenId 契约，若有 runtime-token 外键或专属查询依赖，明确调整归属关联，不能以一个无权限的假 ID 蒙混。

引擎当前 evaluateConnection 中 allowedConnections=[] 表示不限制，不是拒绝全部。认证应用的缺失/删除/失效连接必须在构造 grant 前失败，绝不把空数组当成拒绝权限。no_auth 使用独立的显式执行分支：实时确认目标 action 属于允许的 no_auth 服务，解析引擎认可的公开连接身份，并限制精确 service/action；无法解析时拒绝。禁止因为认证连接解析失败就进入 no_auth 分支。

停用、缩小白名单和轮换在 PG 提交后，对新请求立即生效。已获授权并进入第三方执行的在途请求不承诺可取消，UI 明示。首期不缓存可变授权；目录元信息可缓存。

## 8. MCP 协议与错误

复用已安装 MCP SDK，不手写不完整 JSON-RPC 分发器。先核实当前 SDK 包及版本可支持动态 tools/list 和 tools/call，再落地适配。

支持 initialize、notifications/initialized、ping、tools/list、tools/call。协商协议版本、正确回显 id；通知不返回 JSON-RPC result，按 SDK transport 规范返回 HTTP 响应。对不支持的方法返回标准 method not found。

JSON 模式的 Streamable HTTP 作为首期 transport；基础服务必须原样保持 SDK 输出的 HTTP 状态、Content-Type、协议头和正文，不包 `{status,body}`。未实现 GET 通知流时按协议返回 405；不宣称支持传统 SSE transport。

认证失败为 HTTP 401，凭据被撤销同样拒绝；路径与 token 不匹配不泄露 deployment 详情。格式错误、无效 params、未知工具采用 SDK 标准协议错误；第三方动作执行失败返回 tool result 的 isError 与脱敏错误，不伪装成功。

按 Origin/Host 策略防 DNS rebinding，不使用全来源 CORS；浏览器 playground 只放行配置好的站点。限制请求体、参数深度、输出大小、单次超时和按 deployment/token 的请求速率；多 pod 限流不能只放内存。日志不得记录 Authorization。

标准 MCP JSON-RPC id 不作为写操作幂等键。连接中断后不自动重试写动作；第三方幂等仅在动作与引擎明确支持时使用，不能保证所有写动作 exactly-once。

## 9. 前端产品流程

在已有 `/connectors/:service` 详情加入“MCP 接入”，不新建项目实体。

创建向导：填写名称 → 选择已授权账号 → 选择工具 → 预览 → 创建并一次性显示凭据。

工具选择提供搜索、已选数量、只读/写入/危险/未分类筛选、单选和显式全选。默认可预选当前可用的只读动作，但用户确认才发布；允许选择全部动作。危险动作批量选中时二次确认，不能把 UI 确认描述成每次执行审批。

scope 不足的动作显示原因并提供重新授权入口；只有可靠权限元数据时才禁用，不确定的显示“执行时校验”。权限扩大不自动选中新工具，权限缩小立即由引擎拒绝，UI 标示需重新授权。

编辑实时显示变更差异、未保存提醒和并发版本冲突。已有 MCP 配置旁显示工具数、绑定账号、状态；凭据列表按客户端展示脱敏 token、复制地址、轮换和撤销。历史 token 不可再次查看；丢失时只轮换该客户端凭据，不影响其他客户端，不因查看配置自动换 token。

输出通用接入信息，并按经过验证的客户端格式导出 Cursor、Codex、OpenCode 配置；不同客户端配置格式不可混用。静态 Bearer 存客户端配置有泄露风险，支持环境变量引用的客户端优先引用。禁止把外部客户端支持范围扩大到“所有 MCP 客户端”。

工具更新对下一次 tools/list 生效。首期不承诺主动 listChanged 通知；UI 提示客户端重新连接/刷新，旧客户端即使仍缓存旧工具，tools/call 仍由服务端拒绝已移除动作。

## 10. OpenCode SaaS 接入

复用现有 session MCP 注册和资源权限校验。用户显式选择 deployment 后，注册该 URL 和 token；个人隐藏连接空间不会自动授权给任意需求会话。

用户选择 deployment 接入会话时，服务端创建该会话专属 token，并将其密文写入会话 MCP 敏感配置；不要求用户找回 Cursor/Codex 的凭据，也不轮换其他客户端 token。注册前同时校验 deployment 管理/使用权限与目标会话 run 权限。首期个人连接只允许注册到同一用户拥有的会话；共享/转移会话前必须阻断或显式撤销个人凭据，不能借 session run 权限隐式共享个人账号。

token 签发与会话配置可能跨服务，不能假称单 PG 事务。使用持久化注册操作 ID 和幂等键协调：新凭据先为 pending、不允许认证；密文配置写入并确认后激活，失败则撤销并回滚新增注册。重试复用同一操作，后台对账清理未完成操作，不因重复点击创建多个有效 token。失败回滚不得覆盖原有可用 MCP。会话删除或显式移除 MCP 时撤销对应 managed token；轮换托管 token 采用同一激活流程，确保新配置就绪再切换，不能影响其他客户端。

托管密文不在普通 API、日志、SSE 或模型提示词中出现；只在 MCP 运行时解密。加密存储未落实前禁止开放自动注册。

可选自动应用到未来需求的 Harness 不是首期默认行为；如需配置，必须单独确认共享边界和凭据生命周期。

远端沙箱必须能访问 BASE_PUBLIC_URL，生产要求 HTTPS。沙箱依现有 Session MCP 的命令拉起、就绪探测、网关寻址机制运行客户端，不新增 SaaS 到沙箱 IP 直连。

## 11. 测试与验收

### 单元与接口

- action→tool 映射：长名称、冲突、Unicode、不合法 schema、嵌套输入、危险类型。
- 所有管理 API：owner 隔离、连接/service 不匹配、未知 action、跨应用 action、重复 action、空选择、上限、revision 冲突。
- token：随机强度、认证表只存 hash、恒定格式校验、过期、独立客户端轮换/撤销、路径不匹配、旧通用端点及 proxy 无法复用；轮换 Cursor 凭据不影响 Codex/SaaS 凭据。
- 白名单：tools/list 不显示未选；猜名称 tools/call 仍拒绝；移除工具后旧客户端立即失败；新增 catalog action 不自动授权。
- 并发：工具修改/轮换与调用竞争、连接删除、多个 pod 同时查询；scoped execution 不增加 runtime token 记录，复用引擎策略仍拒绝 scope/连接越权。
- 连接 fail-closed：认证连接缺失、已删除、跨 owner、服务不匹配时不能生成空连接 grant、回退 default、选择其他账号或进入 no_auth；公开应用不能调用其他应用动作。
- 契约变更：可选字段、必需 scope、风险类型变化均使工具失效；仅描述变化不失效；重新确认前发现与执行都拒绝，普通保存不误确认。
- 自动注册：双重权限、跨用户/共享会话拒绝、pending 不可认证、跨服务失败补偿、重试幂等、删除会话撤销凭据、不会改坏已有 MCP；密文不可通过 API/SSE/日志读取。
- 协议：官方 MCP client 完整握手、通知、ping、工具分页、协议头、错误 id、HTTP 状态、JSON 正文无包装、超时和客户端断开。
- scope 缺失、再授权、第三方 401/429/5xx、输出截断、写动作不自动重试。
- 运行日志只能查询该 owner，不能借 run ID 查其他用户的数据。

### Docker API 与真实客户端 E2E

使用 SaaS Docker + PG，分别创建两个用户、两个 GitHub 账号/测试连接、只读和写入 deployment。使用真实 MCP SDK 客户端验证 tools/list 和 tools/call；真实 GitHub get_current_user 仅保存成功标记和结构，不保存个人资料。写操作只在明确批准的测试仓库执行并清理。

用 Cursor/Codex 的实际版本做兼容矩阵，记录版本、transport、鉴权配置格式、握手和动作结果；配置能被解析不等于真实调用成功。

OpenCode 会话测试必须默认 Code Mode 开启，订阅 GET /api/session/:sessionID/event SSE 实时展示执行过程，模拟回答提问并断言调用来自指定 MCP。分别检查模型结果、工具执行链路、PG deployment/token/run 归属。不得把直接 HTTP 调用当作模型内调用成功。

PG 后检区分存储职责：认证 token 表仅 hash；托管客户端配置仅密文且普通角色不可读取；其他表/审计/运行记录不得出现原始 token。验证目标客户端旧 token 已撤销、其他客户端仍可用、白名单正确、run 归属正确、删除测试会话撤销其 managed token 且未误删真实连接、执行不产生额外内部 runtime token。

负载测试覆盖最大目录应用的工具列表体积、分页耗时、内存、认证查询成本和第三方限流。没有测量前不承诺最大工具数或并发吞吐。

### 资源配额与发布前参数

必须由服务端集中配置并强制执行：每 owner 的 deployment 数、每 deployment 有效/待激活凭据数、选中工具数、单工具 schema/描述字节数、整份工具清单总字节数、输入/输出大小与深度、分页条目/字节数、按 token/deployment/owner 的速率与并发上限。分页不能绕过整份清单配额；已选工具未变但目录升级导致超限时明确暂停发布并提示用户缩减，不静默裁剪已选权限。

创建、签发、批量选工具的配额判断与写入必须在同一 PG 事务内锁定对应 owner/deployment 行，避免多 pod 并发突破上限。删除/撤销释放有效资源配额，但历史记录另设保留期限与分页，避免审计无限增长。跨 pod 运行时配额复用已有共享网关能力；没有时需落实 PG 原子计数/有到期时间的并发租约，不能临时用进程内 Map 作为生产实现。

这些上限的具体数值是上线必填配置，不在缺少证据时编造。实现阶段统计当前 provider 动作数、schema/描述体积分布，再测实际 Cursor/Codex/OpenCode 的发现耗时和上下文占用，形成已批准的默认值及压力测试证据；配置缺失则拒绝启用该功能。超过上限时创建/更新返回明确的资源配额错误，HTTP 请求体超限返回 413，运行时限流返回 429；UI 提交前展示已用量与限制。“全选全部动作”仅在这些资源配额内可用。

## 12. 分阶段实施、迁移与回滚

1. 协议基线：先加标准 SDK 客户端失败用例，修复现有响应包装，隔离 Bearer 转发与服务身份认证，补日志归属漏洞。
2. 存储与授权：新增 PG 表、管理 API、多客户端独立 token、scoped execution、连接 fail-closed、契约确认与事务配额测试。
3. MCP adapter：动态 actions 工具、固定账号、标准 transport、真实 SDK 集成测试。
4. 前端：已有详情页管理、工具选择、凭据一次性展示、客户端配置。
5. SaaS 专属凭据注册与失败补偿、会话 + Cursor/Codex E2E，完成兼容矩阵、配额默认值和负载基线。
6. 构建固定 SaaS 镜像并部署；不再依赖 docker cp 补丁。校验公有 HTTPS 地址和稳定加密密钥，不清理 Docker 缓存。

旧五工具 MCP 暂时保留在原 URL 并标注旧入口，不自动迁移、不轮换用户旧凭据；新接入全部走 deployment URL。回滚通过功能开关停用新入口，保留 PG 数据和审计；数据库采用新增式迁移，不靠删表回滚。停用新入口不能重新开放被撤销的旧 token。

## 13. 上线门槛与已知限制

必须完成标准 SDK 兼容、双用户隔离、隐藏工具不可调用、轮换与撤销、scope 拒绝、远端沙箱访问、Code Mode 会话调用、PG 后检和固定镜像部署，任一失败不得宣称整体可用。

已知限制：服务端 token 撤销不能撤销已到达第三方的写请求；客户端可能缓存旧工具列表；静态 Bearer 客户端需要安全保存凭据；首期不支持要求 OAuth 的客户端；上游已有读取/写入分类、schema 与 scope 元数据仍需按应用验证，不能把目录声明等同实际支持。
