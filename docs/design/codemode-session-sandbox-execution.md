# Code Mode 会话 Sandbox 执行方案

## 1. 结论

Code Mode 的模型生成源代码不再由 SaaS 服务进程解释执行，而是在**所属 Session 的 Sandbox**中运行受限的 `@opencode/codemode` Runner。SaaS 服务仍是控制面：创建执行、冻结工具快照、授权、调用真实工具、写入进度与会话消息。

这不是把工具实现下放到 Sandbox：Runner 只解释 Code Mode DSL；`tools.xxx()` 通过 SaaS 主动建立的 Runner WebSocket 请求 Tool Gateway。Shell、文件、MCP、OpenCode 服务工具仍沿既有 `Tool.Snapshot.execute` 路径执行。

## 2. 现状与必须解决的问题

### 2.1 当前链路

- `packages/core/src/codemode/tool.ts` 在服务进程调用 `CodeMode.make(...).execute(code)`。
- `packages/core/src/tool.ts` 为每次请求构造 Tool snapshot，并由 Code Mode 闭包直接调用 Tool executor。
- `SandboxProvider.run()` 复用 `sandbox.command_session_id`；`packages/core/src/sandbox/provider.ts` 的 `commandLocks` 将该 Session 的命令串行化。

服务端解释器会占用控制面 CPU/内存。更重要的是，若直接把 Runner 放入当前共享 command session，Runner 等待 Gateway 的子 shell，而子 shell 又等待 Runner 持有的 command lock，会死锁。

### 2.2 目标

1. Code Mode 的 CPU/内存压力只影响所属 Session Sandbox，不阻塞 SaaS 控制面。
2. 同一 Session 的 Sandbox 支持多个有界并行操作；命令输出、超时、取消彼此隔离。
3. 工具权限、模型可见工具集、审计和 Session Message 语义与当前 Tool snapshot 一致。
4. 工具调用不能因为 Runner/Gateway 网络重试而重复产生副作用。
5. SaaS 服务进程不再因 Code Mode 暴露任意出网 `fetch`。

### 2.3 非目标

- 不在本期把任意用户 Shell/仓库代码的安全模型变更为 Code Mode 模型。
- 不允许 Runner 直接访问数据库、模型密钥或服务端本地文件。
- 不把现有 `Tool.Info.execute` 闭包序列化到 Sandbox。
- 不以“取消所有命令”作为单个 Tool Call 的取消实现。

## 3. 目标架构

```text
LLM 生成 execute.code
        |
        v
SaaS CodeModeExecution Service
  - 选择 Tool snapshot，生成可序列化 manifest
  - 创建 execution，设置预算及 owner lease
  - 启动 Session Sandbox 的独立 codemode command context
        |
        v
Session Sandbox / CodeMode Runner
  - 仅有 @opencode/codemode 解释器和 manifest
  - 无服务端密钥；不注册 Node fs/import 等 capability
  - tools.xxx(args) 通过 SaaS 发起的 WebSocket RPC 请求工具
        |
        v
SaaS Tool Gateway
  - 校验连接 owner、snapshot、预算、输入 schema、权限
  - 幂等地经 Tool.Snapshot.execute 调用真实工具
  - 记录 progress / tool 子调用 / 审计 / 结果
        |
        +--> Sandbox tool command context（shell、MCP bridge 等）
        +--> 文件 API（read/write/edit 等）
        +--> MCP / OpenCode 服务工具
```

Runner 的运行目录可为 `/opt/opencode/codemode`，不需要主动挂载或读取 `/workspace`。Session Sandbox 内仍有用户 workspace；Code Mode 解释器继续保持无 import、无文件 API 的语言能力边界。

## 4. Sandbox 并发命令模型

### 4.1 独立 command context

废弃“一 Session 一个持久 command session”的执行语义。每个 `SandboxProvider.run`：

1. 为本次 `operationID` 创建独立 OpenSandbox command session；
2. 在该 context 内流式运行命令；
3. 仅中断/删除本次 context；
4. 在成功、错误、超时、取消的 finalizer 中删除该 context。

