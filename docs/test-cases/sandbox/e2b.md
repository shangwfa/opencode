# E2B 官方云沙箱

## 配置

在 SaaS 部署环境注入（不要提交真实 Key）：

```sh
OPENCODE_SANDBOX_ENABLED=true
OPENCODE_SANDBOX_PROVIDER=e2b
E2B_API_KEY=<secret>
OPENCODE_SANDBOX_VOLUME_TYPE=snapshot
OPENCODE_SANDBOX_TIMEOUT_SECONDS=600
OPENCODE_SANDBOX_IDLE_REAP_SEC=120
OPENCODE_E2B_TEMPLATE=base
OPENCODE_E2B_RUNNER_ASSET=/app/packages/core/dist/sandbox-runner.mjs.gz
OPENCODE_CODEMODE_EXECUTOR=sandbox
```

`Dockerfile` 已配置 runner asset 默认路径，镜像构建时生成该文件。`OPENCODE_E2B_INSTALL_RIPGREP` 默认 true：模板缺少 rg 时使用 root 安装；生产建议把 rg 和 runner 预装到模板，减少每次创建成本。

默认官方域名和 API 固定为 `e2b.app` / `https://api.e2b.app`，不会读取阿里云端点，也不会被进程中的 `E2B_API_URL` 改到其他后端。当前使用仓库已有 `e2b@2.31.0`，未增加或修改依赖。

会话需要持久化时显式指定 `sandbox.persistMode=snapshot`。本次实测 `base` 模板为 2 vCPU / 512 MiB，应指定 `cpu: "2", memory: "512Mi"`；CPU/内存属于模板属性，不是逐次 create 的资源覆盖。自定义模板填写其实际资源。未指定持久化或 `persistMode=none` 为临时工作区。OpenSandbox PVC 不支持。

## 实现与安全边界

- `sandbox/e2b/provider.ts` 是独立后端入口，PG `sandbox.provider=e2b`；根会话与子会话共享物理沙箱。切换新会话默认后端不会改派既有绑定。
- E2B 与阿里云复用 `e2b-shared/` 的 SDK、命令、文件、网关、PG 租约和快照恢复实现，不复制两份生命周期代码；快照分别存 `e2b_snapshot` 和 `aliyun_snapshot`，不共用目录。
- E2B 作用域包含官方 API 地址和 API Key 的 SHA-256 指纹，PG 不存原始 Key。相同 API 上不同凭据不能把对方的 404 判为本会话丢失。**轮换 Key 会改变作用域**：必须先确认并迁移既有绑定的账号归属，不能直接切 Key 后自动认领旧绑定。测试 Key 建议验收后轮换，生产接入前先确定正式凭据。
- 所有新实例都启用 secure access，`allowPublicTraffic=false`；任意端口的 HTTP/WS 使用 SDK 的真实 host 和 `e2b-traffic-access-token`。token 只供 SaaS 内部连接，浏览器走现有 SaaS 代理，不返回 token。
- 第一版实现独立快照语义：在线拍快照，确认后停止源实例，下一次 boot 从快照创建新实例并推进 generation。未确认快照、失去租约、模糊创建失败均不盲目重放，不回退空工作区。
- 沿用命令台账、孤儿命令终态对账、丢失实例 CAS 收敛和 capture-only 意图恢复。命令/文件操作不依赖 Pod 亲和性。
- 暂不启用 E2B 原生 pause/resume、auto-resume、Volume、filesystem-only snapshot 等不同生命周期策略；暂停实例不会被 readiness/endpoint/boot 隐式恢复。不能把“E2B 原生支持”当成“本服务已暴露”。
- 标准快照会短暂停顿并断开连接；MCP、Runner 和 Tool Host 继续使用现有就绪探测/重连机制。模板须满足官方 snapshot 的 envd >= 0.5.0 要求。
- `onTimeout=kill`，不自动暂停。持久会话应启用续期并把 idle reap 配置在远端 TTL 之前（示例 120s / 600s）；进程故障或远端硬超时仍可能丢失最近一次 ready 快照之后的写入，不承诺零数据丢失。快照保留/成本策略仍按项目既有边界另行处理。

## 官方依据

读取日期：2026-10-26。

