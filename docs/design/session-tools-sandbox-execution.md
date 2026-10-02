# Session Tools 的 Sandbox 执行方案

日期：2026-09-30。状态：实施中；按用户反馈调整为 SaaS 构建、运行时物化部署，不要求重建 Sandbox 镜像。完成验收前不视为已交付。

## 1. 目标与决策

将 session tool 用户源码的模块加载、顶层初始化、参数 schema 提取和 execute 执行全部迁入该会话对应的 OpenSandbox。SaaS 保留定义 CRUD、模型工具目录、请求快照、权限编排、事件投影及结果处理。

采用“Sandbox 常驻监督宿主 + 每 logical session/源码版本一个受管理 worker 子进程”。发现与执行复用同一个模块实例，用户源码不进入监督宿主或 SaaS，不在 CodeMode 的受限解释器中直接运行工具源码。

保留当前 `/api/session/:sessionID/tools` API 和 `session_tools` 存储结构。继续通过既有 `Tool.Info`、`Tool.Snapshot.execute` 与 Session runner 执行，不引入另一套工具注册表或事件结算机制。

SaaS Sandbox 未启用或不可用时明确失败，不回退到服务端执行。该决策面向此仓库的 SaaS 部署；非 SaaS 本地产品的支持应独立决策。

## 2. 当前实现证据

| 路径 | 当前行为 | 代码依据 |
|---|---|---|
| Session tools | PG code 写服务端临时 .ts 文件、动态 import、直接调用 def.execute | `packages/core/src/session/tools.ts:79-105,201-228,299-313` |
| Session context | tools.load 后作为请求级覆盖加入工具快照 | `packages/core/src/session/context.ts:132-155` |
| Session skills | PG 资源写入 Sandbox，加载时返回资源目录 | `packages/core/src/session/skills.ts:121-141`、`tool/plugin/skill.ts:66-81` |
| Skill 脚本 | skill 本身只加载说明；后续由模型通过 shell 等执行 | `tool/plugin/skill.ts`、`tool/plugin/shell.ts` |
| Session local MCP | Sandbox 启动 supergateway/stdio 服务，SaaS 通过 endpoint 调用 | `packages/core/src/session/mcps.ts:55-65,129-181,315-320` |
| Location local MCP | Environment.spawner 启动；运行位置由 Environment 决定 | `packages/core/src/mcp/stdio.ts:74-99` |
| CodeMode | 有 Sandbox daemon 启动、endpoint 与通信实现 | `packages/core/src/codemode/runner.ts` |

全局 skill 当前仍经 Skill.prepare 提供其原目录，不能据此断言所有 skill 资源均已物化到 Sandbox。此方案仅处理 session tools。

## 3. 组件及边界

### 3.1 SaaS：SessionTools

- CRUD 保持现状，PG 为唯一持久化定义源。
- `load(session)` 读取定义，计算版本 hash，请求 Sandbox 获取 manifest。
- manifest 转换为标准 Tool.Info；执行器捕获该版本的源码快照与 manifest。
- 执行器调用 SessionToolSandbox，不在 SaaS import 或 eval 用户源码。
- 保留 `codemode: false`，保证模型使用原生 session tool 的现有调用方式。CodeMode 开启时也使用同一工具执行边界，不改变执行位置。
- 同名覆盖、删除后下一请求回退内置工具、跨 session 不继承均沿用请求 overlay 行为。

### 3.2 SaaS：SessionToolSandbox

新增 Location-scoped 服务，依赖 SandboxProvider。集中负责源码物化、宿主准备、manifest 获取、执行 RPC、取消和释放。

它是 session tool 的执行后端，不存另一套 canonical Tool.Info，也不负责模型工具查找。内部 RPC DTO 放在 Core 的域内协议模块；只有新增公开 API 时才扩展 schema/protocol 包。

### 3.3 Sandbox：Session Tool Host

SaaS 构建时生成独立宿主入口、执行 worker、兼容 tool helper 与 TS 编译器的自包含运行文件；运行时经 SandboxProvider 物化到 Sandbox 的内容寻址目录。沿用 session skills 的资源恢复机制和 local MCP 的启动/端点机制，不要求 Sandbox 镜像预置这些运行文件。宿主只负责协议、排队、子进程管理和结果转发，不在宿主自身 import 用户模块。

