# 本地沙箱桥接（Local Agent Sandbox）

> **方案定位**：在保留远程 OpenSandbox 沙箱的前提下，允许用户通过本地 CLI Agent 把「数据面」下沉到自己的电脑上执行。SaaS 服务端保持控制面（LLM 编排、会话、权限），命令执行按会话级别路由：有本地 Agent 绑定的会话走本地，其余 fallback 远程沙箱。
>
> **三角色架构**：
>
> ```
> 浏览器（测试前端）              SaaS 服务端（Docker :14096）            本地 Agent CLI
> ─────────────────              ─────────────────────────              ──────────────
> fetch :17790/health ────────────┐（浏览器直连检测）
> POST /session/:id/local-agent ──→ AgentRegistry（绑定 session→agent）
> 发消息 / SSE 事件流 ────────────→ SandboxProvider 路由层
>                                 │   ├─ isAvailable=true → LocalAgentChannel ──ws──→ exec/fs 原语（本地执行）
>                                 │   └─ isAvailable=false → 远程 OpenSandbox（K8s/容器）
>                                 └─ ws /agent-ws ←──hello/hello.ack──（Agent 反向连接+自动重连）
> ```

---

## 一、诉求与设计决策

| 决策点 | 结论 |
|---|---|
| 浏览器如何发现本地沙箱 | **浏览器本地检测**：Agent 在 `127.0.0.1:17790` 起 HTTP health server（带 CORS），浏览器轮询 `/health` 拿到 `agentID` |
| 谁决定用本地还是远程 | **自动优先本地**：检测到 Agent 时新建会话自动绑定；未绑定会话走远程沙箱 |
| Agent 服务范围 | **一个 Agent 服务一个用户的所有会话**（一个 ws 连接多路复用） |
| 认证 | 第一期不做（Agent ws、绑定 API 均无认证；上线前必须补，见「安全清单」） |
| 路径映射 | 保留 `/workspace` 虚拟前缀：Agent 启动 `--cwd` 指定真实目录，双向映射 + 命令字符串重写 |
| PTY 数据流 | SaaS 双层 ws 中继（第二期接入，协议已预留） |
| 集成方式 | 新增 `LocalAgentRouterProvider` 实现 `SandboxProvider.Interface`，**上层 14 个消费者零改动** |

---

## 二、组件清单与代码位置

### 2.1 本地 Agent CLI（新包 `packages/agent`，~700 行）

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 入口：`opencode-agent --server ws://host:port/agent-ws --cwd /path`；ws 连接 + 指数退避重连（1s→30s）；SIGINT/SIGTERM 清理 |
| `src/protocol.ts` | ws 消息协议（信封：`{id, type, req/res/stream}`），SaaS 侧共享引用 |
| `src/handler.ts` | 原语实现：exec（`spawn sh -c`，流式输出/超时/中断）、fs.read/readBytes（range+base64）/write/stat |
| `src/path.ts` | `PathMapper`：`/workspace ↔ --cwd` 双向映射 + `rewriteCommand`（命令内嵌虚拟路径重写） |
| `src/local-server.ts` | `127.0.0.1:17790` health server（CORS `*`，`/health` 返回 `{ok, agentID, workdir, agentVersion}`；EADDRINUSE 降级跳过） |
| `src/pty-manager.ts` | node-pty 封装（懒加载，第二期使用） |

### 2.2 SaaS 侧（`packages/opencode/src/agent-local/`，~400 行）

| 文件 | 职责 |
|---|---|
| `registry.ts` | 模块单例 `AgentRegistry.instance`：agent 连接表 + `sessionID→agentID` 绑定表；`unregister` 时 reject 所有 pending、清理绑定 |
| `channel.ts` | `LocalAgentChannel.instance`：请求/流式转发（`Effect.callback`）；120s 超时；`settled` 标志防 resume 双调用；`trackExec` 支持会话级中断 |
| `ws.ts` | `attachAgentWs(server)`：Node http server `upgrade` 事件挂 `/agent-ws`；hello→回 `hello.ack{agentID}`；消息路由到 pending |

