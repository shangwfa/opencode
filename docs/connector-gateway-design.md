# Connector Gateway 实现方案（修订版：主要缺口补齐）

> 状态：主要缺口已补充具体协议，待评审与技术验证；**未实现、未通过运行验证**。
> 日期：2026-10-10
> 上游：`~/code/open-connector`；修订依据：初版审核及 `docs/connector-gateway-design-review-revised.md`。
> 本文替代初版。审核报告保留为初版问题记录，不代表修订版已经通过验收。

配套实施规格（与本文共同构成方案）：

- [调用、授权与审批协议](design/connector-invocation-protocol.md)：可信InvocationContext、grant合并、幂等/审批状态机、MCP调用证明与异步Action。
- [Trigger接收、调度与恢复协议](design/connector-trigger-protocol.md)：原始receipt、受管引擎journal、checkpoint原子提交、webhook/poll/listener与会话投递。
- [内部引擎适配规格](design/connector-engine-adapter-spec.md)：凭证记录/回收、dispatch admission、撤销生效边界与必要扩展。

具体状态机、字段和并发协议以配套规格为准；缺失的引擎/核心扩展是明确交付项，不再用“检查一下”代替设计。

## 1. 目标与架构决策

将 open-connector 嵌入 opencode SaaS，为第三方连接、OAuth、Action、proxy、Triggers、文件和 Marketplace 提供平台能力。

**范围（2026-10-10 收敛）**：当前数据库没有用户概念，第一期只实现**会话级 Connector**——connector 的配置、连接凭据、授权、执行记录全部**跟着会话走**，生命周期归属会话资源域。不做用户/组织/项目的凭据归属与跨会话共享，不引入 Principal/Identity Adapter 的用户模型。会话之间仍必须互相隔离（A 会话不能访问 B 会话的连接），但这是**资源域隔离**，不是多用户安全模型。用户级/项目级归属列为后续演进，不阻塞本期。

固定决策：

1. 连接器执行在 SaaS；凭据不进入模型、会话工具配置或沙箱。
2. 上游作为**内部执行引擎**，不直接暴露上游 `/api/*`、`/v1/*`、`/mcp` 或 dashboard。
3. SaaS 负责资源归属、授权、会话编排、审计与公开契约；引擎负责 provider 契约与执行。
4. MCP 和原生工具共用一个执行服务，上层选择 `disabled | mcp | native | both`；未配置时 disabled，不擅自默认授予能力。
5. **Connector 归属会话资源域**（复用 `SessionResourceOwner` 语义）：内部子会话共享主会话的 connector 定义；显式历史 fork 建立独立资源域，默认不继承凭据。
6. 所有权不等于执行授权；可发现不等于已授权；空权限默认拒绝；会话间默认隔离。
7. 无状态多 pod：持久状态、授权版本、任务租约与幂等记录在 PG；共享文件在对象存储。不引入 pod/沙箱亲和性。

“全量”指平台支持上述类别，不保证每个 provider 已可执行。实际可用性按上游 catalog、执行器、自有 OAuth client、第三方权限与必要外部配置确定。OOMOL 托管 OAuth/执行是独立可选能力，不能默认开启。

## 2. 职责边界与实现位置

以下为**计划新增文件**，不是已经存在的实现。

| 位置 | 职责 |
|---|---|
| `packages/connector/src/engine.ts` | 私有引擎接口、runtime acquire/release、类型化管理/执行操作、错误归一化 |
| `packages/connector/src/assets.ts` | catalog、provider registry、迁移资产与版本校验 |
| `packages/connector/src/migrate.ts` | 上游 PG 迁移入口，部署 Job 使用 |
| `packages/schema/src/connector.ts` | 浏览器安全的连接、grant、模式、执行结果契约；不含凭据 |
| `packages/schema/src/connector-event.ts` | 必要的公开审计/执行事件契约 |
| `packages/protocol/src/groups/connector.ts` | SaaS 管理 API、操作 ID、错误与权限契约 |
| `packages/core/src/connector.ts` | Connector 域服务门面 |
| `packages/core/src/connector/sql.ts` | SaaS 元数据表、约束、索引 |
| `packages/core/src/connector/identity.ts` | 会话归属/资源域校验（SessionResourceOwner 接入）；未来用户级 Principal 解析的预留位置 |
| `packages/core/src/connector/authorization.ts` | 单一授权入口、按连接的有效策略、撤销版本 |
| `packages/core/src/connector/connections.ts` | 所有权、grant、OAuth 生命周期、创建/删除补偿 |
| `packages/core/src/connector/execution.ts` | 审批、执行、幂等、限流、审计、输出脱敏 |
| `packages/core/src/connector/invocation.ts` / `approval.ts` | 可信调用上下文、参数摘要、既有Permission/持久审批桥接 |
| `packages/core/src/connector/capability.ts` | SaaS 短期能力凭证签发/验证，不复用上游 JWT 的 boolean 认证 |
| `packages/core/src/connector/engine-credentials.ts` / `dispatch.ts` | 私有token策略槽、租约/回收、出站commitment与撤销检查 |
| `packages/core/src/connector/remote-jobs.ts` | async Action start/status/cancel与远端job关联 |
| `packages/core/src/connector/mcp.ts` | SaaS MCP 门面与五个工具调度，不透传上游 MCP |
| `packages/core/src/connector/triggers.ts` | 订阅所有权、inbox/outbox、重试、会话投递 |
| `packages/core/src/connector/trigger-receipts.ts` / `trigger-scheduler.ts` / `trigger-delivery.ts` | 引擎journal导入、poll/listener任务、会话幂等接受 |
| `packages/core/src/connector/files.ts` | 文件所有权、受限下载能力、对象存储编排 |
| `packages/core/src/tool/plugin/connector.ts` | 原生工具适配，只调统一执行服务 |
| `packages/server/src/handlers/connector.ts` | 管理/执行 HTTP handlers，逐请求解析身份与资源权限 |
| `packages/server/src/handlers/connector-callback.ts` | OAuth/webhook/文件的显式受限入口 |
| `packages/server/src/handlers/connector-mcp.ts` | MCP HTTP transport 与能力凭证验证 |
| `packages/server/src/middleware/connector-authorization.ts` | 精确路径/方法的鉴权分类，与既有全局鉴权协调 |