每个 logical session/源码版本使用独立 OS worker 子进程，模块只初始化一次。不同工具 worker 并行；同 worker 支持多个异步调用以保持现有并发能力。一个调用超过 deadline 时终止整个 worker，所有同 worker 的在途调用都返回明确失败，均不自动重放。Worker threads 不作为首选，因为工具可以创建子进程。

终止保证覆盖受管理进程组内的进程，不承诺清理用户自行 setsid/detach 的后代；需要完整后代隔离时必须先验证部署支持的 cgroup/job 执行单元。正常完成的调用也无法仅靠进程组区分其所有后代，这一限制须在执行能力文档声明。

启动方式参考现有 CodeModeRunner 的幂等 launcher 和 endpoint 解析，使用独立 PID/log/port。端口在实现时检查镜像和已有服务避免冲突，不以固定候选端口作为已验证事实。Sandbox 内文件锁负责多服务实例的启动互斥；endpoint 可解析后还须 health 探测通过，校验协议、worker runtime、编译器版本和宿主 epoch，不能以启动命令成功代替 readiness。

## 4. 工具源码物化与依赖

目录建议：`/workspace/.opencode/.session-tools/<sessionID>/<versionHash>/`。

- 文件包含 source.ts、manifest 缓存标记；源码通过 SandboxProvider.fileWrite 写入临时路径后原子 rename。
- versionHash 覆盖源码内容、协议版本、适配器版本；模型请求的 name/description 仍来自该行和 manifest 合成。
- 不将工具源码写入宿主服务容器，不允许宿主返回的任意路径作为上传目标。
- 当前 session.location.directory 在 SaaS 流程下统一为 /workspace；worker 的 cwd 与 context.directory 为 /workspace。
- 相对 import 基准为工具源码所在目录；仓库代码可使用 /workspace 绝对路径，裸包通过 /workspace/node_modules 解析。需要明确记录这与旧服务端临时文件目录解析的差异。
- 不自动安装用户依赖。缺依赖返回模块加载错误，由会话正常开发流程安装到 Sandbox。
- TypeScript 转换器随 SaaS 构建产物打包并物化，将 .ts 转为 ESM；不要假定 Node 原生类型剥离支持全部 Bun/TypeScript 语法。
- 工具 helper 通过实际模块映射/转换适配，支持现有两个 tool import 名。避免延续只处理单一 import 写法的正则替换。
- 沙箱重建后按捕获的源码重新物化、重新发现；已确认尚未派发的操作允许重新准备。主源码由 Host 读取后验证 hash，拒绝符号链接逃逸和未完成的物化目录；原子发布以完成标记为准。
- 快照固定主源码和 manifest，不承诺固定 /workspace 仓库依赖。活 worker 复用已加载模块；worker 重建时依赖可能改变，必须重新发现并比较 manifest 指纹。不一致时旧快照明确失败，不以新 schema 替代旧 schema。

## 5. Manifest 发现与 schema

发现阶段同样执行用户模块顶层代码，因此必须运行在 Sandbox 的限时子进程里。

流程：监督宿主创建版本 worker → worker 读取/转换源码 → import → 检查 default export → 提取参数与返回值契约 → 转为 JSON manifest → worker 保留模块与 codec，等待执行。发现超时或非法定义时终止 worker。

manifest 字段：protocolVersion、versionHash、manifestHash、description、inputSchema、outputSchema（可选）、resultMode。只传可序列化 JSON，不传 execute 函数、Effect 服务或 codec 实例。

兼容策略：

1. V1 `tool({description,args,execute})`：保持兼容；string/number/boolean 等已有语义必须回归。复杂 args 的支持范围由 helper 的实际测试矩阵定义，不能声明完整 Zod 兼容而只实现基本类型。
2. plain definition + JSON Schema：完整支持，服务端按 manifest 校验输入和输出。
3. 当前允许的 Effect/Standard Schema 对象：镜像打包与当前工程锁文件一致的必要 runtime/转换适配器，在 worker 保留原 codec。SaaS 使用其 wire JSON Schema 验证 transport input；worker 对 wire input 按原 codec 解码一次，execute 收到内部类型；结果按原 output codec 编码一次，SaaS 仅校验编码后的 wire output。异步 Standard Schema 必须 await。不存在输出 schema 时先走原 toResult 的文本模式转换。
4. 必须以当前 runtime 的输入/输出契约测试确定转换方向。无法得到 wire JSON Schema或缺依赖时返回 unsupported-schema，不降级为 Unknown。无法保留的类型必须在实施验收前逐项列为兼容限制，不能静默取消当前能力。

