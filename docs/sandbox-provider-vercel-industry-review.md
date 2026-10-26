# Vercel 沙箱方案二次审核：产品对比与修订建议

日期：2026-10-24。范围：设计审核，不是实现验收。

落实状态：审核建议已合并到 `sandbox-provider-vercel-design.md` Revision 2；本文保留问题发现时的初稿行号作为历史定位。主方案是当前实施基线，本文不代表 P0/API 验证已经完成。

## 结论

**总体架构符合成熟产品的接入模式，但当前 Draft 不能直接作为实施基线。**

前次审核低估了持久化、命令执行和断线恢复的语义差异。“接口已完全覆盖”“persistent 等价现有 snapshot”“三段式逐字复用即可”均需收回或加限制。

保留 SaaS 执行 Agent、沙箱只执行代码；保留 PG 会话绑定、根会话共享、幂等启动及就绪检查。修正生命周期和执行语义，不把 Vercel API 硬塞成 OpenSandbox 的同义实现。

本文是对原 Draft 及首次审核的补充、更正；发生冲突时以本次发现为准。没有修改运行时代码，没有创建计费资源，没有执行真实沙箱测试。

## 一、其他产品实际采用什么方式

以下来自官方公开文档。它们证明公开契约，不证明其内部数据库实现，也不能替代我们自己的实测。

| 产品 | 官方公开方式 | 对我们的启示 |
|---|---|---|
| LangChain Deep Agents | Agent 在服务端运行，通过 backend 访问远程沙箱；适配 Vercel、E2B、Daytona、Modal 等；应用管理生命周期 | 当前“AI 在 SaaS、文件与命令在沙箱”的分工正确。适配层应薄，不能复制一套 Agent/工具注册系统 |
| Vercel Sandbox | named sandbox 是稳定身份，session 是一次 VM 运行；stop 自动保存文件系统，resume 创建新运行；onResume 重启后台服务 | 停计算不等于删除工作区；不能把每次闲置回收都实现为 stop 再 delete |
| E2B | pause/resume 保留文件系统和内存；可配置超时 pause、请求 auto-resume；公开入口可要求 traffic access token | “文件恢复”和“进程恢复”必须分开建模；公开 URL 不应依靠保密性保护 |
| Daytona | 保留身份的 stop/start；容器 stop 保留文件，VM pause 可保留内存；提供 preview header token 和有期限的 signed URL | 明确区分 stop、pause、archive、delete；控制通道与用户预览的认证策略分别管理 |
| Modal | 文件快照、内存快照、Volumes 是不同能力；提供 readiness probe；tunnel URL 虽随机仍公开，并可限制入口 CIDR | 不能以一个 snapshot 布尔值掩盖语义；addressability 不等于 readiness 的现有原则正确 |

## 二、必须修正的发现

### 1. 快照会停机，不能接到现有在线 checkpoint 上

- **位置**：原方案第 29、138、193 行及 §7.7。
- **情况**：已有 turn checkpoint/周期 refresh，希望保存代码但继续服务；Vercel 官方明确 `snapshot()` 后沙箱自动关闭、不可达。
- **后果**：直接映射会中断 preview、MCP、Tool Host 和后台进程。`stop()+delete()` 还把稳定 named workspace 的正常休眠变成永久删除。
- **最小修正**：区分“停止计算”“永久删除”“在线检查点”。Vercel 正常闲置执行 stop，保留 name；需要永久清理才 delete。禁用不兼容的在线 checkpoint 并明确能力缺口；如果业务必须保持现有 checkpoint 保证，则该能力补齐前不能宣称完整兼容。
- **依据**：[Vercel snapshots][S2]、[Vercel persistence][S1]；Modal 也明确区分文件快照、内存快照和存储卷 [S7][S8]。

### 2. onCreate 不能作为禁止数据丢失的前置防线

- **位置**：原方案第 194 行。
- **情况**：官方说明快照过期时 `getOrCreate` 会删除旧沙箱、创建同名新沙箱，再触发 onCreate。回调里抛错已晚于删除/重建。
- **后果**：无法兑现“恢复失败禁止冷启动”；同名新环境可能掩盖原工作区丢失。
- **最小修正**：PG 已有绑定时走严格 retrieve/resume，失败明确返回恢复错误，禁止回退 create/getOrCreate。只有 PG 确认首次创建、且持有创建租约时才 create。远端丢失与首次创建必须是不同分支。绑定还应包含运行代次，防止同名重建被当成原实例。
- **依据**：[S1] 明确列出过期后的删除、重建和回调顺序；本仓库 `sandbox/create-lease.ts:8-23` 已提供跨 pod 创建仲裁。

### 3. 当前 Code Mode 不支持透明断线续跑

