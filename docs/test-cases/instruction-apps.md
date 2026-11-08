# 应用沉淀：固定脚本优先，旧版指令应用兼容

## 定位

旧版业务指令应用由自然语言指令组成，执行时每步调用 AI，不是脚本。新应用默认沉淀为已验证的固定动作/脚本：先审阅草稿、测试运行、核对结果并发布，发布后才直接执行。旧版应用保留兼容并在界面明确标记为「AI 执行」；不能把文字定义未经验证自动当脚本运行。

固定动作应用（`automation-app`）是新应用的默认路径。两套契约与代码互不依赖：

- `packages/schema/src/automation-instruction.ts`：旧版指令应用契约
- `packages/schema/src/automation-app.ts`：固定动作/脚本应用契约
- `packages/hn-base-server/src/automation/instruction/`：校验、生成、执行、持久化、worker、路由
- `packages/hn-base-server/src/lib/automation-app.ts`、`automation-runtime.ts`、`automation-worker.ts`：固定应用校验、沙箱脚本执行、worker
- `packages/hn-base-server/src/automation/shared/`：两类应用共用的参数/资源校验与会话历史读取
- `packages/hn-app/src/features/automation/session-drafts.tsx`：固定应用草稿卡片
- `packages/hn-app/src/features/automation/instruction-drafts.tsx`：旧版指令草稿卡片
- `packages/hn-app/src/lib/automation-apps.ts`、`instruction-apps.ts`：前端 API

## 固定脚本优先的验收（2026-11-08）

产品分工：**生成阶段**由 AI 与用户讨论业务流程、形成可审阅草稿并验证；**已发布应用页面**面向传统 RPA 使用场景，输入参数后直接运行已验证的固定动作/脚本，正常运行不逐步调用 AI。异常时才请求 AI 给出局部修复，核对可能的部分副作用并审核后，从失败步骤继续；这次继续成功不等于已批准修改未来运行的版本，用户确认后才更新应用。

- 浏览器会话完成任务后写入已验证的 `.automation/draft.json` 和 `{ready:true,execution:"fixed",requestedAt}` 标记；会话「固定应用草稿」卡片自动导入。`automation_draft.generation_key` 对多标签/多 pod 重复导入幂等；纯沙箱会话也可以点击「根据会话生成固定草稿」。证据不足必须拒绝生成，不能编造脚本。
- 草稿测试仍逐步确认；发布后的固定脚本在发起运行时勾选确认本次脚本和参数，此后脚本步骤不再逐条暂停；网页点击仍逐步确认。失败修复仍须核对，不能自动重跑副作用。
- API + 真实 PG + SaaS 沙箱：`demo@example.com`，草稿 `adraft_284d3894-e439-47b3-97b2-1a45fdd2e396` 测试成功后发布 `auto_3f8cc9e5-56a1-4a74-a454-d9d3ccd79da6`。发布后运行 `arun_169817d0-5c49-44cb-813d-be034229256e` `succeeded`，约 2.0 秒，产物 `output/fast-published-1794116643297.json` 回读与参数一致；PG 中版本 v1、cursor 1、结果 succeeded、草稿 published_app_id 一致。
- 真实界面再次运行 `arun_e01a38dc-3cb4-4d88-b462-15aa2b6f12a3`，PG 记录 1923ms、cursor 1，产物 `output/fast-ui-verified-1794116651.json` HTTP 200 且参数一致。运行期间订阅了 SaaS 会话 SSE：只有连接事件，**固定脚本不经过模型 prompt**；阶段进度由运行 API/PG 输出，而不是模型事件。
- 本次比较仅针对这个固定脚本用例；旧版两步 AI 应用曾用时 31.8 秒，不能据此保证所有任务都在 2 秒完成。浏览器加载、网络和沙箱冷启动仍可能耗时。

### AI 从探索记录生成固定脚本（全链路，2026-11-08 16:23）

会话 `ses_e476e548fffe7XBA11T31ZiEyJ` 真实生成 → 测试 → 发布 → 运行全部通过：