坏源码、非法导出和不支持 schema 不进入工具目录；记录带 sessionID/name/hash 的诊断。一个坏工具不阻断其他工具。Sandbox 整体不可达则返回基础设施错误，不伪装为“无工具”。

Manifest 缓存按 sessionID、Sandbox 身份/代际、Host epoch、versionHash 索引，不跨 session 共享用户模块实例。只缓存数据，不缓存服务端用户执行函数。Host 丢失 worker 时重新发现，验证 manifestHash；不能只相信客户端传入的路径/hash。

## 6. 执行协议

推荐在 Sandbox Host 提供 versioned 内部 HTTP API，通过 SandboxProvider.endpoint 的 server gateway 访问。准备 RPC 完成工具目录加载，执行 RPC 使用 NDJSON 流返回结果与生命周期帧。

| 操作 | 关键输入 | 关键输出 |
|---|---|---|
| health | protocolVersion | 协议、宿主能力、Sandbox runtime 信息 |
| discover | requestID、sessionID、versionHash、受控源码路径、预算 | manifest 或 typed error |
| execute | executionID、sessionID、versionHash、manifestHash、generation、ownerID、args、可序列化 context、预算 | accepted、日志/进度、唯一 result/error terminal |
| cancel | executionID | 已取消、已完成或不存在；幂等 |
| status | executionID | queued/running/terminal，用于响应丢失后的同宿主查询 |
| release | sessionID、generation、scope | 关闭准入并清理该 session 或整个 Sandbox 的任务 |

执行帧 ordinal 单调递增；服务端拒绝重复终态和错 executionID 帧。日志、IPC 与协议输出分离：用户 console/stdout 不可破坏 RPC framing。

Context 首期提供 sessionID、messageID、工具调用 id、agent 标识、directory=/workspace、可用的纯数据元信息和 worker 本地 AbortSignal。其它宿主对象不透传。公开文档必须逐字段声明，而不是展开整个 Tool.Context。

当前 V2 尚无 V1 ask 桥接，首期仍不支持 ask。progress 已是当前 Tool.Context 能力，首期必须保留：worker context.progress(update) 返回 Effect，执行时经 IPC/NDJSON 发 progress 帧，SaaS 调用本次 invocation 的 canonical context.progress，ack 后 Effect 完成；失败/取消传播给 worker。effect runtime 由镜像提供，不能将该字段无声改成 Promise。进度帧只允许修改该 execution 的 metadata，不透传任意服务端函数。

worker 本地 AbortSignal 是新增能力，不替代已有 Context；Agent、Session 和调用 ID 均只传可序列化标识。

## 7. 版本快照与执行一致性

每次模型请求捕获 code、versionHash、manifest、name 和执行器。upsert 后新的请求使用新 hash，已发给模型的旧请求继续执行旧 hash；禁止 execute 时再按 name 读取最新 code。

delete 不撤销已捕获快照，但新请求不再包含该工具，与 Tool.Snapshot 既有语义一致。删除整个 session 或 kill-sandbox 则必须取消该 session 的任务。

discover 与 execute 共用版本 worker 的模块，模块状态在其存续期间跨调用保留。新版本新 worker，旧版本 worker 继续服务旧快照。取消/超时导致 worker 重启、Sandbox 重建时状态会丢失，不将其作为持久状态保证。

与旧实现按 code 共用模块不同，新实现明确不跨 logical session 共享模块状态，这是会话隔离所需的有意改变。worker key 固定为 `(sandboxID, hostEpoch, logicalSessionID, versionHash)`，不包含工具名；同一 session 内同源码的多个工具复用一个模块。Context 中调用 id 与工具名属于每次 invocation，不能存在共享的可变全局 context。