依赖方向：`schema ← protocol ← server`；`core → connector → 上游引擎`；`server → core`。connector 包不依赖 core/Session/Tool，避免循环。

引擎进程级服务进入 server 全局服务图；需要 Location 的 Tool/Session 适配进入 `packages/core/src/instance.ts`。handler 内才解析 Location-scoped 服务，不在组装阶段解析。

现有接线位置：`server/routes.ts`、`server/process.ts`、`server/fetch.ts`、`core/session/model-request.ts`、`core/session/mcps.ts`。必要修改由 P0 验证定位，不能声称只改一个入口即可覆盖全部运行形态。

### 2.1 上游引入策略

优先验证官方 headless 包，固定版本与锁文件，不修改 npm 依赖代码。`createConnectorRuntime` 的标准 fetch 边界可作为私有适配入口。

当前已知限制：仅返回 fetch/close/auth 状态；自动启动 maintenance；不提供 SaaS grant 解析扩展，也不自带 dashboard 挂载。外围能完成身份门禁、私有 API 适配及 SaaS MCP 门面，不因此直接引入整仓 vendor。stateful Trigger防丢失还需要新增受管接收/journal扩展，现有receive不满足原子结果提交设计。

固定实施选择：P1/P2优先固定版本官方包；P0同时设计P3需要的最小受管Trigger扩展，优先上游提供扩展，不可用时选择版本化内部fork包，维护形态须用户确认后实施。每项补丁记录原因、上游版本、测试与同步成本，不修改npm安装产物。构建保留Apache-2.0 LICENSE/NOTICE，校验第三方资产与依赖许可证。

## 3. 总体调用链

```text
管理 API ─────── 服务访问凭证+会话归属校验 ─┐
原生工具 ───── 实际调用会话上下文 ────────────┤
SaaS MCP ───── 短期能力凭证+实际会话 ────────┤
code-mode ──── 同一工具执行链 ────────────────┤
                                             ▼
                 身份/初步授权 → 幂等登记 → 审批 → 实时授权/出站commitment → 执行/审计
                                             ▼
                 私有 Engine Adapter → open-connector → 第三方 API

OAuth/webhook 受限回调 → 验证/去重 → PG 持久状态 → 后续编排
```

内部 admin/token 与原始引擎响应均不能跨公开边界。调用 adapter 的服务接口分管理与执行；不向普通 handler/工具暴露任意 path 的通用 fetch，防止授权后任意访问全局管理接口。

## 4. 身份与信任边界（会话级）

### 4.1 主体 = 会话资源域

当前数据库没有用户/组织模型，**不引入 Identity Adapter**。本期可信主体是**会话资源域**：

- Connector 资源归属 `SessionResourceOwner.id` 解析出的资源主会话（内部子会话共享主会话资源域；显式 fork 独立）。
- 会话归属由服务端 `SessionTable` 权威校验，绝不信任请求体/headers 自报的 sessionID 或 owner。
- HTTP 管理面用现有 Basic auth 作为**服务访问凭证**，同时**必须显式指定且服务端校验目标 sessionID 属于该请求合法操作范围**；在无用户模型的当前部署形态下，服务访问凭证持有者对本实例内会话拥有管理权——这不是多用户安全边界，跨实例/跨部署的隔离由部署边界承担。文档不将其描述为"用户授权"。
- 未来引入用户模型后，本节替换为 Principal/Identity Adapter（用户级归属），会话资源域降级为用户之下的二级归属；表结构的 owner_type 已预留该演进。

### 4.2 管理与执行分权（会话域内）

- session manager（会话的管理面调用方）：创建/更新连接、管理会话内授权、删除；不能读取凭据明文。
- agent executor：以已校验的会话执行上下文（agent/messageID/callID）+ 显式选定连接执行，不能通过提示词自行授予连接或访问其他会话的连接。
- platform administrator：实例策略、共享 OAuth client、托管配置；与会话操作分离并额外审计。
- 会话 A 的任何调用方（管理面或 agent）都不得访问会话 B 的 connector 资源；跨资源域调用一律拒绝。

## 5. 数据模型与会话隔离

上游表保持在独立 `connector` schema。SaaS 域元数据按现有 `sql.ts` 与迁移机制管理。schema 隔离只是命名/运维边界，不是租户隔离。

### 5.1 计划表及关键约束（会话级）

> 会话级范围下，**owner 固定为会话资源域主会话 ID**（`SessionResourceOwner.id` 解析结果）。`owner_type/owner_id` 结构仍保留 user/project/organization 的演进口径，但本期只允许 `session` 一种取值，代码中拒绝其他值。

