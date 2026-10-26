# Sandbox 核心逻辑与三个后端实现梳理

日期：2026-10-25。范围：当前工作树 `packages/core/src/sandbox`，以及必要的会话工具、常驻服务和 HTTP 调用点。只做静态梳理，不修改产品代码，不重新启动收费沙箱；历史验收与本轮静态判断分别标注。

> 后续实施状态：本文是优化前的梳理基线。阿里云回收正确性三项已定向修复并复测（`docs/test-cases/sandbox/aliyun-reap-fix-2026-10-25.md`）；多 Pod 风险中的 OpenSandbox readiness 本地缓存、OpenSandbox 跨 Pod 中断、Vercel 跨 Pod 端口更新已于 2026-10-26 修复并验收（`docs/test-cases/mcps/session-mcp-multipod-fix-2026-10-26.md`），B 表「OpenSandbox isReady 只看本地 entries」「Vercel 端口更新仅进程内 mutex」「命令锁/活动命令表在内存」三条不再成立；快照长期保留按用户指示延后；其余标注仍待处理。

## 1. 总体结论

当前不是三个独立业务系统，而是“一套业务入口、三个资源后端”。统一接口已经建立，但统一的是调用形状，不是所有行为：默认持久化、keepalive、readiness、命令隔离、快照完成时机和监控仍有差异。

不建议为了统一而把三个 SDK 包成同一种内部机制。应统一 SaaS 的安全与行为底线，保留各平台自己的执行、网关和持久化优势。

## 2. 核心调用链

1. `config.ts` 读取部署配置；默认新会话 provider 是 opensandbox。
2. `provider.ts:36–54` 构建路由服务：查会话父链得到 root，再查 PG `sandbox.provider`；已有绑定优先，没有绑定才选部署默认值。
3. `contract.ts:154–165` 最多上溯十层 parentID；子会话共享根沙箱。这里不按 worktree 分配资源，也不应将 fork 与 parentID 混同。
4. 首次 `boot/run/文件操作` 由后端惰性创建或恢复；`endpoint` 不创建沙箱，避免浏览器请求触发收费创建。
5. 业务工具只依赖 `SandboxProvider.Interface`；命令与文件走后端 SDK，常驻服务通过命令启动、通过端口网关访问。
6. 停止计算和永久删除工作区分开：`destroy/release` 不一定删除恢复点；Vercel/阿里云另外实现 `purge`。不能按方法名理解为“立即物理删除全部数据”。

### 目录职责

| 位置 | 当前职责 |
| --- | --- |
| `contract.ts` | run、文件、生命周期、快照、端口网关契约；根会话归属 |
| `provider.ts` | PG 绑定路由；兼容导出 OpenSandbox 的历史辅助函数 |
| `config.ts` / `sql.ts` | 环境配置；沙箱绑定、命令台账、阿里云独立快照台账 |
| `lifecycle/create-lease.ts` | 三后端共同使用的 PG 创建租约、心跳、CAS 完成 |
| `lifecycle/generation.ts` | 代次条件更新辅助；当前主要由 OpenSandbox 使用 |
| `tools.ts` / `path.ts` | 内置工具适配、权限、路径转换；glob/grep 在沙箱运行 rg |
| `workspace.ts` | OpenSandbox 工作区可写性初始化；接口仍有 OpenSandbox 特征 |
| `endpoint.ts` | 兼容无 scheme 地址与完整 HTTPS URL，生成 HTTP/WS 地址 |
| `preview/rewrite.ts` | 预览内容重写；不是端口网关本身 |
| `opensandbox/` | 控制面连接、命令上下文、卷、OOM、快照队列 |
| `vercel/` | 原生命令/文件、持久工作区 stop/resume、鉴权端口 gate |
| `aliyun/` | E2B 适配、原生鉴权网关、二代独立 Snapshot |

### PG 是什么的事实来源

`sql.ts:6–47`：

- `sandbox` 每个 root session 唯一一行，记录 provider、scope、生命周期、keep_alive、远端标识和网关凭据。
- `sandbox.id` 是当前代次标识，不保证等于云实例 ID：OpenSandbox 使用实例 ID，Vercel 使用运行 session ID，阿里云使用 `remote.id:UUID`。
- `remote_name` 在 Vercel 是持久工作区名称，在阿里云是实例 ID 或未决创建 intent；不能跨后端直接解释。
- `sandbox_command` 当前主要由 Vercel/阿里云记录远端命令，供取消与停止协调使用。
- OpenSandbox 快照和持久操作队列在 `opensandbox/snapshot/tables.sql.ts`；阿里云使用独立 `aliyun_snapshot`，不是共用同一快照格式。

