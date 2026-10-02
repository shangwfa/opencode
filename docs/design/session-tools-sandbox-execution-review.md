# Session Tools Sandbox 执行方案审核

日期：2026-09-30。审核对象：`session-tools-sandbox-execution.md`。审核性质：设计与当前源码对照，未实施，未做新方案运行测试。

## 结论

方向符合 SaaS 的分工预期：AI、会话编排和 PG 在服务端，用户代码完整移入会话 Sandbox，父子共用物理 Sandbox，继续使用 canonical Tool.Info/Snapshot/runner。

**当前版本不建议直接进入实现。** 执行机制可以作为骨架，但兼容性、发现阶段副作用、取消竞态及 codec 边界尚未闭环。下列阻断项应先修订到主方案；不能将当前文档称为完整兼容迁移。

## 阻断项

### R1：模块生命周期发生未获确认的兼容变化

方案第 7 节声明发现与执行各自 import，且模块状态不跨调用保留。当前 `core/src/session/tools.ts:47,79-105` 缓存模块 Promise，`201-227` 持续调用同一导出对象：闭包计数器、模块缓存、一次初始化资源均可以跨调用存在。

结果：迁移后工具的 module-level state 重置，初始化副作用重复。不能只以文档声明替代兼容决策。

建议：默认采用每 logical session + version 的受管理 worker，discover 和 execute 使用同一模块实例；Host 保持为监督进程而不 import 用户代码。单 worker 内执行串行，跨工具并行；如需维持原并发行为，需显式测试并定义。超时杀 worker 后允许重新初始化，但不能重放已派发调用。是否保留原跨 session 同 code 共用模块的行为需明确：推荐取消共享，但作为有意改变记录。若坚持每次调用子进程方案，必须先确认其为 breaking contract。

### R2：发现阶段执行副作用与工具过滤的次序没有明确策略

方案第 5/8 节承认 discovery 执行模块顶层代码，却同时提出“物化/发现/执行前 Permission.assert”和“discover 没有 invocation identity”。两者矛盾。

当前 `session/context.ts:143-155` 在 registry.snapshot 可见性过滤之前 load 用户工具。当前 `tools.ts:219-227` 并没有新增的 Permission.assert，因此这也是权限语义改变。

建议：明确 session tool 注册意味着允许在 Sandbox 初始化定义；不引入 discovery 的交互权限等待，不伪造 invocation。执行阶段如新增 leaf policy，固定 action、资源、source、ask/deny 行为并增测；不能仅泛称复用权限。被隐藏工具是否仍初始化必须单列契约，若改为不初始化，应按 canonical visibility 规则制定，不复制一个权限系统。

### R3：Effect/Standard Schema 的转换与校验边界不完整

方案第 5 节“服务端校验 JSON Schema + worker 保留 codec 解码/编码”不足以实现当前契约。

证据：`schema/src/tool.ts:44` 接受 Codec/StandardSchema/JSON Schema；`core/src/tool/runtime.ts:28-58` 对输入解码、调用工具、对输出编码。转换型 codec 的输入 wire type 可以不同于 execute 内部 type；输出编码不一定能与第二次 JSON 校验组合。方案必须避免重复解码/编码。

建议：SaaS Tool.Info 暴露 transport input/output JSON Schema；wire input 仅验证，在 worker 原 codec 内解码一次；worker 执行后按原 output codec 编码一次；SaaS 校验已编码 wire output。明确可生成 JSON Schema 的子集、异步 Standard Schema、转换失败处理、依赖版本，添加转换 codec 的实际回归。不能以“后续确定兼容范围”作为已可实施的完整契约。

### R4：context.progress 不是新能力，不能遗漏

方案第 6/13 节将 progress 与 ask 一起视为后续能力。当前 `schema/src/tool.ts:14-20` 的 Tool.Context 已有返回 Effect 的 progress，`session/tools.ts:222` 直接传入用户代码。因此，删除它是现有契约变化。

建议：首期实现 progress 的反向消息，统一由 SaaS context.progress 投影；明确 user code 取得 Promise 还是兼容 Effect 的调用方式。ask 可继续不支持，因为当前 V2 包装器确无该桥接；本地 AbortSignal 是新增能力，不应描述成已有字段搬运。

### R5：取消与删除存在“释放之后仍接受新任务”的竞态