| 表 | 核心字段与用途 |
|---|---|
| `connector_resource` | SaaS resource ID、稳定 engine connection ID（唯一）、owner_type(本期固定'session')/owner_session_id（资源域主会话）、provider、display alias、状态、revision、created_by_session_id |
| `connector_grant` | resource ID、授权范围（本期为资源域内动作/trigger/proxy 子集、可选到期）、deny、revision、revoked_at；用于会话域内细化授权，不是跨会话共享授权 |
| `session_connector_binding` | 实际调用 session ID、resource ID、授权子集、绑定模式、revision；唯一 `(session_id, resource_id)`。主会话默认绑定自己的全部资源；子会话继承父绑定的子集；fork 默认无绑定 |
| `connector_operation` | 创建/OAuth/删除/轮换的持久状态机、幂等键、资源域 owner、失败原因、补偿进度 |
| `connector_execution` | execution ID、真实调用 session/actor/resource/action、policy revision、请求摘要、幂等键、状态、engine run ID、审计关联 |
| `connector_approval` | execution ID、approval generation、不可变操作摘要、Permission 关联、批准者、期限、状态；同 execution/generation 唯一 |
| `connector_engine_credential` | resource generation、purpose、完整策略 digest、schema 版本、token 密文/ID、generation、创建 lease、active/retiring 状态 |
| `connector_credential_usage` | credential ID、execution/subscription 引用、lease epoch、deadline，控制退休与清理竞争 |
| `connector_authority_epoch` / `connector_dispatch_commitment` | 会话资源域撤销屏障；每 execution/attempt 的最终出站授权记录 |
| `connector_remote_job` | owner session/resource generation、remote job ID、start execution、status/cancel action、provider 状态；不等同 execution 完成 |
| `connector_trigger_binding` | engine subscription ID、owner session/resource、目标 session、独立长期授权、状态 |
| `connector_trigger_schedule` | poll/listener 类型、checkpoint revision、next_run_at、wake_seq、lease epoch、错误与分页调度 |
| `connector_event_inbox` | 外部事件去重键、签名验证结果、subscription、最小必要 payload、接收时间 |
| `connector_event_outbox` | inbox ID、目标 session、投递幂等键、lease owner/epoch/expiry、attempt、next retry、状态 |
| `connector_file` | 文件 ID、owner session、resource/execution 关联、对象引用、内容类型、大小、到期时间 |

引擎扩展另在 connector schema 增加私有 `managed_trigger_receipt` journal，原子保存受管接收结果与引擎 checkpoint；不将它误认为 SaaS 同连接池表。

**生命周期跟着会话走**：

- 会话删除 = 删除该会话资源域的 connector 资源、凭据、绑定、订阅、执行审计（保留最小 tombstone）。删除顺序：标记 deleting → 禁新执行 → 撤销/回收内部凭证 → 取消订阅/远端 job（尽力）→ 删除引擎资源 → 删除 SaaS 行。与 `Session.remove` 的清理流程集成（在资源域 owner 的 teardown 中执行），子会话先释放、owner 最后清理，与 `SessionMcps.release` 的 owner-last 语义一致。
- 内部子会话（`parent_id` 且非 fork）**共享**主会话资源域的 connector 定义；执行时仍以**真实调用 session ID**做授权与审计，子会话可用范围 = 父绑定子集（动态重新计算，父撤销即子不可用）。
- 显式历史 fork（`fork_session_id`）建立**独立资源域，默认不继承**任何连接/凭据；如需继承，由 fork 创建方显式复制非秘密配置并重新完成 OAuth/凭据授权，绝不复制凭据密文。
- 会话删除时若仍有活跃执行/订阅，先中断并按补偿流程回收；不残留可被其他会话复用的孤儿连接。

owner/subject 显式区分会话资源域与实际调用会话。SaaS 内部关系使用 FK/唯一约束，跨引擎表关系使用稳定 ID 与 reconciliation，不只靠显示名关联。

内部 engine 连接名由系统生成，防止不同会话资源域的 `default`/同名连接冲突；SaaS alias 唯一范围为 owner（会话资源域）。重命名只改变 alias，不改变授权 ID。执行必须先将 alias 在已授权范围内解析为唯一 resource，歧义拒绝，不自动挑选全局默认连接。

### 5.2 可见性与有效权限（会话级）

可见连接 = **本会话资源域内**的连接（主会话自己的资源；子会话再受父绑定子集限制）。会话 A 看不到也调用不了会话 B 的任何连接——默认隔离，无跨会话共享通道。

每次执行选择一个稳定 resource ID，再计算：

`部署策略 ∩ 资源域 grant ∩ 实际调用会话 binding ∩ agent/tool 权限 ∩ 操作审批`

- 同一 resource 内，当前适用且未撤销/未过期的 grant allow 取并集，deny 取并集，有效 grant = allow 并集 − deny 并集；deny 优先。
- agent 执行必须有实际调用会话的 binding；子会话继承父绑定子集并与**当前**父有效绑定动态取交集，父撤销即子不可用。
- direct_user（管理面直接执行）同样需要部署策略与资源域 grant，不强制 session binding，但不能冒充 agent 审批路径。
- 空集合为拒绝，不使用上游空 allowlist 表达拒绝。不同连接动作集合不合并：A 只读、B 可写，不产生 A 可写的交叉组合。no_auth 操作使用显式服务级授权资源。
- proxy/trigger 使用独立授权规则，action 授权不自动授予 proxy/trigger。

详细合并算法与状态机见 [调用协议](design/connector-invocation-protocol.md)§2/§3（其中 user/organization/project 分支本期不启用）。

list/search/guide 逐资源筛选和脱敏；没有执行权限的 action 不进入该会话可调用列表。

### 5.3 撤销、继承和生命周期（会话级）

- grant/binding 更新在 PG 事务内递增 revision 并更新会话资源域授权屏障；每次受控出站 commitment 检查当前授权。撤销提交之后不能创建依赖已撤销权限的新 commitment，但已 commitment 请求可能发送/完成；进程缓存不是安全依据。会话资源域的授权行全在本 PG，撤销即刻生效于新 commitment，**不存在外部 membership 传播延迟问题**（该问题留给未来用户级模型）。
- 子会话共享沙箱不等于共享权限。子会话以**真实调用 session ID**授权，只继承父绑定子集；动态有效权限不得超过当前父授权。撤销父授权同时影响继承授权。
- 使用 `SessionResourceOwner` 的共享 MCP 定义不能据此将父身份当作实际调用身份；需要专门的调用上下文适配与测试（见调用协议§1）。
- **会话删除即清理其 connector 资源域**：连接、凭据、绑定、订阅、执行审计随会话删除而回收（保留最小 tombstone）；内部子会话删除只释放自身执行/引用，不动共享资源，owner 会话最后清理——与 `Session.remove` 既有清理顺序集成。
- fork 默认不继承凭据；确需继承走显式复制配置 + 重新授权，绝不复制秘密。
- 资源先标记 deleting 并禁止新执行，撤销 grant、清理订阅/内部 token，再删除引擎资源；保留最小审计 tombstone。
- 已发出的第三方写请求不能保证撤回，撤销只阻止后续执行/重试，结果标明可能已发生的副作用。