## 3. 三个后端能力对照

以下是当前实现能力，不等于每个格子都已做完整生产验收。

| 能力 | OpenSandbox | Vercel | 阿里云 Agent Sandbox |
| --- | --- | --- | --- |
| 命令 | execd 持久/isolated/detached 上下文 | 原生命令 start/observe/cancel | E2B background command + wait/kill |
| 普通命令调度 | 共享命令上下文，进程内串行 | root 进程内串行；isolated/detached 绕过 | 独立命令，无对应本地 semaphore |
| 文件 | 原生 files API；部分失败用命令降级 | 原生 FileSystem | 原生 files API |
| 端口网关 | 控制面 endpoint，可选择 server proxy | 公网 HTTPS route 前加自有 token gate | 原生 HTTPS 端口网关 + traffic token |
| 持久化 | PVC / Snapshot，也识别显式 none | 原生持久工作区快照；不支持 PVC | 显式 snapshot / 临时实例；不支持 PVC |
| 未指定持久化时的后端回退 | config.volumeType，默认 PVC | 默认持久工作区 | 默认临时实例 |
| 停止后恢复 | PVC 重挂或从快照新建 | 同名工作区 resume，新 generation | 独立 Snapshot 新建实例，新 generation |
| 手动快照 API | 异步返回 creating | 明确不支持在线快照 | 等待创建确认后返回 ready |
| 最新快照 / 统计 | 已实现 | 明确返回 unsupported | 已实现；operations 统计为空 |
| 周期快照刷新 / GC | 已实现队列与回收流程 | 平台 stop 快照、保留参数；非同一套队列 | 未实现长期刷新/GC调度 |
| OOM 采样 / 会话事件 | 已实现；仅采本进程已连接实例 | provider 未实现 | provider 未实现 |
| 资源规格 | create 转发 CPU/内存 | 固定每 vCPU 对应 2Gi，校验失败拒绝 | CPU/内存取决于模板，创建后核对 |

依据：OpenSandbox `provider.ts:1305–1482, 2018–2108, 2284–2745`；Vercel `provider.ts:31–38, 76–197, 211–268, 383–484`；阿里云 `provider.ts:90–243, 263–437`。

## 4. 各后端关键机制

### 4.1 OpenSandbox：功能最厚的实现

- SaaS 通过 OpenSandbox 控制面/代理访问，不要求直连沙箱容器网络。命令通道与端口网关要分开理解。
- 文件读写现在主要是原生 files API，不是全部转换成 shell 输出；`fileStat` 类型判断与 `fileList` 部分失败才通过命令补偿（`provider.ts:2520–2724`）。
- 创建有本进程 single-flight、PG 租约、已有实例重连、工作区初始化和创建失败清理。缓存命中也会校验 PG generation。
- 普通命令复用共享上下文；isolated 用于嵌套工具避免死锁；detached 保留上下文以免退出时连同 nohup 服务一起杀掉。
- 命令上下文异常只对显式 safe-read 允许重放；普通 shell 不能把不确定失败当成安全重试。
- Snapshot 最完整：显式创建、停止前保存、持久 destroy/refresh 队列、operation 租约/fencing、marker 校验、恢复阻断、GC 和事件。
- 文件/命令 API 很多，生命周期、恢复与后台调度仍集中在约 2749 行的 `provider.ts`；复杂度明显高于另外两个实现。

### 4.2 Vercel：利用平台持久工作区与运行代次

- `Sandbox.get(...resume:false)` 只连接；恢复走创建租约下的 `resume`，不会把丢失工作区悄悄替换成空仓库。
- `destroy` 实际调用 stop，持久工作区必须收到快照保存确认才推进 PG；永久删除另走 purge。
- 命令有 PG 台账、operationID、取消确认和 1MiB 返回上限，完整输出保留在工作区日志。
- 每个内部服务端口外面增加 `port + 10000` gate，token 位于 URL 前缀；转发 HTTP 和 WebSocket。不能把公网 route 当作鉴权。
- 最多 15 个暴露端口，按需注册；Runner、Tool Host、MCP、plugins、preview 共同消耗预算。实际目标端口必须加 10000 后仍不超过 65535。
- 当前不提供统一的在线 snapshot/latest/stats 接口，即使平台 stop/resume 可以持久化，也不能称为与 OpenSandbox 快照 API 完全等价。

