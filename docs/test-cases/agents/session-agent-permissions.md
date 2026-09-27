# Session Agent 权限（V2）

本文档只描述当前 V2 HTTP API 和 SaaS Session 权限。原文基于 V1 `permission` 对象语法、`/session/.../agents/create` 和 `/prompt_async`；这些接口和配置格式不再作为当前用例。

## 当前权限契约

### Rule 结构

V2 Agent 与 Session 权限均使用有序 `Permission.Rule[]`：

```json
[
  { "action": "read", "resource": "*", "effect": "deny" },
  { "action": "read", "resource": "public/*.md", "effect": "allow" }
]
```

- Session Agent 写入：`POST /api/session/:sessionID/agents`，body `{ "id": "...", "config": { "permissions": [...] } }`。
- Session 级规则：`PATCH /api/session/:sessionID`，body `{ "permissions": [...] }`。
- V2 不接受旧版 `{ permission: { read: "allow" } }`，也不使用 `permission` 单数属性存 Agent 配置；应使用 `config.permissions`。
- 匹配由 `Permission.evaluate` 根据 action/resource 做 wildcard 匹配，**最后一个匹配规则生效**。Agent 的有效规则在前，Session 级规则追加其后，因此后匹配的 Session 规则可覆盖 Agent 规则。
- 已保存的 always 批准规则排在配置规则之后；但若最终配置规则判为 `deny`，`Permission.assert` 会先拒绝，不允许 saved approval 覆盖配置 deny。
- 没有匹配规则时默认 `ask`。
- `ask` 不等于 API 无法继续：HTTP 客户端可查询 pending 请求，并调用 reply API 返回 `once`、`always` 或 `reject`。未答复的 ask 会继续等待。

### 工具是否出现在模型工具列表

当前工具注册表会用有效规则过滤工具：对某 action，最后一条匹配该 action 的规则若为 `{ resource: "*", effect: "deny" }`，该工具从可用工具定义中移除。路径级 deny 仍在执行时判定；catch-all deny 后追加的路径 allow 可使工具保留，并由执行阶段按具体资源规则判断。该行为不是旧代码里任何命中 `* deny` 都粗暴移除工具的规则。

权限作用顺序来自当前实现：有效 Agent 规则（全局/Location + Session Agent + sandbox Agent）→ Session `permissions` → saved approvals。Config Agent 的 Session 覆盖会追加 permissions 规则，不会将全局 Agent 规则数组整体替换。

## 运行环境

需要 SaaS V2 服务、PostgreSQL 和测试用 PG 的 `psql` 客户端。规则决策与 ask/reply 的自动化脚本不需要模型调用；runtime 脚本还需已配置模型及 Sandbox，并要求提供 `PG_URL` 对 saved permission 做数据库核验。

```bash
source docs/test-cases/test-env.sh 3
export OPENCODE_PASSWORD='本地服务密码' # 若服务启用 Basic Auth；用户名默认为 opencode
bun docs/test-cases/scripts/session-agent-permissions-v2.mjs
# 真实模型/Sandbox 工具执行链路：
BASE=http://localhost:14096 MODEL='{"providerID":"provider-id","modelID":"model-id"}' \\
  bun docs/test-cases/scripts/session-agent-permissions-runtime-v2.mjs
```

脚本通过 V2 API 创建两个 Session，验证权限规则、Session 覆盖、ask/reply 请求隔离和 PG 内容；最后清理测试会话。需保留测试输出作为执行记录，不要将不执行 `psql` 的结果写成 PG 通过。

## V2 权限用例

### T26.21：Agent 权限数组持久化及规则计算

脚本创建一个 Session Agent，权限规则包含 read 白名单、write deny、bash 命令白名单及 edit ask；并对 ConfigAgent 的 model、request、system、description、mode、hidden、color、steps、disabled、permissions 可选字段进行 API/PG round-trip 检查。断言：

- API 接受 `config.permissions: Rule[]`，拒绝类型不匹配的数据；
- `public/*.md` 在较早的 read deny 后 allow，体现 last matching rule wins；
- 未在白名单中的 read/write/bash 资源为 deny；
- exact `git status` allow 规则通过，其余 bash command 由 catch-all deny 阻止；
- PG 的 `session_agents.config.permissions` 与提交数组一致。