`Entry` 不再保存单个 `commandSessionID`，改为：

```ts
type ActiveCommand = {
  readonly operationID: string
  readonly commandSessionID: string
  readonly kind: "tool" | "codemode" | "bridge"
  readonly startedAt: number
  readonly controller: AbortController
}

type Entry = {
  readonly sb: Sandbox
  readonly commands: Map<string, ActiveCommand>
}
```

`RunInput` 增加非空 `operationID` 和 `kind`。普通 Tool 使用 `context.id`；Code Mode Runner 使用 `cme_` execution ID；MCP bridge 使用稳定的 bridge operation ID。

### 4.2 有界并发，不再全串行

增加配置：

```text
OPENCODE_SANDBOX_MAX_CONCURRENT_COMMANDS_PER_SESSION=4
OPENCODE_SANDBOX_MAX_CONCURRENT_COMMANDS_GLOBAL=64
OPENCODE_SANDBOX_MAX_CONCURRENT_CODEMODE_PER_SESSION=1
OPENCODE_CODEMODE_MAX_PARALLEL_TOOL_CALLS=4
```

- Session semaphore 防止一个会话占满控制平面；全局 semaphore 防止大量会话压垮 OpenSandbox。
- Code Mode Runner 每 Session 先限制为 1；其内部工具调用可并行，但共同计入 Session command 配额。
- 超出配额进入可取消队列；队列等待也有 deadline，超时返回明确 `SandboxQueueTimeout`。

### 4.3 取消与故障恢复

- 新接口：`interrupt({ sessionID, operationID })`，只停止该 command context。
- `interruptSession(sessionID)` 仅用于 Session 删除、显式全量取消或 Sandbox 销毁。
- command context 不持久化、不可跨服务进程重用；服务重启后，执行租约失效，Runner/Gateway 都应停止并把 execution 标记为 `interrupted`。
- `retryPolicy: "safe-read"` 只允许对读取类操作创建新 context 并重试一次；非幂等命令绝不自动重放。

### 4.4 资源竞争

并行并不保证工作区写入可串行化：

- read/glob/grep 默认允许并行；
- write/edit/patch 使用按规范化 Sandbox 路径的 mutation lock，或文件 API 的版本/CAS（若 OpenSandbox 支持）；
- Shell 命令可以并行，但对 git、包管理器、同一路径写入等不提供自动一致性承诺；Tool 描述需明确提示模型不要并行执行相互依赖的写操作；
- 未来如要强化，可给 ShellParse 已识别的写资源加资源锁；无法静态识别的 shell 保持用户/模型负责的语义。

### 4.5 数据库迁移

`sandbox.command_session_id` 只适用于旧的共享上下文。本期分两步：

1. 新版本停止读取和写入该字段，保留字段保证可回滚；
2. 稳定发布后执行独立 migration 删除字段，并移除 `Entry.commandSessionID`、`sessionCreates`、`commandLocks` 及相关恢复逻辑。

在实施前必须用真实 OpenSandbox 验证同一 Sandbox 可同时创建多个 command session，且 A 的取消、超时、输出都不会影响 B；不满足时不可灰度此架构。

## 5. CodeModeExecution 与内部协议

### 5.1 持久化状态

新增 `code_mode_executions`：

| 字段                                       | 含义                                                    |
| ------------------------------------------ | ------------------------------------------------------- |
| `id` (`cme_`)                              | 一次 execute Tool Call 的执行 ID                        |
| `session_id`、`message_id`、`tool_call_id` | 绑定会话和原生 Tool Call                                |
| `status`                                   | `queued/running/completed/failed/cancelled/interrupted` |
| `source_hash`、`manifest_hash`             | 防止执行源和快照漂移                                    |
| `limits`                                   | timeout、step、输出、调用次数、并发预算                 |
| `owner_instance_id`、`lease_expires_at`    | 多实例时定位 snapshot executor 所属实例                 |
| `capability_hash`、`deadline_at`           | capability 不存明文                                     |
| `time_created/updated/finished`            | 生命周期与审计                                          |

