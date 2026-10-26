# 沙箱 Provider 抽象：新增 Vercel Sandbox 支持设计方案

Status: 部分实现并验收（SDK 3.8.0、provider 接入、T19.1–T19.6、公网 token 网关、Code Mode、Tool Host 和原生 HTTP MCP echo 链路通过；完整 MCP 协议能力与完整替代后端仍待完成）
Date: 2026-10-24
Revision: 2

实施进展：已增加 PG provider/scope/remote_name 绑定、sandbox_command、创建租约及持久绑定路由；接入命令、文件、保活、停止/恢复、永久删除和回收。公网端口按“Vercel 路由 + 每沙箱 token 网关”落地，声明 15 个路由端口（13 个 MCP + runner + Tool Host）。Session 本地 MCP 已用 `session/mcp-http-bridge.ts` 替换 supergateway，真实模型 echo 链路通过；不再需要全局 MCP 协议版本兼容修改。实测范围及限制见 [`test-cases/sandbox/vercel-exec-api-2026-10-24.md`](test-cases/sandbox/vercel-exec-api-2026-10-24.md)。下文是目标设计，不代表每项均已实现；原生桥接暂不支持 server→client 请求，显式快照目录与统计明确不支持。

## 1. 目标与范围

在现有 OpenSandbox 之外增加 Vercel Sandbox，SaaS 仍运行在 Docker/k8s，PG 仍是会话绑定和执行所有权的持久来源。AI/model 调用留在 SaaS，代码和文件操作留在沙箱，根会话与子会话共用 `/workspace`。

本方案替代初稿。取舍依据见 `sandbox-provider-vercel-industry-review.md`，首次审核中的部分肯定结论已撤回。

本期不做 SaaS 本体迁移、不做现存工作区自动跨厂商迁移、不实现透明 Code Mode 断线续跑、不新增 provider 专属 tools/skills/MCP/agents 注册链。

**发布边界**：Vercel 持久化恢复的是文件系统，不是内存和进程；其显式快照会停机。第一版必须公开这些限制，不宣称与现有在线 checkpoint、PVC 模式完全等价。若业务要求这些能力无差异替换，则补齐能力前不得发布为完整替代后端。

## 2. 已确定的架构决策

| 主题 | 决策 |
|---|---|
| 提供方选择 | 环境默认仅决定新绑定；已有会话始终按 PG 的 provider/scope 路由 |
| 适配边界 | 复用公共会话编排与现有小模块；厂商层只负责远端命令、文件、连接、生命周期原语 |
| 工作区身份 | 根会话绑定稳定远端身份；另存当前运行代次，区分恢复后的新 VM |
| 闲置回收 | Vercel persistent 工作区只 stop，不 delete；永久清理才 delete |
| 恢复保护 | 已有绑定严格 retrieve/resume；失败返回恢复错误，不回退 create/getOrCreate |
| 快照 | 禁用 Vercel 不支持的在线 checkpoint；停机快照只在独占维护流程中运行 |
| PVC | 显式请求不支持的存储模式直接报错，禁止静默降级 |
| 安全 | 内部 HTTP/WS 入口认证是 MVP 前置，禁止以随机 URL 作为认证 |
| 执行重试 | 仅确定未提交或只读幂等操作可重试；提交后不确定失败禁止自动重放 |

## 3. 代码依据与复用点

以下为审核时定位，行号可能随实现调整：

