# Vercel Sandbox：T19 接口验收结果

日期：2026-10-24。结论：**T19.1–T19.6 PASS**。此前接入预检的 BLOCKED 已解除；不代表完整 Agent 后端验收通过。

## 环境与方法

- 独立 Docker 镜像 `opencode-saas:vercel-t19-20261024`；主、副实例端口 15106/15107，共用专用 PG `opencode-v2-vercel-test`。
- provider 为 Vercel，SDK 固定 3.8.0，持久化模式 snapshot；主实例自动 keep-alive，副实例 lazy boot、idle-reap=60 秒。
- 原四份 `*-v2.mjs` 脚本及断言未修改。新增 `scripts/sandbox-vercel-t19.mjs` 包装器，创建会话后先订阅公共 SSE，再将响应交给原执行器；额外保留 PG、远端绑定和清理证据。
- keep-alive 同时订阅双实例 SSE；idle-reap 只重启本次测试副容器，SSE 共连接三次。原有 `opencode-saas` 未重启或重配置。

## 最终结果

证据目录：`artifacts/vercel-t19-20261024/final/`。每组保留 `result.json`、`events.json`、`executor.log`。

| 用例 | 结果 | 证据与覆盖 |
|---|---|---|
| T19.1 命令与事件持久化 | PASS | `exec-api-workspace/`：HTTP 204、退出码、实时事件、回放、PG；额外 pwd 返回 `/workspace` |
| T19.2 自动 boot、跨实例连接 | PASS | `keepalive/`：自动创建、第二实例复用 PG sandbox ID、双实例 SSE |
| T19.3 release、kill、重建 | PASS | `keepalive/`：release 清除偏好，kill 保留偏好，停止后恢复及新运行代次 |
| T19.4 延迟启动 | PASS | `lazy/`：boot=false 只写偏好，首次 shell 才创建并继承偏好 |
| T19.5 错误与 fork | PASS | `exec-api-workspace/` 与 `keepalive/`：非零退出、请求校验、fork 不自动 boot、首次 shell 和删除 |
| T19.6 重启与闲置回收 | PASS | `idle-reap/`：重启复用原 ID、旧 time_updated 被回收、keep_alive 保留、SSE 重连 |

最终 PG 五条绑定均为 `provider=vercel/state=destroyed/remote_name=NULL`。原脚本已删除会话，包装器再次删除得到 404 是预期。

只读远端复核：五个最终测试沙箱均返回 404；按各自 name 枚举快照，无未删除快照。证据为 `final/cleanup-verification.json`，不是仅凭 delete 请求成功推断清理完成。

## 发现、修复与回归

首次 T19.1 失败现场保留在 `artifacts/vercel-t19-20261024/exec-api/`：Vercel 服务端拒绝 `timeout=0`，返回 HTTP 400（timeout 至少 100）。统一契约的 0 表示无限制，现转换为省略 SDK timeout 字段；补充契约回归后，用最终镜像重新跑原脚本通过。

- 本地回归：127 pass、3 skip、0 fail，420 assertions，10 文件。三个跳过来自未配置 PG 的 session-tool-gate 用例。
- 专用 PG 回归：29 pass、0 fail，102 assertions，覆盖 provider、创建租约和执行 gate。
- Core typecheck、相关 oxlint、迁移一致性检查均通过。

## 能力边界

本次补齐 provider 注册、PG 路由/创建租约、命令与文件适配、根/子会话共享、保活、停止/恢复、永久删除和 idle-reap。

**尚不支持/未验收**：Code Mode sandbox runner、Session MCP/Tool Host 端口认证连接、preview、自定义 VCR 镜像、显式快照目录与统计、完整模型轮次和大型文件压力测试。配置保留 sandbox executor 默认值，但本组纯 shell API 用例没有模型轮次，不能证明 Code Mode 生效。端口能力保持关闭，显式快照相关接口明确报不支持；不得作为 OpenSandbox 的完整替代后端发布。

## Agent 链路与端口补测（2026-10-24，独立 model 实例）

环境：镜像 `opencode-saas:vercel-agent-20261024`（含 runner 资产与端口网关），专用库 `opencode-v2-vercel-model2-test`，模型 `deepseek/deepseek-flash`（凭据仅注入测试库与私有挂载，未入库）。

此后端口能力已从“关闭”改为“公网 URL + token 网关”，原“尚不支持”名单以此节结论为准：