### 2.3 路由层与接入点（最小侵入，+300 行改动）

| 文件 | 改动 |
|---|---|
| `tool/sandbox-provider.ts` | 新增 `createLocalAgentSandbox`（Sandbox 形状适配器：`files.*`/`commands.*`/`getEndpointUrl` → channel 转发）+ `LocalAgentRouterProvider`（每个方法先查 `isAvailable(sessionID)`，命中走本地、miss 走原 remote layer；同 tag 包装 `SandboxProvider.defaultLayer`） |
| `tool/registry.ts` | `SandboxProvider.node` / `defaultLayer` → `LocalAgentRouterProvider.node` / `layer`（**AI 工具执行环境走路由层**，两处） |
| `server/server.ts` | `serverLayer` 内 `attachAgentWs(server)`（+2 行） |
| `server/sandbox-proxy.ts` | 新增 3 个路由（见 2.4） |
| `httpapi/server.ts` | `SandboxProvider.defaultLayer` → `LocalAgentRouterProvider.layer`（exec API/PTY 层，2 处） |

### 2.4 新增 HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/local-agents` | 列出已连接 Agent：`{agents: [{agentID, workdir, boundSessions}]}`（前端刷新后恢复绑定标记） |
| POST | `/session/:id/local-agent` | body `{agentID}`；绑定到 **root session**（工具层用 `resolveSandboxOpts` 的 root ID 查询，子会话共享） |
| DELETE | `/session/:id/local-agent` | 解绑（同样 resolve root） |

### 2.5 ws 协议（信封复用请求 ID 关联）

```
SaaS → Agent                          Agent → SaaS
────────────────────────────          ────────────────────────────
{id, type:"hello", workdir, ver}      {id, type:"hello.ack", agentID}        ← 连接握手
{id, type:"exec", req:{cwd,command,
     timeoutMs,env}}                  {id, type:"exec.stream", stream:{event:"stdout"|"stderr", text}}
{id, type:"interrupt"}                {id, type:"exec.result", res:CommandExecution}
{id, type:"fs.read", req:{path,...}}  {id, type:"fs.read.result", res:{data,truncated}}
{id, type:"fs.readBytes", ...}        {id, type:"fs.readBytes.result", res:{data(base64),truncated}}
{id, type:"fs.write", req:{entries}}  {id, type:"fs.write.result"}
{id, type:"fs.stat", req:{paths}}     {id, type:"fs.stat.result", res:Record<path, FileInfo|null>}
{id, type:"endpoint", req:{port}}     {id, type:"endpoint.result", res:{url}}
                                      {id, type:"interrupted"}                ← 中断确认
                                      {id, type:"error", message}             ← 原语执行错误
（pty.create/input/resize/kill/stream 已定义，第二期接入）
```

`CommandExecution` 结构与 OpenSandbox SDK 对齐：`{logs:{stdout:[{text}],stderr:[...]}}, exitCode, error?`。

---

## 三、关键设计细节

### 3.0 SaaS 如何知道哪个前端/会话该用哪个本地沙箱（身份关联机制）

**核心结论：SaaS 不做身份验证，只维护一张前端上报的绑定表（`sessionID → agentID`）。** Agent 与用户的关联靠「浏览器 localhost 可达性自证」，SaaS 信任这个声明。这是第一期内网单用户假设下的简化设计。

完整关联链路：

```
① 同机自证（浏览器 ↔ Agent 在同一台电脑）
   浏览器 fetch 127.0.0.1:17790/health ──→ Agent 本地 server 返回 agentID
   （能访问该 localhost 端口 == 浏览器与 Agent 同机；Agent 已绑 127.0.0.1，
     跨机器访问不到）

② 前端声明绑定（浏览器 → SaaS）
   POST /session/:id/local-agent {agentID}
   SaaS：校验 agentID 在线 → resolveSandboxOpts 找 root session
       → AgentRegistry.sessionBindings.set(rootID, agentID)（进程内存）

③ 任务路由（SaaS 内部，每次工具调用）
   该 session 的任何请求 → 路由层 isAvailable(sessionID)
       命中绑定表 → ws 通道下发到对应 Agent
       未命中     → 远程 OpenSandbox
```