- `packages/core/src/sandbox/provider.ts:52-79`：RunInput，超时、只读重试、isolated/detached 契约。
- `provider.ts:98-196`：连接三态、文件、执行及生命周期接口。不能因接口方法齐全就认定厂商语义完全兼容。
- `provider.ts:677-698`：根会话解析，所有绑定和操作先归一到 root sessionID。
- `sandbox/create-lease.ts:8-23`：PG 跨实例创建仲裁；进程内 single-flight 不能替代。
- `sandbox/generation.ts`：旧代次操作不得更新或销毁新代次。
- `session/execution-lease.ts`：Session 执行所有权；Bus 锁不能代替执行租约。
- `codemode/runner.ts:48-63,130-145`：幂等启动、寻址、提交 execute；`containers/sandbox/opt/codemode-runner.ts:222-226`：断线取消执行。
- `session/mcps.ts:57,382-387`：多个 MCP 从 9100 开始分配未使用端口；`session/tool-host-protocol.ts:5`：Tool Host 已使用 9912。
- `tool/plugin/shell.ts:213-224`：后台任务已由 nohup 启动器包装，provider.run 仍需等待启动器结果。

## 4. 模块边界与持久模型

### 4.1 实现结构

- 保留 `SandboxProvider.Interface` 为上层统一入口，增加必要能力和连接目标信息，不另建工具执行入口。
- 配置和路由层按 PG 绑定选择 OpenSandbox/Vercel；未绑定才读取默认 provider。
- 新增独立 Vercel 实现，SDK 调用集中在薄适配层，方便 fake 测试；禁止复制整份 OpenSandbox provider。
- 创建租约、运行代次检查、根会话解析、执行 gate 等优先复用已有模块。只在两个实现确实共享逻辑时提取公共函数，不为未来厂商提前搭框架。
- Effect SDK Promise 走 typed error 通道；保留 interruption/defect，不用 catch-all 把它们转换成普通工具失败。

### 4.2 PG 绑定

需要显式持久化以下逻辑信息，具体列名和迁移脚本在实施时结合现有表确定：

| 信息 | 用途 |
|---|---|
| root sessionID | 同一根会话唯一绑定，子会话共享 |
| provider | `opensandbox` 或 `vercel`，不再复用 host 字段充当枚举 |
| provider scope | Vercel team/project 等非敏感资源归属，不包含 token |
| 稳定远端身份 | 远端 sandbox name/ID，与创建占位 ID 区分 |
| 当前运行代次 | Vercel 当前 VM session 身份及本地代次，用于隔离旧 pid、endpoint、cancel、destroy |
| 目标/观测生命周期 | 区分 running、停止保留、恢复中、永久删除及失败；记录远端观测时间 |

不能把稳定 name 单独当作当前 VM 身份。创建后、resume 后都应校验远端身份并 CAS 更新运行代次。

命令状态使用独立可 CAS 更新的记录：root session、代次、operationID、真实远端命令/进程组身份、状态与时间；设置清理策略。不得把整张 operation map JSON 塞入 `command_session_id` 做并发读改写。

迁移先给旧行回填 OpenSandbox provider，再启用新路由；不改写旧远端身份。运行代次和命令表的具体关联约束需迁移测试验证。

## 5. 生命周期与数据保护

### 5.1 首次创建

1. 解析 root sessionID，读取 PG 绑定。
2. 无绑定时获取现有 PG 创建租约；其他 pod 等待并复用胜者结果。
3. 创建前持久化确定的远端名称及创建意图；名称含部署隔离信息，合法字符和长度由 P0 验证。
4. 调用 create，显式设置镜像、资源、timeout、持久化、端口和网络策略。
5. 完成必要初始化后 CAS 保存远端身份、当前代次和状态。失去租约的创建者不能覆盖绑定。
6. 创建请求返回不确定失败时，先查询同一创建意图对应的远端资源；不能盲目再次创建。初始化失败的资源由带代次/租约校验的补偿流程处理。

### 5.2 已有绑定恢复

严格 retrieve，必要时显式 resume；不调用可能在过期时删除旧环境再同名重建的 getOrCreate。缺失、快照过期、认证失败、限流、暂时不可达分别分类，不把所有失败都解释成“应新建”。

已保存工作区无法恢复时明确返回恢复失败并保留诊断记录。用户显式重置工作区属于另一项破坏性操作，不由自动恢复隐含执行。