依据：`vercel/provider.ts:76–197, 314–355, 415–440`；`vercel/port-gate.ts:9–35, 45–116`。

### 4.3 阿里云：原生隔离网关与独立 Snapshot

- 使用 E2B API，不经过 OpenSandbox 控制面。创建固定 secure=true、allowPublicTraffic=false、onTimeout=kill、autoResume=false。
- 创建先落唯一 intent，再发送请求；云端结果不确定时按 metadata 查找，不盲目重复创建。云实例确认后先保存 ID，再初始化工作区与 Runner。
- 没有实现暂停/恢复路径；已有非 running 绑定会阻断并要求 reconciliation，不偷偷 resume。
- snapshot 模式停止前先关闭准入、检查命令台账、持久化快照 intent、等待确认，之后才 kill；恢复仅使用确认 ready 的快照，不降级空工作区。
- 原生网关地址是 `https://<port>-<sandboxID>.<domain>`，凭据通过服务端 headers 传递，不应返回浏览器。
- 命令输出文件留在 `/workspace/.opencode/output`，最多返回 1MiB；单文件读取限制 32MiB，Range 当前是在完整文件读回后切片。
- 模板必须提供相应运行能力；provider 仅主动初始化工作区、可选 rg 和 Runner，不代表已补齐所有插件/技能脚本依赖。

依据：`aliyun/client.ts:29–80`；`aliyun/provider.ts:63–243, 263–313, 374–435`。

## 5. 端口网关是通用基础设施，不只是预览

当前直接使用者包括：

- Code Mode Runner：9911，命令先拉起再解析 endpoint（`codemode/runner.ts:37–64`）。
- Session Tool Host：9912，按 generation 物化与启动执行宿主（`session/tool-sandbox.ts`）。
- Session MCP：9100 起，原生 mcp-http-bridge；remote MCP 本身未必经过沙箱。
- Session Plugin Agent：9200，需要 Bun 和 `/opt/sandbox-plugin-agent.ts`（`session/plugins.ts:67–133`）。
- preview 与任意用户服务，通过 HTTP/WS 代理访问。

统一要求应是“命令通道幂等启动 → 就绪探测 → endpoint 寻址 → 带服务端鉴权连接”，而不是要求三个后端都使用 OpenSandbox 的网络实现。地址能解析不代表目标服务已经监听。

注意：Vercel/阿里云的初始化代码没有主动安装 Plugin Agent 和 Bun。自定义镜像/模板可以预置，但不能仅因 MCP、Runner 已通过就宣称 Session Plugins 或所有技能脚本均已通过。

## 6. 已证实的问题与静态风险

### A. 已有复现实证，优先处理

1. **阿里云 idle reap 活动刷新后仍可能误杀。** sweep 选择旧候选后按 session 调 destroy；capture 重新读取最新时间戳，再对这个新时间做 CAS，无法拒绝“扫描后新活动”。已有真 PG + 可控云端连续两次复现。证据：`docs/test-cases/sandbox/aliyun-lifecycle-2026-10-25.md:43–49`。
2. **阿里云 keepalive 与现有回收契约不同。** sweep 用 `!record.keep_alive` 排除回收；OpenSandbox/Vercel 的 idle 条件不这样排除。应先决定产品语义，不直接称某个平台必然更正确。
3. **阿里云 killed 状态没有后台收敛路径。** sweep 只处理 running/snapshotting；已有接口补测未自动回收。证据见上述生命周期文档。
4. **MCP 杀 bridge 后首次调用不透明恢复。** 本轮阿里云 T22.31 首次 error、模型第二次调用 completed；这是上层 Session MCP 与端口错误恢复链路的问题，不能简单归为文件/命令 provider 不支持。证据：`docs/test-cases/mcps/session-mcp.md` 本轮记录。

### B. 从源码可确认的差异，运行影响需补定向测试