| 阶段 | 结果 |
| --- | --- |
| AI 生成草稿 `adraft_861f9ccb-17e7-419d-946f-cd7aff9af981` | 3 个 js 脚本步骤，耗时约 199 秒（`glm-5.3-flash`） |
| 草稿测试（v1） | 逐步确认；第 2 步失败 → 自动生成修复 → 人工确认后通过 |
| 应用修复并重测（v2） | 3 步全部成功，无新修复 |
| 发布 | `auto_5277fed1-3313-4cac-8f2e-d698f7f02c24` v1 |
| 发布后运行 `arun_476b18e4-a26d-4b68-88fe-813476489118` | `succeeded`，PG 7741ms，一次确认后 3 步直跑 |
| 产物 | `output/report.json` = `{"result":42,"note":"只读验收"}`；`.automation/app-request.json` 与参数一致 |
| 真实界面运行 `arun_3546303f-7267-4247-acb2-a31aa3479873` | `succeeded`，PG 8767ms，产物 `requestedAt=1794126999000` |

本轮修复的两个真实缺陷：

1. **脚本结果契约**：生成的 JS 脚本用顶层 `return {...}` 返回数据，但执行器只捕获 stdout，导致第一步 stdout 为空、第二步解析失败。已给执行器加 JS 兜底（把脚本包进函数执行，`return` 的值自动打印；已用 `console.log` 的脚本不会重复输出），并在生成/修复 prompt 中明确「必须打印到 stdout、禁止顶层 return、`AUTOMATION_RESULTS_PATH` 的值是上一步 stdout 字符串」。
2. **标记文件误判**：登记类应用会写 `.automation/app-request.json`，旧指令卡片把它当成沉淀请求，在 16:27 自动生成了一条多余草稿。现在旧卡片只接受显式 `execution:"instruction"` 的标记，裸标记不再触发自动生成。

另放宽结构化 AI 超时到默认 10 分钟（`STRUCTURED_AI_TIMEOUT_MS`）：实测单次生成 199 秒，原 240 秒上限余量不足，修复方案会误判超时。

## 接口（`/api/instruction-apps`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/drafts/generate` | 按会话生成并保存草稿（需要会话 run 权限） |
| GET | `/drafts?sessionId=` | 会话草稿列表（需要 read） |
| PUT | `/drafts/:id` | 版本化修改定义，已发布草稿不可改 |
| POST | `/drafts/:id/runs` | 用固定 `requestKey` 测试执行；草稿不因此变成正式应用 |
| GET | `/drafts/:id/runs` | 草稿执行记录 |
| POST | `/drafts/:id/publish` | 当前版本完整执行成功后才可创建应用 |
| GET | `/apps`、`/apps/:id` | 应用列表/详情 |
| GET | `/apps/:id/runs` | 应用运行记录（按所有者隔离） |
| POST | `/apps/:id/runs` | 在指定会话执行应用 |
| GET | `/runs/:id` | 查询执行状态与输出 |
| POST | `/runs/:id/resume` | `retry`（未派发则重新派发；已派发只恢复观察）/ `stop` |

## 执行与安全规则

- **单次派发**：`queued → running` 原子认领后才发送提示词，避免多 pod 重复执行副作用。
- **恢复只观察**：已有 `promptId` 的运行恢复时仅继续轮询，不重发指令；只有从未派发的运行才允许重新派发。
- **同一轮多消息**：只接受该 `promptMessageID` 最新且 `finish != tool-calls` 的 assistant 消息作为最终结果，避免把中间工具调用误判为完成。
- **失败不覆盖已发布应用**：执行报错后生成**待审核草稿**，正式应用版本不变；用户需重新测试并确认创建。**不会自动重跑**。
- **中断不重生成**：用户中断或看门狗中止（`error.type=aborted`）按中断结束运行，不触发重生成，也不重放动作。
- **人工介入**：提示词要求登录、验证码、权限问题暂停请求接管；发货、付款、删除等操作先确认；结果不确定时不重试。
- **发布门槛**：仅当前版本、完整成功、未跳过、未修复、未重生成的运行可发布。
- **权限**：所有读写都先校验会话 ReBAC 权限；其他用户得到 404。

## 逐步执行与页面内执行过程（2026-11-08）

- 应用执行改为**按指令逐步执行**：每条指令单独派发一轮，当前步骤确认完成后才派发下一步；步骤状态（待执行/执行中/已完成/失败）逐步落库到 `instruction_run.steps`。
- 执行过程内联在**应用详情页**：新增 `GET /api/instruction-apps/runs/:id/messages`（按本次运行的 promptId 过滤），详情页展示「步骤进度」与「执行过程」；「打开会话查看执行过程」降级为次要入口「在会话中打开（接管或调试）」。会话页只用于探索，聊天区仍保留应用沉淀卡片。
- 实测运行 `irun_71d5ec00-0e24-4c80-8fb7-f4279cc1c0e5`：步骤 1 计算乘积 running→succeeded，步骤 2 生成验收报告文件 running→succeeded，整轮成功；执行过程消息 5 条分属 2 个 prompt。
- 步骤派发使用 `promptId` 作为并发守卫，旧步骤的观察者不会重复推进；网络异常只暂停观察，不重发本步。