`onCreate` 只能做新环境初始化，不能作为拒绝冷启动的唯一防线；官方语义中它在新环境创建后执行。`onResume` 可辅助初始化，但任何 pod 的显式恢复路径都必须校验当前代次并确保服务就绪，不能只依赖某个进程注册过回调。

### 5.3 停止、删除与现有 destroy 契约

- 闲置/正常资源回收：persistent 工作区 stop，确认停止和持久化结果后更新 PG，保留稳定身份。普通后台任务不保证恢复，平台 daemon 按需重启。
- 永久清理：独立删除流程，受会话删除/清理授权约束；远端 sandbox、快照按各自保留策略清理。
- 在实现前遍历 `destroy` 的 API、idle reap、快照队列和会话删除调用方，区分“释放计算”和“删除工作区”。若统一方法无法表达，增加明确的 stop/delete 意图，不依靠隐含参数猜测。
- PG 与远端不能跨系统原子提交：保留持久意图、租约、幂等重试和 reconcile；只有确认成功才记录完成。
- `isReady`/endpoint 不 boot、不 resume。只读浏览不得通过 SDK 自动恢复意外启动 VM；PG 缓存只能是带观测时间的状态提示，不能伪装成实时健康证明。

## 6. 能力与持久化策略

能力信息仅覆盖调用方确有分支需求的差异：支持的存储模式、快照是否停机、是否恢复进程。不做通用插件能力图。

| 能力 | Vercel 第一版行为 |
|---|---|
| 工作区持久化 | persistent 文件系统 stop/resume；不承诺内存/进程恢复 |
| 临时工作区 | 明确 ephemeral/non-persistent；停止后数据不可恢复 |
| 显式 PVC 请求 | 返回不支持，配置及 session 入口行为一致 |
| 在线 turn checkpoint / refresh | 能力门控禁用并对调用方明确可见，不返回伪成功 |
| 停机快照 | execution gate 排空并阻止新任务后执行；完成后按原意图保持停止或恢复并重建服务 |
| snapshot 方法返回契约 | 复用 PG 持久操作记录承接异步状态；SDK 不能提前返回远端 ID 时不伪造远端 ID，必要的契约调整必须同步调用方 |
| latest/delete/stats | PG 操作记录与远端快照对账；保留审计及失败状态 |
| 共享包缓存 / Drives | 第一版不承诺；Drives 单独验证后再接入，不能当作现有 PVC 的同义物 |

明确 keepLastSnapshots/过期策略与现有快照保留策略的兼容性，禁止平台自动淘汰业务承诺保留的快照。不能未经验证沿用默认到期配置。只依赖 stop 自动快照不等于运行中崩溃零数据丢失，需记录并接受恢复点限制，否则阻止发布。

## 7. 命令、后台任务与取消

### 7.1 统一返回与执行预算

`run` 保持 ExecutionResult：exitCode/output/timedOut。boot/resume 与命令执行分别计时；不得把调用方的 10 秒执行预算静默扩成 60 秒。`timeoutMs=0` 保持禁用命令超时，但不改变远端沙箱最大运行时长。

默认命令可用独立 bash 进程执行，但这不等于共享 shell 状态。必须先核实调用方是否依赖 cwd/env 跨调用保留，建立契约测试；不能未经验证宣称等价。

`isolated` 必须允许父操作等待嵌套子工具，不能让父子竞争同一个容量为 1 的槽而死锁。复用已有 tool gate/并发规则，不新建不兼容的信号量体系。

输出按现有 Session/tool 机制限长和落盘，避免在 Vercel 层另设一套用户可见截断规则；适配层必须限制自身缓存，并继续排空远端输出，不能截断后遗留阻塞进程。

### 7.2 detached 与真实后台任务

RunInput.detached 表示保留后台任务所需的命令上下文，不等于 SDK detached 立即返回。对现有 nohup 启动器仍需等到它执行结束并返回启动错误。

真实后台任务必须有可跨 pod 取消的身份：记录实际 SDK 任务或进程组，而不是已退出启动器的 cmdId。必要时最小调整后台启动器，保留其日志文件与现有响应契约。

