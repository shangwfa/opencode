# OpenCode SaaS 会话沙箱终端迁移方案

## 1. 方案结论

将当前运行在 OpenCode SaaS Server 主机上的 PTY manager 和 shell 进程移动到会话对应的沙箱中，其他层尽量保持不变。

```text
迁移前

packages/app
  -> OpenCode SaaS Server /pty
  -> packages/core/src/pty.ts
  -> SaaS Server 主机 node-pty
  -> SaaS Server 主机 shell

迁移后

packages/app
  -> OpenCode SaaS Server /pty
  -> SandboxPtyGateway
  -> 会话沙箱 opencode-pty-agent
  -> 原有 packages/core/src/pty.ts
  -> 沙箱 node-pty
  -> 沙箱 shell
```

核心原则：

- App 继续使用现有 `ghostty-web`、TerminalProvider、TerminalPanel 和命令体系。
- 对外继续使用现有 `/pty` API 名称和响应结构。
- WebSocket 继续使用现有 PTY wire protocol。
- 原有 `Pty.Service` 的 create/get/list/update/remove/connect、buffer、cursor、resize 和事件语义保持不变。
- SaaS Server 从 PTY 执行节点变成会话路由、鉴权和流量代理节点。
- 不增加本地 PTY fallback。沙箱不可用时终端明确失败。

## 2. 目标与边界

### 2.1 目标

- 终端 shell、子进程、文件访问和环境全部位于会话沙箱。
- 终端和 Agent 工具访问同一个 `/workspace`。
- 保持 vim、htop、Ctrl-C、Tab、交互 REPL 和 resize 等真实 TTY 能力。
- 保留现有终端输出重放和断线重连行为。
- 尽量不改变 App 组件和用户交互。
- SaaS Server 不再启动用户 PTY 子进程。

### 2.2 不做的事情

- 不用 `SandboxProvider.runInSession` 模拟终端。
- 不引入 ttyd/wetty 自带前端和私有终端协议。
- 不设计一套新的 `/session/:sessionID/pty` 产品 API。
- 不让浏览器直接访问沙箱 endpoint。
- 不在沙箱销毁后恢复旧进程。
- 不长期维护本地与沙箱两套 PTY 运行时。

## 3. 保留与修改范围

### 3.1 保持不变

| 层 | 保持内容 |
| --- | --- |
| App 渲染 | `ghostty-web`、FitAddon、SerializeAddon、主题、字体、复制粘贴、链接打开 |
| App 面板 | 新建、关闭、拖拽、切换、聚焦、标题编号、自动创建 |
| App 命令 | `terminal.toggle`、`terminal.new`、`terminal.close` 等 |
| HTTP API | `/pty`、`/pty/:ptyID`、`/pty/:ptyID/connect-token` 路径和主体结构 |
| WebSocket | `/pty/:ptyID/connect` 及 text/binary 输入输出 |
| Wire protocol | 普通输出帧和 `0x00 + { cursor }` meta frame |
| PTY schema | `Pty.Info`、`CreateInput`、`UpdateInput`、`PtyID` |
| PTY manager | 2 MiB buffer、64 KiB replay chunk、cursor、subscriber、resize、teardown |
| 公共事件 | `pty.created`、`pty.updated`、`pty.exited`、`pty.deleted` |
| 恢复逻辑 | 连接失败后 get 检查、PTY 不存在时 clone、客户端 buffer 恢复 |

### 3.2 必须修改

| 层 | 最小修改 |
| --- | --- |
| App 请求 | 所有 PTY 请求和 WebSocket 增加 `sessionID` 路由参数 |
| App 缓存 | 从 workspace scope 改为 session scope，避免同目录不同沙箱复用 PTY ID |
| Server handler | 不再调用本地 Location-scoped `Pty.Service`，改为调用 `SandboxPtyGateway` |
| Server connect | 完成现有 ticket 校验后，将 WebSocket 双向代理到沙箱 Agent |
| 沙箱镜像 | 启动 `opencode-pty-agent`，内部运行原有 PTY manager |
| 创建准备 | shell、cwd 和基础 env 在沙箱内解析，禁止复制 SaaS Server 的 `process.env` |
| 事件 | Agent 事件通过内部 event stream 转发为现有公共 PTY 事件 |
| 生命周期 | 活动 PTY 持有沙箱 lease，最后一个 PTY 删除或退出后释放 |