新增 `code_mode_execution_calls`：唯一键 `(execution_id, ordinal)`，保存 `tool_name`、输入 hash/JSON、状态、受限结果、错误与时间。该表是 Gateway 幂等依据；相同 ordinal 重试返回首次已完成结果，不重新调用工具。

结果中超过单次 Tool 内容上限的附件只保存引用，不能将大 data URI 写入该表。

### 5.2 可序列化 manifest

新增 Schema 层 `CodeModeExecution.Manifest`，内容为本次 snapshot 的不可变、可 JSON 编码投影：

```ts
{
  executionID: "cme_...",
  tools: [{
    path: "github.search",
    description: "...",
    inputSchema: { /* JSON Schema */ },
    outputSchema: { /* JSON Schema */ }
  }],
  limits: { timeoutMs, maxSteps, maxToolCalls, maxParallelToolCalls, maxOutputBytes },
  gatewayURL: "https://internal/..."
}
```

manifest 从当前请求的 `Tool.Snapshot` 生成。Gateway 也将调用名与输入重新对照该 manifest；Runner 的校验是第一道防线，Gateway 的重新校验才是授权边界。

`Tool.snapshot` 的 Code Mode catalog 缓存必须先修正：有 session overlay 时不复用只以工具名为 key 的 catalog，避免跨 Session 同名 MCP 的描述/schema 泄露。

### 5.3 V1 Proxy Endpoint 复用：SaaS 主动 WebSocket RPC

复用已由 `session-proxy` 验证的 endpoint/proxy 与 WebSocket 桥接能力。SaaS 主动连接 Session Sandbox 内 Runner 的内部端口；source、manifest 与工具结果都在该连接上传输，Runner 不持有 bearer capability，也不需要 stdin、argv 或 workspace descriptor。

```text
execute            SaaS -> Runner  { executionID, manifest, code }
tool.call          Runner -> SaaS  { executionID, ordinal, tool, input }
tool.result/error  SaaS -> Runner  { executionID, ordinal, output/error }
execution.result   Runner -> SaaS  { executionID, result }
cancel             双向           { executionID, reason }
```

Runner 端口只能由内部 SaaS 连接，不能挂到浏览器公开 proxy 路径；新内部 Runner connector 复用 `SandboxProvider.endpoint()`、连接超时、Sandbox 不可达诊断和 WebSocket 转发逻辑。

### 5.4 Gateway frame 处理

Gateway 顺序：

1. 校验连接 owner lease、execution deadline、ordinal；
2. 校验调用 path 存在于 manifest、输入符合 snapshot schema；
3. 原子创建或读取 `(execution_id, ordinal)`；已完成则返回缓存结果；运行中则等待或返回可重试状态；
4. 经当前 execution 所属的 `Tool.Snapshot.execute` 执行，继续触发权限、hooks、progress 与既有错误归一化；
5. 校验输出 schema，写入结果及状态，响应受限 `Tool.Result`。

副作用工具在 Gateway 记录为 `running` 后不得被第二个同 ordinal 请求重放。调用方网络断开不代表中断工具；取消必须由 execution 生命周期显式触发。

### 5.5 Runner

Sandbox 镜像预装固定版本的 `@opencode/codemode` 和最小 Node/Bun Runner。Runner：

- 从 manifest 构建工具 tree；每个工具执行器在同一 WebSocket 上请求 Gateway；
- 禁止 Node import、fs、child_process、环境读取；
- 不注册现有服务端 `CodeModeWeb.extension`；
- 将 stdout 作为结构化最终结果，stdout 以外日志使用独立 JSONL channel；
- 对协议、manifest、Gateway 返回值严格 schema 解码；
- 接到 SIGTERM/SIGINT 时通知 Gateway execution cancellation 并退出。

Runner 命令不得拼接 source 或 manifest；使用固定入口启动常驻 daemon。source 与 manifest 仅经 SaaS 发起的 WebSocket frame 传输，且受服务端长度上限约束。

## 6. Code Mode 运行时限制