取消前校验 root session、operationID、运行代次和任务身份；TERM 后限时 KILL，并确认完成。只持有 AbortController 不足以证明远端已停止；SDK abort/kill 的精确语义由 P0 验证。

pid 文件不得作为跨代次取消的唯一凭据；停机快照可能保留旧文件、PID 可能被复用。未知任务状态必须报告不确定，禁止宽泛 pkill 兜底误杀。

## 8. 连接目标、端口与安全

### 8.1 连接目标契约

连接解析保留 resolved/no-sandbox/resolve-failed 三态，resolved 承载完整 HTTP(S) URL、必要请求认证信息和运行代次；不要同时暴露可互相矛盾的 endpoint/scheme/urlBase 多份权威字段。

OpenSandbox 在适配层规范化现有网关地址，Vercel 返回官方 domain URL；WS URL 通过统一转换生成。认证信息按需从服务端密钥来源取得，禁止进入 SSE、日志、模型上下文或 preview 响应。

消费方至少包括 Code Mode、Session MCP、Tool Host、session-proxy；实施前搜索全部 endpoint 调用方，统一更新类型、认证、缓存失效及测试。

### 8.2 三段式与恢复

固定次序仍是：**显式确保当前运行代次 → 命令通道幂等拉起并就绪探测 → 解析端点 → 有界连接重试**。禁止直连沙箱 IP，禁止引入 pod 与沙箱亲和性。

恢复后旧 pid/endpoint/health 缓存失效；启动器必须识别当前服务身份，不只 kill -0 检查一个可能复用的 PID。连接失败先分类；认证错误不无限 resume，已提交执行不因重连而再次执行。

### 8.3 MCP 与端口额度

保持 Code Mode 9911、Tool Host 9912，以及现有多个 MCP 独立端口分配，不为 Vercel 任意更改已有常量。

第一版声明一个有界端口集合，为 MCP 和 preview 分配明确容量，超过额度返回容量错误，不能端口碰撞或静默丢 MCP。具体集合在 P0 验证平台配额后固定。

若支持运行中动态追加 ports，必须在 PG 协调下读合并写全量配置，并对冲突/失败做 reconcile；不能两个 pod 分别替换整组 ports。统一多服务认证路由入口只在直接映射确实不足时引入，不先建新 daemon 框架。

### 8.4 MVP 安全门槛

- 所有内部 HTTP 和 WS 入口在处理请求/升级握手前校验凭据；缺少认证时拒绝开启公共入口，dev/test 不豁免。
- runner、Tool Host、MCP bridge 的具体认证实现由 P0 验证。自有 daemon 可直接校验；bridge 不支持认证时使用最小认证代理或已验证的官方机制，不能先裸露再等 P3。
- 内部执行凭据与用户 preview 凭据分离，preview 短期、限范围、可撤销；请求转发不泄露内部凭据，日志脱敏。
- SaaS 管理 token 不写入沙箱。HTTP 凭据优先用经验证的 egress 注入；Git/SSH 等另验，不声称所有协议都可代理注入。
- token 保护公网访问，不作为同一 VM 内不可信代码间的额外隔离；快照不得跨租户复用含凭据的运行配置。
- egress 策略按实际开发需求验证：禁止访问未授权私网/云元数据，明确包源、Git 和联网工具的允许范围。网络安全测试同时覆盖 ingress 与 egress。

## 9. Code Mode 断线策略

当前协议在 socket close 时取消执行，不能透明续跑。

- execute 提交前：允许有界重连、重新探测就绪。
- 提交后或发送结果不确定：报告执行结果不确定，不重发 execute，不自动重放有副作用子工具。
- 保留 executionID/工具调用信息用于诊断，并验证上层错误处理不会隐含重新执行整轮。
- 真正的重新附着需要独立协议设计：执行状态不依赖 socket、状态查询、结果保留、子工具去重。第一版明确不做。