## 6. 创建、OAuth 与凭据安全

### 6.1 可恢复的跨引擎编排

SaaS 与引擎不同连接池，不假设跨调用原子事务。

创建流程：校验目标会话存在与操作合法性（会话资源域 owner = 目标主会话）→ PG 写 pending operation 与资源占位 → 用系统生成的唯一内部名创建引擎连接 → 记录稳定 ID → 激活 resource/grant/binding → operation 完成。

重复请求使用 owner+operation 幂等键；各阶段崩溃由 reconciliation 续作或补偿。资源未 active 前不可执行。孤儿引擎连接不得被默认可见或可用，由定期任务回收并审计。

### 6.2 OAuth

授权意图在 SaaS operation 中绑定 owner 会话资源域、发起会话、resource 和允许 redirect；再发起上游 OAuth。回调只开放明确路径/方法，不开放整个前缀管理面。

验证 state 的随机性、期限、一次性消费、intent 关联、provider、固定回调域名与完成跳转白名单；OAuth code/token 不写入 SSE/日志。任意 pod 必须能够从 PG 恢复 intent 与 state；跨 pod续流需 e2e 证明，不预设已成立。

上游 state 关联/一次性消费的实际行为在 P0 验证；若无法安全关联 SaaS intent，必须先补适配点再开放 OAuth。自有 client 配置按平台/会话资源域管理权限划分，provider 要求的 scope 与 grant 不是同一概念。

### 6.3 密钥与刷新

- connector 启用时加密 key 必须存在；缺少 key 拒启，不接受上游 plaintext fallback。
- 多 pod 使用同一受管 key，管理/执行密钥来自 secret manager 或受限部署 Secret，不放客户端配置。
- 轮换先验证引擎支持的 re-encryption 流程，采用停写/维护窗口或版本化方案；备份恢复必须同时恢复兼容 key。headless 无轮换 API时不声称可在线完成。
- OAuth refresh 以连接级 PG 租约/CAS 编排，检查引擎现有并发策略。防止双 pod旋转 refresh token 后覆盖；无法外围控制则列必要扩展点。
- 输入、输出、provider 错误、headers、runs、SSE、PG审计按敏感字段规则脱敏；日志只记录摘要与稳定关联 ID。凭据提交接口不回显秘密。

## 7. 能力凭证与引擎授权

### 7.1 两种凭证不得混淆

**SaaS 短期能力凭证**：用于 SaaS MCP/受限执行入口，由 SaaS 签发并验证。包含 issuer/audience/subject、实际 session ID、binding/auth revision、expiry、jti；建议 TTL 15 分钟（这是新增设计，不是上游已有功能）。签名 key 与引擎加密 key 分离，校验允许算法、时钟偏差、key rotation。

凭证仅定位受限会话主体；每次请求仍从PG计算实时grant，不能将签名有效等同当前授权有效。已知绑定/主体失效时拒绝旧版本；对已受理调用还需逐attempt出站检查，撤销保证以commitment边界为准。刷新只能由受信会话服务重新签发，不能用旧token自我续期。

敏感MCP执行还必须携带工具叶子签发的短期调用proof，绑定真实actor/session/agent/message/call、execution、resource generation、action、inputDigest、approval generation及policy fingerprint。会话capability不能单独执行Action；proof在服务端校验并CAS领取execution，重复proof只读取相同execution状态/结果。发现工具不要求执行proof。详见调用协议§4。

**内部引擎凭证**：上游 admin token 和按单连接/策略配置的存储 runtime token。后者没有原生 TTL，只作为第二层防护，不暴露给用户、模型或沙箱。内部 token 的加密引用与当前策略版本由服务端管理，过期业务权限由 SaaS gate保证，后台吊销只负责清理。

上游 JWT 仅做 boolean 认证，不能用于替代 SaaS grant。禁用对外的静态全权限 runtime token 旁路；admin 凭证只在私有类型化管理操作里使用。

### 7.2 调用级 scope

一次 Action 调用的内部 token限定稳定 engine connection ID与该连接的有效 action策略；空权限直接拒绝，绝不签发空 allowlist token。proxy/trigger 有独立权限，不从 action 自动推导。

内部token按resource generation+purpose+完整规范化policy digest+policy schema版本复用，不以整数revision作为唯一缓存键。私有credential记录保存加密secret并实现creating/active/retiring/revoked；通过使用引用/lease控制清理，孤儿token先吊销再重建。长期订阅用途独立，不被Action缓存回收。详见引擎适配规格§2。

批量发现由SaaS MCP/native门面组合逐连接授权结果，不合并不同连接权限后直接调用上游MCP。

## 8. Agent 双通道与 code-mode

提供 `list_apps`、`list_connections`、`search_actions`、`get_action_guide`、`execute_action` 的 SaaS 契约；其中 connection 使用 SaaS stable ID/授权范围内 alias。契约可参考上游，但权限语义以本文为准。

### 8.1 MCP

公开的是 **SaaS MCP facade**，不是上游 `/mcp`。tools/list、tools/call 都进入统一 gate；工具调用逐项解析，不接受 JSON-RPC 任意转发。支持的协议版本、batch、通知、取消、body限额和transport状态须在 P0验证并明确；调用上下文不存进程内 session affinity。

Session MCP remote连接使用 `oauth:false`，不需要 local stdio 的 supergateway。普通 MCP 接入配置保持兼容；平台 connector 以受管定义保存 URL、模式和非敏感 auth reference，不能把临时 Bearer header写进 `session_mcps.config`。