## 运行时权限策略（2026-11-08 调整）

- 指令应用的执行由 `permissions: [{action:"*",resource:"*",effect:"allow"}]` 派发：**运行期间不再逐条询问工具权限**，按应用步骤直接执行。
- 风险控制保留在业务层：草稿中的高风险步骤（发货、付款、删除等）标记 `requiresConfirmation=true`，界面在发起运行前要求用户勾选确认；发布应用前还需核对运行输入、输出与产物。
- 实测：运行 `irun_b8b3dc0b-ef07-4f0d-a247-7327945959a8` 期间 SaaS 待确认权限数始终为 0，运行成功。

## 已验收（2026-11-08，demo 账号 + ego-lite 真实界面）

环境：`opencode-saas:instruction-e2e-3042fb09-v2`（当前工作区构建，`core/server/cli/protocol` 与工作区逐字节一致）、本机 PG `opencode-v2-up` / `hn_browser_ui_20261030`、基础服务 `15301`、前端 `3001`、SaaS `14096`，账号 `demo@example.com`。

- 场景 A（纯沙箱）：会话 `ses_e476e548fffe7XBA11T31ZiEyJ` 首轮 Code Mode 计算 6×7 并写入两个文件；自动生成草稿「乘积验收与就绪登记」→ 测试执行（逐项批准 4 次工具权限）→ 成功 → 创建应用 `inst_dff2ffc8`；PG 中草稿 `published_app_id`、运行 `succeeded`、应用版本一致。
- 场景 B（带浏览器）：从「开始任务」新建会话 `ses_e4764e9f5ffeNGmEFqAZ8GfpXR`，浏览器面板实时显示 example.com；草稿「网页标题核对与就绪登记」含 `verification{path: output/title.txt, contains: Example Domain}`；测试执行需逐条批准 shell 权限（共 6 次）后成功；产物预览显示 `Example Domain`；创建应用 `inst_9df04d46`。
- 界面修复验证：待确认权限逐项显示操作与目标；产物一键预览；草稿卡片移出消息流，落在状态行之后的「应用沉淀」分区。

本轮修复的显示与连接问题：

1. 首页误报「连接失败」：健康检查直连 SaaS 无 Basic 凭据返回 401。改为经基础服务 `GET /api/health/saas` 代理，凭据不下发浏览器。
2. 浏览器面板误报「资源不存在或无权访问」：接口/脚本创建的会话没有浏览器记录。改为识别 404 并提示「本会话没有浏览器环境…」，不再显示通用故障。
3. 草稿卡片插在对话与「思考中」之间：新增 `SessionTimeline.footer`，卡片统一落在状态行之后的「应用沉淀」分区。

## 已验收（2026-11-03，当前工作区镜像 + 远程 OpenSandbox）

验收环境：`opencode-saas:instruction-e2e-3042fb09-v2`（当前工作区构建）、独立 PG 库 `opencode_instruction_e2e`、会话前端 `3002`、基础服务 `15321`、远程控制面 `172.18.32.15:30040`、沙箱镜像 `opencode-sandbox:runtime-v2-browser-codemode-v1`。

- 会话 `ses_e62077facffeKel0rTKdQBWqwn`：真实 AI 首轮执行 `execute`（Code Mode）计算 6×7，并写入 `/workspace/output/report.json` 与 `/workspace/.automation/app-request.json`，SSE 见 `session.execution.succeeded`。
- 自动生成草稿「乘积结果报告与就绪登记」（`idraft_e06d8854-919a-4698-98b5-dbd4c4c9b86e` v1），步骤为业务语言。
- 测试执行 `irun_a94bdac1-fb30-41e8-96d0-0ccd3307203e` `succeeded`；SSE 依次出现 `permission.asked`（read/glob/edit）→ `permission.replied`（once）→ 工具成功 → `session.execution.succeeded`，证明 `permissions: [{action:"*",resource:"*",effect:"ask"}]` 生效。
- 产物回读 `output/report.json` = `{"result":42,"note":"只读验收"}`。
- 发布 `inst_354a1e96-a1a4-43d8-bb7d-f5e60b60569f` v1；草稿 `published_app_id` 与运行 `succeeded`、`regenerated_version` 为空一致。
- 界面实测：会话卡片四步进度、折叠长步骤后高度 1540→944px、测试/创建按钮在首屏可见；发布后刷新优先选中已创建应用并显示“执行应用 / 查看应用详情”。