## 10. 活动保活、观测与成本

创建时显式设置运行 timeout；活动心跳接近 expiresAt 阈值才续期，并按运行代次协调，避免每个 pod/每次文件请求都续期。keepAlive/release 保持 PG 意图，不把 keepAlive 宣称为无限续命；接近厂商硬上限时明确反馈。

OOM 采样、只读状态查询不得唤醒已停止工作区，也不得刷新用户活动水位。监控请求是否计入费用由 P0 验证，不把每个命令调用误称为 Sandbox creation。

观测项：创建/恢复/服务就绪耗时、文件工具延迟、限流、断线与不确定执行、快照失败、代次冲突、CPU/内存时间和存储/网络用量。

费用以当前官方 pricing 和项目账单为准。审核时 CPU $0.128/CPU-hour、内存 $0.0212/GB-hour 可作示例；4GB 内存运行一小时约 $0.0848，CPU 另按实际累计 CPU 时间计。5 CPU 小时/420 GB-hours 等为 Hobby Included，不能声称是 Pro 额外免费额度；网络按当前 Pro Flat Rate CDN 条款核对。原初稿的活跃率与总价范围撤回，不当作测量结果。

## 11. 配置与镜像

- `OPENCODE_SANDBOX_ENABLED` 保持总开关；`OPENCODE_SANDBOX_PROVIDER` 默认 opensandbox，仅影响首次绑定。
- Vercel scope 为 `VERCEL_TEAM_ID`、`VERCEL_PROJECT_ID`；token 由服务端密钥配置提供。作用域缺失或无法服务已有绑定时明确报错，禁止选错项目创建同名环境。
- 镜像、区域、timeout、资源和持久化配置在 provider 范围校验，不能把现有 OpenSandbox 镜像默认值直接送入 Vercel。
- SDK 精确版本、VCR 镜像来源/推送方式、架构要求、CA 注入、`/workspace` 权限、node/supergateway/git/rg/flock 工具完整性由 P0 验证后固定；不修改 npm 包源码。
- 不再新增独立输出截断、OOM 开关等重复配置；优先沿用现有含义一致的开关。不兼容的参数直接报错，不做隐藏默认转换。

## 12. 实施阶段与退出标准

| 阶段 | 范围 | 退出标准 |
|---|---|---|
| P0 API/协议验证 | 固定 SDK；strict get/resume、快照缺失行为、stop/delete、run/kill/abort、认证 HTTP/WS、多 MCP 端口、镜像、文件/Range、限流、资源规格、成本实测 | 产出 `docs/research/vercel-sandbox-spike.md`，每项记录版本、请求/响应、结果与未决风险；核心安全/数据保护失败则阻止 P1 |
| P1 安全接入 | PG 绑定迁移与路由、租约/代次、命令/文件、真实后台任务取消、认证连接目标、多 MCP、能力门控、明确断线失败 | 单测、跨 pod PG/API E2E 全通过；无认证公共执行入口为零 |
| P2 持久化收口 | stop/resume/永久清理、停机快照持久操作、异常补偿、保留策略与旧 OpenSandbox 回归 | 数据恢复/失败保护与并发清理测试通过；明确在线 checkpoint 缺口及发布范围 |

不将鉴权、取消正确性、数据保护挪到“后续加固”。Drives、透明重附着、环境 fork 模板不是本期交付。

## 13. 测试矩阵

单测放 `packages/core/test/`，沿用现有命名；风险行为先写失败用例再修复。