需要扩展受管MCP的连接/请求层：以真实调用session注入短期凭证，敏感调用再附签名proof；临近到期刷新，授权版本改变后重签。不能将普通 `_meta.ai.opencode/sessionID`当可信授权。父子会话即使共享发现缓存，也不得共享错误主体。普通MCP API返回值不泄露auth reference背后的秘密。

受管connector工具使用专用Tool叶子：先幂等登记，再完成单一复合Permission/动作审批，再签proof走transport。普通MCP保留原有McpTool权限路径；不在registry新增授权callback。facade验证proof/PG审批并重新授权，不再重复发同一审批。首次协议只开放五个工具及认证发现，执行通知/未经逐项证明的batch拒绝；外部用户执行采用direct_user API。

这是新增适配能力，不是现有 Session MCP开箱支持；不能安全注入上下文前，MCP模式不开放，native仍按计划保留。

### 8.2 原生工具

以完整Tool.Info对象注册connector工具；Tool叶子捕获Permission.Service，使用Tool.Context的sessionID/agent/messageID/callID构造canonical source与可信InvocationContext。sessionID单独不等于完整执行权限。native在进程内复用同一execution/approval流程，不需网络proof。LLM只获得显式绑定连接描述和动作，不获得管理面。

上层配置确定模式；both时采用不冲突的 namespace并说明用途，避免重复工具描述导致误选。原生/MCP之间相同调用使用同一审计与幂等语义，不能一个有审批另一个无审批。

### 8.3 code-mode

默认开启的 code-mode只作为工具调用入口，不获得引擎 token。code-mode通过 SaaS已有工具调度执行connector调用，每个批量调用独立授权并可关联同一父 execution。不得从 runner直连引擎管理端；验证 sandbox/server网络模式下语义一致。

## 9. HTTP 入口与鉴权分类

建议公开路径如下，属于新SaaS契约，不表示上游现成提供：

| 路径类别 | 示例 | 鉴权/授权 |
|---|---|---|
| 管理/审计 | `/api/connector/connections`、grants、session bindings、runs | 服务访问凭证 + 显式目标 sessionID 校验（会话资源域归属）；runs/订阅按资源域过滤 |
| 显式执行 | `/api/connector/actions/:actionID/execute` | direct_user（管理面）或 agent：后者需可信 InvocationContext/调用 proof + 实际会话 binding |
| MCP | `/api/connector/mcp` | SaaS 能力凭证；敏感 tools/call 另需 proof/PG 审批；逐调用实时 grant |
| OAuth完成 | `/connector/oauth/callback` | 仅固定方法，state+SaaS intent验证 |
| webhook | `/connector/webhook/:bindingID` | provider签名/nonce/时间/replay校验，订阅映射，不接受回调自报sessionID |
| 文件下载 | `/connector/files/:fileID` | 资源域授权或短期受限download capability |
| 平台配置 | 实例策略、OAuth client、托管配置 | 平台管理员专用，与会话操作分离 |

管理API进入 protocol/server正常路由。特殊入口在统一router中显式注册；调整既有 `process.dispatch` 和 route authorization时只按精确路径/方法委派专用认证，不能匿名放行整个 `/connector/*`。Bearer请求不再先被Basic错误拦截。

process与ServerFetch复用相同分类函数/路由适配，保留readiness、CORS、trace、metrics、限流、关闭drain。body/backpressure/abort/multi-cookie/大文件/错误映射经PoC后确定web Response适配细节；不预先否决Effect路由。

上游fetch仅内部使用。SaaS响应不转发上游admin cookie/内部headers；未知path和不允许方法返回拒绝。callback请求使用服务端固定origin，不信任可伪造的Host/Forwarded来生成敏感URL。

## 10. Action、proxy、文件与外部副作用

统一执行顺序：验证主体/解析stable resource及初步grant → 幂等登记不可变execution → pending approval或自动授权 → approved → 重新授权/领取执行 → 逐attempt dispatch commitment → 脱敏结果/审计。

状态机、参数摘要、审批代际、双提交与重启恢复见调用协议§3；审批前先登记幂等key，等待期间不持有PG事务。approval必须绑定resource generation/action/inputDigest，已批准参数不可编辑。

出站复用上游providerHttpDispatch：beforeAttempt排队/初审，onDispatch短事务重新校验epoch/实时授权并写commitment，撤销修改相同授权屏障；每次HTTP retry/redirect分别检查。非HTTP/绕过hook的transport建立覆盖矩阵，未覆盖敏感写默认不启用，不能声称一律支持即时撤销。

- 默认不自动重试非幂等写操作；仅明确支持的操作按provider规则传幂等键。网络超时后的未知结果标记 ambiguous，先对账再重试，不能承诺第三方exactly-once。
- 客户端重复提交按 `(主体/会话, resource, action, 幂等键)` 检查请求摘要，异内容同键拒绝；引擎幂等记录的scope也需验证，避免跨资源域命中。
- 无可靠读写分类的action默认按敏感/有副作用操作执行审批策略；批量调用不能绕审批。
- proxy单独显式授权，并约束service、method、host、path、重定向及body，保留SSRF/metadata防护；不因同provider某action获准就允许任意proxy。
- 配置并发、每主体/连接/provider配额、响应大小、deadline与取消；取消不能撤销已发生的外部写。
- 文件先创建SaaS owner关联再上传；对象存储只保存文件内容，PG保存权限与生命周期。下载capability限定file、有效期、用途，不提供bucket凭据。
- 引擎可能生成transit URL，必须核验其读写权限与可外部取回机制。对agent输出重写为SaaS受限URL；provider取回用可过期URL。不能未经验证原样暴露引擎 `/api/files/*`。

### 10.1 异步Action

P2只支持显式start/status/cancel，不自动长轮询。每次Action均重新授权，remote job关联稳定owner/resource并保存start execution；只有provider提供明确schema映射时登记job ID。execution.succeeded表示该次调用成功，remoteJobStatus单独返回，不等于业务完成。会话停止不自动cancel远端job，后续status/cancel不能借创建记录绕过当前权限。详见调用协议§5。