### T26.22：Session 权限覆盖 Agent 权限

Session Agent 设置 read/write deny 后，再通过 Session PATCH 添加特定资源 allow。断言：

- `docs/*.md` read 和 `docs/release.md` write 最终为 allow；
- `private/secret.md` read 和 `secrets.txt` write 仍为 deny；
- `GET /api/session/:sessionID` 与 PG `session_v2.permission` 读回规则。

该用例直接请求 `POST /api/session/:sessionID/permission` 评估 action/resources/agent，不依赖模型猜测要调用哪个工具。

### T26.23：ask 请求生命周期

对 edit 资源请求 permission，断言返回 `effect=ask`，pending 列表及单项 get 能读取对应请求；另一个 Session 对请求的 get/reply 返回 404；所属 Session reply `once` 返回 204，pending 请求随后消失。

V2 路由：

```text
POST   /api/session/:sessionID/permission
GET    /api/session/:sessionID/permission
GET    /api/session/:sessionID/permission/:requestID
POST   /api/session/:sessionID/permission/:requestID/reply
```

`session-agent-permissions-v2.mjs` 验证 `once`；runtime 脚本验证 `always` 写入 saved rule、API/PG 读回、后续同资源评估为 allow、真实 write 工具执行及 sandbox 文件副作用。它也验证真实工具请求被 `reject` 并附带反馈后以工具错误返回，模型继续到成功终态且目标文件不存在。

### T26.24：错误输入与不存在 Session

补充检查：错误 Rule shape/effect、资源列表异常、Agent ID 不存在、未知 Session 创建 permission 请求、unknown request get/reply。确认错误状态和响应 tag 与 OpenAPI 契约一致；不要按 V1 期待 500 或旧格式错误。

补充 ID 兼容性检查：V2 `Agent.ID` 当前是任意字符串标识符，并无“保留名称拒绝”契约。脚本针对 `title`、`compaction`、`summary` 这类看起来像内部名称的字符串验证 Session Agent API/PG 写入和列表读回；这只验证 CRUD 接受性，不推断这些 ID 的运行时语义。

### T26.25：工具列表过滤及资源级执行拒绝

使用 `Tool.snapshot` / SessionContext 验证 catch-all deny 从工具定义中过滤工具；再验证 `ask`、路径 allow/deny、bash pattern 在调用时的结果。Unit 证据应来自 `packages/core/test/tool-registry.test.ts` 和 `packages/core/test/permission.test.ts`。runtime 脚本以随机 canary 检查 catch-all 工具过滤、资源级 read deny、允许 read 的 SSE 工具终态及实际读回值。工具过滤是模型目录可见性，不代替叶子的 execution-time `Permission.assert`；API evaluate 单独不足以证明工具隐藏或执行受阻。

### T26.26：Agent / Session / saved 规则优先级

针对同一 action/resource 设置冲突规则，分别验证：Agent 内顺序、Session 规则覆盖 Agent 规则、saved approval 覆盖 ask、配置 deny 阻止 saved approval。PG 检查只应验证持久化的 Agent/Session 规则；saved approval 属于 PermissionSaved 存储，应单独查对应表/API。

### T26.27：路径与外部目录规则

覆盖 `read`、`edit`、`write`、`external_directory` 对 Session `/workspace` 相对路径及目录外访问的 allow/deny。runtime 脚本用 permission API 核验 `external_directory` 的具体 allow/deny，并通过模型写 `/tmp` 断言 Sandbox 返回 `Path escapes the location` 且无文件副作用；另通过有效 Agent API 与 permission evaluate 验证 `~/...` 和 `$HOME/...` 规则展开成绝对 home 资源并匹配。外部目录规则决策为 allow 不代表可以越过 SaaS Sandbox 的 `/workspace` 挂载边界。

### T26.28：subagent 权限

使用 V2 `subagent` 工具及 child Session 验证 caller 的 subagent 规则、子 Agent 自身规则、子 Session permissions 的组合；断言 child 的请求 Agent/Session、SSE tool 终态、执行时权限和实际副作用。另以两个同轮 `background=true` 调用检查生成独立 child Session 并发 admission 和完成。旧 `task`、`deriveSubagentSessionPermission` 命令不再适用。