| 项目 | 源码依据 | 需要确认的影响 |
| --- | --- | --- |
| OpenSandbox isReady 只看本地 entries | `opensandbox/provider.ts:2727–2728`；`server/handlers/session-fs.ts:46,64,86` 用它作为读取前置 | 同一运行沙箱请求落到未连接过的新 Pod 时可能误报未运行；不应称跨 Pod readiness 已统一 |
| Vercel 端口更新仅进程内 mutex | `vercel/provider.ts:314–326`，update 替换完整 ports 集合 | 多 Pod 并发新增端口可能覆盖；本地锁不能证明跨 Pod 安全 |
| OpenSandbox 命令锁、活动命令表在内存 | `opensandbox/provider.ts:433–475, 2500–2516` | 不能据 PG 绑定就宣称任意 Pod 定向取消/共享上下文串行均已成立 |
| 阿里云残留命令台账无 sweep 核对分支 | `aliyun/provider.ts:188–193, 273–289, 324–338` | SaaS 在执行中重启后，已结束命令的旧 PG 行可能持续阻塞 snapshot；需要重启故障测试 |
| 三后端 snapshot 完成时机不同 | OpenSandbox 返回 creating；Vercel unsupported；阿里云等待 ready | 前端/调用方不能假定统一异步响应时延 |
| 文件通知未纳入 provider 契约 | `contract.ts` 无 watch/subscribe，三实现没有统一文件事件桥 | UI 实时更新不能由“文件 API 可用”推导；既有 SSE T9.11 失败需单独解决 |

### C. 持久化和成本边界

- 阿里云官方复核记录：独立 Snapshot 默认七天、单次实例活跃上限 86400 秒；当前未做长期归档、过期刷新和安全轮转。保活不等于永久运行，快照不等于永久存储。见 `docs/test-cases/sandbox/aliyun-snapshot-official-review-2026-10-25.md`。
- Vercel 有快照保留参数，但统一 snapshot 目录 API 未实现；OpenSandbox 的 refresh/GC 策略不能自动覆盖另外两个后端。
- 阿里云 sweep 每个实例约每 15 秒检查并给 keepalive 续期；每个 SaaS 实例都会启动自己的 sweep。Vercel 也有周期扫描，不能按一个 Pod 的调用量估计多 Pod 成本。
- `maxConcurrentCommands*` 当前主要落在 OpenSandbox isolated/detached 上；不能当成三后端统一的全局限流。
- Vercel/阿里云完整命令输出落在工作区；当前 run 代码没有对应日志 GC，长期使用与快照体积应关注。

## 7. 文档与配置漂移

这些不是本轮产品修改项：

- `sandbox/README.md:14` 仍称阿里云“暂停/恢复”，与当前独立 Snapshot、禁止自动 resume 的实现不符。
- `config.ts:18–19,172` 保留 pauseEnabled 字段，但本轮搜索 core 源码没有实际使用者。
- `contract.ts:73–75` 把 snapshot 描述为立即返回后台完成，阿里云实际同步确认；`contract.ts:137–138` 仍说 endpoint 无 scheme，而新后端返回完整 HTTPS URL。
- 旧架构说明“文件全部通过命令输出”已不准确；应区分原生文件通道和命令降级。

## 8. 建议的整理顺序（先讨论，不在本轮实施）

1. **先确定产品契约**：idle 与 keepalive、临时/持久化默认值、停止与永久删除、快照有效期与丢失时行为、后台任务的恢复承诺。
2. **优先修正确性与数据安全**：阿里云 idle CAS、killed 收敛、快照到期策略；再补多 Pod readiness/端口更新/取消测试。
3. **建立三后端共同验收矩阵**：工具/文件、命令取消、MCP、Code Mode、Tool Host、Plugins/Skills、HTTP/WS、重启/跨 Pod、恢复点与清理。明确 N/A 与功能缺口，不用“接口存在”代替验收。
4. **只复用真正相同的逻辑**：根归属、PG 创建租约、generation 校验、能力声明和统一错误；保留各后端命令模型、网关鉴权和 Snapshot 编排。
5. OpenSandbox 大文件可按创建/连接、命令执行、后台回收逐步内聚拆分，但不把代码搬迁当作当前首要修复，也不为对齐行数引入万能生命周期引擎。

本轮没有新跑单测/E2E，没有重新核验云平台文档；上述实测结论均指向已有验收记录，其余按静态差异或待验证风险标注。