- https://docs.e2b.dev/llms.txt
- https://docs.e2b.dev/sandbox.md
- https://docs.e2b.dev/sandbox/snapshots.md
- https://docs.e2b.dev/sandbox/persistence.md
- https://docs.e2b.dev/network/restrict-public-access.md
- https://docs.e2b.dev/network/public-url.md
- https://docs.e2b.dev/sandbox/secured-access.md

E2B 的暂停持久化和独立快照是不同能力；本次只对齐当前 SaaS 独立快照契约，不把内存态保留、无限保留或特定套餐时长扩大成未经验证的服务保证。

## 验证

专用 PG `opencode-v2-e2b-support-test`，Docker SaaS 两个 Pod 15160/15161，镜像 `opencode-saas:e2b-support-20261026`，真实官方 E2B `base` 模板。

- SDK 预检：2 vCPU / 512 MiB，envd 0.10.0，Node 20.9.0，secure token 和独立快照可用。预检实例及快照已删除。
- API/SSE/PG：文本/二进制读取、目录枚举、在线快照不更换 generation、保存后停机、另一 Pod 恢复文件校验和与新文件、新实例/generation、snapshot restored_count 均通过。
- 任意端口网关：匿名请求 403、SaaS 代理 200；独立快照恢复后 HTTP 服务仍返回原内容。
- 真实模型 Code Mode：恢复前、另一 Pod 恢复后各一轮 `execute` 均返回 1024，公共 SSE 保存了工具调用与执行成功事件。自动回答 pending 表单。
- SDK 双端点测试：静态 snapshot list/delete 显式沿用各实例 apiUrl，不修改全局环境；为 E2B 与阿里云混合部署提供回归保护。

执行器：`docs/test-cases/scripts/e2b-snapshot-api.mjs`（复用参数化的原快照验收）、`sandbox-vercel-session-mcp-t22.mjs` F 阶段（通用 provider 包装）。证据目录：`artifacts/e2b-support-20261026/`。最终回归、跨 Pod MCP 和资源清理结果在该目录日志及专项报告中记录。

### 最终结果（2026-10-26）

- **126 pass / 0 fail，10 个单测文件**，包含 E2B、阿里云、Vercel、创建租约、执行 gate 和 MCP bridge 回归；typecheck、oxlint、migration check 均通过。
- **双 Pod MCP F 阶段 4/4 通过**：健康 bridge PID 1712→1712，慢调用不被另一 Pod 发现过程杀死，模糊失败的副作用一次且不重放，死亡 stdio 派发前恢复。公共 SSE 的 slowEcho running、另一 Pod execution.started、slowEcho success 顺序分别为 90/100/102，证明确实存在重叠。
- 快照 API 全链路通过，恢复前后两轮真实 Code Mode 均返回 1024，恢复后服务进程也可经私有网关访问。见 `snapshot/result.json`。
- 初轮单测 66 pass / 1 fail：SDK host 被创建租约的 complete 覆盖成配置域名，区域 host 断言失败。现将 SDK host 一并传给租约完成，避免自行拼接丢失区域域名；最终回归已覆盖。失败日志 `e2b-unit.log` 保留。
- 新增迁移 `20261026114630_e2b_snapshot.ts`，已同步 migration.gen.ts、schema.gen.ts、schema.json 和 pg-schema.sql。
- PG 会话、MCP、命令、E2B 快照、阿里云快照、活动绑定全部为 0。4 个本轮云实例（含预检）逐个 `not-found`，各自快照目录均为空。两个测试容器已停止并删除，临时凭据文件已删除，原始 API Key 扫描无泄露。
- 没有启用原生 pause/resume，没有自动提交代码，也没有改动其他后端的持久化策略。后续如需暂停持久化，应独立设计 PG 状态及恢复代次，不能直接给 `connect` 增加隐式 resume。

## 本轮修复（2026-10-26）：Tool Host 在 Node < 20.11 沙箱启动即崩（影响所有后端）

E2B 扩展验收首节发现自定义工具 `Session Tool Host capability/identity mismatch`。根因：`session/tool-host/{host,worker}.ts` 使用 `import.meta.dirname`（Node 20.11+ 才支持），E2B `base` 模板 Node 20.9.0 下为 `undefined`，`path.join(undefined, ...)` 启动即崩，9912 永不监听（网关报 “port is not open”）。OpenSandbox 镜像 Node 较新所以从未暴露；任何 Node < 20.11 的模板均受影响。