## 4. 为什么复用原有 PTY manager

`packages/core/src/pty.ts` 已经实现完整运行逻辑：

- 使用 `@lydell/node-pty` 或 `bun-pty` 创建真实 PTY。
- `list/get/create/update/remove/resize/write/connect` 服务接口。
- 每个 PTY 维护 2 MiB 输出环形窗口。
- 每次 WebSocket 连接根据绝对 cursor 增量重放。
- 重放按 64 KiB 分片。
- 支持多个 subscriber。
- PTY 退出时发布 `pty.exited` 并清理。
- 服务释放时终止全部 PTY。

这些逻辑不应在 SaaS Server 和 Agent 两处各实现一次。目标是把同一个 Core PTY layer 装配到 Agent 进程中，SaaS Server 只实现远程 adapter。

## 5. 目标组件

### 5.1 `opencode-pty-agent`

沙箱镜像内新增一个内部服务：

```text
opencode-pty-agent
  -> Core Pty.Service
  -> Core Pty node/bun adapter
  -> shell process
```

建议作为独立 package 和进程，原因：

- 生命周期独立于 execd 命令执行。
- 可直接复用 Core Schema、Pty Service 和 protocol。
- Agent 崩溃不会影响 SaaS Server。
- 可以单独设置资源、健康检查和协议版本。

Agent 监听固定内部端口，例如 `4097`。该端口只允许 Sandbox 平台私网和 SaaS Server 访问。

### 5.2 `SandboxPtyGateway`

SaaS Server 新增远程 gateway：

```text
sessionID
  -> resolveSandboxOpts(sessionID)
  -> SandboxProvider.get/getOrCreate(rootSessionID)
  -> SandboxProvider.getEndpoint(rootSessionID, 4097)
  -> Agent HTTP/WebSocket
```

Gateway 对 Server handler 提供与现有 `Pty.Interface` 对齐的方法：

```text
list
get
create
update
remove
connect endpoint
events endpoint
```

Gateway 不保存 PTY 进程状态。Agent 是 PTY 状态权威源。

### 5.3 Server PTY handlers

保留现有 HttpApi group、endpoint identifier 和响应 schema。handler 内部从：

```text
LocationServiceMap -> local Pty.Service
```

改为：

```text
sessionID -> SandboxPtyGateway -> sandbox Pty.Service
```

## 6. 会话路由

### 6.1 路由参数

现有 PTY API 增加必需 query：

```text
sessionID=<current session id>
```

示例：

```text
GET    /pty?sessionID=ses_xxx
POST   /pty?sessionID=ses_xxx
GET    /pty/:ptyID?sessionID=ses_xxx
PUT    /pty/:ptyID?sessionID=ses_xxx
DELETE /pty/:ptyID?sessionID=ses_xxx
POST   /pty/:ptyID/connect-token?sessionID=ses_xxx
WS     /pty/:ptyID/connect?sessionID=ses_xxx&cursor=123&ticket=...
```

现有 `directory` / workspace routing query 可以在过渡期继续携带，但不能再用于选择 PTY 执行位置。

### 6.2 根沙箱解析

Server 使用现有 `resolveSandboxOpts(sessionID)`：

```text
requested sessionID
  -> parent chain
  -> root sessionID
  -> pvcMode/appId/resource limits
  -> session sandbox
```

子会话与父会话可能映射到同一沙箱，但请求仍携带当前 sessionID。Agent 以请求 sessionID
作为 PTY owner；即使共享 root sandbox，父子 Session 的 list/get/update/remove 也互相隔离。App 同样按当前
session 保存标签状态。

这样避免要求 App 新增 root-session discovery，同时终端进程仍进入正确的根沙箱。

### 6.3 App 缓存作用域

当前终端缓存按 workspace 共享。迁移后必须至少加入 `sessionID`：