在 `@opencode/codemode` 增加 `maxSteps`，每个 AST statement/expression 和每次循环迭代消耗预算，超出产生稳定诊断 `StepLimitExceeded`。单纯 `Effect.timeout` 是协作式的，不能作为紧密同步循环的唯一防线。

SaaS **不设默认限额**，与 V2 线一致；限额是部署侧可选策略，由环境变量显式开启：

```text
OPENCODE_CODEMODE_TIMEOUT_MS
OPENCODE_CODEMODE_MAX_STEPS
OPENCODE_CODEMODE_MAX_TOOL_CALLS
OPENCODE_CODEMODE_MAX_OUTPUT_BYTES
```

显式设置但不是正整数会在启动时报配置错误，不会静默取消预算。生产部署建议显式设置 `timeoutMs` 与 `maxSteps`：默认不限额时 `while (true) {}` 无法被协作式 timeout 抢占。`maxParallelToolCalls` 仍未实现。

同时保留 `@opencode/codemode` 已有值边界；不能以其 10,000 pending promises、10,000,000 array 项等上限替代 SaaS 配额。

`fetch` 不再通过服务端 `globalThis.fetch` 暴露。Sandbox executor 默认通过 Runner 所在 Sandbox 进程的原生 `fetch` 直接发请求；`network=disabled` 时不注入该全局函数。未来的网络治理可在 Sandbox 网络出口增加私网/metadata 拒绝、方法/header/重定向/响应大小限制与审计；不得将请求回退到 SaaS 进程。

## 7. Core 改造点