**多用户场景的已知漏洞**：绑定关系无任何身份校验——用户 B 若拿到用户 A 的 agentID（猜测/泄露），可把 B 的会话绑到 A 的 Agent，**A 的电脑将执行 B 的任务**。当前仅适用于单用户可信环境。

**多用户正解（第三期「认证与安全」的核心工作，身份锚点从「前端声明的 agentID」改为「用户登录态」）**：

```
① Agent 启动带用户 token 连 SaaS → SaaS 记录 agentID → userID（服务端持有映射）
② 前端请求带登录态（cookie/JWT）→ SaaS 知道每个请求的 userID
③ 绑定校验或自动绑定：
   POST /session/:id/local-agent 时校验 session.owner == agent.owner
   更优：创建会话时 SaaS 自动查「该 userID 是否有在线 Agent」→ 有则自动绑
   （前端无需传 agentID，localhost 检测降级为纯 UI 提示「本地沙箱已连接」）
④ 执行时：session → userID → 在线 agent → ws 下发（Agent 断线自动摘除）
```

### 3.0.1 SaaS 调用本地沙箱的完整时序（以 bash 工具为例）

```
AI 决定调用 bash 工具（"运行 ls"）
  │
  ① 工具层 shell.ts（SaaS 进程内）
  │     取 ctx.sandboxSessionID（root session ID）
  │     构造命令：cd /workspace && env ... sh -c 'ls'
  │
  ② SandboxProvider.Service（= LocalAgentRouterProvider 路由层）
  │     runInSession(sessionID, command, opts, handlers, signal)
  │     └─ isAvailable(sessionID)? 查 AgentRegistry.sessionBindings
  │         命中（已绑定）↓
  ③ LocalAgentChannel.instance.exec()
  │     生成 reqID → conn.pending.set(reqID, {resolve, reject, onStream})
  │     ws 发送 {id: reqID, type:"exec", req:{cwd:"/workspace", command, timeoutMs}}
  │     （挂 120s 超时 timer + AbortSignal 监听 + trackExec 记录活跃请求）
  │
  ④ Agent 回包按 reqID 路由（ws.ts routeMessage → conn.pending）
  │     exec.stream{stdout}  → pending.onStream → handlers.onStdout（SSE 实时推前端）
  │     exec.result          → pending.resolve → Effect 完成 → CommandExecution
  │
  ⑤ 本地 Agent CLI（用户电脑，handler.ts handleExec）
  │     PathMapper.toReal("/workspace") → /tmp/agent-e2e（--cwd 参数指定的真实目录）
  │     rewriteCommand：命令内嵌的 /workspace → 真实目录
  │     spawn("sh", ["-c", command], {cwd, env})
  │     stdout/stderr 逐块回发 exec.stream；进程退出回发 exec.result{logs, exitCode}
  │
  ⑥ 结果逐级返回 → 工具输出 → AI 继续推理循环
```

文件工具（read/write/edit）走同一条通道，只是入口不同——`ctx.sandbox` 是 `getOrCreate` 返回的 `createLocalAgentSandbox` 适配器：

```
sb.files.readFile("/workspace/a.ts")  → ws {type:"fs.read"}      → Agent: fs.readFile(真实路径)
sb.files.writeFiles([{path, data}])   → ws {type:"fs.write"}     → Agent: fs.writeFile
sb.files.getFileInfo([path])          → ws {type:"fs.stat"}      → Agent: fs.stat
```

**通道要点**：

| 点 | 说明 |
|---|---|
| ws 连接方向 | **Agent 主动反向连 SaaS** `/agent-ws`（用户电脑可能无公网入口），断线指数退避重连（1s→30s） |
| 多路复用 | 一条 ws 连接用 `reqID` 关联请求/流式/结果三阶段，一个 Agent 服务该用户所有会话 |
| fallback | Agent 断线 → `unregister` reject 全部 pending + 清绑定 → 后续 `isAvailable=false` → 自动走远程沙箱 |
| 路径约定 | SaaS 侧全程使用虚拟路径 `/workspace/...`；真实路径只有 Agent 知道（`--cwd` 映射），SaaS 永不感知宿主机路径 |