```text
serverScope + directory + sessionID
```

原因：同一 directory 下的两个 session 可能对应不同沙箱。旧 PTY ID 不能带到另一个沙箱连接。

这属于必要的状态隔离改动，其他 TerminalProvider API 保持不变。

## 7. Agent 内部 API

Agent API 是私有协议，可以直接镜像现有公开 PTY API：

```text
GET    /health
GET    /pty
POST   /pty
GET    /pty/:ptyID
PUT    /pty/:ptyID
DELETE /pty/:ptyID
WS     /pty/:ptyID/connect?cursor=<cursor>
GET    /pty/events
```

### 7.1 Health

```json
{
  "status": "ready",
  "protocolVersion": 1,
  "agentVersion": "..."
}
```

Server 在首次请求该沙箱 Agent 时检查 protocolVersion。版本不兼容时返回明确错误，不使用本地 PTY。

### 7.2 HTTP 语义

Agent 尽量直接使用现有 `Pty.Info`、`Pty.CreateInput` 和 `Pty.UpdateInput`，减少转换层。

Server 到 Agent 的 create payload 应是可移植输入，不能包含 SaaS Server 主机解析后的 cwd 和完整环境。

### 7.3 WebSocket 语义

直接复用当前协议：

- Browser 输入 text/binary UTF-8。
- Agent 将输入写入 PTY。
- Agent 输出普通 text frame。
- 连接时根据 cursor 重放 retained buffer。
- 重放完成后发送 `0x00 + JSON.stringify({ cursor })`。
- `cursor=-1` 表示从当前末尾开始，不重放历史。

SaaS Server 原样转发 frame，不解析和重组终端输出。

## 8. Shell、cwd 和环境

这是迁移中唯一不能照搬 SaaS Server 本地值的部分。

### 8.1 cwd

当前默认 cwd 是 Server 的 Instance directory。迁移后默认 cwd 必须是：

```text
/workspace
```

处理规则：

- 未指定 cwd：使用 `/workspace`。
- cwd 等于原 workspace directory：映射为 `/workspace`。
- 明确指定沙箱绝对路径：规范化后传入 PTY。
- 指向 SaaS Server 主机且无法映射的路径：返回 BadRequest，不静默回退。

### 8.2 shell

默认 shell 在 Agent 内解析：

1. Server 配置指定的 shell 在沙箱内存在时使用它。
2. 否则使用沙箱 `$SHELL`。
3. 否则按 `/bin/bash`、`/bin/sh` 顺序选择。
4. 根据 shell 保留现有 login 参数语义，例如 bash 增加 `-l`。

App 当前通常只传 title，因此常规路径不发生 UI/API 行为变化。

### 8.3 env

不能继续将 SaaS Server 的 `process.env` 复制到终端，否则会把服务端凭据带入用户沙箱。

目标组合顺序：

```text
Agent 进程安全基础环境
  + Sandbox/session 环境
  + 允许传入的 CreateInput.env
  + 允许传入的 shell.env 插件结果
  + TERM=xterm-256color
  + OPENCODE_TERMINAL=1
```

Server 必须通过 allowlist 过滤插件环境。API 行为保持 env overlay，但环境来源切换为沙箱，这是执行位置变化带来的必要差异。

### 8.4 `pty.shells`

`GET /pty/shells` 不能再调用 SaaS Server 的 `Shell.list()` 作为终端 shell 来源。

建议：

- 有 sessionID 时查询对应 Agent 的 shell 列表。
- 全局设置页没有 sessionID 时返回标准沙箱镜像支持的 shell catalog。
- 如果 SaaS 只支持固定镜像，可固定返回 `/bin/bash`、`/bin/sh` 中镜像保证存在的项。

## 9. HTTP 请求流程

### 9.1 Create

```text
App sdk.client.pty.create({ sessionID, title })
  -> Server 验证 session
  -> resolveSandboxOpts
  -> SandboxProvider.getOrCreate
  -> 等待 Agent health ready
  -> POST Agent /pty
  -> Agent 在 /workspace 创建 PTY
  -> 返回原有 Pty.Info
  -> Server 原样返回 App
```