| 范围 | 必测场景 |
|---|---|
| 路由/迁移 | 旧行回填、默认切换不改旧绑定、scope 错误、根/子会话唯一绑定 |
| 多 pod | 并发 create/resume/init、创建超时但远端已成功、租约失效、旧代次 cancel/destroy 不影响新 VM |
| 恢复保护 | 快照过期/删除、远端缺失、认证/限流/网络失败分别分类，均不意外冷启动 |
| 命令 | exitCode/output、timeout=0、执行预算与恢复预算分离、isolated 嵌套不死锁、输出排空与截断落盘 |
| 后台任务 | 启动失败、实际后台进程持续运行、跨 pod 取消、PID 重用、停止后不误复活用户任务 |
| 安全 | 未认证 HTTP/WS 被拒、preview 不能访问内部入口、凭据不进 SSE/日志、禁止未授权 egress |
| 端口 | 两个以上 MCP 与 Code Mode/Tool Host 同时工作、容量错误、端口更新并发及恢复后缓存失效 |
| Code Mode | 默认开启、三段式次序、提交前重连、执行中断线不重放、上层不重复副作用 |
| 文件 | 缺失/权限/中文/二进制、大文件、Range、目录与路径边界、文件密集延迟基线 |
| 持久化 | stop 不 delete、resume 文件保留、停机快照排空、在线快照/PVC 明确拒绝、永久清理及失败补偿 |
| 兼容 | 原 OpenSandbox 文件工具、shell、MCP/skills/agents 发现、compaction、fs/vcs/preview API 不回归 |

E2E 文档落 `docs/test-cases/sandbox/vercel-<主题>-<日期>.md`。SaaS 在 Docker/OrbStack 中运行，使用独立 PG 测试库与 Vercel 项目；通过接口驱动，code-mode 默认开启，按 `docs/test-cases/skills/streaming-output-spec.md` 全程订阅 SSE，处理提问后继续，分别检查结果、执行过程和 PG 数据。

没有真实 API 凭据时可完成 fake/PG 单测，但不得把它们等同沙箱接入验收；相关阻塞必须在报告中明确。

## 14. 发布与回滚

先部署可读取新旧 provider 绑定的兼容版本并执行向后兼容迁移，再灰度新会话使用 Vercel。回滚新建默认值不改变已有会话；仍保留可处理 Vercel 绑定的兼容运行版本和配置，直至其工作区完成显式迁移/清理。

不支持把软件直接退回完全不识别新绑定格式的历史版本；禁止拿 Vercel ID 访问 OpenSandbox 或反向操作。故障时停止新建 Vercel 会话、保留已有工作区，不能以自动切换厂商“恢复”丢失文件。

上线前需确认：接受无在线 checkpoint 的恢复点限制、后台普通任务不保证跨 stop 存活、账单限额/告警，以及保留/删除策略。此处是发布门槛，不再保留“静默降级或拒绝二选一”等未定核心行为。

## 15. 来源与验证状态

产品对比及详细证据见 `sandbox-provider-vercel-industry-review.md`。核心来源：

- https://vercel.com/docs/sandbox/concepts/persistent-sandboxes
- https://vercel.com/docs/sandbox/concepts/snapshots
- https://vercel.com/docs/sandbox/sdk-reference
- https://vercel.com/docs/sandbox/pricing
- https://vercel.com/docs/sandbox/concepts/firewall
- https://docs.e2b.dev/network/restrict-public-access
- https://www.daytona.io/docs/en/persistence
- https://modal.com/docs/guide/sandbox-snapshots
- https://docs.langchain.com/oss/python/deepagents/sandboxes

当前状态：已固定 SDK 3.8.0，新增严格连接边界、请求级防重发、固定代次命令提交/流式输出/取消、SDK 与本地 HTTP 契约测试以及 opt-in smoke 脚本，记录见 `docs/research/vercel-sandbox-spike.md`。原始 SDK detached 自动重试已复现，适配层通过公开 fetch 扩展点抑制同一次写请求重发；此保证不等于跨调用或服务端 exactly-once。默认测试项目中的真实 SDK smoke 已通过 8 个阶段，且复核本次沙箱和快照均已从 API 查询结果中清理。provider 尚未注册，PG 编排、daemon 鉴权、完整配额、镜像和 API/PG/SSE E2E 仍须验收，不能作为已支持能力。