| 能力 | 结果 | 证据 |
|---|---|---|
| 端口网关 + token | PASS | Vercel 公网路由 → `/t/<token>` 网关 → 沙箱内服务；宿主与容器内 initialize 均 200，错误 token 404，明文 http 400；Vercel 边缘确实转发 `mcp-session-id` / `mcp-protocol-version` / 自定义头 |
| Code Mode 模型链路（sandbox runner） | PASS | `session.tool.* name=execute` 成功，最终回复 1024；runner 打包资产由镜像构建期生成、按沙箱物化到 `/opt`，WebSocket 经 token 网关 |
| Tool Host 自定义工具 | PASS | `chain_probe` 工具成功，回复 `TOOL-HOST-OK` |
| Session 本地 MCP 桥接 | BLOCKED（上游握手） | 桥接与网关均已运行（9100 initialize 200，19100 网关 pid/日志正常）；同版本 SDK + supergateway + 网关在本地可连接并列出 `echo` 等工具；经 Vercel 公网路由时 `notifications/initialized` 返回 400 空体，服务端日志 `failed to connect session MCP … Error POSTing to endpoint` |

上表 MCP BLOCKED 为 supergateway 阶段记录，已由下节原生桥接最终验收解除。

**本轮修复的两个产品缺陷**（均先复现后验证）：

1. 沙箱桥接启动命令被自身 `pkill -f` 匹配杀掉：启动 argv 同时包含 `supergateway … --port 9100`，在带 procps 的镜像（Vercel/ubuntu）上直接杀死启动 shell。真实 Vercel 沙箱对照：旧命令 `exit 143`、无 pid/进程；新命令 `exit 0`、bridge 存活。改成 `SGBIN`/`SGBIN_PORT` 变量拼接，并补回归测试。
2. 曾尝试调整 MCP 首选协议版本兼容 supergateway，但未解决后续握手问题。改用原生桥接后已移除这项全局兼容修改，MCP 客户端继续使用原协议协商逻辑。

**跨域压力（4 GiB 工作区）**：创建 34.9s、fs/list 1.1s、20k 文件搜索 2.8s、小文件读 1.4s、2 GiB 读按上限 404（1.1s）、kill+快照 6.9s、恢复 4.8s、恢复后 sha256 校验 3.3s、删除+purge 7.8s；恢复后 2 GiB 文件与 2 万文件树完整。证据 `artifacts/vercel-files-20261024/stress`。

**该阶段遗留问题**：supergateway 握手阻塞、停止 wrapper 遗留 stdio 子进程、Tool Host 收尾健康检查偶发 502。前两项后续采用下节原生桥接处理；Tool Host 收尾问题仍未宣称修复。历史汇总：`artifacts/vercel-agent-chain-20261024/summary.json`。

## 原生 HTTP MCP 桥接（方案 1）

用户选择自研桥接替换 supergateway 后，新增 `packages/core/src/session/mcp-http-bridge.ts`，由 SaaS 写入会话工作区，沿用命令启动、端口网关寻址、SaaS 主动连接的通信路径。不需要在沙箱安装 supergateway。

- 单个桥接进程拥有一个 stdio 子进程树，HTTP POST 转发 JSON-RPC，GET SSE 转发通知。
- 每次转发重映射请求 ID，响应恢复调用方 ID，避免不同 HTTP 调用使用相同 ID 时串包；UTF-8 使用流式解码。
- SIGTERM 清理整个 stdio 进程组，随后 KILL 兜底；避免只停 shell wrapper 遗留 npx/server。
- 认证仍由 Vercel token 端口网关负责，不能直接暴露内部桥接端口。

首轮成功证据为 `artifacts/vercel-agent-chain-20261024/run10/`：Code Mode 返回 1024、Tool Host 返回 TOOL-HOST-OK、`execute` 内嵌调用 `everything.echo` 完成并返回 Echo: MCP-CHAIN-OK，PG 后检均 destroyed/remote_name=NULL。run9 的失败是测试断言只认顶层工具、未识别 Code Mode 嵌套调用；修正断言后重跑，不把文本回复单独作为 MCP 成功依据。

补充回归：`mcp-http-bridge.test.ts` 验证重复请求 ID、中文、通知、非法 JSON 以及 stdio 进程树停止；`session-mcps.test.ts` 覆盖启动命令、旧桥接清扫和真实 stdio→HTTP 协议连接。

**最终镜像验收：PASS**。镜像 `opencode-saas:vercel-native-mcp-20261024`，证据目录 `artifacts/vercel-agent-chain-20261024/final/run/`。三个场景全部通过，公共 SSE 含 `everything.echo` 的 completed 状态与工具成功输出，不只检查最终文本。三个 PG 绑定均为 destroyed/remote_name=NULL。`final/cleanup-verification.json` 只读确认三个远端沙箱均 404、无未删除快照。

最终回归：本地 171 pass、3 skip、0 fail（569 assertions，16 文件）；独立 PG 31 pass、0 fail（118 assertions）。Core/Server typecheck、相关 oxlint、迁移一致性检查通过。三个 skip 是本地未配置 PG 的 gate 用例，独立 PG 回归已执行。日志副本位于 `final/checks/`。

能力边界：此实现不支持 server→client 请求（如 sampling/elicitation，明确回复 method-not-found），也不宣称完整多客户端隔离/多 pod 同时初始化、SSE 断线重放或任意大型 MCP 消息压力已验收。已有 stdio 服务依赖这些能力时，不应直接切换。