本轮同时修复了三个阻断缺陷：

1. 生成草稿 500：模型把“无产物校验”返回为 `verification: null`，结构化解码失败；现已把 null 与省略等同处理。
2. 权限列表 400：`glob`/`grep` 的权限 `metadata` 含 `undefined` 字段（`hidden/path/limit`），`session.permission.list` 编码失败，导致用户无法应答、运行被看门狗中止；已改为省略未提供字段。
3. 中断被当作应用缺陷：`error.type=aborted` 现在按中断结束，不触发重新生成。

## 已验收（2026-11-01，远程 OpenSandbox）

- 会话 `ses_e6885c27effen4EoyP5qt7aZN8` 中由真实 AI 生成指令草稿，卡片展示指令与参数。
- 会话卡片执行测试 → 成功；确认创建应用 → 卡片出现“执行应用”；再次执行成功并显示完整业务结果。
- SSE 观察窗口内可见：执行开始、思考、`shell` 工具、文本结果、执行成功。
- PG 核验：
  - 草稿 `idraft_8750ae9d-2f03-456d-9194-9f20f185f0a3` v1 → 应用 `inst_2f79e0ee-16d0-4447-b98b-e6d92f3f37c1` v1，`content_hash` 与发布记录一致。
  - 测试运行 `irun_d62948b9-90d7-41a4-ab7e-848785b1a840`、应用运行 `irun_4b8d6b41-efa5-4047-85ca-108c406f988f` 均 `succeeded`，`regenerated_version` 为空。
  - 验收结束时无 `queued/running/regenerating/paused` 残留。
- 自动化测试：后端 53 项、前端相关 12 项通过，前后端与 schema 类型检查通过。

## 真实业务场景（2026-11-01）

固定数据放在会话沙箱内（`/workspace/.fixture`，本地 `python3 -m http.server 18767`），不访问外部真实店铺；全部为只读操作。

| 场景 | 输入 | 结果 |
| --- | --- | --- |
| 订单核对 2026-10-30 | 页面 3 笔订单 + ERP 缺 O-1003 | 运行 `irun_8cae7dcb…` 成功；报告 totals `A=2,B=1,C=4`，`differences` 标记 `O-1003 missing_in_erp` |
| 订单核对 2026-10-31 | 参数切换日期 | 运行 `irun_5b3fa2e2…` 成功；报告只含 `O-1004`，totals `D=5`，无差异 |
| 重复请求 | 相同 `requestKey` 再次提交 | 返回同一运行，不重复派发 |
| 用户中断 | 运行中调用会话 interrupt | 修复后运行立即 `failed`：`执行被用户中断，未自动重试`，`regenerated_version` 为空，不自动重跑 |

报告文件 `/workspace/output/order-report.json` 通过会话文件接口回读校验；PG 中运行状态、应用版本、输出长度与上述结果一致。中断场景修复前会一直停在 `running`，修复后按终态结束且不触发自动重生成。

## 旧版指令应用：步骤是业务语言（区别于固定动作 RPA 应用）

- 每条步骤只描述：做什么、看什么、判断什么、产出什么。面向普通业务人员，可读、可审阅。
- 禁止把工具名（shell、python、node、curl 等）、命令行、脚本代码、选择器、CSS/XPath、DOM、正则等实现细节写进步骤。
- 保存、更新、发布时都会扫描并拒绝技术细节；生成时若模型首次输出技术细节，会自动要求改写一次。
- 界面统一使用“业务应用 / 业务步骤”的叫法；内部契约与 API 仍保留 `instruction` 命名，不影响使用。

## 安全与结果约束

- **高风险确认（平台门）**：指令可标记 `requiresConfirmation=true`。只要应用包含此类指令，运行请求必须带 `confirmed: true`，否则接口返回 400；界面显示“需确认”并要求勾选后才能执行。生成提示会要求发货、付款、删除、提交订单等指令自动标记。
- **结果校验**：应用可声明 `verification = { path, contains? }`（路径相对 `/workspace`）。模型回合完成后仍会读取产物；文件缺失或未包含指定内容时运行标记为失败，且不自动重试、不自动重生成。
- **秘密扫描**：保存、更新与发布都会扫描说明、参数默认值、指令正文和校验内容，命中常见密码/令牌/私钥格式时拒绝，并指出疑似字段。
- **草稿归属**：指令应用草稿保存在 PG（版本+哈希），沙箱只承载执行过程和产物；这是与原“草稿先放沙箱”设计的明确调整，便于多 Pod、持久化和审计。
- **自动生成**：旧版指令应用仅接受显式 `execution:"instruction"` 的新鲜请求标记；默认走固定动作应用（`execution:"fixed"`）。业务脚本写出的同名文件或裸 `ready` 标记不得触发旧版应用生成。两类草稿仍需测试并确认发布。