只有 create 可以触发新沙箱创建。get/update/remove/connect 不应为了恢复旧 PTY 隐式创建空沙箱。

这样现有 App 恢复流程仍成立：

1. connect 失败。
2. `get` 返回 404，确认旧 PTY 已不存在。
3. App 调用现有 clone/new。
4. create 创建或获取沙箱并生成新 PTY。

### 9.2 Get/List/Update/Remove

- 使用 `SandboxProvider.get` 获取现有沙箱。
- 沙箱不存在时按 PTY not found/unavailable 语义返回。
- update 的 title 和 size 直接转发。
- remove 杀掉沙箱 PTY，不操作 SaaS Server 主机进程。
- 响应继续使用原有 schema。

## 10. WebSocket 请求流程

```text
Terminal.tsx
  -> POST /pty/:id/connect-token?sessionID=...
  -> Server 校验 Origin 和 PTY 是否存在
  -> ticket 绑定 sessionID + rootSessionID + ptyID
  -> WS /pty/:id/connect?sessionID=...&cursor=...&ticket=...
  -> Server 验证 ticket
  -> Server 获取 Agent endpoint
  -> Server upgrade browser socket
  -> Server connect Agent socket
  -> 双向原样代理
```

继续复用：

- `PtyTicket.Service` 的短期、scope-bound ticket；有效期内允许同 scope 网络重试。
- `WebSocketTracker` 的服务关闭行为。
- Effect Socket 的双向代理模式。
- 当前异常关闭后的 App 指数退避重连。
- 当前 `gone()` 的 get 检查和 clone 恢复。

### 10.1 Ticket scope

现有 ticket scope 包含 directory/workspace。迁移后增加：

```text
requested sessionID
rootSessionID
ptyID
```

防止一个 session 的 ticket 被用于连接另一个沙箱中的同名 PTY。

### 10.2 关闭码

- 用户正常关闭：1000。
- Agent/沙箱暂时不可达：1011。
- Server 下线：沿用 `WebSocketTracker.SERVER_CLOSING_EVENT()`。
- ticket/Origin 失败：upgrade 前返回 403。

## 11. PTY 事件转发

App 继续监听原有全局事件：

```text
pty.created
pty.updated
pty.exited
pty.deleted
```

Agent 暴露内部 `/pty/events` stream。Server 的 `SandboxPtyEventRelay` 将 Agent 事件映射并发布到现有 EventV2/兼容事件出口。

要求：

- 公共事件 schema 不变。
- `pty.exited` 仍使 `packages/app/src/context/terminal.tsx` 自动移除 tab。
- inactive tab 即使没有 WebSocket 连接，退出事件也必须送达。
- 多实例 SaaS 环境按 at-least-once 投递，App 对退出/删除事件做幂等处理；不能依赖 exactly-once。

多实例推荐使用已有共享事件基础设施；如果当前事件总线仅进程内，则必须满足以下一种条件：

1. session 请求和事件连接具有稳定粘性路由；或
2. Agent event 写入共享 pub/sub，由各 Server 实例消费；或
3. App 的现有事件连接由 Server 动态桥接当前 session 的 Agent stream。

最终对 App 仍表现为原有 PTY 事件，不新增产品层事件模型。

## 12. 沙箱生命周期

### 12.1 创建

- App 打开终端并执行现有 `terminal.new()`。
- create 请求触发 `SandboxProvider.getOrCreate`。
- SandboxProvider 等待镜像和 Agent ready。
- Agent 创建 PTY。

### 12.2 活跃状态

Agent 的 running PTY 快照是 lease 聚合的权威来源。创建首个 PTY 前设置共享
`keep_alive=true`；退出或删除后重新查询 Agent，只有确认没有 running PTY 才释放。释放后再次查询，
若并发创建了新 PTY则立即恢复 keepAlive。WebSocket 心跳刷新 active 时间，但不决定 PTY 生命周期，
因此浏览器刷新时 PTY 继续运行。

### 12.3 沙箱销毁和 Agent 重启