默认值建议：版本 worker 空闲 30 分钟回收、Sandbox 最多 16 个 worker。快照租约固定源码/manifest 数据，不固定物理 worker；有在途 discover/execute 的 worker 不回收，空闲 worker 可按 LRU 淘汰。批量发现有界并发 4，允许超过 16 个工具逐批建立 manifest；execution 按需恢复 worker并验证 manifestHash。全部 worker 都忙时排队，受总 deadline 和队列容量约束，不无限等待。worker 淘汰可导致模块状态重新初始化，该状态仅在 worker 存续期间保留，不能承诺整个 session 恒久保留。

服务端每个模型请求获取 snapshot lease，在请求结束后释放；多实例 lease 分 ownerID 管理。旧快照 worker 失效后允许重新初始化但需校验 manifest，已派发调用不重放。

## 8. 结果与权限

- worker 返回 JSON 可序列化结果。string、V1 `{title,output,metadata}` 保持既有 toResult 语义；声明 schema 的结构化 output 按原契约编码。
- 先在 worker 按当前 toResult/resultMode 规范化返回值，再检查 wire result 可序列化性。非结构化模式继续保留 String(undefined)/String(BigInt) 等既有文本转换；结构化模式无法编码的循环引用/BigInt/函数明确失败。不得在 SaaS 对已编码 output 再执行转换 codec。附件/媒体不增加超出现有 adapter 的承诺。
- 保留 metadata.title 及模型 content 的映射；通用 output bounding 仍由 Session runner 负责，避免双重截断。传输预算是独立硬上限，超限明确失败。
- 目录可见性继续由 canonical registry 过滤。本次迁移保持现有 session tool 不额外发起 Permission.assert 的语义，不新增工具初始化或执行的交互等待。注册 session tool 意味着允许其在该 Sandbox 初始化；与当前 load 先于 snapshot 过滤一样，隐藏工具可能仍执行顶层初始化，必须明确记录。
- discover 没有 tool call identity，不伪造 messageID/callID。若后续增加用户代码执行权限，作为独立功能定义 action/resource/source 和初始化策略，拒绝/反馈继续经既有 model-request 边界传播。本次不顺带实现。
- session tool 可直接操作 Sandbox 文件，不意味着其内部 fs 会自动逐文件走 OpenCode 的 read/edit 权限。应明确该能力等价用户代码执行权限，不能宣传为逐路径授权沙箱。
- 只传显式会话环境/配置，不复制服务端 PG、provider 或 process.env。用户代码仍能访问其 Sandbox 本身具有的环境和网络。

## 9. 超时、取消、并发及故障

首期设计默认值：discover 10s、execute 60s、终止宽限 2s、每 Sandbox 并行任务 4、队列 32；请求体上限 1 MiB、manifest 512 KiB、result 8 MiB、单调用日志 1 MiB、终态缓存 5 分钟且全 Host 最多 64 MiB（LRU）。达到日志预算后丢弃后续日志并明确 truncated，不能堵塞用户进程。结果超过硬上限明确失败。配置只能由 SaaS 设置且 Host 校验硬上限；这些是待压测的设计值，不是当前实现数据。

- 排队等待也计入总执行预算；上下限由 SaaS 配置控制。
- 中断流程：服务端 abort → cancel RPC → Host SIGTERM 整个进程组 → 宽限后 SIGKILL → 清理 IPC/任务记录。
- HTTP 断开不能单独代表取消成功；服务端确认取消结果。网络断开时 Host 自有 deadline 仍终止 worker。
- Watchdog/user abort/shutdown 都由原 execution/runner 结算 tool part，Host 不向 PG 发布 session.tool.failed，避免两套终态写入者。
- 已接受的 execute 禁止自动重放：可能已写文件或调用外部 API。响应丢失时只查询原 executionID 状态，查询失败返回结果未知错误。
- 相同 executionID 在同 Host 只执行一次；宿主重启后不能声称持久 exactly-once。任务结果做有界 TTL 缓存，丢失后仍不自动重放。
- 幂等身份记录与结果缓存分开；结果被淘汰后仍禁止同 executionID 重执行，保留 tombstone 至所属 admission generation 关闭。tombstone 达到有界容量时拒绝新准入，不通过淘汰活 generation 内标记破坏去重保证。
- 独立子进程支持并发，不使用 Sandbox command channel 的长占用 semaphore 执行用户代码；launcher/物化的锁局限于准备过程。

### 9.1 准入与取消状态机