## 11. Triggers与持久投递

不把 `triggerMaintenance`当作会话事件调度器。上游maintenance负责订阅策略维护/清理，已有claim/save/release租约；先验证PG存储实现与续约，再决定是否需补强，不默认新增全局leader。

### 11.1 订阅授权

订阅使用独立长期授权资源与专用内部token，不依附短期MCP token。SaaS绑定订阅、owner会话资源域、resource和目标session（本期owner=会话资源域主会话）；创建/取消走operation状态机，会话删除/权限撤销时停止新事件并异步清理provider资源。

维护线程每pod自动启动的行为只有在现有租约和存储验证通过后才接受。若无法满足并发与停机要求，补充生命周期控制点后再启用Triggers，不在外围假装已经控制线程。

### 11.2 投递流程

`provider callback → bounded raw receipt → 受管校验/归一化 → 引擎事务原子提交checkpoint+result journal → ACK → SaaS事务导入inbox/outbox → 会话幂等接受 → 确认投递`

stateful receive的saveCheckpoint/saveSubscription全部使用working state，结果与引擎checkpoint在同事务提交，不能提前推进checkpoint。受管receive不执行外部写；长读取返回wake转listener。现有receive需要最小扩展，无扩展不能开放该provider安全投递。原始receipt保存并不等于已经解决防丢失，固定选择journal方案，不用两池伪事务。

event映射业务inbox；wake映射scheduler；ignored只审计；respond保留provider challenge/status/body/允许headers。成功ACK必须在结果durable之后，签名未知的quarantine数据不能投递。导入用engine journal ID+event序号唯一去重，先SaaS事务入库再确认journal；确认丢失可安全重复导入。

outbox用逻辑租约/fencing，目标Session接受在同PG事务写唯一delivery去重记录与输入队列，运行中排队而非另启turn。原Session链不支持时先扩展，再启用。至少一次+消费幂等，不声称第三方副作用exactly-once；完整故障注入和provider响应矩阵见Trigger协议。

### 11.3 Poll与Listener

SaaS scheduler持久化type、interval、next_run_at、checkpoint/revision、wake_seq与lease epoch；SKIP LOCKED短事务领取，事务外read，事务内检查epoch并原子写events/outbox与新checkpoint。失败不能只推进游标。

poll逐event dedupeKey去重；listener按page键记录outputs。hasMore受分页/时间/配额限制；空页按协议更新checkpoint；transient退避，permanent/auth暂停；执行中到达的wake通过seq保留，不被本轮完成吞掉。引擎maintenance不负责这些调度。

webhook/poll/listener各需独立provider验收；未通过provider以不可用状态呈现，不把“全量目标”当成已交付事实。

## 12. Marketplace、控制台与供应商依赖

不挂上游dashboard。平台UI通过SaaS安全API展示catalog、连接、授权、runs、订阅与provider可用状态。具体页面落入现有SaaS前端应用，P4前验证入口归属，不预设 `packages/web`就是会话控制台。

上游实例级Marketplace/provider偏好由平台策略管理；用户/项目偏好在SaaS域保存，不能把全局配置当作个人设置透传。对外可参考的上游路径是 `/api/marketplace`、`/api/provider-preferences`，但它们不直接公开。

OOMOL托管能力默认禁用，启用前确认数据出境/共享、费用、服务协议、client配置及出站目标；验证禁用时不会执行托管调用。自有OAuth/provider执行与托管能力可用性分别呈现，不能将缺配置误报为已接入。

## 13. PG迁移、部署与无状态运行

### 13.1 迁移

部署Migration Job按顺序创建受控 `connector` schema → 运行上游PG迁移 → 运行SaaS元数据迁移 → 校验版本 → 应用滚动启动。上游迁移已有advisory lock；运行时仅assert缺迁移并拒绝ready，**不自动重放**。

迁移角色拥有DDL；运行角色仅必要DML，禁止非受信用户修改search_path涉及schema。版本固定，两套迁移分别记录。N/N-1滚动窗口采用expand/contract，不在同一上线删除旧列；回滚前判断数据兼容，不可回滚时恢复备份或前向修复。

### 13.2 运行

- 每pod一个runtime；用Effect scoped acquire/release封装Promise生命周期。启用时提前加载，未就绪返回受控503；关机停止接入、处理取消/drain，再close。
- 引擎单例测试使用隔离进程；生产只支持项目要求的Node/Bun+PG形态，不将其直接带入workerd。
- PG、grant/lease状态、共享对象是权威数据；本地catalog/cache/tmp不是资源所有权依据。pod丢失后能够从PG重建。
- 独立连接池按 `pod数量 × (SaaS池max + connector池max + worker预算)`限制总量；新增池不意味着互不竞争。
- 容器连接宿主PG使用现有Docker网络配置，不使用容器内 `127.0.0.1`当宿主；宿主测试数据库仍为 `opencode-v2-up`。
- 生产多pod文件使用S3兼容共享对象存储。清理采用可幂等策略并验证并发删除/下载竞争；节点临时盘只用于上传staging并设置容量限制。
- 不改变SaaS经OpenSandbox控制面通信的约定。本能力不要求新增沙箱daemon、端口或镜像内容；code-mode与网络模式仍需集成验证。

### 13.3 配置（计划新增）

统一使用 `OPENCODE_CONNECTOR_` 前缀：

| 后缀 | 说明 |
|---|---|
| `ENABLED` | 总开关，默认false |
| `PUBLIC_ORIGIN` | 固定外部origin/允许callback路径的基址 |
| `PG_URL` / `POOL_MAX` | 受控schema连接及预算，不回显URL秘密 |
| `ENCRYPTION_KEY_REF` | 加密key引用，启用时必配 |
| `CAPABILITY_SIGNING_KEY_REF` / `CAPABILITY_TTL` | SaaS能力签名key引用/建议15m |
| `INTERNAL_ADMIN_TOKEN_REF` | 私有引擎管理密钥引用 |
| `TRANSIT_STORE_REF` | 共享对象存储配置引用，不将access key放公开JSON |
| `MANAGED_PROVIDER_ENABLED` | OOMOL托管能力开关，默认false |