| 位置                                    | 改造                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/codemode`                     | `maxSteps`、稳定诊断、Runner 可复用 manifest adapter；同步更新 `interpreter-support.md` 与直接测试 |
| `packages/schema`                       | `CodeModeExecution`、Manifest、Limits、状态和内部调用 contract                                     |
| `packages/core/src/codemode/tool.ts`    | 由直接 `runtime.execute` 改为 `CodeModeExecution.run`；保留 server executor 作为 feature-flag 回退 |
| `packages/core/src/tool.ts`             | overlay catalog 不缓存或使用完整 manifest hash；快照生成可序列化 manifest                          |
| `packages/core/src/sandbox/provider.ts` | 每 operation 独立 command context、Session/全局 limiter、定向 interrupt、活动 context 清理         |
| `packages/core/src/sandbox/config.ts`   | 并发、Code Mode budget、executor mode 配置                                                         |
| `packages/core/src/session/context.ts`  | 注册 CodeModeExecution service，并使 execution 捕获当前 Session snapshot                           |
| `packages/server`                       | 仅内部路由挂载 Gateway；不得把 capability 或 Gateway 暴露进公开 SDK/OpenAPI                        |
| Sandbox image                           | 固定 `codemode-runner`，最小依赖、非 root、资源限制、仅允许访问内部 Gateway 的网络策略             |

SaaS 下 `opencode.session_move` 不应进入 Code Mode manifest：会话工作目录固定为 `/workspace`，worktree/任意本地目录迁移不具备产品语义。

## 8. 多实例与路由

`Tool.Snapshot` 内有进程内 executor 闭包，不能直接跨实例传递。第一期部署条件为：执行创建和 Gateway 请求必须粘滞到同一 SaaS 实例；execution 表中的 owner lease 用于拒绝误路由。

多实例正式支持有两个可选方案：

1. 内部 Gateway 根据 owner instance 的私网地址转发请求；
2. Gateway 在任意实例基于持久化 manifest 重新构建、验证并获得等价 snapshot（需要明确 MCP runtime、插件和 Location 状态的一致性策略）。

在未实现之一以前，不能宣称 Code Mode execution 支持无粘滞的多副本部署。

## 9. 分阶段实施与发布

### Phase 0：基础正确性与保护

1. 修复 Session overlay catalog 缓存。
2. SaaS 禁用服务端 Code Mode fetch。
3. 加 `timeout/maxToolCalls/maxOutputBytes/maxSteps`；加入服务进程全局 Code Mode 并发池作为迁移期保护。
4. SaaS 移除 Code Mode 中的 `session_move`。

### Phase 1：Sandbox 并发 command context

1. 用 OpenSandbox E2E 验证同 Sandbox 并行 session 的行为。
2. 引入 operationID、ActiveCommand、定向取消、Session/全局 limiter。
3. 所有当前 Sandbox 调用方改为传递 operationID。
4. 保持 Code Mode 仍在服务端，验证 Shell/读写/MCP bridge 的并发与回归。

### Phase 2：Runner 与 Gateway

1. 新增 Schema、migration、Execution Service、内部 Gateway。
2. 构建 Runner 镜像并实现 manifest/RPC 协议。
3. `OPENCODE_CODEMODE_EXECUTOR=server|sandbox`，默认 `server`；灰度 Session 使用 `sandbox`。
4. 仅完成全部 E2E 后，将 SaaS 默认切换到 `sandbox`；保留 `server` 紧急回退窗口。

### Phase 3：收尾与强化

1. 清理 `command_session_id` 旧字段和共享上下文逻辑。
2. 加入 Sandbox Fetch（若产品确实需要）。
3. 处理无粘滞多实例路由。
4. 评估将 Session Tools 的服务端动态执行迁移到 Sandbox；其风险独立于 Code Mode，但同属 SaaS 执行面治理。

## 10. 验收测试

所有测试必须走 Docker + HTTP API + OpenSandbox + PostgreSQL，禁止 `docker exec` 绕过产品路径。

### 并发 Sandbox

1. 同 Session 两个 `sleep`/`echo` 并行，墙钟时间接近最长单任务而非总和，stdout 不串线。
2. 取消 A，B 正常完成；PG/Session Message 仅 A 标记 cancelled。
3. 超时 A 后再执行 B，B 使用新 command context 且可成功。
4. 并发超过 Session、全局配额时排队；取消排队任务不创建 command context。
5. destroy Session 时全部 active contexts 被回收，PG 无 running execution。

### Code Mode Runner/Gateway

1. `execute` 在 Sandbox Runner 成功调用 `tools.*`，其 tool progress、最终 output 与服务端 executor 兼容。
2. Runner 调用 shell，Shell 使用不同 command context；证明无死锁。
3. `Promise.all` 多工具调用受 `maxParallelToolCalls` 限制（该限额尚未实现，当前无并发上限）。
4. 显式设置 `OPENCODE_CODEMODE_MAX_STEPS` 后，`while (true) {}` 返回 `StepLimitExceeded`，不会占住 SaaS 服务进程；未设置时该用例不成立。
5. 输入不合法、未知工具、超调用数、超输出均返回稳定诊断（同样需要显式设置对应限额变量）。
6. Gateway 同 `(executionID, ordinal)` 重试仅执行一次 edit/shell fixture。
7. capability 过期、跨 Session、错误 manifest hash、越权工具名均拒绝。
8. 同名 Session MCP 在两个 Session 具有不同 schema/description 时，catalog 和 Gateway 均使用各自 manifest。
9. Runner 不能触发 SaaS 服务进程网络 fetch；若 sandbox.fetch 已开启，验证网络限制与审计。
10. 服务实例重启、Sandbox 被回收、Gateway 连接中断时，execution 状态与 PG 记录符合预期，不产生重复副作用。

## 11. 发布门槛

以下任一未满足，不切换 SaaS 默认 executor：

- OpenSandbox 并发 command session 的隔离 E2E 未通过；
- Code Mode -> Gateway -> Sandbox tool 无死锁证明；
- capability、schema、幂等、取消和 PG 生命周期用例未通过；
- overlay catalog 跨 Session 隔离用例未通过；
- Sandbox Runner 无服务端密钥、无服务端 fetch 的镜像审计未完成。

## 12. 对既有功能的影响与兼容策略

这不是透明的基础设施重构；以下行为会发生变化，必须在 Phase 1 前建立基线并逐项验收。

| 既有能力                            | 影响                                                                                                                                | 兼容策略 / 验收                                                                                                                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell command                       | 旧实现复用持久 bash command session；独立 context 后，跨 Tool Call 的 shell cwd、`export` 变量、alias、函数和前台进程状态不再可依赖 | Tool 契约以每次 `workdir` 和完整 command 为准；为真实依赖持久 shell state 的客户端保留临时 `stateful` legacy mode，默认不扩大该模式；用现有 shell、session shell、commands 用例验证 |
| Shell 性能                          | 每个命令需 create/delete command session，短命令延迟和 OpenSandbox API 调用数增加                                                   | 先压测并行收益与创建开销；可实现受限 context pool，但不得重新引入跨 operation 的共享 stdout/取消语义                                                                                |
| Shell/文件写一致性                  | 并行后两个写操作可发生竞态；过去命令串行化偶然降低了该概率                                                                          | read 默认并行；精确文件 mutation 采用路径锁/CAS；Shell 写竞争明确为非事务性，加入 git/npm/同文件冲突 E2E                                                                            |
| Session MCP local bridge            | bridge 通过 `nohup supergateway ... &` 在 Sandbox 启动；删除创建它的 command context 后，后台进程是否存活取决于 OpenSandbox 实现    | 必须验证 bridge start/stop/reconnect、Sandbox 重建和多 MCP 并行；若 context 关闭会杀死子进程，则桥接改为 OpenSandbox detached process/专用 bridge context，不能依赖 nohup           |
| `SandboxProvider.interrupt`         | 当前接口按 Session 仅能中断唯一 command context；改造后需同时存在定向取消和 Session 全量取消                                        | 新增 `interrupt({sessionID, operationID})`；Session 用户取消、watchdog、删除使用 `interruptSession`；逐个更新调用方并测试不会误杀无关命令                                           |
| Sandbox 生命周期                    | 旧 PG `command_session_id` 支持服务重启后的共享 context 复用；新独立 context 不应复用                                               | 服务重启把未终结 CodeModeExecution 标为 interrupted，由正常 Session 重试机制重新推进；不自动重放副作用命令                                                                          |
| Code Mode `fetch`                   | Sandbox executor 由 Runner 进程直接发起网络请求；显式 server executor 保留服务端网络兼容路径                                      | 默认 Sandbox 路径不得回退到 SaaS；`network=disabled` 返回明确的未知 `fetch` 诊断。Sandbox 出口策略是网络隔离边界，后续应增加私网/metadata 拒绝与审计。                         |
| Code Mode `session_move`            | SaaS Session 固定 `/workspace`，旧工具/worktree 语义无效                                                                            | SaaS manifest 不暴露它；HTTP API 是否保留由 Session 产品语义单独决定，不能由 Code Mode 隐藏替代                                                                                     |
| Session MCP / Session Tools overlay | catalog 缓存修复会改变模型可见的 description/schema，但这是修正跨 Session 同名工具的错误                                            | 同名 MCP/Tool 的两会话隔离 E2E 必须通过；真实执行器仍遵循本次 snapshot                                                                                                              |
| 资源与吞吐                          | 会话内可并行，但会提高同 Sandbox CPU/内存、OpenSandbox context 数与 MCP 连接压力                                                    | 先配额、队列、timeout、指标，再灰度；监控排队时长、active contexts、OOM、Gateway 幂等命中和取消耗时                                                                                 |

### 12.1 迁移原则

1. **先增后切**：先加入独立 context API 和 feature flag，不立即删除共享 session 实现或 PG 字段。
2. **调用方显式选择**：先让 Code Mode Runner 使用 `isolated` context；普通 Shell 在性能、状态和 MCP bridge E2E 完成前保持可控灰度。
3. **不隐式保留状态**：若保留 legacy `stateful` mode，必须是显式、受限、不可被 Code Mode 子工具占用的独立通道；不能用它解决并发死锁。
4. **双路径对比**：在 `server` / `sandbox` Code Mode executor 灰度期间，对同一固定 fixture 比较 tool call 顺序、结果、Session Message、PG execution state 与取消行为。
5. **可回退**：`OPENCODE_CODEMODE_EXECUTOR=server|sandbox` 保留到 Sandbox executor 连续稳定后；回退不改变已经开始的 execution，只影响新请求。