- **位置**：原方案第 181-182 行及 P3。
- **情况**：`core/src/codemode/runner.ts:130-145` 在连接打开时发送 execute；`containers/sandbox/opt/codemode-runner.ts:222-226` 在 socket close 时取消执行。协议没有查询/重新附着执行的接口。
- **后果**：简单“自动重连”会失败；重发 execute 则可能重复已执行的写文件、shell 或外部 API 副作用。
- **最小修正**：执行提交前允许重连；提交后断线报告执行结果不确定，禁止自动重放。透明恢复另立协议能力：执行归属不依赖 socket、执行状态查询、结果缓存、子工具调用去重。当前 `RunInput` 的“不重放不确定写操作”原则必须保留。
- **依据**：`provider.ts:60-64`；Vercel 长连接建议只说明传输可能中断，不等于我们的应用协议已支持恢复 [S3]。

### 4. 固定单个 MCP 端口会破坏多 MCP 能力

- **位置**：原方案第 175 行。
- **情况**：`session/mcps.ts:57` 从 9100 开始，`:382-387` 为各 MCP 分配未使用端口；`tool-host-protocol.ts:5` 已固定为 9912。原方案却提出 MCP=9912、Tool Host=9913。
- **后果**：不仅无必要改动 Tool Host，还不能支撑同会话两个以上独立 MCP bridge。
- **最小修正**：保留现有内部端口分配。第一阶段用有界端口集合并给出明确上限和容量错误；动态更新整组 ports 时必须跨 pod 串行合并，避免互相覆盖。超过平台入口配额再评估一个带认证的统一 HTTP/WS 路由入口，不先重构全部 bridge。
- **依据**：上述代码；Vercel ports 有数量限制且 update 替换全量配置 [S4]。

### 5. 把 RunInput.detached 直接映射 SDK.detached 是错误的

- **位置**：原方案第 131、157 行。
- **情况**：`provider.ts:71-75` 的 detached 意思是“命令上下文不清理”，不是“run 立即返回”；`tool/plugin/shell.ts:213-224` 已经把用户命令包在 nohup 中，等待启动器返回。
- **后果**：SDK 提前返回可能漏掉启动错误；保存的 cmdId 是短命启动器，不是后台任务，kill 已结束的启动器不能取消实际任务。此前补充的 pid 文件若记录的仍是启动器，也没有解决问题。
- **最小修正**：等待启动器完成并保留当前返回契约；后台任务另外记录实际进程组或 SDK 直接启动的真实任务句柄。取消需匹配 root session、运行代次、operationID；先 TERM、限时后 KILL。快照中的旧 pid 文件不得跨代次使用，防止 PID 重用误杀。

### 6. 公网执行入口鉴权必须是 MVP 前置

- **位置**：原方案第 199-200、259 行。
- **情况**：当前允许 dev/test 依赖“不可枚举 URL”，将认证推迟到 P3。这里暴露的是可执行任意代码的服务，而不只是展示页面。
- **后果**：URL 经日志、浏览器、错误报告泄露后即可被直接访问；egress 白名单不能代替 ingress 认证。
- **最小修正**：MVP 同时具备 HTTP/WS 握手认证，缺少认证拒绝启动外部入口；凭据仅用于沙箱内部入口，不能使用 Vercel 管理 token。用户 preview 单独签发短期凭据，禁止复用内部执行凭据。将认证、headers、URL 作为连接目标契约整体处理，不只增加 scheme。
- **依据**：E2B 要求 traffic token [S5]；Daytona 区分 preview header token 与 signed URL [S6]；Modal 明确随机 tunnel URL 依然公开 [S9]。未找到足以证明 Vercel 原生提供同等 ingress 认证的证据，必须由适配层补齐或验证后使用官方机制。

### 7. 多 pod 的运行代次和取消状态必须持久化

- **位置**：原方案第 118、157、277-279 行。
- **情况**：方案强调进程内 single-flight，却没有完整继承 PG 创建租约；还建议将 operationID→cmdId 的 JSON 塞入 `command_session_id`。两个 pod 并发读改写该 JSON 会丢记录。以同名 sandbox 当唯一身份，还会混淆 resume 后的新 VM 与旧进程状态。
- **后果**：重复初始化、漏取消、旧 pod 误停新 VM。环境变量切换也不能改变已有绑定的实际提供方。
- **最小修正**：复用现有创建租约、generation 校验和 session execution lease，不新增第二套所有权机制。明确持久化 provider、provider scope（Vercel team/project）、稳定 sandbox 身份、运行代次；活动命令使用可独立 CAS 更新的记录，不复用另一语义的单字符串字段。环境默认只决定新绑定，已绑定会话按持久化 provider 路由。
- **依据**：`sandbox/create-lease.ts:8-23`；`sandbox/provider.ts` 已调用 `generation.ts`；Core AGENTS.md 明确 Session execution lease 与 Bus 锁不能互相替代。此处是针对本项目多 pod 部署的推导，不声称是厂商内部实现。

## 三、应同步修正的事项

