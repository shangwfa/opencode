# Connector Gateway 方案审核

> 日期：2026-10-10；对象：`docs/connector-gateway-design.md`。
> 结论：**不通过，需修订后再进入实现**。嵌入方向可保留，但当前方案不具备安全的多租户闭环。
> 本次为源码静态审核，未启动服务、未执行功能测试、未修改业务代码。原方案保留，以下纠正其事实与设计。
> 上游路径均相对 `/Users/ruomu/code/open-connector`；SaaS 路径均相对当前仓库。

## 一、阻断性问题（P0）

### 1. Basic auth 不提供用户身份，多租户授权没有前提

- 原方案 §5.4 声称“复用 Basic auth，请求上下文取用户身份”。
- 实际：`packages/server/src/auth.ts:15-33` 只有固定用户名 `opencode` 和共享密码校验；`packages/server/src/process.ts:190` 也使用固定用户名。
- 影响：不能仅凭该鉴权判断 user、organization、project 归属。租户 ID 若由客户端任意传入，将形成越权入口。
- 修订：明确可信 Principal 的来源（宿主平台身份服务，或受信网关验证后的身份）。Principal 必须携带可验证主体，成员关系由服务端查询。Basic auth 只能是服务访问凭证，不能充当用户身份。
- 门禁：未配置可信身份时拒绝多租户管理请求，不默认赋予全局管理员权限。

### 2. 白名单粒度与空集合语义均写错

- 原方案 §5.3 用 `connection_name` 计算 `allowedConnections`。
- 实际：`src/core/action-policy.ts:226-245` 按稳定 **connection ID** 校验；`src/core/action-policy.test.ts:335-349` 明确测试 stable IDs。Action/MCP 调用也以 ID 进行授权。
- 更严重：`action-policy.ts:227-228` 中 `allowedConnections=[]` 表示不限制；`evaluate():123-125` 中空 action allowlist 同样不限制。现有测试 `action-policy.test.ts:315-331` 明确确认此语义。
- 影响：无可见连接的会话若签发空白名单 token，会获得跨租户连接访问能力；空 action 集也不是拒绝所有动作。
- 修订：binding 保存稳定 connection ID，名称只作租户内显示别名。SaaS 授权入口必须明确区分“全部允许”和“一个也不允许”，空授权集直接拒绝；禁止将其转换为上游的空白名单。无认证 action 的放行单独建策略。

### 3. token TTL 与 JWT scope 并不存在于现有实现

- 原方案 §5.4 假定控制台签发 token 支持 15 分钟 TTL，并可直接升级为 scoped JWT。
- 实际：`src/server/storage/runtime-token-service.ts:6-17,60-83,99-117` 无到期字段、无到期校验。其 API 是 create/revoke/update，而非短期凭证。
- `src/server/api/runtime-jwt.ts:7,44-47` 只返回 boolean，验证签名、issuer、audience 和 exp。
- `src/server/api/auth.ts:291-301` 只有存储 token 分支写入 RuntimeGrant；JWT 成功不生成连接/action grant。
- 影响：存储 token 泄露后不会自动过期；JWT claims 即使写了 scope，也不会按方案自动执行。
- 修订：SaaS 自己实现带 session、subject、audience、expiry、授权版本的能力凭证验证与 scope 解析；或者维护受管存储 token，加独立到期与吊销门禁。任一方案都需要额外适配，不能声称上游开箱支持。禁止把“JWT 验证成功”当作执行授权成功。

### 4. 原样挂管理面会绕过租户边界

- 原方案 §5.1、§5.7 整体转发 `/connector/*` 并原样暴露管理 API/dashboard。
- 实际：`src/server/connect-server.ts:234-249,296-309` 存在全局订阅、连接、runs、token、策略等接口；`src/server/api/auth.ts:276-288` 使用实例级 admin token，而非 SaaS 租户授权。
- 如果直接提供 admin 凭证则具有实例级权限；不配置 admin token 时，部分管理路径可能放行或部分连接路径返回 403（`auth.ts:68-79,182-193`），都不是租户管理语义。
- 修订：上游 admin 面只供服务内部调用，不对租户透传、不向浏览器发 admin token/cookie。对外新增 SaaS 管理 API，逐项校验 Principal、角色、资源所有权并筛选返回值。OAuth/webhook/文件下载分别列明可公开路径、验证机制和限额。

## 二、重要设计问题（P1）

### 5. binding 不足以描述授权，简单并集存在权限放大

- 一个 token 的 action 集和 connection 集是独立集合，不是“连接 → 动作权限”的映射（`src/core/action-policy.ts:38-44`）。
- 若 A 连接只允许读、B 连接允许写，合并两集合会让 A 也获得写权限。单个 `granted_scopes` 的描述不足以避免此交叉组合。
- 修订：先建立 `owner` 与 `grant` 两个概念，区分 user/session/project/organization，不能将项目与组织直接视为同一种资源；授权主体和资源 ID 必须服务端验证。
- 最终有效权限为：部署策略 ∩ 资源 grant ∩ 会话选择/授权 ∩ agent 权限；deny 优先。按本次选择的连接计算 action scope，批量发现结果逐连接过滤。
- 补齐唯一约束、关联/生命周期约束、授权版本、重命名、删除、回收、撤销语义。创建 connection 与 binding 跨连接池不是天然原子操作，必须有可重试事务编排或补偿清理。
- 不建议未经用户明确选择就把用户/组织所有连接自动授予会话。

