# Gumloop 连接器设计调研（2026-10-20）

来源：https://docs.gumloop.com/（`core-concepts/credentials`、`human_in_the_loop`、`enterprise-features/hosted_mcps|proxied_mcps|app_activity`、`nodes/mcp/*`、`mcp-server/*`、`api-reference/mcp/*`）。

状态：仅调研记录，**本轮不实现**；用于后续团队共享、审批、活动日志等预留能力的设计输入。

## 核心模型

- Connector = 服务的工具集；Connected Account = 身份凭据；Secrets 单独存储（代码沙箱用）。三者解耦。
- 统一 catalog 承载三类来源：`gumcp_server`（内置）、`gumstack_server`（用户自部署）、`mcp_server`（自定义 URL），各自带连接状态。
- 内置连接器本质都是 MCP server；另有 Custom / Proxied / Hosted 三种 MCP 接入形态（Hosted 支持 GitHub CI/CD、回滚、Pod 监控、运行日志；Proxied 支持 Access Gate 与 managed tunnel）。
- 中央授权层：Claude/Cursor/VS Code 经 Gumloop MCP 调用已连接应用，凭据不离开 Gumloop，RBAC/App Rules/域名限制/Activity 同样生效。与我们 base 网关定位一致。

## 账号归属与选择分离（重点）

选择（Selection）回答"这次调用用哪个账号"；归属（Ownership）回答"这个账号代表谁的身份、谁有权借用"。

| 场景 | 选择 | 归属 | 效果 |
|---|---|---|---|
| 共享 Agent 各用各的账号 | Personal Default | user-owned | 运行者身份隔离 |
| 固定团队账号但需权限 | Specific Account | user-owned | 有权限者用之，缺失回退/fail-closed |
| 团队共享收件箱 | Team Default | user-owned | 全员同一共享账号 |
| Agent 固定服务账号 | Specific Account | agent-owned | 所有使用者同身份；不能与公开分享并用；企业默认禁用；克隆/移动解绑 |

缺失 pin 的语义写死在产品里：个人 pin 缺失 → 回退运行者个人默认；团队 pin 缺失（有权限者）→ fail closed 不换账号；agent-owned 不可用 → 必须由 owner 修复。

对我们：当前 deployment `connection_id` 创建后不可变，相当于 Specific Account + agent-owned。将来做共享/团队时必须拆成"选择层"与"归属层"；数据模型不应把 connection_id 等同于纯授权对象。

## 工具治理与审批

- 挂载到 agent 显式化：只连账号不生效，必须 Add Connector 到 agent。
- 每连接器设置：账号选择、`approval_mode`、`tool_approval_modes`（按工具）、`restricted_tools`、`credential_mode`、incognito、disabled。
- 审批模式：Always allow / Ask each time / **Ask for writes/deletes（推荐）** / Never allow / Custom 每工具；工具自动按读/写分组，自建连接器同样适用。
- App Rules：CEL 表达式按**参数**条件审批（如"外部收件人才审批"），可由 agent 自然语言创建、需人确认；与审批模式叠加。
- 审批卡片多入口（Web/Slack/Tasks/通知），沙箱代码与嵌套 MCP 调用会预览；"don't ask again" 只记该 agent/工具。
- 企业治理：custom role 工具×角色矩阵、整 server 禁用、Domain restrictions、App Claims（可连接的账号/工作空间）。
- 新工具发现策略与我们相反：Proxied "Fetch New Tools" 新增默认开启但需复核；我们选择新增不自动授权。

## API 与可观测

- `GET /mcp/servers/{id}` 返回 `allowed_tool_call_ids`（RBAC+策略过滤后）。
- `POST /mcp/tools/call` 批量 1–5 并发，逐条 `status`（success/unauthenticated/error），混合结果 207，积分不足 402，未连接返回 `gumloop_auth_url`。
- Connector Activity：每次调用记录 server/tool/user/**source**/latency/status，筛选、CSV 导出、按 server 7 天统计、错误率/延迟分位。
- OAuth 懒刷新（下次使用时），refresh token 过期需重连；API key 仅创建时可见；URL 凭据脱敏；gate 凭据 write-only。

## 对我们的预留输入（不实现）

> 修正（2026-10-20）：我们**并非没有角色体系**。hn-base-server 已有平台 `user.role`、组织 `member.role`（owner/admin/member/viewer/guest）、组织自定义角色 `org_role.permissions`（资源×动作矩阵）、ReBAC `relation_tuple`（owner/editor/viewer/use/read_secret 等）与 `assertPermission` 校验，解析规则同 Gumloop 的"角色天花板 ∩ 单项共享 − 自定义角色"。缺的是连接器链路未接入：`RESOURCE_TYPES` 无 connector/tool 维度、connector_scope 按 user 归属、MCP 调用未走权限校验。因此"角色×工具矩阵"= 给现有权限模型补资源类型，不是新系统。

1. 接入授权层：拆"选择层/归属层"，团队共享、运行者自带身份、agent-owned 三种归属。
2. 审批层：写操作需确认、按参数条件规则（类似 CEL），沙箱内嵌套调用预览。
3. source 维度活动日志：哪个客户端/agent 调用了哪个工具（成本低、价值高）。
4. 角色×工具矩阵：`RESOURCE_TYPES` 增加 connector（动作 use/manage 或工具级），deployment 用 relation_tuple 授权，MCP 调用按调用者角色过滤；新工具默认策略需再权衡。
5. deployment catalog 化：内置/自定义 MCP 统一入口与治理。

## 未核实项

- app-policies/app-rules 详细规则语法与限制未抓到正文（页面空返回），仅据 human_in_the_loop 与 centralized-auth 描述记录。
- 各形态的真实延迟、定价、托管 MCP 的运行时隔离细节未核实。
