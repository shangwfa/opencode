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
- 一次请求包含多个 resources 时，任一资源最终为 `deny` 则整体拒绝；没有 deny 但至少一个资源为 `ask` 时整体等待批准；只有全部资源均 allow 才直接放行。
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

对 edit 资源请求 permission，断言返回 `effect=ask`，pending 列表及单项 get 能读取对应请求；另一个 Session 对请求的 get/reply 返回 404；所属 Session reply `once` 返回 204，pending 请求随后消失。Runtime 用例另验证真实 write 工具在 `once` 后继续执行并写入 Sandbox，且 PostgreSQL 中没有新增 saved permission。

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

针对同一 action/resource 设置冲突规则，分别验证：Agent 内顺序、Session 规则覆盖 Agent 规则、saved approval 覆盖 ask、配置 deny 阻止 saved approval。另以多 resource 请求验证聚合语义：有任一 deny 即整体 deny；无 deny 时有任一 ask 即整体 ask。PG 检查只应验证持久化的 Agent/Session 规则；saved approval 属于 PermissionSaved 存储，应单独查对应表/API。

### T26.27：路径与外部目录规则

覆盖 `read`、`edit`、`write`、`external_directory` 对 Session `/workspace` 相对路径及目录外访问的 allow/deny。runtime 脚本用 permission API 核验 `external_directory` 的具体 allow/deny，并通过模型写 `/tmp` 断言 Sandbox 返回 `Path escapes the location` 且无文件副作用；另通过有效 Agent API 与 permission evaluate 验证 `~/...` 和 `$HOME/...` 规则展开成绝对 home 资源并匹配。外部目录规则决策为 allow 不代表可以越过 SaaS Sandbox 的 `/workspace` 挂载边界。

### T26.28：subagent 权限

使用 V2 `subagent` 工具及 child Session 验证 caller 的 subagent 规则、子 Agent 自身规则、子 Session permissions 的组合；断言 child 的请求 Agent/Session、SSE tool 终态、执行时权限和实际副作用。另以两个同轮 `background=true` 调用检查生成独立 child Session 并发 admission 和完成。旧 `task`、`deriveSubagentSessionPermission` 命令不再适用。

### T26.29：Session 与 Agent 权限预设 API

本用例验证服务端权限预设接口，不涉及 UI。每个预设只能写入对应作用域：Session 预设替换 Session `permissions`；Agent 预设将规则写入当前 Session 的 `session_agents.config.permissions`，创建/更新 Session Agent 覆盖，并保留该 Agent 其余已配置字段。它不修改全局 Agent 配置。

接口：

```text
PUT /api/session/:sessionID/permissions/preset
{ "preset": "read-only" | "workspace-write" | "full-access" }

PUT /api/session/:sessionID/agents/:agentID/permissions/preset
{ "preset": "read-only" | "workspace-write" | "full-access" }
```

分别对 Session 和一个已有 Agent 执行以下检查：

1. `read-only`：读普通工作区文件的 permission evaluate 为 allow；edit、shell 及未列入读取白名单的 action 为 deny。读取 `.env` / `.env.*` 为 ask，`.env.example` 为 allow。
2. `workspace-write`：工作区内 read/edit 为 allow；shell 和未明确放行的自定义/MCP action 为 ask；`external_directory` 为 deny。对编辑与目录外访问分别通过 permission evaluate 检查，不以 API 返回 200 作为权限正确的证据。
3. `full-access`：常见工具 action、自定义 action（例如 MCP action）与 `external_directory` 评估为 allow；`full-access` 因此显式包含 `{action:"external_directory",resource:"*",effect:"allow"}`，而不是只依赖 `* allow` 通配。随后尝试通过真实工具访问 `/workspace` 外路径，断言 Sandbox 仍拒绝越界且没有宿主机文件副作用；权限 allow 不等于绕过 OpenSandbox。
4. 作用域和持久化：Session 端点后由 `GET /api/session/:sessionID` 读回规则，并检查 PG `session_v2.permission`；Agent 端点后由 Session Agent 列表读回并检查 PG `session_agents.config::jsonb->'permissions'`。Agent 的 `system`、`description` 等预先设置字段保持不变；Session 预设不应写入/修改 `session_agents` 行，Agent 预设不应修改 Session `permission`。
5. 替换和隔离：重复设置不同预设后，目标作用域只保留新预设规则，不与之前规则累加；对另一个 Session 执行相同查询，确认其 Session/Agent 权限及 PG 行不变。Agent 预设仅作用于指定 Agent ID。
6. 错误响应：未知 Session 返回 404；未知 Agent 返回 404；非法 preset 值返回 400；非法 Agent ID 返回 400。失败请求不得留下部分写入或新增 `session_agents` 行。