第 9/10 节 release/session destroy 的设计只描述清理现有任务，没有准入封锁；cancel 若早于 accepted，会返回不存在，而延迟 execute 仍可能到达并运行。

建议：Host 引入 Sandbox generation/host epoch 和 logical session 的 admission state；release 先原子关闭准入，再取消队列和运行任务。cancel 建立有界 tombstone，阻止迟到 executionID；请求原子注册、版本验证、accepted 与启动有明确顺序。版本 generation 对不上拒绝执行。释放和取消必须幂等，用户 delete 与快照的冲突优先由 admission state 判定。

服务端 interrupt 必须在 uninterruptible cleanup 中发起有界取消，然后由既有 runner 写终态；远端 deadline 兜底不能替代正常取消的确认。

### R6：版本 hash 不保证执行内容与 manifest 一致

第 4/7 节仅 hash 主源码与协议，仓库依赖与工具物化目录仍可改变；execute 的独立 import 还可输出不同 schema。旧快照可能以旧 manifest 执行新行为。

建议：Host 读取主源码验证 hash；执行绑定持有的模块/manifest，而不是只信传入路径。manifest 指纹随快照带入执行请求，重新初始化后校验，不一致明确失败。区分“主工具源码固定”与“仓库依赖可变”，不要承诺完整依赖快照；需要固定依赖时另行 content-addressed 打包。并发物化、符号链接与半写入必须通过受控路径/原子发布处理。

## 重要补充项

### R7：结果兼容应以当前 toResult 为基线

方案第 8 节把 undefined/BigInt 一律变成错误，但当前 `tools.ts:177-193` 在非结构化模式会 String(undefined)、String(BigInt)，得到文本。应在 Sandbox 先做现有 resultMode 对应的规范化，再对规范化 wire result 做可序列化检查；结构化模式独立规定失败。附件/媒体不能泛称兼容，当前 adapter 支持范围应写清。

### R8：进程组终止的保证范围要准确

SIGTERM/SIGKILL 进程组能覆盖继承同一进程组的后代，不能保证清理自行 setsid/detach 的后代。应将保证限定为受管理子进程组；若必须隔离所有后代，需要经环境验证的 cgroup/job 执行单元，不能无依据声明“所有后代全部清理”。

### R9：长执行的 touch 与资源预算缺具体实现

HTTP 执行不经过 SandboxProvider.run 的正常活跃路径，仅首次 endpoint 解析不足以支持长任务。必须明确 active execution 的 provider heartbeat 获取/释放，不能全局永久 keepalive。队列容量、stdout/stderr、RPC 请求体、manifest、结果和 TTL 存储都要有具体边界以及压力测试。

### R10：部署和故障观测需要收口

启动完成不等于 ready；应 health 校验协议与 worker runtime 后再发现工具。镜像不含宿主、版本不匹配、网关不可达分开报错。沙箱默认镜像和 session 自定义镜像均要定义能力要求，不 silent fallback。日志至少含 sessionID、tool name、hash、executionID、阶段、duration、error code；不记录整段源码/凭据。

多实例启动应通过 Sandbox 内锁解决，缓存须对物理 Sandbox generation 失效。服务端 shutdown 是否释放另一实例的 active worker 要定义 ownership；不能不加区别 release 整个 session。

## 符合预期、可直接保留的部分

- 用户源码包括顶层加载不进入 SaaS；控制与执行职责分开。
- 保留 CRUD、PG 存储和请求级 overlay，避免第二套工具注册/事件体系。
- logical session 的定义隔离 + root Sandbox 复用。
- Snapshot 捕获旧版本；新请求热更新；已派发副作用调用不自动重试。
- Sandbox 无能力时明确失败；不自动安装依赖、不复制服务端环境。
- 通过 Docker/API/SSE/PG 同时验收结果与执行过程。

## 修订优先级和批准条件

先解决 R1–R6，确定模块生命周期、codec wire 契约、progress 兼容及 admission/cancel 状态机；再补 R7–R10 的明确实现条款。

增加 E2E：顶层初始化计数、模块级状态跨调用、转换 codec、progress 投影、取消先于接受、release 与迟到请求、多实例 ownership、manifest 漂移、镜像能力缺失、长执行 heartbeat。其余沿用主方案 T32 全量回归矩阵。

完成上述修订后，可将方案批准为实现基线；当前仅批准“迁入 Sandbox 的架构方向”。