- Host epoch 标识宿主实例；logical session admission generation 标识一次执行准入生命周期，ownerID 标识 SaaS 服务实例。generation 只由服务端 prepare 获取，不由用户源码生成。
- execute 原子执行：校验 epoch/generation/manifest → 检查取消 tombstone → 注册 executionID → 返回 accepted → 排队/启动。重复 ID 只读状态，不重复运行。
- cancel 即使先于 execute 到达也登记 executionID tombstone；迟到 execute 返回 cancelled。cancel 作用于对应 epoch/generation；旧 epoch 请求不进入新 Host。
- session release 先原子关闭准入，再清队列、取消任务和版本 worker。只有服务端确认 session 仍存在且允许继续执行才能 prepare 新 generation；session 删除不允许重新开放。
- kill-sandbox 使用物理 Sandbox 级关闭，阻止全部关联 session 准入。prepare 和销毁必须复用 Sandbox 生命周期锁/状态检查，避免释放后再次启动。不可依赖单个 SaaS 实例的本地锁解决跨实例竞态。
- interrupt 的有界 cancel/确认在 Effect uninterruptible cleanup 内执行；失败不妨碍既有 runner 结算，Host deadline 继续兜底。一个调用超时杀 worker 时，其他在途调用以 worker-terminated 明确失败。

### 9.2 活跃信号与多实例 ownership

所有 discover/execute/snapshot lease 在 Host 有 owner lease；SaaS 每 5s 续约，Host 15s 未获续约关闭该 owner 的新准入并取消其任务，续约故障返回基础设施错误。通过 provider 的 scoped heartbeat 在调用期间刷新 root Sandbox 活跃信号，不把全局 keepalive 永久设为 true；调用完成/取消后释放。

服务端 shutdown 仅释放自己的 owner 任务与 snapshot lease，不能全 session release 杀掉另一实例任务。session 删除和 kill-sandbox 是显式全局 release。请求准备期间启动失败、协议不符、镜像不含宿主、网关不可达分别返回可诊断错误；自定义 Sandbox 镜像也必须满足能力探测，不 silent fallback。

### 9.3 完整内部 RPC 契约

首期固定 HTTP 路径 `/internal/session-tools/v1/<operation>`，均为 POST JSON，health 为 GET。execute 响应为 NDJSON，其余为 JSON。协议 DTO 由 Core 域内模块与镜像构建共同使用，不新增对外 API。

- health 返回 `{protocolVersion, sandboxID, hostEpoch, capabilities}`，不启动 worker。
- prepare 输入 `{sandboxID, ownerID, logicalSessionID, lifecycleEpoch}`；服务端先完成第 9.4 节 PG 准入检查，Host 返回 `{hostEpoch, generation, ownerLeaseID}`。相同有效 owner/session/epoch 幂等，不开放已关闭 epoch。
- renew 输入 `{sandboxID, hostEpoch, ownerID, ownerLeaseID, lifecycleEpoch}`；只续约已有开放准入，不能借 renew 建立新 generation。
- discover 输入公共 envelope 加 `{requestID, versionHash, sourcePath, deadlineMs}`；返回 manifest。worker 绑定源码 hash，不能接受任意宿主路径。
- snapshot-acquire 输入 envelope 加 `{snapshotID, manifests:[{versionHash,manifestHash}]}`；固定 manifest 数据及版本引用，不 pin worker。
- snapshot-release 输入 envelope 加 `{snapshotID}`；幂等释放该 owner 的引用。
- execute 输入 envelope 加 `{executionID,snapshotID,versionHash,manifestHash,args,context,deadlineMs}`；输出帧为 accepted/progress/log/result/error，每帧带 executionID、ordinal，terminal 只有一个。
- progress-ack 输入 envelope 加 `{executionID,progressID,outcome:"ok"|"error",message?}`；独立 HTTP 请求回传 ack，progress 的 Effect 等待对应 ack。默认 ack 预算 5s，取消/owner 失联使待 ack 失败；帧重复不得重复调用 SaaS progress。
- cancel/status 输入 envelope 加 `{executionID}`；status 返回 queued/running/completed/failed/cancelled/unknown。cancel 返回 tombstoned/cancelling/terminal，确认清理使用 status 有界查询。
- owner-release 输入 `{sandboxID,hostEpoch,ownerID,ownerLeaseID}`；只清理该 owner，不关闭其他 owner 的 session 准入。
- release 输入 `{sandboxID,hostEpoch,logicalSessionID?,lifecycleEpoch,scope:"session"|"sandbox"}`；由具有控制权限的 SaaS 调用，关闭指定 epoch，不能用其重新开放准入。