用 `POST /api/session/:sessionID/permission` 分别评估 action/resources/agent；至少对 Agent 预设显式传入目标 Agent ID。检查 PG 时使用本次创建的 Session/Agent ID，并在结束后清理 Session，再确认对应 Session、Agent 行已删除。真实权限生效必须再通过模型轮次触发 Agent 工具，并检查 Sandbox 文件副作用；只测 permission evaluate/API 状态码不能通过验收。当前 `session-agents.test.ts` 的 ServerFetch 测试只证明 HTTP handler 与内存数据库路径，不代替 Docker/PG 验收。

自动化脚本：

```bash
BASE=http://localhost:14101 \\
OPENCODE_PASSWORD=ab123456 \\
PG_URL='postgresql://local@127.0.0.1:5432/opencode-v2-up' \\
bun docs/test-cases/scripts/session-permission-presets-v2.mjs
```

此脚本覆盖 HTTP 读回、permission evaluate、PG 规则和字段核对、跨 Session 隔离、错误响应及清理；它订阅 SSE 观察 Sandbox 初始化命令，但不启动模型轮次。它不代替下一段真实工具 `/workspace` 越界执行测试。

真实模型/Sandbox 执行另跑：

```bash
BASE=http://localhost:14101 \\
OPENCODE_PASSWORD=ab123456 \\
SAAS_CONTAINER=opencode-saas-permission-presets \\
MODEL='{"providerID":"Yd-DeepSeek","id":"deepseek-v4-flash"}' \\
EVIDENCE_DIR=/private/var/folders/zk/8qd0lv657wn8kvpp__hwjj400000gn/T/opencode/permission-presets-e2e-deepseek \\
bun docs/test-cases/scripts/session-permission-presets-runtime-v2.mjs
```

该脚本在模型轮次期间订阅 Session SSE，并核对 execute/真实工具终态和 Sandbox 文件内容。它确认默认 Code Mode `execute` 实际运行；Session 与 Agent 两种 `read-only` 都可读但不能写；Agent `workspace-write` 可写；Agent `full-access` 允许外部目录权限评估但 Sandbox 仍拒绝 `/tmp` 越界写。

### T26.30：同一 Session 多轮开发与动态权限切换

模拟一个连续开发任务：创建同一个 Session 和 Agent 后，第一条消息不设置预设，验证使用 Agent 原有细粒度权限；后续消息按需携带权限预设，在同一 `/workspace` 仓库读取、修改代码并运行语法检查；再发送一条不带预设的消息，验证回到 Agent 原规则。

不新增 API，也不调用 `/api/session/:sessionID/permissions/preset`。每轮都复用现有会话消息接口，在 `prompt_stream` 请求体中附带可选预设：

```text
POST /api/session/:sessionID/prompt_stream
{ "text": "...", "preset": "read-only" | "workspace-write" | "full-access" }
```

不传 `preset` 且不传 `permissions` 时，使用该 Agent 原有的细粒度权限规则。显式 `permissions` 与 `preset` 可随同一消息一起传入；显式规则追加在预设规则之后。

标准流程、步骤及验收：

1. 建立一个 Session Agent，配置原始细粒度规则：普通读取 allow、Session 相对资源 `src/**` 的 edit ask、其他 edit deny；创建源码 canary 并订阅该 Session SSE。Sandbox 文件工具会把 `/workspace/src/file.js` 映射为权限资源 `src/file.js`。
2. 第一条 prompt_stream 消息不传 preset/permissions；经 permission API 检查 src edit 为 ask。要求模型读取源码并写一个开发记录文件，断言真实 read 成功，write 经 SSE 的 once 应答后成功，且 PG 没有 saved permission。
3. 第二条 prompt_stream 消息设置 `preset: "read-only"`；同轮要求读取源码并尝试写入，断言真实 read 成功、write 未成功且 Sandbox 文件不存在。
4. 第三条 prompt_stream 消息设置 `preset: "workspace-write"`；要求模型将 TODO 改为实现标记，检查真实 write 完成、Sandbox 文件内容精确，并执行 `node --check`。
5. 第四条 prompt_stream 消息不传 preset/permissions；断言权限回到 Agent 的 ask/deny 细粒度规则。真实 write 再次触发权限询问；SSE 自动以 once 应答后写入成功，且 PG 不产生 saved permission。