会话级范围不需要 Identity Adapter 配置；会话归属由服务端 SessionTable 校验。未来用户级模型再补 Principal 配置，不临时用环境里的某个 user ID 充当身份。

## 14. 测试与验收

单测覆盖身份验证、权限交集/deny、空集合、每连接scope、alias解析、继承、revision撤销、operation状态机、输出脱敏与凭证不落公开配置。契约测试遵循schema规范，验证optional/稳定ID/敏感字段排除。

服务API测试同时覆盖ServerFetch和Node process；PG语义采用独立PG测试。Docker中运行服务，以API驱动e2e，测试期间订阅 `GET /api/session/:sessionID/event` SSE实时输出思考/工具/问答/文本/状态，自动回答提问，按规范校验结果、过程及PG记录。

| 测试组 | 必测结果 |
|---|---|
| 会话隔离/越权 | 会话A不能读/改/执行会话B的连接、订阅、runs、文件；伪造sessionID拒绝；fork默认无凭据；子会话只能用父绑定子集，父撤销即子失效；服务访问凭证不等于可跳过会话归属校验 |
| 授权 | 无连接/空动作拒绝；稳定ID正确；A只读+B可写不能变成A可写；no_auth/proxy独立策略 |
| 生命周期 | OAuth state一次性/归属/跨pod、连接失败补偿、alias重命名、**会话删除回收整个资源域（含凭据/订阅/执行审计）**、fork不复制秘密、refresh并发、密钥轮换 |
| 双入口 | disabled/mcp/native/both；上层模式与实际工具集一致；同一执行权限/审批/SSE审计 |
| 凭证 | TTL/错误audience/签名/revision拒绝；跨pod撤销；长会话刷新；PG MCP配置与API/SSE不含Bearer秘密 |
| 调用/审批proof | 会话token单独执行拒绝；伪造agent/子会话、参数/文件版本篡改、proof重放；审批前双提交只有一份交互，MCP/native不重复审批 |
| grant/内部token | 同层allow并集/deny优先、退组、相同revision不同策略不串token；双pod创建/秘密落库失败补偿；长期订阅与Action清理隔离 |
| 父子会话 | 同沙箱不同实际授权、显式继承子集、父撤销后子调用拒绝 |
| code-mode | 默认确实启用，批量工具经过gate；两种网络模式不泄露内部引擎凭证 |
| HTTP | Basic/Bearer/callback矩阵、未知路径拒绝、body限额、abort/backpressure、多cookie、文件下载权限 |
| 迁移/恢复 | 空库/缺迁移拒启、并发migration、N/N-1滚动、pod重启恢复、对象文件跨pod取回 |
| 副作用/Triggers | 双pod并发幂等、超时ambiguous、重复webhook、租约过期/fencing、投递前后崩溃、死信重放重新授权 |
| Trigger归一化/调度 | checkpoint+journal共同提交前后崩溃、导入确认丢失；event/wake/ignored/respond及challenge；poll/listener分页/空页/wake竞争 |
| 撤销/异步job | 第一跳后撤销阻止新commitment，已commitment边界明确（会话域授权行全在本PG）；start/status/cancel与remote状态区分 |
| 平台安全 | 管理原始路由不可访问，runs/订阅按owner过滤，无全局admin cookie泄露，托管关闭无对应执行出站 |

测试发现问题先固化可复现用例，讨论处理；修复后重跑受影响矩阵。测试只对确有运行证据的结果下结论，不将“设计需要”写成“已经通过”。

## 15. 实施顺序与门禁

| 阶段 | 交付 | 前置/验收门禁 |
|---|---|---|
| P0 对接与PoC | 会话归属校验、包/资产、双HTTP入口、proof/持久审批、dispatch覆盖、受管Trigger扩展、PG初始化 | 会话资源域边界确定；证明协议与原子journal最小PoC；必要fork维护形态先确认 |
| P1 安全管理闭环 | 引擎嵌入、加密、resource/grant/binding（会话域）、API Key/OAuth、会话删除回收、受限管理API | 会话隔离当期通过；会话删除不残留可执行孤儿连接；无公开上游管理路由 |
| P2 Agent执行 | 幂等/持久审批、native/SaaS MCP、调用proof、私有凭证/dispatch、code-mode、显式asyncAction | 空scope/交叉权限/子会话、单一审批、proof重放、逐attempt撤销、长会话全部通过 |
| P3 完整运行能力 | proxy、文件、长期订阅、原子journal、poll/listener scheduler、inbox/outbox | 原子checkpoint/result与Session接受；租约/fencing/签名/响应协议及故障注入通过 |
| P4 控制台/市场 | 安全API驱动UI、个人/团队偏好、可选托管配置 | 不泄露实例管理能力；清楚区分已配置/可执行/托管服务依赖 |

每阶段默认关闭新增入口，通过门禁才灰度启用。P0/P1会话归属校验与会话间隔离不是后续优化项，不能延后。

## 16. 待确认与事实依据

### 16.1 尚未解决的对接/技术门禁

1. 会话级范围不依赖外部身份发行方；会话归属由服务端 SessionTable 校验。未来用户级模型需要 Principal/成员查询接口与ID命名空间，届时替换§4，不在本期引入。
2. 官方headless包资产/版本可用性，OAuth intent关联、跨pod refresh与文件URL权限，需要PoC；不预先承诺npm形式足够或必须fork。
3. 受管MCP需要实施调用协议的完整InvocationContext/proof与既有Permission持久恢复适配；Session需要原子接受/去重边界。接口位置需PoC，协议本身已固定，不能回退为只传sessionID。
4. 上游Trigger受管journal、working state、provider签名/响应协议与maintenance租约需要最小扩展和验证；生产投递不允许提前checkpoint再写SaaS inbox。poll/listener scheduler按配套协议实施。
5. 控制台页面实际宿主与是否启用OOMOL托管需要部署确认；组织/项目级归属与授权规则随未来用户级模型一并设计，不在本期范围。多grant合并规则已固定（见调用协议§2，本期只启用session分支）。