### 3.1 会话级路由（fallback 语义）

`LocalAgentRouterProvider` 对 `SandboxProvider.Interface` 的每个方法（`getOrCreate/get/runInSession/runDetached/interrupt/getEndpoint/keepAlive/touch/...`）统一模式：

```ts
if (yield* LocalAgentChannel.instance.isAvailable(sessionID)) → 走本地 channel
else → 委托原 remote 实现（pgLayer 或单机 layer，行为完全不变）
```

- `isAvailable` 查询 `AgentRegistry` 的绑定表（进程内存），Agent 断线时 `unregister` 清空绑定 → 自动 fallback 远程
- `ctx.sandbox`（`getOrCreate` 产物）：本地会话返回 `createLocalAgentSandbox` 适配器（`read.ts`/`write.ts`/`edit.ts` 的 `sb.files.*` 调用经 ws 转发）
- `runInSession`/`runDetached`：本地模式下统一为同一 exec 原语（无需持久 shell——`shell.ts` 本就每条命令拼 `cd {cwd} && env ...`，cwd/环境变量每次显式传递）

### 3.2 路径映射与命令重写

- **路径参数**：`PathMapper.toReal("/workspace/x")` → `{--cwd}/x`
- **命令字符串**：`rewriteCommand` 用 `\/workspace\b` 正则把命令内嵌虚拟前缀重写为真实目录（`shell.ts` 拼接的 `cd /workspace && ...`、AI 自己写的 `ls /workspace` 都覆盖）
- **原因**：宿主机不存在 `/workspace`，不重写会 `cd: /workspace: No such file or directory`

### 3.3 请求生命周期与竞态防护（channel.ts）

- **settled 标志**：Effect 的 `resume` 只允许调用一次。工具 abort/timeout 先结束后，Agent 迟到响应再次 resolve 会抛 defect 并**拖垮 ws 连接**（实测断连根因），`settled` 保证只生效一次
- **超时**：单请求 120s（timer + `Effect.timeoutOrElse` 双保险）
- **abort**：`AbortSignal` 触发时向 Agent 发 `interrupt` 并 reject
- **会话级中断**：`trackExec` 维护 `sessionID → Set<reqID>`，`interruptSession` 批量发 interrupt；pending 结算时通过 `onSettle` 回调解除跟踪
- **Agent 断线**：`unregister` reject 所有 pending（"Agent disconnected"）+ 清空该 agent 的会话绑定

### 3.4 浏览器检测与绑定流程

```
1. Agent 启动 → ws 连 SaaS /agent-ws → hello → hello.ack(agentID) → :17790/health 暴露 agentID
2. 浏览器（每 5s 轮询 :17790/health + SaaS /local-agents 交叉确认连接状态）
3. 新建会话 → POST /session/:id/local-agent {agentID}（SaaS 绑定 root session）
4. 前端 localBound 集合驱动「本地」绿标 + 输入框模式提示；刷新后从
   /local-agents 的 boundSessions 恢复显示
```

---

## 四、环境搭建与端到端验证

### 4.1 启动（本地 PG + 远程沙箱组合）

```bash
# 1) TCP 转发（15432→本地 PG，30040→远程沙箱）
#    见 docs/local-test-env.md 组合说明

# 2) 构建 SaaS 镜像（含 agent-local 代码）并启动
cd /Users/ruomu/code/opencode
docker build -t opencode-saas-sandbox-test:localagent -f Dockerfile .
docker run -d --name opencode-saas-test -p 14096:4096 \
  -e OPENCODE_DATABASE_URL=postgresql://local@host.docker.internal:15432/opencode \
  -e OPENCODE_SANDBOX_DOMAIN=host.docker.internal:30040 \
  -e OPENCODE_SANDBOX_API_KEY=<key> \
  -e OPENCODE_SANDBOX_USE_SERVER_PROXY=true \
  -e DEEPSEEK_API_KEY=<key> \
  opencode-saas-sandbox-test:localagent

# 3) 启动本地 Agent（--cwd 即 /workspace 映射的真实目录）
cd packages/agent
bun run src/index.ts --server ws://localhost:14096/agent-ws --cwd /tmp/agent-e2e
# 期望输出：local health server on :17790 → connected → registered as agent-xxx

# 4) 测试前端（vite+react+shadcn，docs/products/local-sandbox）
cd docs/products/local-sandbox && bun run dev   # http://localhost:5173
```