修复：改用 `path.dirname(fileURLToPath(import.meta.url))`，重建三件套产物（artifact `4ae29cfd…`），在 E2B Node 20.9 实测 `HEALTH 200`（protocolVersion=1、身份回显正确）。连锁的“启动看似卡住”现象均为该崩溃后模型反复重试工具、每次走满 45 秒健康探测循环所致，非启动路径变慢（实测 create 1.3s + ripgrep 5.4s + bun 5.1s）。

## 本轮修复（2026-10-26）：插件 Agent 重启后 hook 永久失效（影响所有后端）

扩展验收 plugins 节的确定性证据（inbox 载荷）发现：kill 掉 `/tmp/plugin-agent.pid` 后，后续轮次的 user 消息**未被 hook 改写**（模型读取插件源码后模仿标记作答，会让只看最终文本的弱断言假通过）。根因两处叠加：

1. `session/plugins.ts` 的 `ensure` 在缓存 agent 健康时直接复用，`launch` 拉起的新 agent 为空配置且无人 `/configure`——被杀重启后 hook 全程失效。
2. `invalidate` 的 configure 用 5 秒超时且 `Effect.ignore`——配置含 npm 安装时远超 5 秒，跨 Pod 更新/并发 upsert 的配置被静默吞掉。

修复：`launch` 在健康探测通过后同步注入 PG 插件配置（120 秒超时、失败闭合），覆盖 kill 恢复、跨 Pod 更新（invalidate 清缓存后必经 launch）与并发 upsert 三处。验收断言同步加严：以 user 消息确为改写文本为准，杜绝模型模仿假通过。

## E2B 扩展能力验收最终结果（2026-10-26/27）：六类 13 项全部通过

真实双 Pod（15170/15171）+ 专用 PG `opencode-v2-e2b-extensions-test` + 官方 E2B `base` 模板，经公共 SSE wrapper 驱动真实模型轮次（deepseek 欠费后切换 xiaomi/mimo-v2.6-pro），断言只认 tool part、SSE、PG、inbox 载荷与确定性 shell 证据：

| 类别 | 检查项 | 证据 |
| --- | --- | --- |
| 自定义工具 | Tool Host 执行、progress、upsert 版本切换、kill-sandbox 后新代次恢复 | tool part `v1:1→v2:1`、progress 事件 |
| skills | Session 注册 + 显式 attachment；沙箱发现 + 脚本资源执行 + 删除 | REVIEWER_OK、sourcePath、脚本输出 |
| commands | 重复名折叠稳定、sandbox 优先、执行展开获胜模板 | user 消息 = 模板正文 |
| agents | 沙箱发现、子会话共享根沙箱、PG 零写入 | child 列表 + 子会话扫描结果 |
| plugins | hook 真实改写 + 源码脱敏；抛错/超时 fail-open；npm/code 故障隔离；Agent 被杀后恢复；跨 Pod 更新与并发 upsert 后消费 PG 胜者；删除清零 | **inbox user 消息改写文本逐一核对**（杜绝模型模仿假通过） |
| MCP | 本地 stdio 注册、真实 completed 调用、删除 | 嵌套 `shared.echo` completed |

执行器 `docs/test-cases/scripts/e2b-extensions.mjs`（wrapper 公共 SSE + 自动答表单 + PG/远端清理）。证据：`artifacts/e2b-support-20261026/extensions8`（前两节）与 `extensions12`（后四节最终通过）；`extensions12/events.json` 的 inbox 载荷为 hook 改写的确定性证据。插件相关单测 41/41 通过（plugin、plugin-failure、session-mcps）。

清理：PG 各表（sessions/mcps/commands/tools/plugins/agents/inbox/sandbox_commands/activeBindings）全部为 0；按 `opencode_session` metadata 全账号扫描 E2B 零残留（`extensions-account-sweep.json`），逐实例快照目录为空；测试 Pod 已停止。deepseek 凭据欠费（402）已切换 xiaomi 凭据完成，未修改任何凭据。

注意事项：验收过程还发现 mimo 会读取沙箱内插件源码后模仿标记作答，弱断言（只看最终文本）会被假通过——最终以 inbox 的 prompt 改写文本为准。queue 投递停驻问题见下文待讨论项。