这些待确认项不得以宽松回退方式绕过；本修订版是后续实施的设计约束，不是运行兼容性证明。

### 16.2 已由源码确认的关键事实

上游路径相对 `~/code/open-connector`：

- `src/server/connector-runtime.ts:67-110,118-128,230-231,240-246`：headless入参、fetch/close边界、单例、自动维护线程、mount path剥离。
- `src/core/action-policy.ts:38-44,123-125,226-245`：token集合模型、空allowlist不限制、稳定connection ID。
- `src/server/storage/runtime-token-service.ts:6-17,60-83,99-117`：存储token没有TTL。
- `src/server/api/runtime-jwt.ts:7,44-47` 与 `src/server/api/auth.ts:291-301`：JWT认证boolean，不自动生成RuntimeGrant。
- `src/server/storage/postgres/runtime-store.ts:105-124` 与 `postgres/migrations.ts:16-82,85-103`：启动检查与独立迁移；迁移已有PG锁。
- `src/triggers/maintenance.ts:112-143`、`subscriptions.ts:38-51`、`store.ts:5,26-28`：维护/清理、已有租约、订阅绑定token ID。
- `src/triggers/subscriptions.ts:127-141,241-260` 与 `common/integration.ts:55-76`：现有即时state写及receive结果类型，需要journal原子扩展。
- `src/triggers/trigger-runner.ts:110-117`、`common/poll.ts:9-19`、`common/integration.ts:20-29`：poll/listener读接口与checkpoint/page契约。
- `src/core/provider-http-dispatch.ts:21-30,38-63`：已有per-attempt admission与onDispatch扩展；不等于所有transport已经覆盖。
- `src/core/types.ts:256-265`：asyncLifecycle start/status/cancel契约。
- `src/server/connect-app.ts:59-72,99-109,141-149`：托管SaaS服务构建及注入；不能忽略供应商边界。
- `src/server/connect-server.ts:214-220,296-309`：全局marketplace/provider偏好/管理接口。

SaaS路径相对当前仓库：

- `packages/server/src/auth.ts:15-33`：固定Basic用户名/共享password。
- `packages/server/src/process.ts:73-79,190-205`：全局中间件与Basic门禁；`fetch.ts:41-53`：独立web-handler入口。
- `packages/schema/src/session-mcp.ts:21-29`：remote配置必需 `oauth:false`。
- `packages/core/src/session/mcps.ts:275-277,414-441`：remote直接连接、配置持久化与资源owner归一化。
- `packages/core/src/tool.ts`：Tool overlay；server/core/schema包AGENTS约定：契约、运行服务、Location graph与host wiring的职责划分。
- `packages/core/src/tool/mcp.ts:42-53`、`mcp/client.ts:272-281`：叶子Permission及当前只发送session metadata，尚不具备本文调用proof。

## 17. 初版审核闭环

| 审核项 | 本次修订 |
|---|---|
| P0-1 身份缺失 | §4 收敛为会话级：可信主体=会话资源域+服务访问凭证与会话归属校验；用户级Principal留待未来模型 |
| P0-2 ID/空集合 | §5稳定ID与逐连接授权，空scope拒绝 |
| P0-3 TTL/JWT | §7新增SaaS能力层，与上游无TTL/boolean认证区分 |
| P0-4 管理透传 | §1/§9取消原样挂载，SaaS显式管理API |
| P1-5 权限放大 | §5 owner/grant/binding拆分与权限交集 |
| P1-6 HTTP双入口 | §9共享路由分类，process与ServerFetch共同验证 |
| P1-7 PG迁移 | §13独立Job、运行仅assert、连接预算与容器地址 |
| P1-8 runtime控制点 | §2/§11已知限制与必要扩展门禁 |
| P1-9 Triggers语义 | §11长期授权+持久投递，不把maintenance当dispatcher |
| P1-10 MCP生命周期 | §8受管auth reference/真实调用session/刷新，不持久化Bearer |
| P2完整性 | §2包边界、§6密钥、§10副作用/文件、§12供应商、§13运行、§14验收矩阵 |

“闭环”表示每项已写入修订设计或明确实施门禁，不表示功能已实现或审核已通过。

## 18. 修订版复审主要缺口闭环

| 缺口 | 本次明确决策 | 验收规格 |
|---|---|---|
| MCP缺完整可信context | canonical Tool InvocationContext+单一复合审批+签名call proof；capability不能单独执行 | 调用协议§1/§3/§4 |
| checkpoint/result丢失窗口 | working state+引擎PG原子journal，SaaS幂等导入；必要最小扩展 | Trigger协议§1-4 |
| poll/listener遗漏 | 独立scheduler，events与cursor同事务，wake_seq/fencing/分页预算 | Trigger协议§5 |
| 撤销承诺过强 | per-attempt onDispatch事务commitment；已commitment不可保证撤回；会话域授权行全在本PG，撤销即刻作用于新commitment | 引擎适配§3 |
| 内部token缺记录/回收 | 策略digest私有凭证槽+使用引用/创建补偿，长期订阅单独purpose | 引擎适配§2 |
| grant/审批不确定 | 同层allow并集/deny优先；先幂等登记后审批；请求快照不可变 | 调用协议§2/§3 |
| 异步Action不明确 | 显式start/status/cancel、remote job关联；call成功与job完成分离 | 调用协议§5 |

以上修复的是方案缺口，不代表相应扩展已经实现。身份来源、上游维护形态与PoC仍是实施前置条件。