## 全局入口

- `/cdp/instruction-apps`：指令应用列表（搜索、版本、指令数）。
- `/cdp/instruction-apps/:appId`：查看业务指令、选择运行工作区、运行应用、查看输出与运行记录；暂停时可继续观察或结束。
- 侧栏「指令应用」进入；会话卡片的“查看应用详情”跳转同一页面。

## Code Mode 验证（2026-11-01）

首次执行时模型确实调用了 `execute`（SSE `tool ◇ execute`），但返回：

```
Failed to start Code Mode Runner: runner-started:1030 Code Mode Runner exited before readiness
```

沙箱内核对：`/opt/opencode-codemode-runner.mjs` 不存在，日志为 `MODULE_NOT_FOUND`。根因是远端沙箱镜像 `opencode-sandbox:runtime-v2-browser-v1` 未内置 Runner，不是执行链路或权限问题。

在临时会话沙箱中补齐 Runner 后复测同一指令应用：

- SSE：`tool ◇ execute` → `tool ✓ {"result":42,"note":"6 * 7 = 42（Code Mode 内计算的乘法结果）"}` → 文本 → 执行成功。
- 运行记录 `irun_51ca319a-0cf4-4b62-beab-9165ec8d0817` 成功，输出包含结果 42。
- 复测使用 `Yd-GLM/glm-5.3-flash` 会话；此前失败还遇到 DeepSeek 免费额度与上下文超限，属环境问题。

持久修复（2026-11-02）：

- 以原镜像为基础构建 `opencode-sandbox:runtime-v2-browser-codemode-v1` 并推送；构建期实际启动 Runner 并检查 9911 就绪。
- SaaS 容器改用该镜像（`OPENCODE_SANDBOX_IMAGE`），旧容器保留为 `opencode-saas-aliyun-qr-backup-*` 便于回滚。
- 新建会话验证：沙箱内已存在 `/opt/opencode-codemode-runner.mjs`，无需手工补装；指令应用运行 `irun_ec31fbc7…` 成功，SSE 显示 `tool ◇ execute` → `tool ✓ {"expression":"6 * 7","result":42}` → 执行成功。
- 应急补装脚本 `docs/test-cases/scripts/install-codemode-runner.mjs` 仅用于镜像尚未更新的环境，会膨胀会话上下文。

## 尚未覆盖

- 会话卡片新增待确认权限列表：基础服务按会话 read/run 权限代理 V2 请求，界面逐项展示操作/目标，只允许「仅本次允许」或「拒绝」，不自动答复或持久授权。已通过 HTTP + PG 模拟 SaaS 的归属与请求校验测试，以及前端交互测试；尚未对新增确认按钮做远程沙箱实点 E2E。
- 成功运行后卡片可直达本次隔离产物；文件 404/沙箱不可达显示读取失败，不能伪装成空文件。修改测试参数后必须重新测试，旧成功结果不可用于确认创建。
- 会话内自动生成标记仍由前端轮询消费；页面关闭时不会自动消费。可在返回会话后继续，或手动点击「根据会话生成」，不能宣称服务端自动生成。

- 真实业务失败（如模型额度、上下文超限）下的失败修订仍只由模拟 SaaS 的接口测试覆盖。
- Code Mode 已在当前镜像验证通过；普通业务指令仍可能选择 `shell`，不保证每次都走 Code Mode。
- 生成文案可能仍包含 `output/report.json` 这类文件路径描述，未强制改写为纯业务措辞。
- 同一会话重复生成（前端自动生成与手动按钮）会各产生一份草稿，按 `generationKey` 去重只在同一键内生效。
- 凭据只靠生成提示与用户审阅防止写入，没有可靠的自动秘密检测。
- 沙箱控制面 `172.18.32.15:30040` 会短暂不可达；此时新建会话报 `Sandbox.create failed`，属环境问题而非功能缺陷。
- 多 pod 并发下的执行归属由 PG 咨询锁与状态守卫保证，未做 k8s 多副本压测。