## 既有 4 项 PG 失败（2026-10-27）：已定位并修复，非产品缺陷

`session-runner.test.ts` 在 PG 上曾有 4 项失败，与 E2B 改动无关，本轮已修复：

| 用例 | 根因（有据） | 处理 |
| --- | --- | --- |
| generates the title while the first model step is still running | 测试用先进先出脚本喂模型响应；PG 上请求顺序是 `["step","title"]`（SQLite 下相反），标题请求拿到 `Stream.never` 导致挂起 | 测试改为按请求内容路由（session 系统提示含 `Generate a title.`） |
| coalesces title generation while a request is active | 同上，且断言 `requests[0]` 必须是标题请求 | 同上，断言改为「存在标题请求」 |
| retries title generation from the first prompt after title and execution failures | 同上，且断言固定下标 `requests[2]/[4]` | 同上，断言改为「3 个标题请求都以首个用户消息为输入」 |
| preserves a stale subagent child session in its model-visible failure | 用例用 `json_set(...)` 直接改行，该函数只在 SQLite 存在，PG 报错 | 改为读行 → 改 `state.metadata` → 写回，两库通用 |

证据链：先把两段脚本都改成合法文本后，PG 下标题生成与 `session.renamed` 正常发生（请求顺序仍是 step 先行），证明产品行为正确、问题在测试脚本的投递顺序假设；随后按内容路由改写用例。修复后整文件在 PG 上 217 pass / 0 fail（此前 213 / 4）。

为支持内容路由，`@opencode/ai` 的测试客户端补了 `serve(responder)`（与内部 `Test` 服务一致，仅测试面）。

## 待查现象：queue 命令曾留在收件箱（2026-10-27 补测后修正结论）

E2B 扩展验收曾观察到 queue 命令留在收件箱；目前不能确定其原因，也不能认定其它沙箱后端存在相同缺陷。

- **原始证据**：`artifacts/e2b-support-20261026/` 日志及诊断会话 `ses_e8797f023ffeKXhDXRJ73klTe6` 的 inbox/消息行核对。有限观察窗口只能证明当时未投递，不能证明永久停驻或唤醒被抢。
- **测试框架修正**：`session-runner.test.ts` 现在把 coordinator 的 scope 传给 runner，并在 Location 继续执行时保留 scope；不修改生产调度代码。
- **新增确定性用例**：已有 shell 型合成通知时，一次 input 唤醒可依次处理两条 queue 输入且各投递一次；steer 执行中到达的 input 唤醒不被后续 steer 唤醒覆盖；只有 steer 唤醒时 queue 保持暂停，显式 input 唤醒后再执行。另加强用户停止后不自动重启的既有用例。
- **单测结果**：上述 4 项及另外 6 项既有调度回归，各用独立临时 PG 库运行，10/10 通过；coordinator 全文件 26/26 通过；typecheck、oxlint 通过。日志见 `artifacts/queue-dispatch-20261027/`。
- **完整 runner 回归**：`session-runner.test.ts` 整文件（217 项）在本专用 PG 库执行 213 通过 / 4 失败；4 项失败（3 项标题生成、1 项子会话 JSON 更新）用未修改的 HEAD 测试文件在同一源码上单独复跑同样 4 项全部失败，判定为既有问题，与本次测试框架改动的 scope 透传无关。
- **HTTP 双 Pod 验收**（`docs/test-cases/scripts/queue-command-http.mjs`，真实 API + 真实 PG + 本地 OpenSandbox 沙箱 + 门闩模型探针，5/5 通过）：
  1. 真实 `POST /shell` 成功后在收件箱留下 steer 通知，随后 `POST /command`（queue）一次唤醒依次消费通知与命令，各投递一次（Pod A、Pod B 各一轮）。
  2. Pod A 执行中被门闩挂起时，Pod B 入队命令：租约 owner 不变，收尾后原执行者消费一次。
  3. Pod B 入队后用户 `POST /interrupt`：租约有界释放、queue 项保留、1 秒观察内无新模型请求；随后新命令唤醒即恢复，两条命令各投递一次。
  4. Code Mode 默认开启，`execute` 在真实会话沙箱内完成并返回 1024。
  证据：`artifacts/queue-dispatch-20261027/http7/`（`result.json`、`events.json`、`requests.json`、逐会话消息与收件箱快照）。