- 沙箱销毁会丢失全部 PTY。
- Agent 重启会丢失由其管理的 PTY。
- 旧 ID 的 get/connect 返回 404。
- App 使用现有 clone 恢复成一个新 shell。
- 现有 SerializeAddon buffer 可以保留旧屏幕，但不能恢复旧进程状态。
- 不在 SaaS Server 创建本地 PTY 作为恢复。

## 13. App 最小改造

### 13.1 `context/terminal.tsx`

- cache key 增加 `params.id`。
- 每个 workspace terminal session 保存绑定的 sessionID。
- `new/update/clone/close` 调用增加 sessionID。
- 其余 all/active/focus/move/next/previous 行为保持。
- `pty.exited` 监听保持。
- persisted 数据换版本，旧本地 ptyID 不迁移。

### 13.2 `components/terminal.tsx`

- `connectToken/get/update` 增加 sessionID。
- `terminalWebSocketURL` 增加 sessionID query。
- ghostty、输出 writer、resize debounce、cursor、reconnect、copy/paste 保持。
- 不增加另一套 terminal component。

### 13.3 `terminal-panel.tsx`

- 面板、tab、handoff、drag、focus 行为保持。
- 切换到不同 session 时加载对应 session scope 的 terminal state。
- 连接错误仍复用 recover/clone。
- 沙箱创建阶段可以调整文案，但不改变交互模型。

### 13.4 settings

- shell 列表改为沙箱 shell 来源。
- 终端字体、主题、keybind 等设置保持。

## 14. Server 最小改造

### 14.1 HttpApi schema

- 在 PTY endpoint query 中加入 sessionID。
- 保持 endpoint path、identifier、payload、success 和现有错误结构。
- connect query 保留 cursor、directory、ticket，并增加 sessionID。
- 修改公开 HttpApi 后在 `packages/client` 运行 `bun run generate`。
- 完成后按仓库要求重新生成 legacy JavaScript SDK。

### 14.2 Handler

- 保留 `ptyHandlers` 和 `ptyConnectHandlers`。
- 替换 LocationServiceMap/local Pty 调用为 SandboxPtyGateway。
- 保留 CORS、ticket、schema decode、WebSocketTracker 和错误映射。
- handler 保持薄层，不直接包含 Sandbox SDK 调用细节。

### 14.3 本地 `Pty.Service`

迁移期间 Core `Pty.Service` 仍保留，因为 Agent 直接复用它；但 SaaS Server 的 HttpApi layer 不再装配或调用本地 Location PTY。

最终状态：

- Core PTY manager 存在。
- Sandbox Agent 使用 Core PTY manager。
- SaaS Server 只使用 SandboxPtyGateway。
- SaaS Server 主机没有用户 PTY 进程。

## 15. 安全

### 15.1 SaaS Server 到 Agent

- Agent endpoint 不返回浏览器。
- Agent 端口仅开放在 Sandbox 平台私网。
- 使用每沙箱 credential 或平台提供的等价强认证。
- credential 只能通过 header 传递，不能放 URL 和日志。
- 多 Server 实例必须可以读取同一沙箱 credential。

### 15.2 环境隔离

- 禁止把 SaaS Server `process.env` 传入沙箱 PTY。
- cwd 默认 `/workspace`。
- PTY Agent 使用沙箱普通用户。
- 沙箱不挂载 SaaS Server 文件系统、Docker socket 或服务凭据。

### 15.3 Browser 到 Server

- 沿用 Origin/CORS 校验。
- ticket 使用短 TTL、绑定 session/location/ptyID，并在有效期内允许同 scope 重试。
- sessionID 必须通过授权校验，不能只相信 query。
- ptyID 操作必须在解析后的目标沙箱内查询，禁止跨沙箱访问。

## 16. 多实例 SaaS 要求