### 6. HTTP 挂载过早否决 Effect 路由，且忽略双重鉴权

- `packages/server/src/process.ts:73-79,190-205` 有全局 Basic 鉴权、状态控制与中间件。Bearer MCP 请求和匿名 OAuth 回调在这里会被拦截。
- 绕过它又可能丢失 CORS、metrics、trace、停机控制等行为。只改 Node listener 还无法覆盖 `packages/server/src/fetch.ts:41-53` 的 API 测试入口。
- 修订：管理接口进入 protocol/server 正常路由；MCP/回调使用显式路由或统一 HTTP 适配入口，各自规定鉴权。统一覆盖 process 与 ServerFetch。
- Effect 已提供 web handler 转换（`fetch.ts:48-53`），不足以支持“流式转发必然易损”的结论。先验证 body/backpressure/abort/headers/多 Set-Cookie/大文件/错误映射，再决定桥接点。
- 原生工具内部 fetch 不能绕过同一授权服务。

### 7. PG 启动不会自动迁移

- 原方案 §5.2 将 `assertPostgresSchemaReady` 描述为自动校验/重放。
- 实际：`src/server/storage/postgres/runtime-store.ts:105-124` 启动仅 assert；`postgres/migrations.ts:85-103` 缺迁移即报错，要求先执行 runtime:migrate。
- 真正执行迁移的是 `postgres/migrations.ts:16-82`，已包含 advisory lock；独立入口见 `node-runtime-database.ts:60-73`。
- 修订：部署 migration Job 先创建 schema、配置权限并执行迁移，再启动应用。运行期角色只需必要 DML 权限。明确滚动升级的 N/N-1 兼容、备份恢复和不可回滚迁移处理。
- search_path 是命名隔离，不是租户隔离；独立连接池也不消除连接预算竞争。应控制 pods × 每池 max 的总量。
- Docker 内 PG 地址不能直接沿用宿主 `127.0.0.1`，连接配置应复用现有容器环境约定。

### 8. headless runtime 不暴露方案所需的控制点

- `src/server/connector-runtime.ts:106-110` 仅提供 fetch/close/runtimeAuthConfigured。
- `connector-runtime.ts:230-231` 自动启动 saasCleanup 与 triggerMaintenance，没有关闭开关，无法从外部按方案只启动一个 leader。
- `src/server/connect-app.ts:51-55` 才返回 maintenance handles，并有依赖注入选项；它不是 headless 公共接口同等能力。
- `connector-runtime.ts:212-229` 未传入 registerStaticRoutes，因此 headless 包不等于自带 dashboard 挂载。UI 构建和静态路由必须额外设计；实际市场 API 是 `/api/marketplace`、`/api/provider-preferences`，不是原文示例的下划线路径。
- 修订：保留 headless 标准边界，但列清必须增补的扩展点；只有证明确实不能外围适配时，才讨论 fork/vendor 补丁。

### 9. Triggers 被误当成会话事件调度器

- `src/triggers/maintenance.ts:112-143` 主要根据 token/策略状态维护或清理订阅，并非往会话投递事件的调度器。
- 上游已有 `src/triggers/subscriptions.ts:38-51` 的 claim/save/release 租约流程；不能不调查存储实现就追加全局选主，也不能由 leader 锁推导“恰好一次”。
- 订阅绑定 `tokenId`（`src/triggers/store.ts:5`）；maintenance 发现 token 不存在会转为删除（`maintenance.ts:124-136`）。若每 15 分钟吊销会话 token，会误伤长期订阅。
- 修订：触发订阅使用独立长期授权资源，不依附短期调用 token；增加 subscription→tenant/session 绑定、签名与 replay 校验、durable inbox/outbox、事件去重键、重试/死信、顺序与频率限制。
- 投递语义采用“至少一次 + 消费幂等”，覆盖 pod 在写 PG/调用外部 API/写会话消息各阶段崩溃。执行中的会话采用排队策略，删除/暂停会话明确拒收或归档。
- 现有租约是否足够覆盖各 provider 的多 pod 操作，属于待验证项，而非本审核已证实的保证。

### 10. MCP 生命周期、密钥存储与子会话继承缺失

- 原方案 remote config 示例缺少必需 `oauth:false`（`packages/schema/src/session-mcp.ts:21-29`）。
- remote MCP 直接使用 `McpClient.connect`（`packages/core/src/session/mcps.ts:275-277`）；supergateway 是 local stdio 场景，不是该 HTTP 服务接入的必经链路。
- `mcps.ts:414-441` 将整个 config 原样存储，并返回 Info。直接放 Bearer header 会将凭证持久化到 config，方案未规定加密、脱敏或对外字段限制。
- 该模块使用 `SessionResourceOwner.id` 归一化资源所有者；子会话共享 MCP 定义时必须明确实际授权是按父会话还是调用会话计算，不能默认是会话独立隔离。
- 修订：持久化非敏感凭证引用，连接/请求时注入短期凭证；设计刷新、重连、跨 pod 缓存失效、授权撤销、父子会话边界。MCP/native 使用同一授权和审计服务，上层模式 `disabled|mcp|native|both`，避免重复工具定义。