自动化覆盖在 `session-permission-presets-runtime-v2.mjs` 的 CASE 4；通过 `GET /api/session/:sessionID/event` 实时订阅执行事件，并检查 PG 中四条用户消息依次保存未设置、`read-only`、`workspace-write`、未设置。该用例同时证明权限随消息轮次变化，不会泄漏到下一轮。

**边界原因**：Sandbox 启用时，`write` 进入 `SandboxTools.write`，先通过 `SandboxTools.resolve` 将目标映射到固定 `/workspace`；路径不在该根下时直接报 `Path escapes the location`，早于 `Permission.assert(action="edit")`，也不会调用 `SandboxProvider.fileWrite`。因此 `external_directory=allow`（甚至 `* allow`）只代表权限规则决策，不会改变 SaaS 的 `/workspace` 路径约束；这条错误由 SaaS 路径映射层产生，不是 OpenSandbox 返回的拒绝。`full-access` 已显式写入 `{action:"external_directory",resource:"*",effect:"allow"}`，使"权限层全放行"在规则数组里可直接读出，不依赖通配符；但这不解除 `/workspace` 路径门禁。补充事实：沙箱内 `/tmp` 也不在持久化范围——PVC 持久挂载只有 `/workspace`、`/resources`、`/home/sandbox`（含 `.cache/.config/.local/tmp`），snapshot 清单只扫 `/workspace`；shell 工具在沙箱内执行命令不受 `/workspace` 门禁，因此写 `/tmp` 会执行但不持久。

## 覆盖矩阵与缺口

| 覆盖项 | 当前证据 | 状态 |
|---|---|---|
| V2 Rule[] API 写入、顺序匹配、Agent 与 Session 规则合并 | `session-agent-permissions-v2.mjs` + `permission.test.ts` | HTTP 决策及 PG 持久化已覆盖 |
| ask request list/get/reply 与 Session 间隔离 | HTTP 脚本 + runtime 脚本 | `once` API 流程；`always` 持久化及实际执行、`reject` 恢复流程由真实模型验证 |
| `once` 对真实工具调用的放行且不持久化 | `session-agent-permissions-runtime-v2.mjs` + PG | 已补用例，尚待隔离服务/Sandbox/PG 实跑；断言真实 write 成功、文件副作用及无 saved permission 行 |
| 单次请求多 resources 的 deny/ask 聚合 | `packages/core/test/permission.test.ts` | 任一 deny 整体拒绝；无 deny 时混合 allow/ask 整体 ask |
| PG Agent config、Session permissions | V2 HTTP 脚本的 `PG_URL` 查询 | 已覆盖 |
| ConfigAgent 全部可选字段的 API/PG round-trip | `session-agents-v2.mjs` | model/request/system/description/mode/hidden/color/steps/disabled/permissions 已覆盖 |
| 工具过滤、execution-time Permission.assert | 各工具 Core 单测 + `session-agent-permissions-runtime-v2.mjs` | E2E 覆盖 catch-all 过滤、资源级 read deny/allow、write ask/once/always/reject 及 SSE/实际副作用；其他工具叶子授权由各自 Core 工具单测覆盖 |
| 路径基准、wildcard、external_directory、HOME 展开 | Core tests + runtime HTTP/Sandbox | 覆盖 `/workspace`、Sandbox 越界及 HOME 规则展开/匹配 |
| 多 Session / subagent permission 隔离、子任务恢复 | Core tests + runtime HTTP/模型/Sandbox | 覆盖 caller allow/deny（deny 不创建 child）、child Agent deny、并行 child Session 与完成 |
| reserved-looking Session Agent IDs | V2 schema/API/PG runtime | 只验证当前 API 接受和 round-trip，不设未定义的保留名行为 |
| `always` saved approvals 及配置 deny 优先级 | Core tests + runtime HTTP/模型/Sandbox/PG | saved permission API、原始 PG 行与实际 write 覆盖；配置 deny 优先级以 Core 单测为证 |
| Session/Agent 三档权限预设 API 与真实执行 | `session-permission-presets-v2.mjs`、`session-permission-presets-runtime-v2.mjs` + Docker/PG/SSE | 三档规则、HTTP/PG、跨 Session 隔离、真实 Code Mode、read-only 禁写、workspace-write 实写及 full-access 的 Sandbox 越界拒绝均已覆盖 |
| 同一 Session 多轮开发、消息级预设、默认 Agent 细粒度权限 | `session-permission-presets-runtime-v2.mjs` CASE 4 + Docker/PG/SSE | 复用 prompt_stream、不增加 API；真实模型/Sandbox 文件副作用、语法检查、PG 消息预设读回、Agent ask/deny 及 once 不持久化 |
| V1 T26.21–T26.67 原始脚本 | V1 route/object syntax | 已替换为当前 V2 契约，不应逐行执行 |