- PTY 状态位于会话沙箱，不位于 Server 实例。
- HTTP 和 WebSocket 可以由不同 Server 实例处理。
- `SandboxProvider` 的 session 到 sandbox 定位必须跨实例一致。
- ticket 使用所有 Pod 共享 secret 的自校验 HMAC，不依赖粘性路由。
- PTY lease 状态持久化在共享 sandbox 记录，并由 Agent running 快照协调，不能只用单进程 `Set`。
- Agent event relay 为 at-least-once；连接到任意实例的 App 必须幂等处理退出/删除事件。

## 17. 错误和恢复语义

| 场景 | 行为 |
| --- | --- |
| session 不存在或无权限 | 404/403，App 不创建终端 |
| 沙箱创建失败 | create 返回 typed 503，不回退本地 |
| Agent 未安装或版本不兼容 | typed 503，提示沙箱镜像不支持终端 |
| Agent 短暂不可达 | WebSocket 1011，App 继续现有退避重连 |
| PTY 不存在 | get/connect 404，App 走现有 clone |
| Agent 重启 | 旧 PTY 404，App clone 新 shell |
| 沙箱销毁 | 旧 PTY 404，create 可创建新沙箱和新 shell |
| Server 实例下线 | WebSocketTracker 关闭，App 重连其他实例 |
| 输出 cursor 仍在 2 MiB buffer | Agent 增量重放 |
| cursor 已早于 buffer 起点 | 保持当前 Core 行为，重放仍保留的 buffer |

第一版应保持当前 Core cursor 行为，不扩展新控制帧，避免 App 协议改造。

## 18. 可观测性

新增指标：

```text
sandbox_pty_create_duration_ms
sandbox_pty_ws_connect_duration_ms
sandbox_pty_ws_active
sandbox_pty_active_total
sandbox_pty_agent_unavailable_total
sandbox_pty_proxy_bytes_in_total
sandbox_pty_proxy_bytes_out_total
sandbox_pty_reconnect_total
sandbox_pty_clone_total
sandbox_pty_lease_active
local_pty_spawn_total
```

上线验收要求 `local_pty_spawn_total = 0`。

结构化日志字段：

```text
requestID
sessionID
rootSessionID
sandboxID
ptyID
serverInstanceID
agentVersion
```

禁止记录用户终端输入、输出、环境变量、ticket、credential 和私有签名 endpoint。

## 19. 性能目标

- 已运行沙箱创建 PTY：P95 小于 500 ms。
- 已运行沙箱建立 WebSocket：P95 小于 300 ms。
- Server 代理增加的输入输出延迟：同区域 P95 小于 50 ms。
- 保持现有 100 ms resize 合并。
- 保持 2 MiB/PTY buffer 和 64 KiB replay chunk。
- Server 代理必须使用 Socket writer 背压，不能自行无限缓存。

实现前记录当前本地 PTY 基线，再用相同用例比较：

- create latency。
- WebSocket connect latency。
- 1 MiB 和 10 MiB 输出吞吐。
- 断线重放时间。
- 20 个终端的 CPU/内存。

## 20. 测试方案

### 20.1 Core PTY 回归

由于 Agent 复用原有 Core PTY manager，原有测试必须在 Agent 装配下再次运行：

- create/get/list/update/remove。
- stdin/stdout。
- resize。
- cursor 和 2 MiB buffer。
- 64 KiB replay chunk。
- 多 subscriber。
- exit/delete events。
- layer teardown。

### 20.2 Agent 集成测试

- 在目标沙箱镜像中启动真实 Agent。
- 验证 node-pty 原生 ABI。
- `/workspace` cwd。
- bash login shell。
- env 不包含 SaaS Server 凭据。
- Agent health/version。
- Agent 重启后旧 PTY 消失。

### 20.3 Server 集成测试

- session 到 root sandbox 路由。
- create 才允许 getOrCreate。
- HTTP payload/response 与旧接口一致。
- ticket 绑定 session 和 ptyID。
- WebSocket 文本/二进制 frame 原样转发。
- close code 和 WebSocketTracker。
- 多实例 create/connect。
- Agent event 转成现有 `pty.exited`。
- 多 PTY lease 不提前释放。
- 不调用本地 `Pty.Service.create`。

### 20.4 App 测试