公共 envelope 固定为 `{protocolVersion:1,sandboxID,hostEpoch,ownerID,ownerLeaseID,logicalSessionID,generation,lifecycleEpoch}`。prepare/renew/release 等例外字段按上面各操作定义，不把缺字段默认为当前 epoch。所有预算为持续时间，Host 接受时转换成本地单调 deadline；不依赖跨机器 wall-clock 相等。

错误统一 `{code,message,retryable,executionID?}`。首期 code 固定为 protocol-mismatch、not-ready、admission-closed、stale-epoch、owner-expired、source-invalid、unsupported-schema、manifest-mismatch、resource-busy、deadline-exceeded、cancelled、worker-terminated、serialization-failed、result-too-large、result-unknown。正常用户代码异常转换为 tool-execution-failed。retryable 仅指准备/查询可重试，不授权 execute 重放。

通信复用经过鉴权的 Sandbox server gateway，不额外公开宿主端口为用户 API。ownerID 仅为身份标签不是授权凭据，release/prepare 的调用权限必须由网关服务身份建立；不能以请求体中的 sessionID 当作鉴权。

### 9.4 PG 生命周期准入屏障

当前 provider 的进程内同步不足以保证跨实例顺序。本次明确新增内部 PG 生命周期状态，而不是假定存在可复用跨实例锁：

- 新增 `sandbox_execution_gate`：root sessionID 为主键，epoch、state(open/closing/closed)、sandboxID、time_updated。
- 新增 `session_execution_gate`：logical sessionID 为主键，rootSessionID、epoch、state、time_updated。记录 session 是否仍允许执行，删除后保留有限期 tombstone；外键策略不得使 tombstone 在删除时立即消失。
- 准入事务按固定顺序锁 root gate 再锁 logical gate（PG SELECT FOR UPDATE），检查 session_v2 存在、两 gate 为 open、sandboxID 匹配；完成 Host prepare/请求派发后释放锁。网络操作严格设准备预算，不在长 execute 响应读取期间持有事务。派发仅等待 Host accepted，随后的结果流在事务外消费。
- session delete：同序取得 gate 行锁，将 logical gate 改为 closing 并 epoch+1，事务提交后 release 旧 generation，执行既有 session 删除；最终标为 closed。此后旧准入事务无法通过存在性与 gate 检查。
- kill-sandbox：root gate 改为 closing 并 epoch+1，提交后 release 旧 Host 并 destroy。成功后 root gate 置 closed；下一次合法 boot 在同 root 锁下建立新 sandboxID，epoch 再递增、置 open。不能从旧 prepare 复活被销毁实例。
- 初始 gate 行用 INSERT ON CONFLICT DO NOTHING 建立再加行锁；并发 boot/destroy 必须通过同一入口协调，所有显式/idle destroy 路径纳入，不能只修改 HTTP handler。
- closing 操作若进程崩溃，由下次操作读取 PG 状态继续幂等完成 release/destroy；不得自动把 closing 改回 open。session 删除失败保留 closing 并提供诊断/可重试清理。

Host admission 是 PG gate 的执行侧镜像：PG 屏障阻止新派发，Host epoch/generation+tombstone 阻止已派发但迟到的任务。明确要求所有 prepare/execute 派发和 delete/kill 共用该协议，单靠发 release 不构成屏障。

该补充改变了原“不改 PG schema”的假设；需要 migration 和真实 PG 并发测试。事务网络往返预算、连接池占用必须压测，超预算回滚后不重发无法确认 accepted 的 execute。

### 9.5 Effect scope、heartbeat 和 snapshot lease 接入