### 4.2 验证用例

| # | 用例 | 命令/操作 | 期望 |
|---|---|---|---|
| 1 | Agent 注册 | `curl localhost:14096/local-agents` | `{agents:[{agentID, workdir, boundSessions:[]}]}` |
| 2 | 浏览器检测 | `curl 127.0.0.1:17790/health` | `{ok:true, agentID, workdir:"/tmp/agent-e2e"}` |
| 3 | 绑定会话 | `POST /session/$SID/local-agent {agentID}` | 200，返回 `rootSessionID` |
| 4 | exec 走本地 | `POST /session/$SID/exec {"command":"whoami && pwd && sw_vers"}` | `ruomu` + `/tmp/agent-e2e` + `macOS`（本机指纹） |
| 5 | AI 工具走本地 | 前端发「用 bash 执行 whoami && pwd」 | tool 卡片输出 `ruomu`/真实目录；`tail -f /tmp/agent-cli.log` 无错误 |
| 6 | 命令重写 | AI 执行 `ls /workspace` | 列出 `--cwd` 真实内容（非报错） |
| 7 | 未绑定 fallback | 对未绑定会话发 exec | 走远程沙箱（`whoami` 为容器用户） |
| 8 | Agent 断线自愈 | kill Agent 进程 → 等待重连 | pending 请求报 "Agent disconnected"；重连后 `/local-agents` 恢复；SaaS 容器重启后 Agent 4s 内自动重连 |
| 9 | 绑定状态恢复 | 前端刷新页面 | 侧边栏已绑定会话恢复「本地」绿标 |
| 10 | 会话删除 | 前端删除会话 | `DELETE /session/:id` 成功，列表不再出现 |

### 4.3 已实测结果（2026-08-14）

- 用例 1–10 全部通过（模型 `Yd-DeepSeek/deepseek-v4-flash`，PG 中 `Yd-DeepSeek` 为运行时 provider，`deepseek` 原生 provider 的 key 未挂载会报 `ProviderModelNotFoundError`）
- AI 消息链路实测：`whoami && pwd && ls` → `ruomu / /tmp/agent-e2e / index.html package.json src vite.config.js`（HTTP 200，5.2s）

---

## 五、已知限制与分期

| 期 | 内容 | 状态 |
|---|---|---|
| 第一期 | exec/fs 原语 + 路由层 + 绑定 API + 测试前端 | ✅ 完成 |
| 第二期 | **PTY 本地化**：`SandboxPtyRuntime` 依赖 `getEndpoint(4097)`，本地会话返回 `localhost:4097`（SaaS 容器不可达）→ 浏览器终端坏。需实现 LocalPtyRuntime 走协议已预留的 pty 原语（SaaS 双层 ws 中继） | 未做 |
| 第二期 | **端口代理本地化**：`/session/:id/proxy/:port` 同样依赖 endpoint 可达 | 未做 |
| 第三期 | LSP 本地模式；认证与安全；断线重连后的会话状态恢复 | 未做 |

其他限制：
- `readBytesStream` 为一次性 base64 全量返回（非真流式），大文件内存峰值高
- `interruptSession` 只发 ws interrupt，不等待 Agent 确认

## 六、安全清单（上线前必须）

- [ ] Agent ws 连接认证（token / pin 码绑定用户）
- [ ] 绑定 API 鉴权（当前任何知道 agentID 的人可绑定）
- [ ] Agent 端命令白名单 / 目录逃逸防护（当前信任 SaaS 下发的任意命令，含 `rm -rf`）
- [ ] health server（:17790）防 DNS rebinding（已绑 127.0.0.1，建议校验 Host 头）
- [ ] Agent 与 SaaS 间流量加密（wss）