## 覆盖矩阵与缺口

| 覆盖项 | 当前证据 | 状态 |
|---|---|---|
| V2 Rule[] API 写入、顺序匹配、Agent 与 Session 规则合并 | `session-agent-permissions-v2.mjs` + `permission.test.ts` | HTTP 决策及 PG 持久化已覆盖 |
| ask request list/get/reply 与 Session 间隔离 | HTTP 脚本 + runtime 脚本 | `once` API 流程；`always` 持久化及实际执行、`reject` 恢复流程由真实模型验证 |
| PG Agent config、Session permissions | V2 HTTP 脚本的 `PG_URL` 查询 | 已覆盖 |
| ConfigAgent 全部可选字段的 API/PG round-trip | `session-agents-v2.mjs` | model/request/system/description/mode/hidden/color/steps/disabled/permissions 已覆盖 |
| 工具过滤、execution-time Permission.assert | Core 单测 + `session-agent-permissions-runtime-v2.mjs` | E2E 覆盖 catch-all 过滤、资源级 read deny/allow、SSE 和 canary |
| 路径基准、wildcard、external_directory、HOME 展开 | Core tests + runtime HTTP/Sandbox | 覆盖 `/workspace`、Sandbox 越界及 HOME 规则展开/匹配 |
| 多 Session / subagent permission 隔离、子任务恢复 | Core tests + runtime HTTP/模型/Sandbox | 覆盖 caller allow/deny（deny 不创建 child）、child Agent deny、并行 child Session 与完成 |
| reserved-looking Session Agent IDs | V2 schema/API/PG runtime | 只验证当前 API 接受和 round-trip，不设未定义的保留名行为 |
| `always` saved approvals 及配置 deny 优先级 | Core tests + runtime HTTP/模型/Sandbox/PG | saved permission API、原始 PG 行与实际 write 覆盖；配置 deny 优先级以 Core 单测为证 |
| V1 T26.21–T26.67 原始脚本 | V1 route/object syntax | 已替换为当前 V2 契约，不应逐行执行 |

## 本轮执行记录

2026-09-26：以隔离 SaaS 容器 `opencode-saas-sandbox-test:session-agent-local`（端口 `14097`）连接本地 PostgreSQL `opencode-v2-up` 执行。权限 HTTP/PG 脚本 **29 项检查通过**。首轮真实模型 runtime E2E 发现 Sandbox read 分支缺少 execution-time `Permission.assert`：权限 API 对具体文件返回 deny，但模型仍读到 canary。已修复 `SandboxTools.read` 并新增授权顺序/拒绝无文件访问测试。扩展后的 runtime E2E **10/10 场景通过**：工具过滤、资源级 read deny/allow、always 保存并执行、reject 后恢复、external_directory 与 `/workspace` 越界拒绝、HOME 规则展开/匹配及 HOME 路径沙箱边界、保留样式 Agent ID API/PG 往返、caller subagent allow/deny（deny 时无 child 创建）、child Agent deny 和并行 background child Session。Session Agent CRUD/PG 脚本新增 ConfigAgent 10 个可选字段 round-trip 用例并通过；其中 API 有效配置读取、原始 PG 配置字段和清理级联均有断言。相关 Core 测试 **191 pass / 0 fail**；Core typecheck、JS syntax check 与 `git diff --check` 通过。runtime 测试清理创建的 Session 和 saved approval。

HTTP 响应、SSE 过程、实际文件/工具副作用和 PG 行应分别记录；只有 API 状态码不足以判定权限用例通过。保留样式 ID 当前只验证 V2 API/PG 接受及往返；`compaction`、`summary` 等 ID 的运行时保留/禁止语义没有明确产品契约，因此不据测试臆定拒绝行为。

脚本：[`../scripts/session-agent-permissions-v2.mjs`](../scripts/session-agent-permissions-v2.mjs)、[`../scripts/session-agent-permissions-runtime-v2.mjs`](../scripts/session-agent-permissions-runtime-v2.mjs)。相关单测：`packages/core/test/permission.test.ts`、`packages/core/test/tool-registry.test.ts`、`packages/core/test/tool-subagent.test.ts`、`packages/core/test/sandbox-tools-read.test.ts`。