- 在 SandboxProvider 新增内部 `activity(sessionID): Effect<void, Error, Scope>`：只在现有运行实例上每 5s touch root Sandbox，返回 scoped finalizer；不 boot、不永久 keepalive、不自动改变 PG gate。暴露部署所需接口并为 disabled layer 明确 no-op/失败语义，由工具后端在进入前检查 enabled。
- SessionToolSandbox 为 discover/execute 获取 activity scope，正常结束、typed failure、defect、中断均关闭。结果流消费期间保持 scope，RPC 发起完成不等于释放。
- SessionContext.select 获取 manifests 不获取长期 model-request lease；ModelRequest.prepare 在该次 provider request 专用 scope 中 snapshot-acquire，获取失败时不发送模型请求。
- Session runner 的 step/请求消费边界建立 Effect.scoped，将模型响应消费、该响应触发的全部工具执行及 settlement 放在其作用域内；scope finalizer 释放 snapshot lease。Prepared 不添加手动 dispose，防止出现忘记调用的第二套生命周期。
- 同一请求的 provider retry 使用同 scope/快照；重新 prepare 的新请求使用新 snapshotID。title/compaction 等不使用 session tool 时不申请租约。
- owner renew 在 SessionToolSandbox 的 scoped owner 服务中维护，引用计数覆盖 discover、snapshot 和 execute；最后引用释放后停止 renew。shutdown finalizer owner-release；不是 session-wide release。
- finalizer 的释放/取消均有独立短预算，错误记录诊断，保持原始执行失败原因。PG gate 的关闭/恢复另由明确生命周期入口负责，普通 scope 关闭不关闭整个 session gate。

## 10. 父子会话与生命周期

SandboxProvider 解析 root session，因此父子共用同一个 Sandbox Host。但工具定义、物化目录、manifest/cache 和 executionID 归属保留逻辑 sessionID；不自动继承父 session tools。

任务 key 至少含 logical sessionID + executionID。宿主初始化按物理 Sandbox 单次启动，服务端缓存不得只按 directory=/workspace 索引。

kill-sandbox 前释放该物理 Sandbox 下全部关联 session 的任务；仅停止一个子 session 时不得杀其他 session 的任务。session 删除按自己 sessionID 清理；root sandbox 销毁按整个 sandbox 清理。

邻接风险：Session MCP 的 usedPorts 来自单 session 的 runtimes；父子共享 Sandbox 时是否发生跨 session 端口冲突尚未实测，不能当作已确认缺陷。本方案使用物理 Sandbox 单 Host、多逻辑 session，避免复制这一风险。

## 11. 改动范围

| 文件/模块 | 改动 |
|---|---|
| `core/src/session/tools.ts` | 移除服务端 fs/import 用户代码，改 manifest + 标准 Tool.Info 代理 |
| `core/src/session/tool-sandbox.ts`（新增） | 物化、准备、RPC、取消、释放与数据缓存 |
| Core 内部 RPC 协议模块（新增） | versioned DTO、预算、错误映射 |
| `core/src/session/context.ts` | 保持 overlay；传递后端加载所需 session 信息 |
| session destroy/delete/shutdown 既有入口 | 接入释放，保持 root/child 语义 |
| `core/src/sandbox/provider.ts`、PG 生命周期协调模块 | scoped activity、准入/boot/destroy 的跨实例协调 |
| PG migration 与 gate 表 | root/logical session epoch、closing tombstone 和恢复 |
| `core/src/session/model-request.ts`、`runner/step.ts` | 请求作用域 snapshot lease 和工具消费生命周期 |
| `core/src/session/tool-host/`（新增） | Host/worker/compiler/helper 及运行文件物化 |
| SaaS Dockerfile、Core build script | 编译并携带版本化运行文件；Sandbox Dockerfile 无新增要求 |
| 测试和 tools 文档 | T32 全量回归、部署和兼容说明 |

不新增公开工具执行端点；session_tools 表及 CRUD 不变，新增第 9.4 节两个内部 gate 表以闭合跨实例销毁竞态。现有 code 长度以 Schema.isMaxLength 检查；迁移沿用公开 API 的现有接受范围，传输/物化的 UTF-8 字节预算需覆盖其合法多字节输入。若要收紧为 256 KiB UTF-8，作为独立契约变更测试和说明，不能混入迁移无声拒绝旧输入。

诊断至少包含 sessionID、tool name、versionHash、executionID、ownerID、阶段、duration 和错误代码，不记录完整源码、参数凭据或服务器环境。

## 12. 实施顺序与验收