- 所有 PTY 请求携带 sessionID。
- cache 按 session 隔离。
- new/close/move/focus/next/previous 不回归。
- reconnect/cursor/clone 不回归。
- buffer 和 scroll 恢复不回归。
- `pty.exited` 自动移除 tab。
- 不产生本地 fallback 请求。

### 20.5 E2E

- `pwd` 为 `/workspace`。
- 终端写文件后 Agent 工具立即可见。
- Agent edit 后终端立即可见。
- vim、htop、Tab、Ctrl-C、交互 REPL。
- `stty size` 随面板 resize 更新。
- Browser 刷新后连接同一 PTY。
- 网络断开后 cursor 重放无重复。
- 切换 session 不串到另一个沙箱。
- kill sandbox 后旧 PTY 不可恢复，clone 创建新 shell。
- SaaS Server 进程树中没有用户 shell。

## 21. 发布顺序

### 阶段 0：盘点和基线

- 盘点 App、TUI、CLI、SDK 对 `/pty` 的消费者。
- 记录本地 PTY 性能基线。
- 确认 SaaS 多实例 ticket、event 和 lease 的共享机制。
- 验证目标沙箱镜像支持 node-pty。

### 阶段 1：Agent

- 将 Core PTY manager 装配为 `opencode-pty-agent`。
- 发布包含 Agent 的沙箱镜像。
- 完成 health、HTTP、WS 和 events 测试。
- 此阶段不切换生产 App。

### 阶段 2：Server remote gateway

- 增加 sessionID query。
- 实现 SandboxPtyGateway。
- 将现有 handler 切换到 gateway。
- 实现 Agent event relay 和 Agent 快照协调的共享 lease。
- 生成 Client 和 legacy SDK。

### 阶段 3：App 最小切换

- PTY 调用增加 sessionID。
- terminal cache 改为 session scope。
- WebSocket URL 增加 sessionID。
- 使用新 persisted version，丢弃旧本地 ptyID。

### 阶段 4：灰度

- 先确保目标沙箱镜像全部包含兼容 Agent。
- 按租户或 workspace 灰度 Server/App。
- 功能开关只允许关闭终端，不允许回退本地 PTY。
- 监控 Agent unavailable、reconnect、clone、lease 和 `local_pty_spawn_total`。

### 阶段 5：清理

- 删除 SaaS Server 的本地 Location PTY 装配。
- 删除 App workspace-scoped 旧 persisted 数据迁移路径。
- 保留 Core PTY manager，供 Agent 使用。
- 更新 `/pty` API 文档，明确 sessionID 必需且进程运行在会话沙箱。

## 22. 回滚

禁止运行时 fallback 到本地 shell。允许的回滚方式：

1. 回滚 App、Server 和沙箱镜像到完整兼容版本。
2. 暂时关闭终端入口。
3. 回滚到前一个仍包含兼容 Agent 的沙箱镜像。

Server 与 Agent 维护协议兼容矩阵。发布顺序必须保证新 Server 兼容当前和前一版 Agent，之后才升级镜像。

## 23. 验收标准

- App 终端交互和当前版本一致。
- `/pty` 路径、核心 payload、response、event 和 WebSocket protocol 保持。
- 每个请求通过 sessionID 路由到正确沙箱。
- shell cwd 为 `/workspace`，与 Agent 工具共享文件和进程环境。
- cursor、buffer、resize、clone、exit event 全部保持现有语义。
- 沙箱不可用时明确失败，不创建本地 PTY。
- SaaS Server 不向沙箱传递自身 `process.env`。
- 多终端 lease 正确，不误回收、不永久泄漏。
- 多实例连接和事件投递正确。
- `local_pty_spawn_total` 在灰度和全量阶段均为 0。
- 性能满足目标，且对比基线无不可接受回归。

## 24. 实施前待确认

1. 共享事件基础设施何时提供跨 Pod 去重；在此之前消费者按 at-least-once 幂等处理。
2. 标准沙箱镜像保证提供哪些 shell。
3. 外部 SDK 消费者增加 sessionID 的迁移窗口。
4. bun-pty 在目标沙箱镜像架构上的 ABI 验证矩阵。