## 三、完整性缺口（P2）

1. **代码边界**：新 connector 包若同时依赖 core Tool/Session，而 core 又依赖 connector，容易循环。建议 connector 仅封装引擎；core 承载授权、会话编排和工具适配；schema/protocol 定契约；server 做管理 API/HTTP 桥接。文件名与归属应在修订版给出依赖图。
2. **上游引入**：npm 包也能外围适配，不能以“不改 npm 代码”为理由推导必须 vendor。先验证官方 headless 包，固定版本；确需缺失扩展点再列 fork/vendor 最小补丁。保留 Apache-2.0 LICENSE、NOTICE，评估目录、生成资产、第三方依赖与镜像大小。
3. **凭据安全**：加密必须 fail-closed；跨 pod 共用受管密钥；补密钥轮换、OAuth refresh 并发、client 配置权限、日志脱敏、输入输出敏感字段、文件 capability URL 和审计保留策略。state 校验不等于无需验证回调与租户归属。
4. **外部副作用**：审批/权限、超时取消、幂等、限流、成本与重试要贯穿 action/proxy/MCP/native/code-mode。取消不能承诺撤回已发生的外部写操作；原始 proxy 可能绕过 action 粒度限制，必须单独授权。
5. **供应商托管依赖**：`src/server/connect-app.ts:59-72,105,149` 构建 SaasClient/SaaS OAuth/执行服务。需明确自有 OAuth client 与 OOMOL 托管能力边界、出站调用、数据共享、费用/许可，不将“全量”误写为全部无需外部配置。
6. **运行形态**：全局单例与进程级 egress 配置已确认；这只证明单进程限制，不证明无状态多 pod安全。补 readiness、关闭 drain、故障降级、连接池预算、共享文件清理与长响应测试。S3 支持可保留，但共享存储不自动解决文件租户权限。

## 四、修订后的实施顺序（建议）

| 阶段 | 内容 | 必须通过的门禁 |
|---|---|---|
| P0 设计/验证 | Principal 来源、所有权/grant、拒绝默认值、包边界、迁移、runtime 扩展点 | 所有阻断项写清；最小技术验证覆盖两 HTTP 入口与多 pod |
| P1 安全管理闭环 | PG 初始化、加密、租户管理 API、API Key/OAuth、连接绑定和撤销 | 跨用户/组织/项目/会话越权矩阵；创建失败不残留可用孤儿连接 |
| P2 执行闭环 | MCP/native 统一授权、按连接 scope、code-mode、审批、审计、刷新 | 无连接拒绝；交叉权限不放大；子会话、撤销、长会话与双 pod正确 |
| P3 完整运行能力 | proxy、文件、triggers inbox/outbox、幂等、恢复 | 重放/重复投递/故障注入不造成重复会话副作用，非法代理请求被拒绝 |
| P4 控制台/市场 | 复用安全管理 API 的 UI、provider 偏好和托管能力配置 | 无全局 admin 泄露，用户看不到其他租户的 runs/订阅/连接 |

P1 必须包含隔离，不能将租户安全推迟到原方案 P2。

## 五、测试增补清单

- 安全：空 grant、错误 connection name/ID、action×connection 交叉组合、伪造 tenant ID、跨组织成员、全局管理路由、无认证 action、过期/撤销/JWT无scope、全局 token 旁路。
- 生命周期：连接创建失败/重命名/删除、binding 补偿、凭证轮换、OAuth state 一次性与归属、并发刷新、父子会话、会话删除、MCP刷新重连与跨 pod撤销。
- HTTP：process/ServerFetch 一致、Basic/Bearer/匿名回调路径矩阵、流式 backpressure、客户端取消、多 cookie、大文件与敏感 header 不外泄。
- PG/多 pod：空库与缺迁移拒启、迁移并发、滚动升级、幂等竞争、触发租约失效、各阶段崩溃恢复、共享文件权限。
- Agent：Docker API 驱动，实时订阅 `/api/session/:sessionID/event` SSE，自动回答提问；分别验证 MCP/native/both/disabled 及 code-mode，校验结果、过程和 PG 数据。

## 六、最终判断

可保留：嵌入 SaaS、独立 connector schema、凭据留服务侧、MCP/native 两种入口、完整能力分阶段交付。

必须否决：Basic auth 等于用户身份、空白名单等于拒绝、名称等于授权 ID、现成 token 有 TTL、JWT 自动携带 grant、PG启动自动迁移、原样暴露管理面、maintenance 等于会话事件调度器。

**这些是方案缺陷，不是已经运行并复现的业务故障。完成修订与技术验证后，才能称为可执行的完整实现方案。**