1. 沉淀现有执行契约：T32 已保留全部用例的自动脚本；增加 cwd/fs/env、顶层代码、旧快照版本及 context 测试。
2. 实现 Host/worker 和协议单测：编译、发现、结果编码、deadline、进程组终止、并发和结果缓存。
3. 实现 SessionToolSandbox 与物化/hash/endpoint 单测，接入 Tool.Info 代理及生命周期。
4. 使用包含新宿主的 Docker 镜像，连接隔离 PG 和 OpenSandbox，通过 API 做完整 E2E。
5. 更新文档，清理测试 session/sandbox；确认代码不存在服务端用户源码 import 路径。

验收矩阵：

- T32.1–24、27、28 全部复跑；25/26 历史移除单列，不能计作 pass。
- 源码顶层和 execute 中 fs 写标记只出现在 Sandbox；SaaS 对应位置不存在文件。
- 脚本取得 Sandbox 进程身份、cwd=/workspace、会话环境；不携带服务端专有环境变量。
- 顶层死循环、execute 死循环、永不 resolve、工具 spawn 同进程组后代：预算后受管理进程组终止，session 后续 prompt 可用；detached 后代不列为当前保证。
- 工具语法错误/非法导出/schema 无法转移不影响好工具；模块依赖缺失有可诊断错误。
- code 热更新 V1→V2、新旧请求并发、删除回退、跨 session 同名工具、父子共用 Sandbox 不泄漏定义。
- stdout/stderr 噪声、大输出、序列化失败、执行中断只产生一个工具终态；PG 与 SSE/API 读回一致。
- 网络断开/Host 重启/Sandbox 重建时不重放有副作用任务；结果未知明确可见。
- keepalive/touch 正常刷新；多任务不误回收 Sandbox；删除/kill 后无遗留任务或容器。
- CodeMode 默认开启时，模型请求实际工具目录、execute 调度与结果投影符合既定契约。
- 模块顶层只初始化一次、闭包状态跨调用保留、同 worker 并发和超时关联失败、不同 logical session 不共享模块状态。
- 转换型 Effect codec 输入解码/输出编码各一次、异步 Standard Schema、progress Effect/ack 和取消传播正确。
- cancel 先于 accepted、release 与迟到 execute、多实例 owner shutdown、Host epoch 切换不产生额外执行。
- 主源码 hash/manifest 不匹配、仓库依赖漂移、物化半写/符号链接、缺宿主/协议不匹配、自定义镜像能力失败明确可见。
- 长执行 heartbeat 持续刷新、owner 续约丢失停止任务、cache 淘汰不破坏幂等、队列/日志/结果预算压力测试。
- 超过 16 个工具的批量 manifest 发现、按需 worker 恢复、同源码多名称的模块状态共享和独立 context。
- 两个 SaaS 实例共享 PG：prepare/accepted 与 delete/kill 的屏障顺序、closing 崩溃恢复、旧 sandboxID/epoch 拒绝；SQL 锁不覆盖长执行、连接池不被耗尽。
- progress-ack 的真实双向往返、迟到/重复 ack 和 scope 中断；Prepared 所属 scope 关闭后 snapshot lease 清零。

## 13. 已锁定决定与实施门槛

保留版本 worker 存续期间的模块状态和已有 progress；有意取消跨 session 的模块共享，服务端专用 import/env 迁移到 Sandbox 依赖。保留原文本 resultMode 转换，不承诺增加附件能力，不增加 ask 或交互权限能力。

进入实施先补现有 codec/progress/模块状态契约测试；完成 codec 转换方向验证、Host ownership/admission/cancel 协议测试后才能接入主链路。尚未支持的 schema 类型必须列清单、给出错误与迁移说明，不能用文档笼统声明完整兼容。首期预算和 idle lease 需由 Docker/API/PG 压测校准。

审核报告 `session-tools-sandbox-execution-review.md` 是修订前问题记录；R1–R10 的设计修订已纳入本版，实际修复有效性仍需实施测试验证。

实施基线补充：RPC 闭合、PG 准入屏障、Effect scope/heartbeat 接入、worker key/容量策略已在第 7、9.3–9.5 节固定。允许按契约测试 → 基础组件 → PG gate 与 provider → 主链路 → Docker/API/PG 全量验收的顺序实施。不能以设计审核通过代替实现测试通过。

成功标准是用户源码生命周期完整处于 Sandbox，而非只把正常 execute 分支改成远程调用。工具注册、AI 编排和 PG 事件依然由 SaaS 的 canonical V2 服务承担。