- **结论**：单测与真实 HTTP 双 Pod 链路都未复现“steer 通知抢走唤醒”。不实施无条件收尾补 input 唤醒——第 3 项正是用户停止后 queue 必须保持停驻的契约。
- **边界**：本轮 queue 验收用的是最小 arm64 测试镜像（仅 node/python/rg/git + Code Mode runner），不含浏览器/LSP/插件/MCP——这些扩展能力已改用全功能沙箱镜像单独覆盖，见下节。
- **复跑方式**：`BASE=<podA> BASE_SECONDARY=<podB> PG_URL=<专用测试库> bun docs/test-cases/scripts/queue-command-http.mjs`。脚本内置 OpenAI 兼容门闩探针（默认端口 18194），会话与命令在 `finally` 里删除；`QUEUE_OUT` 指定证据目录。生产 Pod 需注入 `OPENCODE_SANDBOX_PROTOCOL=http` 才能连本地控制面，且自建 arm64 沙箱镜像须自带 `/opt/opencode-codemode-runner.mjs`。

## 全功能沙箱镜像补测（2026-10-27）：浏览器 / 插件 / Session MCP 在本地 OpenSandbox 通过

E2B base 模板缺浏览器等扩展，改用本地 OpenSandbox + 全功能沙箱镜像（`packages/containers/sandbox/Dockerfile`，arm64，含 chromium / cdp-browser / agent-browser 0.39.4 / codegraph / 插件 agent / LSP daemon / pty agent / Code Mode runner）补齐这些能力的真实验收。

**构建更正**：先前误用根 `Dockerfile`（SaaS 镜像）产出 `opencode-opensandbox:local`，导致浏览器验收报"缺 cdp-browser 启动脚本"。已改用 `docker buildx build --platform linux/arm64 -f packages/containers/sandbox/Dockerfile --build-context repo=<repo> --load .` 重建，镜像以 root 运行、`/workspace` 可写（先前"需 root 变体"的判断不成立）。

| 能力 | 检查项 | 结果 |
| --- | --- | --- |
| 浏览器（CDP） | chromium + CDP 网关就绪（`/usr/local/bin/chromium`、agent-browser 0.39.4） | ✓ |
| | CDP 真实打开页面并回报标题（`BROWSER_PROBE_5BCBD4`） | ✓ |
| | 目标列表含 4 个可连 webSocketDebuggerUrl | ✓ |
| 插件 | hook 改写 prompt 且源码脱敏（以 user 消息改写为准） | ✓ |
| | 抛错 / 超时均 fail-open | ✓ |
| | 沙箱内 npm/code 插件故障隔离 | ✓ |
| | plugin agent 被杀后下一轮自动恢复 | ✓ |
| | 跨 Pod 并发 upsert 后运行时消费 PG 胜者 | ✓ |
| | 插件删除后 PG/Agent 清零且会话可用 | ✓ |
| Session MCP | 注册、真实 completed 调用与删除（`shared.echo` 返回 `Echo: e2b-mcp-extensions`） | ✓ |
| commands | 重复名折叠、沙箱优先且执行获胜模板 | ✓ |
| agents | 沙箱发现与子会话共享根沙箱 | ✓ |

证据：浏览器 `artifacts/queue-dispatch-20261027/browser/`（`result.json`）；插件/MCP/commands/agents `artifacts/queue-dispatch-20261027/extensions/`（`checks.json` 9 项、`events.json`、`turn-1..11.json`）。hook 真实改写以 `events.json` 的 user 载荷为准（`Reply with exactly E2B_PLUGIN_mvq0a56k...` 出现于初始/kill 恢复/插件更新三处），fail-open 两例原文透传——杜绝模型读源码模仿假通过。

清理：会话 204 删除、沙箱绑定 destroyed、PG 各表清零、测试 Pod 与 OpenSandbox server 已停、专用测试库已删。模型用 `Yd-DeepSeek/deepseek-v4-flash`（free 系列触发额度限制不可用）。生产/本地差异：本地 Docker runtime 需 `OPENCODE_SANDBOX_PROTOCOL=http` 才能连本地控制面。
