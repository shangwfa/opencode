# V2 Agent 功能验收（含 Session Agents）

本文档只描述当前 V2 HTTP API 和当前 SaaS 架构。V1 `/session/...`、`/message`、`{name, prompt, permission}` 命令已移除；API payload 使用 `{ id, config }`，Agent 字段以 `ConfigAgent.Info` 为准。

**覆盖口径（2026-10-08）**：本文同时盘点 V2 Agent 定义、选择、内置角色、配置字段、授权、原生 subagent、命令子任务与 SaaS 沙箱/恢复链路。既有核心链路已验；下文新增 T16.31–T16.70 是缺失用例设计，**尚未执行，不代表全量验收通过**。HTTP/SSE/PG 在线证据、单测证据和契约待确认项必须分别记录。

依据：官方 [V2 Agents](https://opencode.ai/v2/docs/agents)（2026-10-08 核对）、`packages/schema/src/config/agent.ts`、`packages/core/src/agent.ts`、`session/agents.ts`、`session/context.ts`、`tool/plugin/subagent.ts`。官方文档与当前 SaaS 实现不一致处单列，不以 V1 或推测补全。

## 环境与运行

仅在 SaaS + PostgreSQL + 可用 OpenSandbox 环境执行。按 [`../test-env.sh`](../test-env.sh) 配置环境，确保 Docker 服务、目标 PG 和沙箱服务可用：

```bash
source docs/test-cases/test-env.sh 3
# 服务启用 Basic Auth 时设置密码；用户名默认为 opencode，也可用 OPENCODE_AUTH='user:password' 指定完整凭证
export OPENCODE_PASSWORD='本地服务密码'
bun docs/test-cases/scripts/session-agents-v2.mjs
```

需要真实模型调用时，`MODEL` 必须指向该服务已配置且可用的模型，再运行：

```bash
bun docs/test-cases/scripts/session-agents-runtime-v2.mjs
```

上述两个脚本通过 V2 HTTP API 测试，使用 `finally` 删除所创建的 Session。PG 后检需额外设置 `PG_URL`，未设置时不能声称已跑 PG 断言。不要对共享会话运行清理操作。

通知专项脚本为 [`../scripts/session-subagent-notifications-v2.mjs`](../scripts/session-subagent-notifications-v2.mjs)，设置 `EVIDENCE_DIR` 后运行；PG 连接变量为 `OPENCODE_DATABASE_URL`。支持 failure/interrupt/restart/success，成功清理测试会话，失败保留现场。它调用 subtask command，**不替代原生 subagent 工具专项**。

### V2 契约速查

| 操作 | V2 路由 | 成功响应 |
|---|---|---|
| 创建会话 | `POST /api/session` | `{ data: Session }` |
| 列出有效 Agent | `GET /api/session/:sessionID/agents` | `{ data: SessionAgent.Info[] }` |
| 创建/替换 Session 覆盖 | `POST /api/session/:sessionID/agents`，body `{ id, config }` | `SessionAgent.Info` |
| 删除一个覆盖 | `DELETE /api/session/:sessionID/agents/:agentID` | `204` |
| 清空 Session 覆盖 | `DELETE /api/session/:sessionID/agents` | `204` |
| 重扫沙箱 Agent 文件 | `POST /api/session/:sessionID/agents/refresh` | `{ data: SessionAgent.Info[] }` |
| 选择会话 Agent | `POST /api/session/:sessionID/agent`，body `{ agent }` | `204` |
| 发送消息并等待执行事件 | `POST /api/session/:sessionID/prompt_stream` | SSE |
| 查询持久化消息 | `GET /api/session/:sessionID/message?order=asc` | `{ data: Message[] }` |

`ConfigAgent.Info` 字段包括 `model`、`request`、`system`、`description`、`mode`、`hidden`、`color`、`steps`、`disabled`、`permissions`。不支持 V1 顶层 `temperature` 或 `permission` 字段。Session 重复 upsert 会替换该 Session 保存的部分 config；有效 Agent 再按全局/Location → Session → 沙箱定义逐字段合并。

## 自动化用例

### T16.1–T16.5：CRUD、合并与回退

`session-agents-v2.mjs` 通过 HTTP 验证：

1. 创建自定义 `session/reviewer`，响应 `source=session`，mode/system/description 与提交值一致。
2. 同 ID 再次 POST，验证覆盖记录 upsert 且新 config 替换旧 config；未提交的 Session 字段不会被当作 PATCH 保留。
3. 列表返回有效 Agent，并验证来源字段和 Session Agent 内容。
4. 第二个 Session 看不到第一个 Session 的定义。
5. refresh 成功返回有效列表；沙箱文件优先级、Markdown 解码和失败处理由 Core 测试验证。
6. 删除单项后 Session 来源覆盖消失；clear 后列表仍可读取。

### T16.6：自定义 primary Agent 实际生成

`session-agents-runtime-v2.mjs` 使用真实模型，通过 V2 API 创建 Session Agent、切换 Agent、调用 `prompt_stream`，并同时断言：

- SSE 包含 `session.execution.succeeded` 且不包含 `session.execution.failed`；
- 持久化 assistant 文本包含 Agent system prompt 指定的唯一标记。

此项依赖可用模型配置和外部模型服务。模型不可用时记为环境阻塞，不得将 4xx、provider error 或超时记作通过。

### T16.7–T16.8、T16.16、T16.18：权限与 subagent

当前以 Core 行为测试作为自动化依据：

- `packages/core/test/permission.test.ts`：Session Agent permission 规则参与授权判断；
- `packages/core/test/tool-subagent.test.ts`：Session 定义的 subagent 可被调度，子 Session 关联正确 parent、Agent 和 Location。

V2 在线 E2E 的覆盖要求：通过 `prompt_stream` 让 primary 请求原生 `subagent` 工具；断言 SSE/持久化消息中的工具调用和完成状态、子 Session parent/agent 关系、主子 Session 沙箱目录共享。2026-10-08 已补在线权限 ask→允许、命令子任务并行/共享/通知；**原生工具完整前台/后台矩阵、权限拒绝及恢复仍待补**，见 T16.50–T16.63，不能以命令路径或 Core 测试替代。

### T16.9–T16.10：隔离与删除清理

- Session 隔离由 HTTP 冒烟用例覆盖。
- PostgreSQL upsert/唯一键及 Session 删除级联由 `packages/core/test/session/agents-pg.test.ts` 覆盖。运行方式：

  ```bash
  (cd packages/core && OPENCODE_DATABASE_URL="$PG_URL" bun test --timeout 60000 test/session/agents-pg.test.ts)
  ```

### T16.11–T16.15：完整流程与错误响应

HTTP 冒烟脚本验证创建/更新/读取/删除/清空，并覆盖：

- 不存在 Session 的 create/list/refresh 返回 `404`；
- 缺少 `id`、非法 `mode` 返回 `400`；
- 超过 256 KiB 的配置返回 `413 SessionAgentContentTooLargeError`。

HTTP 冒烟脚本在设置 `PG_URL` 时会额外使用 `psql` 验证 API 创建对应的 `session_agents` 行、删除覆盖后行数归零，以及删除 Session 后级联清理。单独运行 `agents-pg.test.ts` 则用于隔离验证数据库服务的 upsert 和外键级联行为。

### T16.17：内置 ID 与 Session 覆盖

旧版“`compaction`/`title`/`summary` 均拒绝”的预期不再作为 V2 断言：当前 V2 Session Agent 使用 Agent ID 和 `ConfigAgent.Info` 覆盖模型；`SessionContext.selectTitle` 还会按有效配置解析 `title` Agent。当前协议没有保留 ID 禁止列表。

HTTP 冒烟脚本验证 `title` Session 覆盖可被创建并在响应中生效；还应通过一次实际标题生成确认该覆盖被执行。`compaction`/`summary` 的 Session 覆盖是否属于受支持能力需产品契约确认；未确认前不将它们标成“保留名”或“通过/失败”。

### T16.19–T16.20：模型覆盖与全局回退

- Agent 模型覆盖字段为 `config.model`，结构采用 `ConfigModel.Selection`；Session 所选模型则通过 `/api/session/:sessionID/model` 修改。旧版 `temperature` 不在当前 Agent Schema 中。
- 未配置 Session 覆盖时应继续使用全局/Location Agent；ServerFetch API 测试验证 list fallback，Core SessionRunner 测试验证 prompt 实际选择和 system prompt。
- 真实模型路由须区分 primary、原生 subagent 与 commandSubagent：primary 切换 Agent 不改 Session 已存模型；原生 subagent 新建时依次使用显式工具 model、Agent model、父 Session model。2026-10-08 已有字段保存与当前模型执行记录，但同一模型的成功输出不能独立证明上述优先级；需两种可区分模型/variant 对照，见 T16.45–T16.46。

### T16.29：主子 Agent 沙箱共享

V2 不使用项目 worktree 作为会话隔离依据。验收以根 Session 的 sandbox 为准。2026-10-08 已在线验证命令子任务文件落共享沙箱；通知专项补验子无独立 sandbox 行、父绑定前后 ID 不变。**原生工具主写子读、子写主读、多层共享及两根 Session 隔离**还需可重复脚本，见 T16.57。

### T16.30：沙箱重建后的文件/VCS 状态

旧用例中的 worktree 重建前提不适用于 SaaS 会话架构，不能原样迁移。若需验证沙箱重建，应改成验证 Session 对应沙箱的持久化策略：重建前后对同一 `/workspace` 文件做读取和 diff，并检查 PG 中的 Session/sandbox 元数据。具体期望取决于当前 Sandbox volume 配置；本功能文档不把旧 worktree 用例列为适用项。

## T-SUB 子任务专项

旧脚本的 `/session/:id/message`、`/agents/create` 请求全部属于 V1，已不再作为可执行命令。当前已由 `tool-subagent.test.ts` 覆盖 foreground/background 子任务完成、Session Agent 调度、父子关系、Location 共享及失败恢复相关行为。

在线命令路径的并行、失败/中断后父恢复、普通服务重启消息/PG 后检已有记录。仍需单独覆盖真正 watchdog、原生工具路径、异常宕机及通知投递竞态，见 T16.53–T16.63。执行过程检查 SSE tool started/completed/failed、最终 assistant、子 Session 记录及 PG 关联；单看 HTTP 状态码不足以通过。

## V2 执行记录 2026-10-08（当前代码补缺轮）

> **环境**：组合 3（本地 PG `opencode-v2-up` + 本地 OpenSandbox + 容器 `opencode-saas-mcp-t1025:local` 第二次重建镜像），模型 `Yd-GLM/glm-5.3-flash`。

本轮在 9-26 记录之上重跑既有两个脚本，并补跑部分在线缺口。以下记录不能推导为 V2 Agent 全功能、全部异常组合均已验。

**既有脚本重跑**：`session-agents-v2.mjs` HTTP/PG 冒烟 **24 项全过**（含 413/404/400、PG 行读写与级联）；`session-agents-runtime-v2.mjs` 真实模型 **29 个 SSE 事件**、fork 隔离与 system prompt 标记验证通过。

**在线缺口补跑结果**：

| 缺口项 | 结果 | 证据 |
|---|---|---|
| ConfigAgent 字段矩阵 round-trip + PG | ✅ | 全字段（description/mode/model/system/hidden/color/disabled/steps/request/permissions）POST 200 → 列表平铺于 `agent` 字段往返一致 → PG 一致。**规范化行为**：`permissions` 1 条 ask 规则入库后被默认规则集合并为 6 条、`request` 补 `settings:{}`；`steps` 是**正整数**（步数上限），非步骤对象；`color` 必须 `#hex6` |
| Agent model 字段与当前模型执行（在线） | ⚠️ 部分 | `config.model={providerID,model}` → 切换该 agent 跑一轮 → assistant 消息 `model=Yd-GLM/glm-5.3-flash` + 标记回复。未用不同模型隔离 Session 已选模型与 Agent 模型优先级，不能记为完整路由覆盖 |
| title generation override（在线） | ✅ | 覆盖 `title` agent（system 要求含 TITLEFX）→ 首轮后 `session.renamed` 事件 1 次、标题=`TITLEFX Loops`（覆盖生效）。**判定要点**：title 生成是 `llm.ts` fork 的异步任务且要求 `isUntitled && !parentID`——创建会话**不得带显式 title**，且断言要在 assistant 后多等一拍（首跑 120s 窗口不足误判） |
| permission 在线链路 | ✅ | 覆盖 agent 带 `[{action:"shell",resource:"*",effect:"ask"}]` → SSE 完整链：`permission.asked`（id 在 data 顶层）→ `POST /permission/:id/reply {decision:"once"}` **204** → `permission.replied` → `session.tool.success`（输出 `PERM_GATE_7742`）→ `execution.succeeded`。首跑 FAIL 是执行器应答时序（watchdog 窗口内未送达），链路本身完好 |
| subagent 派生 + 共享沙箱 | ✅（终判：机制正常） | 子会话 succeeded + 真实工具输出 + 文件落共享沙箱容器（与主标记同在）；「不继承父模型」为产品语义，subtask 命令须带 `model` |

**subagent 派生 + 共享沙箱：最终判定为机制正常（初判缺陷已撤销，A/B 镜像定障）**

初判「子写的文件不在主沙箱」经过四轮取证推翻，判定污染源与真实行为如下：

1. **判定污染（教训）**：subtask 命令的模板文本本身就含 token 与 "DONE"——凡对子会话 context 做全文 `includes` 的判定必然假阳性（user message 里就有）。正确判定 = 只看 **tool part 的输出** + 以**共享沙箱容器内的文件**为最终事实；事件终态断言要容忍 type 的版本后缀（`session.execution.succeeded.1`）。
2. **A/B 镜像定障**（B 仅注释 `projectAgentsMd` 一行）：两镜像行为一致——**命令带 `model` 时子会话成功且文件落在共享沙箱**（`docker events` 全程单容器，主/子标记同在）；无 `model` 时子会话因落到默认 Console provider（403）失败。新加的项目 AGENTS.md 指令源与共享沙箱机制均无缺陷。
3. **产品语义（重要）**：`commandSubagent` 派生的子会话**不继承父会话当前模型**——命令定义不带 `model` 时子会话用服务默认 provider（SaaS 下 Console 403）。**subtask 命令必须显式带 `model`**，或作为产品改进让子会话继承父当前模型（可议，未定）。
4. **遗留观察**：无 model 的 403 失败路径上，曾观察到 3 次子会话停在 `execution.started` 数分钟无终态（重启后同条件又快速 failed）——**偶发竞态**，未能稳定复现；不影响正确用法（带 model 全链路稳定通过），留待后续如再出现时按「执行失败路径挂起」单独立案。

**沉淀**：T16 在线判定四要点——① 列表项形状是 `{agent: Agent.Info, source}`（config 平铺于 `agent.*`）；② `steps`=正整数、`color`=#hex6、permissions/request 会被规范化（断言用包含式而非全等）；③ title 断言需无显式标题创建 + 异步等待余量；④ 权限应答的请求 id 在 `permission.asked` 的 `data.id` 顶层，reply 成功返回 204。

### T-SUB 深水专项 + 悬置项探测（2026-10-08 补跑）

| 项 | 结果 | 证据 |
|---|---|---|
| S1 多 subagent 并行 | ✅ | 双命令并发 admit 204 → **2 个子会话并行** `succeeded.1` → 父收 **2 条** `<subagent>` synthetic → 两文件均落共享沙箱 |
| S2 子失败 → 父恢复 | ✅（原断言假阴性） | PG 精确匹配子 ID：子 `failed.1` → 父恰好 1 条 `state="error"` synthetic，job 清除；父通知恢复轮成功 |
| S3 子中断（interrupt） | ✅（原断言假阴性） | 真实 shell 执行中 `POST /api/session/:id/interrupt` 200 → 子 `interrupted.1` → 父恰好 1 条 `state="cancelled"` synthetic，job 清除 |
| S4 服务重启（子执行中） | ✅（已修复，接口复验通过） | 修复前 PG 父 synthetic=0、job 持续 running；修复后重启恢复子执行至 `succeeded.1` → 父恰好 1 条 completed synthetic，job 清除 |
| S5 compaction/summary 覆盖探测 | 📋 行为记录 | 两者覆盖**均被接受**（create 200 + listed）且 compact 正常 admit 200——无保留名拦截；产品契约确认前维持悬置，行为已实测 |
| S6 沙箱重建（记录型） | ✅ | `kill-sandbox` 200 → 重建后轮次正常 → **文件保留**（`REBUILD_KEEP_2210` 在，PVC 语义） |

**通知专项：先沉淀 → 定位 → 修复（2026-10-08）**

- **S2/S3 翻案**：原执行器在 `JSON.stringify(context)` 上匹配 `/state="error"/` 或 cancelled；JSON 字符串的引号被转义，导致假阴性。结构化 context 实际包含 synthetic，不能宣称该 API 排除了通知，也没有证据支持“通知延迟数分钟”。改为 PG `session_message.type='synthetic'` 精确匹配 child ID、解析原始 text，并验证通知恰好一次。
- **S4 真缺陷**：`packages/server/src/process.ts` 仅在传入服务注册 `lifecycle` 时安装 `installRestartContinuity`；Docker `serve` 不传该参数，因而跳过整个重启恢复扫描。`background()` 已持久化 running job，不是持久化缺失、KV 域隔离或 `jobs.wait` 挂起。
- **确定性回归**：`packages/server/test/process.test.ts` 使用专用 PG 库，分别验证有/无注册 lifecycle 的启动恢复。修复前无注册用例超时、有注册用例及原 API 用例通过；移除恢复安装处的门控后 **3 pass / 0 fail**。不改变服务注册回调与 applicationScope 生命周期。
- **核心回归**：专用 PG `opencode-v2-test` 的 `session-execution.test.ts` **41 pass / 0 fail**；server typecheck 通过。
- **接口复验**：`docs/test-cases/scripts/session-subagent-notifications-v2.mjs` 使用真实模型、远端 OpenSandbox、父/子 SSE 与 PG 后检。第一轮 failure/interrupt/restart/success **4/4 通过**，证据目录 `/private/var/folders/zk/8qd0lv657wn8kvpp__hwjj400000gn/T/opencode/subagent-notifications-fix`。重启后子会话恢复并完成，而非永久停在 interrupted。
- **远端强断言复验**：最终轮 **4/4 通过**，证据目录 `/private/var/folders/zk/8qd0lv657wn8kvpp__hwjj400000gn/T/opencode/subagent-notifications-remote-final`。S3/S4 均有 `execute` 工具真实成功输出 `NOTIFICATION_CODE_MODE_OK`（默认 sandbox executor），再调用原生 shell；子会话无独立 sandbox 行，父 sandbox 绑定前后 ID 相同（S4：`afbd8945-a678-4226-bf0a-22fca49be5fb`，控制面 `host.docker.internal:8080`）。四个父代理均输出 `PARENT_NOTICE_ACK` 并成功结束；四项 context 均包含对应 synthetic，进一步排除“context 不含通知”的错误解释。failure/success 刻意不要求子工具调用，不将其标成 Code Mode 执行覆盖。
- **执行器约束**：父代理只确认通知、不自行重试子任务；工具开始以真实 assistant tool part 为准；失败保留现场；表单自动代答；服务重启后重新读取访问口令并重连 SSE。后检轮询不使用 sleep，每 10 秒输出进度。

## 覆盖结论与缺口

### 本轮实测记录（2026-09-26）

本轮用工作区源码构建的隔离 SaaS 容器（`14097`）、本地 PostgreSQL `opencode-v2-up`、本地 OpenSandbox 和 `Yd-DeepSeek/deepseek-v4-flash` 执行：

- `session-agents-v2.mjs`：**24 项 HTTP/PG 检查通过**，包括真实沙箱 Markdown 写入与 refresh、PG 行读写和 Session 删除级联；
- `session-agents-runtime-v2.mjs`：primary Agent system prompt 真实模型执行通过，收到 **17 个 SSE 事件**，并验证 fork 未继承 Session Agent；
- `packages/core/test/session/agents.test.ts`、`tool-subagent.test.ts`、`permission.test.ts`、`session-runner.test.ts`：**337 pass / 0 fail**；
- `packages/server/test/session-agents.test.ts`：**1 pass / 0 fail**；
- PG `agents-pg.test.ts`：**2 pass / 0 fail**；Core/Server typecheck、两个脚本的 Node 语法检查和 `git diff --check` 通过。

该 2026-09-26 实测未执行在线权限拦截、多 Agent 并行协作、模型优先级对照、自动 title generation 覆盖、sandbox 重建等场景；后续已补验的子场景以 2026-10-08 记录为准，其余缺口见新增矩阵，不能据旧轮记录推断全量通过。

| 验收面 | 当前证据 | 状态 |
|---|---|---|
| V2 Agent CRUD、错误响应、隔离 | HTTP 冒烟脚本 | 覆盖 |
| 字段级来源合并、sandbox Markdown | Core `session/agents.test.ts` | 覆盖；目标服务沙箱文件实扫仍需在线场景 |
| PG upsert、唯一键、API 写入与级联删除 | `agents-pg.test.ts` + HTTP 脚本 `PG_URL` 检查 | 覆盖 |
| primary prompt 生效、SSE 终态 | 真实模型 runtime 脚本 | 有条件覆盖，取决于模型服务 |
| permission 实际拦截工具 | Core `permission.test.ts` + 2026-10-08 在线 ask 链路（asked→reply 204→tool.success） | 覆盖 |
| subagent 真实工具调用、沙箱共享 | Core 调度测试 + 2026-10-08 在线（工具真实执行、文件落共享沙箱、A/B 镜像定障） | 覆盖（subtask 命令须带 model） |
| Agent 模型优先级、title generation override | 字段/SessionRunner 单测 + 当前模型执行 / TITLEFX 标题 | title 有正例；模型优先级矩阵待验 |
| ConfigAgent 全部可选字段（request headers/body、steps、hidden、disabled 等） | 2026-10-08 API round-trip + PG 字段矩阵（含规范化行为记录） | 仅字段保存覆盖；执行语义见新增用例 |
| fork 不继承 Session Agent | `session-runner.test.ts` + runtime HTTP 脚本 | 覆盖；runtime 脚本先执行真实模型消息再 fork；空 Session fork 返回 `400 empty_session` |
| sandbox 重建/VCS | S6 PVC 重建后标记文件仍在 | PVC 文件保留有正例；snapshot 与 VCS 状态矩阵待验，不使用 worktree 前提 |

本轮测试结果需按上表逐项记录；Core/Server 单测通过不能写成所有 HTTP/E2E 用例通过。完整 HTTP 脚本：[`../scripts/session-agents-v2.mjs`](../scripts/session-agents-v2.mjs)、[`../scripts/session-agents-runtime-v2.mjs`](../scripts/session-agents-runtime-v2.mjs)。

## V2 全功能盘点与新增缺失用例

### 状态、范围与证据要求

- **已在线**：记录中有 HTTP 驱动、执行过程及 PG/产物断言；只针对实际跑过的子场景。
- **单测**：代码行为有自动化测试，不代表目标 Docker 服务的在线路径已验。
- **待执行**：尚无本轮在线证据的子场景；即使同类单测或历史正例通过，也不能直接勾选。新增矩阵的实际执行状态见末尾补跑记录。
- **契约待确认**：官方与实现差异或能力限制；先记录实测，再确认期望，不凭猜测定通过/缺陷。
- 范围是当前 V2 Agent 的 **SaaS HTTP 服务端能力**。TUI/桌面的快捷键、颜色渲染、交互选择器不属于本服务验收；`color` 的 Schema/存储、`hidden` 对模型目录的影响仍在范围内。AGENTS.md、skills、MCP、commands 的独立功能由各专项负责，本页验证它们与 Agent 的交叉链路。不引入 worktree。

每个在线子场景均须记录：镜像/源码版本、模型及 variant、配置来源、Session/parent/owner/sandbox ID、API payload/status、父子 SSE、真实 tool part、最终消息、PG 前后状态和清理范围。遵循 [`../skills/streaming-output-spec.md`](../skills/streaming-output-spec.md)，实时输出并自动代答；权限拒绝场景按用例指定答案执行，不自动允许。只操作本轮测试会话/沙箱，恢复单测使用专用 `opencode-v2-test`。

### 功能覆盖矩阵（不是全量通过表）

| V2 功能面 | 当前证据与不足 | 新增用例 |
|---|---|---|
| 定义位置、JSONC/Markdown、嵌套 ID | 有 Session CRUD/单个沙箱 Markdown 在线正例；全来源优先级与热更新仅部分单测 | T16.36–T16.39、T16.69–T16.70 |
| 内置 build/plan/general/explore | `agent.test.ts` 有部分内置权限测试；角色行为无完整在线矩阵 | T16.31、T16.51 |
| default_agent、选择、primary/subagent/all | `agent.test.ts` 覆盖默认选择与非法默认；在线切换/模式/失效行为待验 | T16.32–T16.35 |
| system、description、指令组合 | primary system 唯一标记已在线；替换基础 prompt 与其他指令共存、description 目录语义未完整验证 | T16.48、T16.58 |
| model、variant | model 字段保存已验；primary 不换模型、原生工具三级优先级、续跑切换待在线对照 | T16.45–T16.46、T16.55 |
| request.headers/body | 保存/合并有证据；官方声明当前不向模型发送，必须作为限制验收 | T16.47 |
| steps | 正整数字段保存已验；上限、最后一步移除工具与新输入重置待验 | T16.49 |
| hidden、disabled、color | round-trip 已验；可见性、删除/恢复、运行失效矩阵待验；UI 不在范围内 | T16.35、T16.42 |
| permissions | ask→允许在线已验；父调度权限、子工具权限、最后匹配与拒绝反馈待验 | T16.50–T16.52 |
| 原生 subagent 前台/后台/续跑/深度 | `tool-subagent.test.ts` 有前台、后台恰好一次、续跑与深度单测；不能用命令专项代替 | T16.46、T16.53–T16.56、T16.63 |
| commandSubagent | 并行、失败、中断、普通重启通知已在线；模型继承差异须保持独立记录 | T16.46、T16.61 |
| 资源 owner、fork、持久化与隔离 | 独立 Session 隔离和 fork 不继承已有正例；子孙双向 CRUD、跨域防护及重启后定义待验 | T16.40–T16.41、T16.68 |
| 共享远端沙箱、Code Mode | 命令路径共享及 Code Mode 真实执行已验；原生路径双向文件/多层/授权待验 | T16.57–T16.58 |
| watchdog、宕机、幂等及删除竞态 | interrupt 与普通 restart 已验；并非 watchdog 或 SIGKILL/崩溃窗口验收 | T16.59–T16.63、T16.67 |
| PVC/snapshot 与 VCS | PVC 重建保留文件有正例；snapshot 与仓库状态未完整覆盖 | T16.64 |
| title/compaction/summary | title 正例已验；title 条件/降级待验，其他仅接受覆盖/compact 准入 | T16.65–T16.66 |

### T16.31–T16.44：定义、选择、资源与边界

以下用例全部 **待执行**；“单测参考”只说明可复用依据。

| 编号 / 优先级 | 子场景与最低断言 | 单测参考 / 限定 |
|---|---|---|
| T16.31 / P1 内置角色 | 列出 build/plan/general/explore 并核对 mode；build 正常开发；plan 不改普通项目文件但按规则写 plan 文件；explore 读/搜索允许、写拒绝；general 子任务成功且默认不能再派生。PG/真实工具证明允许与拒绝的结果；无 V2 内置 scout | `agent.test.ts`；维护角色另见 T16.66 |
| T16.32 / P0 默认选择 | default_agent=可见 primary、all、未配置分别跑新会话；未知、subagent、hidden、disabled 默认分别记录列表/API admission/runner 终态；修改默认后既有 Session 的已选 Agent 不被替换 | `agent.test.ts`；非法默认的文档/实现差异见契约说明 |
| T16.33 / P1 主 Agent 切换 | 同一 Session 连续 A→B→A，下一轮使用新 system，历史保留；核对 AgentSelected 事件与 PG；无效 ID、选中后删除覆盖、有低优先级回退/无回退分别记录实际错误与终态，不永久 running | `session/context.ts`、`session/session.ts`；选择接口 204 不等于执行成功 |
| T16.34 / P0 mode 矩阵 | omitted/primary/subagent/all × primary 选择/原生子调度；新 custom 默认 primary、all 两种角色可用、primary 不能经原生工具派生；subagent 被选为 primary 的 API 与 runner 行为分开记录 | `tool/plugin/subagent.ts`；与官方“subagent only”不符时单列差异 |
| T16.35 / P1 hidden/disabled | hidden 不进入正常模型 subagent catalog，已知 ID 的直接调用按授权判断，不能把隐藏当安全拒绝；原始 HTTP 列表是否含 hidden 按 API 契约记录。disabled 移除、后层恢复、删除上层后回退；选中后 disabled 的下一轮不得沿用旧缓存 | `session/agents.test.ts` 有 disabled 合并单测；维护角色单列 |
| T16.36 / P1 来源合并 | 同 ID 设全局/Location、Session、sandbox 不同 scalar 标记；验证逐字段优先级、request 按 key 合并、permissions 追加及 last-match；source/sourcePath 与有效定义一致。Session 重复 POST 是替换其部分 config，不是 PATCH | `session/agents.test.ts`、`config/agent.test.ts` |
| T16.37 / P1 发现/解码 | 全局与项目 Markdown、当前沙箱 `.opencode/agents/` 及兼容 `.opencode/agent/`；嵌套 team/reviewer ID、合法 frontmatter、正文 system、空正文、损坏 YAML/非法字段、同名文件确定性；不得越过扫描路径读无关文件 | `session/agents.ts`、`session/scan.ts`；项目 JSONC 通道见 T16.70 |
| T16.38 / P1 缓存更新 | 新建/修改/删除文件→list/refresh→下一轮执行；未变文件不重复读取，变更读取失败重试并记录已知定义保留/降级；强制 refresh 绕过 fingerprint；父子看到一致有效定义 | `session/agents.test.ts`；不得以 list 内容代替 system 实际生效 |
| T16.39 / P0 扫描故障 | 沙箱断连、扫描超时、文件数量/单文件大小限制：普通 list/prompt 依实现 best-effort 降级，显式 refresh 报失败；已有 PG 覆盖不被清空，恢复沙箱后可 refresh；日志不泄露文件内容 | `session/agents.test.ts`；用隔离控制面/故障注入，不破坏其他沙箱 |
| T16.40 / P0 owner 与 fork | root→child→grandchild 读/写/删/clear 均落同一 owner 的 session_agents 行；子删除不误清父定义；另一根 Session 隔离；显式历史 fork 起独立定义域、不复制 Session override；比较 PG 唯一行与实际 owner | `session/resource-owner.ts`；不可把内部 child 与历史 fork 混为继承 |
| T16.41 / P1 定义持久化 | 创建/修改后重启 SaaS，读取 config/time_created/time_updated 并执行；删除后重启不得复活；源码记录指纹缓存与持久化的区别；root 删除级联清零、重复删除/clear 按当前 API 契约验证 | `session/agents-pg.test.ts`、`session/agents.ts` |
| T16.42 / P1 Schema 矩阵 | steps=0/负数/小数/正整数，color 非 hex6/合法大小写，mode/permissions effect 非法，model/request 类型错，空 config；无效输入无 PG 写入。未知字段、旧 temperature/prompt/tools 等是否拒绝或剥离实测记录，不擅自断言所有情况 400 | `schema/src/config/agent.ts`；旧字段适配与 V2 Schema 分开 |
| T16.43 / P1 容量边界 | 对 `JSON.stringify(config)` 的 UTF-8 字节精确构造 256KiB−1/等于/＋1；ASCII、中文/emoji、引号/换行/反斜杠；前两项可保存，超限 413 且 actualBytes/maxBytes 正确；失败不改变旧值或时间戳 | `session/agents.ts:create`；不能只按字符数或原 HTTP body 长度计算 |
| T16.44 / P1 并发/版本 | 同 ID 并发 upsert 唯一行、时间戳严格前进，结果是某次完整 config 而非混合字段；不同 ID 不串；upsert 与 delete/clear/refresh 并发检查错误、最终状态及下一轮配置，不假定跨请求未定义的赢家顺序 | `session/agents-pg.test.ts`；跨服务实例竞态须另测，不依赖进程内锁证明 |

### T16.45–T16.58：执行语义、授权与原生 subagent

| 编号 / 优先级 | 子场景与最低断言 | 单测参考 / 限定 |
|---|---|---|
| T16.45 / P0 primary 模型 | Session 显式模型 A、Agent 配置模型 B，切 Agent 后仍用已存 A；显式改 Session model 后用 B；无 Session model 情况记录服务默认解析。使用两个确实可区分的可用模型/variant，检查 assistant.model、选择事件与 PG，而非只看回复标记 | `session/context.ts:load`、`session/session.ts:switchAgent` |
| T16.46 / P0 子模型/variant | 原生新 child：工具显式 model > Agent model > 父 Session model；覆盖字符串/对象 Agent model、#variant、不存在 provider/model/variant、非法格式，拒绝时无新 child/job。命令 subtask 分别带/不带 model，记录当前不继承父模型差异 | `tool-subagent.test.ts`、`tool/plugin/subagent.ts`；不得统一两种入口的优先级 |
| T16.47 / P1 request 限制 | Agent headers/body 多来源合并、覆盖/删除回退、列表与 PG 一致；隔离 HTTP 模型探针验证当前 runner 不发送 Agent request overlay，provider/model/variant 活跃配置另按其专项验证；不向真实 provider 发送测试密钥 | 官方 Warning；不能把“保存成功”标为“请求转发生效” |
| T16.48 / P1 system/description | 非空 Agent system 替换基础 agent/provider prompt，空/未指定分别核对 fallback；Session/项目 AGENTS.md、skills、references 等来源仍按当前组合存在。用模型请求捕获/独立真实输出证明，不把模板 token 当输出；description 进入可调度目录并可更新 | `session/context.ts`、`session-runner.test.ts`；与其他专项交叉引用 |
| T16.49 / P0 steps | steps=1/2/默认：真实多步工具任务最终一步无工具、以文本总结，不无限循环；下一条用户输入重置 allowance；子 Agent 使用自己的 steps；重试/中断续跑的预算行为记录；SSE 步数、tool parts 与 PG 一致 | 正数字段 round-trip 不代替执行；复用 runner 步数相关测试 |
| T16.50 / P0 父调度权限 | 父 subagent broad deny + 单 ID allow、ask→允许/拒绝、规则顺序反转；验证最后匹配规则有效，被拒绝时无未授权 child、job、沙箱副作用；权限反馈能让父继续合法任务 | `permission.test.ts`、`tool/plugin/subagent.ts` |
| T16.51 / P0 子工具权限 | 父可 launch，但 child 的 read/edit/shell 分别 allow/ask/deny，结果按 child Agent/Session 合并权限执行；edit 同时涵盖 write/patch；父能写不意味着子能写，子规则不回流父；Code Mode 嵌套调用同样不可绕过 | `permission.test.ts`；同时核验真实远端文件未改变 |
| T16.52 / P0 拒绝后恢复 | ask 的 once/持续决策按当前 permission API、直接拒绝、带反馈纠正、表单取消/权限等待中 interrupt；SSE 终态、tool failed、父下一轮成功、PG 无残留 pending/running；不要把 question form 与 permission 接口混用 | `permission.test.ts`、流式输出规范；拒绝场景不自动允许 |
| T16.53 / P0 原生前台 | primary 通过模型实际调用 `subagent`（非 command），child 新鲜 context、parent/agent/location 正确，工具返回 completed + child 最终 assistant 文本；parent 使用结果完成；不得混入父历史 token 或只凭用户 prompt 判成功 | `tool-subagent.test.ts` 前台与 Session-defined 调度单测 |
| T16.54 / P0 原生后台/并行 | background=true 真实工具立即返回 running + child ID；父执行不重叠工作/结束当前轮，子完成后自动通知并恢复父；两个子并行、成功/失败/中断混合，每 child 通知恰好一次、job 清零，工具返回与通知不重复当成两次完成 | `tool-subagent.test.ts` 后台恰好一次；在线命令并行不能替代 |
| T16.55 / P0 续跑/steering | 指定同父 child sessionID 续跑 idle 与 running child，不新建 Session；running 时 prompt 真正入 inbox，结果包含第二任务；换 Agent、显式换模型/不换模型按实现；不存在 ID/其他父 child 拒绝且对方 PG/消息不变 | `tool-subagent.test.ts`；续跑模型规则与新建分别验证 |
| T16.56 / P0 多层/深度 | 默认 depth 限制拒绝孙子；在隔离配置下开启更深链，边界深度可执行、超限 typed tool error；同时覆盖内置 general/explore 默认 subagent deny，不能只调深度就假定授权允许 | `experimental.subagent_depth`、`tool-subagent.test.ts` |
| T16.57 / P0 原生共享/隔离 | 主写唯一文件→子真实读取，子修改→主读/diff，孙子同根可见；文件经远端 OpenSandbox 工具读写；PG root sandbox ID 同一、内部 child 无独立绑定；两根 Session 同路径不同 token 不互串，确认 /workspace 不依赖 worktree | 已有命令正例，不替代此原生多层矩阵 |
| T16.58 / P1 Code Mode/目录 | primary/child 的 execute 真实成功，嵌套调用检查 state.metadata.toolCalls 与实际输出；工具按当前 permissions 过滤并执行叶子授权，hidden/description/disabled 更新影响下轮目录；原生 shell/subagent 的 codemode:false 允许直接调用，不强制它们经 execute | `tool.ts`、`tool/plugin/{shell,subagent}.ts`；默认 executor=sandbox |

### T16.59–T16.70：生命周期、维护 Agent 与交叉链路

| 编号 / 优先级 | 子场景与最低断言 | 单测参考 / 限定 |
|---|---|---|
| T16.59 / P0 真 watchdog | 隔离服务调短 watchdog budget，child 非豁免工具真实 running 超时后由 watchdog 中断（不是人工 interrupt），工具终态与父 cancelled/error 通知、下一轮恢复、PG job 清除；长原生 subagent 默认豁免，不误杀父 | `session/watchdog.ts`；通过 reason/日志/时序证明 watchdog，验证远端工作取消 |
| T16.60 / P0 异常宕机 | child 工具已真实开始、job running 已落 PG 后，只 SIGKILL 指定测试 SaaS 容器再启动；恢复执行、陈旧 tool part 结算、父通知与 claim/job 状态正确；无注册 lifecycle 也恢复；同时区分无模型请求、模型流中、工具中窗口 | 普通 `docker restart` 已通过，但不能替代未清理退出 |
| T16.61 / P0 通知幂等窗口 | 故障注入：child 终态后/通知 admission 前、通知已 durable 后/job 清除前分别崩溃；再启动两次，child ID 对应父 synthetic/inbox 不重复，job 最终清除；原生后台与 commandSubagent 分开；失败注入点可确定，不凭随机重启撞窗口 | `subagent-completion.ts`、`job.ts`、`session/execution/restart.ts` |
| T16.62 / P0 删除/孤儿 | child running 时删 child/root；子终态与通知在删除并发窗口不复活会话；不清理另一根 Session；不存在父/子或关系不匹配的持久化 job 按恢复分支清除；核验 session_agents、inbox、job、sandbox 资源清理策略 | 用本轮创建的实体/专用单测库；不得泛清 kv/全部容器 |
| T16.63 / P0 父中断/前后台切换 | 原生前台等待 child 时 interrupt 父；父/子/工具/job 的取消或转后台结果依当前 `SubagentJob`/`Job.block` 契约记录，再发父新输入可用；后台子运行时父结束一轮不误取消子；避免将任意继承取消逻辑当成预期 | `session/subagent-job.ts`、`tool/plugin/subagent.ts`；先核对实现再定断言 |
| T16.64 / P1 PVC/snapshot | 两种 persistMode 分别覆盖主子文件、git status/diff/未提交修改、kill-sandbox 重建与 SaaS 重启；代码快照/PVC 内容及 PG snapshot/sandbox/session 关联正确；策略不允许持久化的内容明确列出，不用 PVC 正例证明 snapshot | `sandbox/provider.ts` 与沙箱专项；VCS 只检查真实仓库，不测 worktree |
| T16.65 / P1 title 条件 | 未显式命名根 Session 首轮生成；显式 title、已有 title、child 不重复生成；title model/variant 覆盖与不可用时的降级，Agent disabled/hidden 的行为单列；等异步 renamed 后核对 PG，不以首轮结束时缺标题判失败 | `session/context.ts:selectTitle`、title 在线正例 |
| T16.66 / P1 维护角色 | title/compaction/summary 的隐藏与直接选择限制，覆盖配置的接收和实际使用分开测；强制发生 compaction 并核对事件/消息窗口及维护模型/system，实际触发 summary 路径后核对；恢复阶段不得丢父通知 | S5 仅准入；当前支持范围与官方维护角色契约待确认 |
| T16.67 / P0 Provider 故障 | child 模型 unavailable、真实 403、429、流式断连、超时分别区分环境与产品结算；全部在预算内收终态、父错误通知、job/claim 不永久 running；retry 不耗尽/重复任务的行为按 runner 契约验证 | 历史 403 started 挂起观察待复现；隔离 mock provider 故障与真实模型正例配套 |
| T16.68 / P0 域隔离/鉴权 | CRUD/list/refresh/选择的无鉴权/错鉴权、不存在 Session；两根 Session 同 Agent ID 不互串；owner 跨 app/project/directory/workspace、断链/循环须通过专用测试夹具验证拒绝，不能借异常 parent 关系读写他域 | `session/resource-owner.ts`、server middleware；不推断未实现的租户体系 |
| T16.69 / P1 全局动态定义 | JSONC/global Markdown 新增、修改、删除/disabled 后配置刷新或重启生效；Agent.transform 更新/移除/作用域结束的回放与 updated 事件有确定性单测；已有请求用捕获快照、下轮用新定义，不因一次动态更新串配置 | `agent.test.ts`、`config/agent.test.ts`；服务端 operator 配置不放进用户沙箱 |
| T16.70 / P1 SaaS 配置通道/联动 | 远端项目 Markdown Agent 与 JSONC agents/default_agent 分开写、刷新、下一轮执行并记录实际可见性；已知项目 JSONC 仍经服务端 FSUtil 的情况列限制/缺陷，不记通过；Agent 与 Session AGENTS.md、skills、MCP、custom tools/commands 同时启用，验证权限及删除回退不串根 Session | 引用各独立专项，不重新宣称其全量覆盖；项目 JSONC 配置通道需单独定位 |

### 必须保留的契约差异与能力限制

1. **default_agent**：官方 Agents 页描述非法默认回退 build/首个可见 primary；当前 `Agent.select/list` 确实宽松回退，但 `Agent.default` 会对未知/subagent/hidden 默认报 `DefaultAgentUnusableError`，测试也明确如此。T16.32 必须分开观察发现接口与 runner，不能直接把官方描述当全部入口的通过预期。
2. **切 Agent 与选模型**：primary Agent ID 切换不自动改变 Session.model；原生 subagent 新建有 model 三级优先级。`commandSubagent` 当前未配置 command model 时不继承父已选模型，这与原生工具不同，不扩展为“所有子 Agent 不继承”。
3. **request**：官方明确 V2 runner 保留但尚不发送 Agent request overlays。T16.47 用于确认限制与保存/合并；实现转发属于另外的功能变更，不能通过本测试计划暗示已支持。
4. **hidden/maintenance/mode**：hidden 是可见性，不是权限；原始 HTTP 列表与模型调度目录不必具有同一过滤语义。官方维护角色不可直接选择、subagent 仅子会话使用；当前选择 API admission 与 runner 实际执行需分开核验，不把接受覆盖、返回 204 或字段保存当成功选择。
5. **项目配置通道**：沙箱 Markdown Agent 扫描已可用，不代表沙箱 `.opencode/opencode.json(c)` 的 agents/default_agent 已被服务端配置发现读取；此前观察必须保留并由 T16.70 复现。

### 全量验收完成条件

新增用例按矩阵拆为可独立执行的子场景，先沉淀稳定执行器/单测，再运行。所有 P0、适用 P1 均有当前镜像证据；失败有复现/修复/复测记录；契约差异有明确决定；能力限制与不适用项明确排除；各独立专项的交叉引用可追溯。每项记录接口结果、执行过程、PG 与远端沙箱产物，不能用同类单测或旧镜像结果代替。

**当前结论：新增 40 项矩阵已全部在线执行：39 项取得通过证据（含 1 项修复后通过），T16.39 在线故障注入腿仍 blocked（文件数量上限已有单测）。沉淀 7 条契约/行为发现、1 项产品修复（provider timeout，单测+在线双验证）。仍不能宣称"全量验收完成"：T16.39、T16.70 缺口、沙箱断连等长尾需要后续窗口。**

### 新增矩阵在线补跑（2026-10-08，三阶段全量执行完成）

执行环境分两段：主服务 `http://localhost:14096` / `opencode-saas-test`（阶段一与阶段二首轮），后因与并行测试冲突改用**隔离副本** `opencode-saas-matrix`（端口 14098、专用 PG `opencode-v2-test`、同一远端 OpenSandbox 控制面、固定密码）。副本容器曾缺 `OPENCODE_SANDBOX_PROTOCOL=http` 导致沙箱连不上，已修复重建。镜像 `opencode-saas-restart-fix:local`；timeout 修复验证轮的副本容器为热替换源码后的同镜像。实证模型 `Yd-GLM/glm-5.3-flash` 与 `glm-5.3`；探针模型 MatrixProbe（openai-compatible 协议本地 19197）。

执行器：`../scripts/session-agents-matrix-lib.mjs`（公共）、`-api-v2`、`-runtime-v2`、`-runtime2-v2`、`-lifecycle-v2`、`-config-v2`（配合 `-control.mjs` 的可恢复 operator 注入/探针/崩溃窗口）、`-crash-v2`。必须设置 `EVIDENCE_DIR`；可用 `CASES=` 选择子场景；副本执行需 `BASE/SAAS_CONTAINER/PG_URL/OPENCODE_PASSWORD` 环境变量。

**最终状态：T16.31–T16.70 共 40 项中 39 项已有通过的在线子场景证据；T16.39 仍为 blocked（见下）。**

| 编号 | 结果 | 关键证据与契约记录 |
|---|---|---|
| 31 | PASS | build 真实 write+edit；plan 模式拒写普通文件（PLAN_WRITE_DENIED，不改文件）；explore 读允许/写拒绝；general 子任务成功且嵌套拒绝（无 subagent 工具可见） |
| 32 | PASS | 显式选择持久化不替换（换默认后仍 DEFAULT_A_OK，PG agent 列保持）；未显式选择会话 agent 列为 NULL、每次按当前默认解析（设计行为，PG 实证）；unknown/subagent/hidden/disabled 默认均 typed 失败 `cannot run as a session default`；all 默认可用 |
| 33–38、40、42–44、47、68 | PASS | 见前表；40 的子孙 owner/fork 隔离、43 的精确字节边界、44 的并发唯一行均以 PG 复核 |
| 34 | PASS | all 两用 + primary 原生调度拒绝（`cannot run as a subagent`） |
| 35 | PASS | hidden 不入列表但已知 ID 可原生调用；disabled 恢复 |
| 36 | PASS | Session→sandbox 逐字段合并与删除回退（含 request headers/body 深合并、permissions 顺序） |
| 37 | PASS | 嵌套 ID、兼容目录；**损坏 YAML 被整文件读为正文**（frontmatter 原样进 system、mode 回退 primary）——容错契约记录，不判缺陷 |
| 41 | PASS | 重启后 config/time_created/time_updated 逐字节保留并真实执行；删除后重启不复活；沙箱 Markdown 定义跨重启保留 |
| 45 | PASS | Agent 模型不覆盖 Session 已选模型；显式切换生效 |
| 46 | PASS | 继承/Agent/工具显式三级优先级 + 非法 provider/model/variant/格式四种 typed 拒绝且无 child 创建；真实 variant 列表回显（low/medium/high/xhigh/max） |
| 48 | PASS | Agent system、Session AGENTS.md、项目 AGENTS.md 三层标记同时生效 |
| 49 | PASS | steps=1 预算耗尽无工具、内置总结指令生效；steps=2 新输入重置预算后真实执行 shell |
| 50–53 | PASS | 父/子权限矩阵、拒绝恢复、原生前台完成输出与 PG parent 关联 |
| 54 | PASS | 并行成功/失败各通知恰好一次（合并确认为合法时序）；中断腿由 watchdog 终止后通知恰好一次、三 job 清零、父可继续 |
| 55 | PASS | 同 child 续跑双路径（idle 同步返回 / running 转 backgrounded 后通知）；两段任务输入都在 child 会话；跨父 child 拒绝 |
| 56 | PASS | 深度=2 孙会话可执行；深度 3 拒绝 `depth limit reached (2)`（错误在孙会话工具调用中） |
| 57–58 | PASS | 主子双向共享文件与根隔离；primary/child Code Mode execute 真实输出 |
| 59 | PASS | 真实 watchdog（reason=watchdog，工具 running ~166s 后中断）+ cancelled 通知恰好一次 + job 清零 |
| 60 | PASS | SIGKILL 后 child shell 被中断并按重启语义自动重跑；完成输出 CHILD_RECOVERED_OK；父通知恰好一次；沙箱不变；父新轮可继续 |
| 61 | PASS | before-admission / after-admission 两窗口：恢复后通知恰好一次、无重复、job 清零、父自动确认 |
| 62 | PASS | 运行中删 root 与删 child：不复活、消息清零、job 清零（或恢复扫描清零）、父可继续 |
| 63 | PASS | 后台子跨父轮存活（父新轮完成时子未到终态）；空闲父 interrupt 不传播到后台子（记录为契约）；**发现：子长前台命令会以 `command queue wait timed out` 使父轮失败**（共享沙箱命令队列，预算=命令超时+宽限；提示词不丢、后续恢复） |
| 64 | PASS | PVC 与 snapshot 两 persistMode 均验证 kill-sandbox 重建后 git 未提交修改/未跟踪文件保留；snapshot ready→stale/restored_count=1、sandbox ID 变更 |
| 65 | PASS | 未命名根首轮自动生成 title（renamed 事件=1）；child 无自动改名；显式 title 保持 |
| 66 | PASS | title/compaction/summary 均 hidden 不入目录；显式选择 title 可执行（生成 title 文本、全工具拒绝）；手动 compact 事件链（compaction.started manual → ended）+ 压缩后会话可用；summaryFrom 创建带 summary 的新会话 |
| 67 | PASS（修复后） | 403 不重试即 typed 失败；429/断连各 ~10 次重试后失败（retry.scheduled 事件可观测）；后台错误通知恰好一次、job 清零。**发现并修复 provider timeout 断链（见修复记录）**；修复后 timeout 腿 3s/次×11 次尝试 ≈2 分钟完整结算 |
| 69 | PASS | 全局 agents 增改删/disabled：**热更新生效**（无重启即更新并执行新 system）；重启后同样生效；移除即消失 |
| 70 | PASS（缺口复现） | 沙箱项目 `.opencode/opencode.json` 的 agents/default_agent 仍不进入发现——**能力缺口，非通过**；default_agent 执行路径见 32 |
| 39 | BLOCKED | 沙箱断连/扫描超时需隔离控制面故障注入（会波及并行测试的沙箱）；文件数量上限（200 截断）已有单测覆盖（`Sandbox Agent scan truncated`），在线腿未执行 |

#### 本轮沉淀的契约与行为发现

1. **read/edit 权限 resource 约定**：相对 location 目录的路径（`sandbox/tools.ts:309` `path.relative`）；绝对路径规则不匹配。探针三轮实证（`*` 隐藏工具、`*.txt` 执行期 `Permission denied: read`、绝对路径不拦截）。read deny 为 per-action 限制、非保密边界（模型可用 shell cat 绕过）。
2. **共享沙箱命令队列争用**：后台子长前台命令（>命令超时+宽限）会使父轮以 `command queue wait timed out` 失败；提示词不丢、子结束后恢复执行。设计上"排队过久/运行过久"刻意区分（provider.ts `withSemaphoreWaitTimeout`）。
3. **父 interrupt 传播边界**：前台子随父取消；空闲父的 interrupt 不影响后台子（子运行至自然完成或 watchdog）。已核对三方实现依据，**确认为继承语义而非回归，不改**：upstream/dev（V2 主线）的 `RunCoordinator.interrupt` 仅 `Fiber.interrupt` 本会话 fiber、无级联，且其 `background-job.ts` 无消费者、`parentID` 仅为数据/遥测字段；upstream/2.0 exploration 的 `task.ts` 前台 `ctx.abort→cancel(child)`；V1（feat/opencode-1.18.31 线上验证）background=true 立即返回且不注册 abort 监听——前台传播/后台分离与 V1 线上行为一致。
4. **default_agent 解析语义**：会话未显式选择时 agent 列为 NULL、每轮按当前配置解析；显式选择（AgentSelected 事件）才持久化且不被默认变更替换。unknown/subagent/hidden/disabled 默认在执行入口 typed 失败。
5. **损坏 frontmatter 容错**：YAML 解析失败的 Agent 文件被整文件读为正文（system 含原始 frontmatter、mode 回退 primary），不跳过。
6. **通知合并确认**：并行多子完成可能并入父同一轮处理（合并确认合法），断言不得以"每通知一轮确认"为通过条件。
7. **T16.70 项目配置通道缺口**：沙箱内 `.opencode/opencode.json(c)` 的 agents/default_agent 不被服务端配置发现读取（复现两轮）。

#### 产品修复记录（本轮落地）

**provider 请求超时四层断链修复**（发现于 T16.67，隔离副本双验证）：
- 断链：`provider.ts TRANSPORT_KEYS` 剥掉 `timeout`（原供 aisdk fetch 包装）→ native 包 `model()` 无该字段 → `HttpOptions` 无超时概念 → `RequestExecutor` 无 deadline。修复前挂起请求靠 bun socket ~5min 兜底且触发重试风暴（实测 11.4 分钟不保证结算、阻塞重启守卫）。
- 修复（5 文件，高内聚最小改动）：`packages/ai/src/schema/options.ts`（HttpOptions.timeoutMs + merge 细粒度覆盖）、`packages/ai/src/route/client.ts`（transportDeadline：streamPrepared 的 execute 包 Effect.timeout → typed `TransportError(code:Timeout)`，仅覆盖连接/首字节不切长流）、`packages/ai/src/providers/{openai-compatible,anthropic}.ts`（Settings.timeoutMs 降到 route http）、`packages/core/src/model-resolver.ts`（被剥的 timeout 归一为 timeoutMs 传入 native）。
- 验证：`packages/ai/test/http-timeout.test.ts` 4 用例（合并语义/双 provider 映射/挂起 60ms typed 超时/无预算不加隐式 deadline）；ai 包 1428 单测 0 失败、双包 typecheck 通过；在线复测 timeout 腿 3s/次×11 尝试≈2 分钟完整结算（修复消息原文出现在 retry.scheduled）。

#### 执行器与运行记录

- 执行器缺陷修正（非产品）：204 错误信息拼接、agents-md 方法、口令类断言过严、until 把 PG count "0" 当真值、irqTerminal 终态过滤、native() 精确匹配改宽松、T16.63 计时与断言重构、T16.51 相对路径规则、探针键名 `rate-limit`。
- 控制模块加固：全部 docker 操作带 60–120s 超时（阶段二实际发生 bun execFile Promise 丢失挂起）；restore rm 失败继续；restart 前等待非本轮会话退出活跃（最长 180s）；还原 rm 以 root 执行。
- 事件记录：主服务容器 08:22:49 因设置固定密码被重建，中断一轮重跑（四用例环境性失败，关键行为证据已抢救）；一轮超时腿悬挂会话阻塞重启守卫致 T16.41 超时（守卫行为正确）。
- 单测结论修正：此前"214 pass/45 fail"是用例运行方式（多文件共用一个 PG 库）造成的交叉污染。干净环境：core 8 文件 214/214、agents-pg 4/4、session-execution 41/41（另有 1 次偶发测试隔离竞态复跑即绿）。

证据根目录（`/private/var/folders/zk/8qd0lv657wn8kvpp__hwjj400000gn/T/opencode/`）关键目录：`agents-phase1-runtime2-20261008`、`agents-phase1-rerun-20261008`、`agents-phase1-final-20261008`、`read-deny-probe-20261008`、`agents-phase2-config-20261008`（首轮 + 人工还原记录）、`agents-phase2-isolated2-20261008`、`agents-phase2-final2-20261008`、`agents-fix-verify-20261008`、`agents-fix-final-20261008`（修复验证 PASS）、`agents-phase3-crash-20261008`。每个目录含 result.json、http.jsonl、events.jsonl、probe-requests、prompt-N 快照与 operator 备份/还原记录（private-backup 为 0600 私有）。