## 本轮执行记录

2026-09-26：以隔离 SaaS 容器 `opencode-saas-sandbox-test:session-agent-local`（端口 `14097`）连接本地 PostgreSQL `opencode-v2-up` 执行。权限 HTTP/PG 脚本 **29 项检查通过**。首轮真实模型 runtime E2E 发现 Sandbox read 分支缺少 execution-time `Permission.assert`：权限 API 对具体文件返回 deny，但模型仍读到 canary。已修复 `SandboxTools.read` 并新增授权顺序/拒绝无文件访问测试。扩展后的 runtime E2E **10/10 场景通过**：工具过滤、资源级 read deny/allow、always 保存并执行、reject 后恢复、external_directory 与 `/workspace` 越界拒绝、HOME 规则展开/匹配及 HOME 路径沙箱边界、保留样式 Agent ID API/PG 往返、caller subagent allow/deny（deny 时无 child 创建）、child Agent deny 和并行 background child Session。Session Agent CRUD/PG 脚本新增 ConfigAgent 10 个可选字段 round-trip 用例并通过；其中 API 有效配置读取、原始 PG 配置字段和清理级联均有断言。相关 Core 测试 **191 pass / 0 fail**；Core typecheck、JS syntax check 与 `git diff --check` 通过。runtime 测试清理创建的 Session 和 saved approval。

2026-10-08：为避免使用旧镜像或干扰现有 14096/14098 服务，构建当前源码镜像 `opencode-saas-permissions-current:7cc3055e45`，在隔离 SaaS 容器 14100 上运行，连接本地 PG `opencode-v2-up` 与 OpenSandbox。`session-agent-permissions-v2.mjs` 全部 **29 项通过**；`session-agents-v2.mjs` 的 Agent CRUD、Session 隔离、sandbox Markdown 发现、10 个可选字段 API/PG round-trip、错误输入及清理断言全部通过。runtime E2E **11/11 场景通过**，新增 `once` 场景确认真实 write 工具成功、文件内容正确且 PG 无 saved permission；执行期间订阅 `GET /api/session/:sessionID/event`，实时观察思考、工具、文本及执行终态。相关 Core 单测（permission、Session Agent、subagent、sandbox read、edit、patch、shell、execute）**283 pass / 30 skip / 0 fail**；Tool Registry 权限过滤定向用例 **1 pass**。收尾 PG 核验：测试 Session、孤儿 Agent 行、permission canary 均为 0；隔离服务容器已删除，既有服务未重启。

2026-10-08：直接执行 `bun test test/tool-registry.test.ts` 时，5 个需 Code Mode 执行的用例报 “Code Mode requires an enabled Session Sandbox”。原因是该命令绕过 Core 官方 runner；`packages/core/script/test.ts` 会为不依赖真实 Session Sandbox 的 Core 单测设置 `OPENCODE_CODEMODE_EXECUTOR=server`，默认 Sandbox executor 则由 `codemode-config.test.ts` 覆盖。按官方命令 `bun run test -- test/tool-registry.test.ts` 后 **40/40 通过**；权限相关 Core 单测合并重跑 **323 pass / 30 skip / 0 fail**（9 个测试文件）。

2026-10-08：在当前工作树镜像 `opencode-saas-permission-presets-current:local`、隔离 SaaS 容器 `opencode-saas-permission-presets`（14101）、本地 PG `opencode-v2-up` 和 OpenSandbox 上验收权限预设。API/PG 脚本全部断言通过：Session/Agent 写入与读回、PG 规则/字段、Agent 其他字段保留、作用域覆盖与跨 Session 隔离、非法输入/目标、清理。真实 Runtime 脚本 **3/3 场景通过**：默认 sandbox Code Mode 的 `execute` 返回标记；Session 与 Agent 两种 `read-only` 的真实 read 工具成功、write 工具不可用且文件不存在；Agent `workspace-write` 的真实 write 成功并从 Sandbox 读回内容；Agent `full-access` 的 `external_directory` 评估为 allow，但真实 `/tmp` write 收到 `Path escapes the location` 且无文件副作用。执行期间实时订阅 SSE，事件包含 reasoning、工具 input/success/failure、文本及 execution 终态；PG 会话/Agent 数据清理后为 0。最终证据目录：`/private/var/folders/zk/8qd0lv657wn8kvpp__hwjj400000gn/T/opencode/permission-presets-e2e-deepseek-final2`。GLM `glm-5.3-flash` 在隔离容器中遇到 `UNKNOWN_CERTIFICATE_VERIFICATION_ERROR`，故改用已配置且成功的 `Yd-DeepSeek/deepseek-v4-flash` 完成权限验收；该 GLM TLS 失败不作为权限测试结果。一次先后在同一 Agent Session 内从 read-only 切换 workspace-write 的尝试中，模型受先前拒绝轮次的上下文影响而未调用 write；改为独立 Session 隔离每种预设后复验通过，因此 runtime 用例使用独立会话避免对话上下文污染。