1. **预算分离**：boot/resume 有自己的预算，命令 timeout 从实际执行阶段计算；不应偷偷把调用方 10 秒改成 60 秒。`timeoutMs=0` 必须继续表示无命令超时，不等于无沙箱生命周期上限。
2. **持久化不静默降级**：明确请求 PVC 时返回不支持，不应“配置报错、会话却自动降级”。Vercel Drives 是独立存储能力 [S4]，不能直接等同 K8s PVC，也不能把将来的 Drives 设计成当前支持承诺。
3. **接口按能力表达差异**：增加最少必要能力信息，如 checkpoint 是否打断运行、是否恢复内存、支持哪些存储模式；不必做庞大的通用插件框架。
4. **密钥不随意注入环境**：Vercel 已支持边界外 egress header 注入 [S10]；支持的 HTTPS 凭据优先代理注入。Git/SSH 等不兼容路径单独验证，不宣称所有 clone 都能代理注入。
5. **计费纠错**：当前 pricing 页将 5 CPU 小时、420 GB-hours 等列在 Hobby Included，不是 Pro 额外免费额度；Pro Data Transfer 当前列为 Flat Rate CDN。原 §4.3 表不能当账单依据。[S11] 的计算价格可用于估算，真实 CPU 活跃率、网络及折扣仍需实测。

## 四、建议采用的最终结构

- 业务工具、权限、MCP/skills/agents 的发现与物化保持现有统一路径，不创建 provider 专属工具注册系统。
- **公共会话编排**：根会话绑定、PG 创建租约/运行代次、活动保活、销毁权限与可观测性。
- **薄 provider 适配**：远端命令、文件、连接目标、停止/恢复和能力描述。复用现有小模块，不复制整个 2916 行 OpenSandbox provider。
- **Vercel 工作区生命周期**：首次 create → PG 绑定 → retrieve/resume → 初始化所需服务并探测就绪 → 执行 → idle stop；永久清理走独立 delete。
- **Code Mode**：保持 SaaS 主动连接及三段式；鉴权先行，提交后不确定失败不重放。跨 pod 不引入沙箱 IP 直连或 pod 亲和性。
- **功能发布门槛**：不支持在线 checkpoint 必须公开为能力限制；若要求对现有 snapshot 语义完全等价，则应暂缓宣称可替换。

这比原方案更接近上述产品的公开实践，但在真实 API 验证前仍不能称为已验证最佳实现。

## 五、进入实现前的验收门槛

1. 两个 SaaS pod 并发 boot/init：仅一次有效创建；失去租约的 pod 不能覆盖新绑定。
2. 快照缺失/过期：明确恢复失败，不能冷启动新工作区；回调抛错不作为唯一保护。
3. 同一根会话及子会话配置两个 MCP，加 Tool Host、Code Mode：均连接到正确实例。
4. WS 执行中断线：有副作用命令不重放；结果不确定状态正确传给调用方。
5. shell 后台任务：启动错误被捕获；跨 pod 定向取消真实任务且不误杀其他操作。
6. resume 后 daemon 重启：旧 pid/endpoint 缓存失效；旧代次的 cancel/destroy 不影响新代次。
7. 未认证的 HTTP/WS 被拒绝；preview 凭据不能用于内部执行端口。
8. stop 与 delete 区别正确；不支持的在线快照和 PVC 请求明确拒绝。
9. 文件密集工具延迟、真实资源账单、大小文件/Range 行为有基准数据。

真实 E2E 必须在 Docker 中运行 SaaS，使用独立 PG 测试库和 Vercel 项目，通过 API 驱动，按流式输出规范订阅 SSE；校验结果、过程、PG 数据。无 Vercel 实测和 SDK 固定版本前，不能把 fake SDK 测试等同接入成功。

## 来源

- [S1] https://vercel.com/docs/sandbox/concepts/persistent-sandboxes
- [S2] https://vercel.com/docs/sandbox/concepts/snapshots
- [S3] https://vercel.com/docs/sandbox/concepts
- [S4] https://vercel.com/docs/sandbox/sdk-reference
- [S5] https://docs.e2b.dev/network/restrict-public-access
- [S6] https://www.daytona.io/docs/en/troubleshooting
- [S7] https://modal.com/docs/guide/sandbox-snapshots
- [S8] https://modal.com/docs/guide/sandbox-exit-snapshots
- [S9] https://modal.com/docs/guide/tunnels
- [S10] https://vercel.com/docs/sandbox/concepts/firewall
- [S11] https://vercel.com/docs/sandbox/pricing
- [S12] https://docs.langchain.com/oss/python/deepagents/sandboxes
- [S13] https://www.langchain.com/blog/the-two-patterns-by-which-agents-connect-sandboxes
- [S14] https://docs.e2b.dev/sandbox/persistence
- [S15] https://www.daytona.io/docs/en/persistence
- [S16] https://modal.com/docs/guide/sandbox-networking

[S1]: https://vercel.com/docs/sandbox/concepts/persistent-sandboxes
[S2]: https://vercel.com/docs/sandbox/concepts/snapshots
[S3]: https://vercel.com/docs/sandbox/concepts
[S4]: https://vercel.com/docs/sandbox/sdk-reference
[S5]: https://docs.e2b.dev/network/restrict-public-access
[S6]: https://www.daytona.io/docs/en/troubleshooting
[S7]: https://modal.com/docs/guide/sandbox-snapshots
[S8]: https://modal.com/docs/guide/sandbox-exit-snapshots
[S9]: https://modal.com/docs/guide/tunnels
[S10]: https://vercel.com/docs/sandbox/concepts/firewall
[S11]: https://vercel.com/docs/sandbox/pricing