2026-10-09：排查并定性 `full-access` 写 `/tmp` 失败：`SandboxTools.resolve`（`packages/core/src/sandbox/tools.ts:28-33`）在权限检查前把目标约束到固定 `/workspace`（`SandboxPath.WORKDIR`），`external_directory` 只在权限层裁决，不解除该门禁；且 `/tmp` 不在 PVC 持久挂载列表（`packages/core/src/sandbox/volumes.ts:25-32`），snapshot 清单只扫 `/workspace`（`packages/core/src/sandbox/snapshot-reuse.ts:43,179`），shell 在沙箱内执行命令不受该门禁。按产品决策把 `full-access` 的 `external_directory` 改为**显式 allow 规则**（不再只靠 `* allow` 通配）：`packages/core/src/permission/preset.ts` 的 `fullAccessRules` 现为 `* allow` + `external_directory allow`，`/workspace` 路径门禁保持不变。同步断言：`permission-preset.test.ts` 校验显式规则存在；`session-agents.test.ts` 校验 Agent preset 回读含该规则且 evaluate external_directory 为 allow；两个测试脚本把 full-access 规则数从 1 改为 2 并校验 explicit external_directory。验证：`packages/core` `test/permission-preset.test.ts` **2 pass**、`packages/server` `test/session-agents.test.ts` **2 pass**，core/server typecheck 通过，脚本 `node --check` 通过。

2026-10-09：按标准流程新增 T26.30，复用现有 `POST /api/session/:sessionID/prompt_stream`，不新增 preset 接口：同一 Session 第一条消息不带 preset（Agent read allow、edit ask/deny），后续消息分别带 `read-only`、`workspace-write`，最后再次省略 preset 验证回落 Agent 规则。真实 E2E 首轮发现 `session.prompt` 与 `session.prompt_stream` handler 均未将协议中的 preset/permissions 透传给 `Session.prompt`，已修复并分别补普通 prompt 与 prompt_stream SSE admission 契约测试。使用当前源码镜像与隔离容器 `opencode-saas-permission-turns`（14101）、PG `opencode-v2-up` 和 OpenSandbox 复验 CASE 4 **通过**：SSE 实时观察 Agent 默认 edit ask→once→真实写入、read-only 真实 read 成功且 edit 被拒并无文件副作用、workspace-write 真实修改源码且 `node --check` 成功、最后不带 preset 回到 Agent ask 并经 once 写入；PG 核对四条 user message 的预设序列为 `[null, "read-only", "workspace-write", null]`，once 未产生 saved permission，Session permission 未被修改，测试 Session 已删除。测试规则使用 `src/**`，因为 `SandboxTools.write` 将绝对 `/workspace` 路径映射为 Session 相对权限资源。旧容器 14096/14098 对专用 preset 路由返回 404，按需求不再使用该路由；它们未被重启或修改。验证：Core 相关单测 **156 pass**，Server session-events **6 pass**，Core/Server/Schema typecheck 通过，脚本语法与 `git diff --check` 通过。

HTTP 响应、SSE 过程、实际文件/工具副作用和 PG 行应分别记录；只有 API 状态码不足以判定权限用例通过。保留样式 ID 当前只验证 V2 API/PG 接受及往返；`compaction`、`summary` 等 ID 的运行时保留/禁止语义没有明确产品契约，因此不据测试臆定拒绝行为。

脚本：[`../scripts/session-agent-permissions-v2.mjs`](../scripts/session-agent-permissions-v2.mjs)、[`../scripts/session-agent-permissions-runtime-v2.mjs`](../scripts/session-agent-permissions-runtime-v2.mjs)。相关单测：`packages/core/test/permission.test.ts`、`packages/core/test/tool-registry.test.ts`、`packages/core/test/tool-subagent.test.ts`、`packages/core/test/sandbox-tools-read.test.ts`。
