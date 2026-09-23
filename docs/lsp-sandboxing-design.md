# LSP 沙箱化技术设计（SaaS 模式）

> 状态：设计稿  
> 目标：在 SaaS / 沙箱模式下，让 LSP（诊断、跳转、悬停、符号等）完整可用，LSP server 在沙箱容器内运行，宿主通过现有 WebSocket 代理与之通信。  
> 范围：TypeScript / Python 优先，架构通用化以支持其余语言。

---

## 0. TL;DR

- **现状**：SaaS 模式下 LSP **完全不可用且系统无感知**。LSP server 在宿主启动本地子进程、读宿主文件系统，而代码文件在沙箱容器里，所有 `Module.resolve` / `which` / `Filesystem.up` 全部落空；`getClients` 的 `containsPath` 检查更会让路径不匹配时**静默返回空**。
- **唯一可行通道**：沙箱的对外通信是 **HTTP / WebSocket 反向代理**（`sandbox-proxy.ts`），不是裸 TCP。LSP 是 JSON-RPC 长连接，**必须走 WebSocket**。
- **核心思路**：在沙箱内跑一个 `lsp-bridge`（WebSocket server，spawn `tsserver --stdio` 做 ws↔stdio 桥接）；宿主 `lsp/client.ts` 用 WebSocket 接入，所有下游 LSP 协议代码零改动。
- **关键依赖已就绪**：`keepAlive`、`getEndpoint`、`proxyWebSocket`、路径映射 `toSandboxPath/toHostPath` 全部现成。
- **需新增**：① 沙箱内 `lsp-bridge` 脚本；② `SandboxProvider` 暴露 background `run`；③ 宿主 WebSocket↔MessageConnection 适配；④ LSP 层注入沙箱感知；⑤ LSP 文件读取与 URI 改走沙箱路径。

---

## 1. 现状分析（基于代码核查）

### 1.1 LSP 调用链与守门点

LSP 通过 Effect Context Tag `@opencode/LSP` 注入，在实例引导时启动（`project/bootstrap.ts:37-41`）。真正消费 LSP 的工具：

| 工具 / 调用点 | 方法 | 位置 |
|---|---|---|
| `apply_patch` | `touchFile` + `diagnostics` | `tool/apply_patch.ts:280,282` |
| `lsp` 工具 | `hover/definition/references/...` | `tool/lsp.ts:77-101` |
| `prompt` | `documentSymbol` | `session/prompt.ts:910` |
| HTTP API | `status` | `handlers/instance.ts:89` |
| `edit` / `write` | **硬编码 `{}`，不调 LSP** | `edit.ts:103,157` / `write.ts:65` |

**守门点（关键）** — `lsp/lsp.ts:211-213`：

```typescript
const getClients = Effect.fnUntraced(function* (file: string) {
  const ctx = yield* InstanceState.context
  if (!containsPath(file, ctx)) return [] as LSPClient.Info[]
```

`containsPath`（`instance-context.ts:18-23`）检查 file 是否在 `ctx.directory` / `ctx.worktree` 下。SaaS 模式下宿主拿到的是宿主路径，而沙箱工作目录是 `/workspace`，一旦路径语义不一致，**LSP 静默失效，无任何报错**。

### 1.2 LSP server 的本地文件系统依赖（全部在宿主）

所有 server 的 `spawn()` 走 `lsp/launch.ts` 的 `Process.spawn`（本地子进程）。以 TypeScript 为例（`server.ts:88-119`）：

```typescript
const tsserver = Module.resolve("typescript/lib/tsserver.js", ctx.directory) // ① 宿主 node_modules
const bin = await Npm.which("typescript-language-server")                     // ② 宿主 PATH
const proc = spawn(bin, ["--stdio"], { cwd: root, env: { ...process.env } })  // ③ 宿主子进程
```

SaaS 下 `ctx.directory` 是宿主路径，沙箱里才有真正的代码与依赖 → 全部失败。

### 1.3 文件内容如何流向 server（决定性细节）

`lsp/client.ts:599` 的 `notify.open()`：

```typescript
const text = await Filesystem.readText(request.path)  // 宿主读文件内容
// → 通过 didOpen / didChange 的 text 字段推送给 server
await connection.sendNotification("textDocument/didOpen", {
  textDocument: { uri: pathToFileURL(request.path).href, languageId, version: 0, text },
})
```

**两层文件访问**：
1. **当前编辑的文件**：内容由宿主读出后通过协议 `text` 字段推送（client 主动 sync）。
2. **依赖文件**（import 的模块、`tsconfig.json`、`node_modules` 类型）：server **自己按 `uri` 读盘**。

结论：
- server 必须在沙箱内运行（否则读不到依赖文件）。
- `uri` 必须是**沙箱路径**（`file:///workspace/...`），否则 server 找不到文件。
- client 推送 `text` 时的 `readText` 在 SaaS 下也必须**改走沙箱读取**（`read.ts` 已有范式：`sb.files.readFile(sandboxPath)`，`read.ts:106`）。

### 1.4 sandbox 与 LSP 分属两层（架构缺口）

- **sandbox 在 `Tool.Context` 层**：`tool/tool.ts:42` 的 `sandbox: Promise<unknown> | null`，按会话注入（`session/tools.ts:44-61`）。
- **LSP 在 `InstanceContext` 层**：`instance-context.ts:5-8` 只有 `directory/worktree/project`，对 sandbox 一无所知。

LSP 要沙箱化，必须把"当前会话是否 SaaS / 对应的 SandboxProvider + sessionID"传达到 LSP 层。

---

## 2. 通信通道：为什么是 WebSocket

### 2.1 否决裸 TCP

`Sandbox.getEndpointUrl(port)`（`opensandbox/index.js:758-761`）：

```javascript
async getEndpointUrl(port) {
  const ep = await this.getEndpoint(port);           // useServerProxy 决定形态
  return `${this.connectionConfig.protocol}://${ep.endpoint}`;
}
```

- `useServerProxy=false`：`http://localhost:44772`（直连，仅本地/同网络）
- `useServerProxy=true`：`http://domain/route/{sandboxId}/{port}`（**L7 HTTP 路由**）

SaaS 多租户必须 `useServerProxy=true`（`flag.ts:97`）。**HTTP path 路由无法承载裸 TCP socket**，因此 TCP 方案在 SaaS 下不成立。

### 2.2 WebSocket 通道已完整存在

`sandbox-proxy.ts` 提供通用代理路由（`:515`）：

```
*  /session/:sessionID/proxy/:port    →  proxyWebSocket / proxyHttp
```

`proxyWebSocket`（`sandbox-proxy.ts:560-617`）：

```typescript
const wsUrl = ProxyUtil.websocketTargetURL(endpoint + subPath)  // http→ws / https→wss
const inbound  = yield* Effect.orDie(request.upgrade)           // 宿主侧连接
const outbound = yield* Socket.makeWebSocket(wsUrl, { protocols })// 沙箱侧连接
// 双向帧转发：inbound ⇄ outbound
```

WebSocket 帧转发是**协议透明的**，不做内容改写（HTML/JS 改写只对 HTTP 分支生效）。LSP 的 JSON-RPC 帧可直接穿透。

---

## 3. 目标架构

```
┌──────────────────────────── Host (opencode) ────────────────────────────┐
│                                                                          │
│  lsp/lsp.ts  ── getClients(file) ──┐                                     │
│                                    │ 取 LspSandbox.Service                │
│                                    ▼                                      │
│  lsp/server.ts  Info.spawn(root, ctx)                                    │
│        │  sandbox mode ?                                                 │
│        │     ├─ yes → launch.spawnSandboxed(...)                         │
│        │     └─ no  → launch.spawn(...)（现状本地逻辑不变）               │
│        ▼                                                                  │
│  launch.spawnSandboxed:                                                  │
│    1. SandboxProvider.run(sid, "node lsp-bridge.mjs", {background:true}) │
│    2. SandboxProvider.keepAlive(sid)                                     │
│    3. ws = connect(ws://<self>/session/<sid>/proxy/<port>/)              │
│    4. return Handle { socket: ws }                                       │
│        │                                                                  │
│        ▼                                                                  │
│  lsp/client.ts  createMessageConnection(                                 │
│        SocketReader(effect Socket), SocketWriter(effect Socket))          │
│        │  （URI 用沙箱路径；文件内容读取走沙箱）                          │
└────────│─────────────────────────────────────────────────────────────────┘
         │  ws://<host>/session/<sid>/proxy/<port>/
         ▼
┌──────────────────────────── opencode HTTP server ───────────────────────┐
│  sandbox-proxy.ts  proxyWebSocket → Socket.makeWebSocket(ws://endpoint)  │
└────────│─────────────────────────────────────────────────────────────────┘
         │  getEndpoint(sid, port) → sandbox 内 port
         ▼
┌──────────────────────────── Sandbox Container ──────────────────────────┐
│  lsp-bridge.mjs  (WebSocket server, listen :PORT)                        │
│       │  on connection → spawn(LSP_CMD, ["--stdio"])                     │
│       │  ws frame ⇄ child stdio（原始字节透传）                          │
│       ▼                                                                   │
│  typescript-language-server --stdio  (cwd=/workspace/...)                │
└──────────────────────────────────────────────────────────────────────────┘
```

**关键点**：宿主连接的是**自己的** HTTP server（`/session/{sid}/proxy/{port}/`），由 `sandbox-proxy` 转发到沙箱。这样无论 `useServerProxy` 真假，宿主端连接方式统一。

---

## 4. 详细设计

### 4.1 沙箱内桥接：`lsp-bridge.mjs`

放在容器镜像 `/usr/local/bin/lsp-bridge.mjs`，由 `Dockerfile` COPY。

```javascript
#!/usr/bin/env node
// ws↔stdio 桥接：在沙箱内监听 WebSocket，spawn LSP server (--stdio)
import { spawn } from "node:child_process"
import { WebSocketServer } from "ws"   // 容器内预装 ws

const PORT = parseInt(process.env.LSP_BRIDGE_PORT || "2087")
const CMD  = process.env.LSP_CMD
const ARGS = process.env.LSP_ARGS ? JSON.parse(process.env.LSP_ARGS) : ["--stdio"]
const CWD  = process.env.LSP_CWD  || "/workspace"

if (!CMD) { console.error("LSP_CMD required"); process.exit(1) }

const wss = new WebSocketServer({ port: PORT })
console.error(`[lsp-bridge] listening :${PORT} for ${CMD} ${ARGS.join(" ")}`)

wss.on("connection", (ws) => {
  const child = spawn(CMD, ARGS, { cwd: CWD, stdio: ["pipe","pipe","inherit"], env: process.env })

  // ws 帧直接透传到 child.stdin；child.stdout 透传回 ws（原始字节）
  ws.on("message", (data) => child.stdin.write(data))
  child.stdout.on("data", (buf) => ws.readyState === ws.OPEN && ws.send(buf))

  const cleanup = () => { try { child.kill() } catch {} ; try { ws.close() } catch {} }
  child.on("exit", cleanup)
  ws.on("close", cleanup)
  ws.on("error", cleanup)
})

process.on("SIGTERM", () => { wss.close(); process.exit(0) })
```

设计要点：
- **环境变量配置**：`LSP_CMD` / `LSP_ARGS` / `LSP_CWD` / `LSP_BRIDGE_PORT`，命令与参数分离（`ARGS` 走 JSON），避免 shell 注入。
- **每端口一个 server**：见 §4.5 端口分配。
- **生命周期**：ws 断开 → kill child；child 退出 → close ws。
- **分帧**：vscode-jsonrpc 默认 `Content-Length` 字节流分帧。WebSocket 帧边界不必对齐 LSP 消息边界，宿主侧 reader（§4.3）负责按字节流重组，故 bridge 只做**原始字节透传**，不解析协议。
- **依赖**：容器当前 Dockerfile 仅 `npm install -g typescript typescript-language-server pyright`（`Dockerfile:6`），**未装 `ws`**。需追加 `npm install -g ws`，并让 `lsp-bridge.mjs` 能 resolve 到全局 `ws`（设 `NODE_PATH=/usr/local/lib/node_modules` 或改用相对 import）。

### 4.2 `SandboxProvider` 暴露 background `run`

当前 `Interface`（`sandbox-provider.ts:86-114`）只有 `runInSession`（不支持 background）。新增：

```typescript
// sandbox-provider.ts Interface 内
readonly run: (
  sessionID: SessionID,
  command: string,
  opts: { background?: boolean; timeoutSeconds?: number; workingDirectory?: string; envs?: Record<string,string> },
) => Effect.Effect<{ commandId?: string }>
```

实现：调用 SDK `sb.commands.run(command, { background: true, ... })`（SDK `ExecdCommands.run` 支持 `RunCommandOpts.background`）。内存版与 PG 版各加一份，复用 `getOrCreate` / `getOrCreateUnlocked`。

`NoopSandboxProvider`（`:988-1003`）补 `run: () => Effect.fail(new Error("Sandbox is disabled"))`。

> 为何不用 `runInSession`：它在 Promise resolve 前阻塞，且对同一 session 用 `Semaphore.make(1)` 串行化，长驻进程会卡住后续命令。background `run` 是独立进程，fire-and-forget。

### 4.3 宿主 WebSocket ↔ MessageConnection 适配

`vscode-jsonrpc`（已装 `8.2.1`，`package.json:165`）的 `createMessageConnection(reader, writer)` 接受任意 `MessageReader/Writer`。

**宿主侧不引入 `ws` 依赖**：宿主连接的是自己的 HTTP 代理（`/session/{sid}/proxy/{port}/`），可复用 `effect` 的 `Socket.makeWebSocket`（`sandbox-proxy.ts:566` 已用此 API 连沙箱）。需自写 ~40 行适配，将 effect `Socket.Socket` 的消息流包装成 `vscode-jsonrpc` 的 `AbstractMessageReader/Writer`（把收到的字节喂给内部 `Content-Length` 解码器；写出时直接 `Socket.write`）。

> 不用 `vscode-ws-jsonrpc`：它依赖浏览器/`ws` 的 WebSocket 接口，而宿主侧用的是 effect Socket，自写适配更贴合现有栈、零新依赖。

`lsp/client.ts:152-154` 当前写死 stdio：

```typescript
const connection = createMessageConnection(
  new StreamMessageReader(input.server.process.stdout as any),
  new StreamMessageWriter(input.server.process.stdin as any),
)
```

改为按 Handle 形态分支：

```typescript
let reader: MessageReader, writer: MessageWriter
if (input.server.socket) {                       // 沙箱：effect Socket（经 ws 代理）
  reader = new SocketReader(input.server.socket)  // 自写适配（§4.3）
  writer = new SocketWriter(input.server.socket)
} else if (input.server.process) {               // 本地：stdio（现状不变）
  reader = new StreamMessageReader(input.server.process.stdout as any)
  writer = new StreamMessageWriter(input.server.process.stdin as any)
} else throw new Error("LSP Handle requires process or socket")
const connection = createMessageConnection(reader, writer)
```

`lsp/server.ts:27` 的 `Handle` 扩展：

```typescript
export interface Handle {
  process?: ChildProcessWithoutNullStreams   // 本地（改为可选）
  socket?: Socket.Socket                      // 沙箱：effect Socket
  initialization?: Record<string, any>
  dispose?: () => Promise<void>               // 沙箱：关 socket + kill bridge
}
```

**所有下游协议代码（initialize / didOpen / diagnostics / hover ...）零改动** —— 它们只跟 `connection` 打交道。

### 4.4 LSP 层注入沙箱感知（推荐：独立 Service）

LSP 当前在 `InstanceContext` 层、不持有 sessionID，而沙箱在 `Tool.Context` 层。为打通，新增独立 Effect 服务，**不污染** `InstanceContext` 纯数据结构：

```typescript
// lsp/sandbox-context.ts（新增）
export namespace LspSandbox {
  export interface Info {
    mode: "local" | "sandbox"
    sessionID?: SessionID
    provider?: SandboxProvider.Interface
  }
  export class Service extends Context.Service<Service, Info>()("@opencode/LspSandbox") {}
  // 默认 local layer；SaaS 模式提供含 sessionID + provider 的 layer
}
```

- `mode` 判定：`Flag.OPENCODE_SANDBOX_ENABLED` 且存在 `SandboxProvider`（与 `session/tools.ts:44-61` 的 `sandboxEnabled` 一致）。
- `sessionID` 来源：会话执行进入工具前注入。LSP 在 `server.ts` 的 `spawn` 内 `yield* LspSandbox.Service` 取用。
- 备选：直接给 `InstanceContext` 加 `lsp?: { mode; sessionID }` 字段（改 `instance-context.ts:5-8` + `instance-store.ts:42-60` 创建点）。**不推荐**——污染纯数据结构。

### 4.5 端口分配（每语言固定端口）

一个会话可能同时需要多个 server（tsserver + pyright + eslint）。采用**每语言固定端口**，简单可靠、易调试：

| server id | port |
|---|---|
| typescript | 2087 |
| pyright | 2088 |
| eslint | 2089 |
| gopls | 2090 |
| ...（按需扩展） | 2091+ |

- 同一会话内同一语言只跑一个 bridge（与现状 `s.clients` 按 `root+serverID` 去重一致，`lsp.ts:248`）。
- 多 root（monorepo 多 tsconfig）需同语言多实例时：端口 = `basePort + rootIndex`，由宿主分配并通过 `LSP_BRIDGE_PORT` 传入。

### 4.6 文件读取与 URI 走沙箱

`launch.spawnSandboxed` 返回的 Handle 需携带 `sessionID` 与 workdir，供 client：

1. **URI 构造**：`notify.open` 里 `pathToFileURL(request.path)` 的 `request.path` 改为 `toSandboxPath(hostPath, instance.directory)` → `file:///workspace/...`。
2. **文件内容读取**：`Filesystem.readText(request.path)` 在 sandbox 模式改为 `sb.files.readFile(sandboxPath)`（范式见 `read.ts:106`）。
3. **server 返回的 URI**（diagnostics/definition 等）：`uri` 为 `file:///workspace/...`，回宿主前用 `toHostPath` 转回宿主路径，使 `apply_patch.ts` 的 `diagnostics[normalizePath(target)]` 命中。

> `client.ts:90-91` 的 `fileURLToPath(uri)` 是 URI→path 的统一入口，可在此集中插入 `toHostPath`。

### 4.7 `containsPath` 守门点

`getClients(file)` 的 `file` 由 `apply_patch`/`lsp` 工具传入，是**宿主路径**；`ctx.directory` 在 sandbox 模式仍是宿主 workdir。因此让 LSP 外部 API 统一接收宿主路径、内部再转沙箱路径，`containsPath(file, ctx)` 用宿主 workdir 比较即可通过，无需改 `containsPath` 本身。

### 4.8 生命周期与 TTL

- **保活**：`spawnSandboxed` 调 `keepAlive(sessionID)`，防止 idle 回收（`run-state.ts:62-73` 在 idle 时按 `isKeepAlive` 决定销毁）。
- **TTL**：keepAlive 沙箱 TTL = `baseTtl*10`（`sandbox-provider.ts:614`，默认 10 小时）。**当前无自动 `renew` 定时器**（见 §6）。
- **清理**：LSP client 关闭在 sandbox 模式走 `Handle.dispose()`：关 ws +（可选）kill bridge；会话结束 / 沙箱销毁时 bridge 随容器回收。

---

## 5. 文件变更清单

| 文件 | 变更 | 说明 |
|---|---|---|
| `packages/containers/sandbox/lsp-bridge.mjs` | 新增 | ws↔stdio 桥接 |
| `packages/containers/sandbox/Dockerfile` | 改 | COPY 桥接脚本；确保 `ws` 包可用 |
| `packages/opencode/src/tool/sandbox-provider.ts` | 改 | Interface + 内存版 + PG 版 + Noop 增加 `run`(background) |
| `packages/opencode/src/lsp/launch.ts` | 改 | 新增 `spawnSandboxed()` + WebSocket 连接 |
| `packages/opencode/src/lsp/client.ts` | 改 | 按 Handle 形态选 Socket/Stream reader-writer；URI/读取走沙箱；URI→host 回转 |
| `packages/opencode/src/lsp/server.ts` | 改 | `Handle` 扩展；各 `Info.spawn` 走策略分支（先 TS/Pyright） |
| `packages/opencode/src/lsp/lsp.ts` | 小改 | 取 `LspSandbox` 上下文；`dispose` 替代 `Process.stop` |
| `packages/opencode/src/lsp/sandbox-context.ts` | 新增 | `LspSandbox.Service`（mode + sessionID + provider） |
| 会话入口 / `session/tools.ts` | 小改 | 提供 `LspSandbox` layer（sessionID + provider） |

---

## 6. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| keepAlive 沙箱无自动续期，长会话超 TTL 断连 | 中 | 中 | 为 keepAlive 沙箱加周期 `sb.renew()` 定时器（current gap） |
| `ws` 包未在容器镜像 | 中 | 高 | Dockerfile 显式安装（Node 无原生 WS server） |
| 多 root / monorepo 端口冲突 | 中 | 中 | `basePort + rootIndex` 动态分配 |
| sessionID 传达到 LSP 层的链路改造 | 中 | 中 | 用独立 `LspSandbox.Service`，避免污染 InstanceContext |
| server 自身读依赖文件慢（容器冷启动） | 中 | 低 | 镜像 `warmup-tsserver.mjs` 已预热 tsserver |
| 首次连接延迟（bridge 启动 + ws 握手 + LSP init） | 中 | 低 | bridge ~1s + ws ~50ms + init ~2s，可接受；可懒启动 |
| 本地模式回归 | 低 | 高 | 策略分支，本地路径代码完全不变 |

---

## 7. 实施阶段

**Phase 1 — 基础设施（~2d）**
1. `lsp-bridge.mjs` + Dockerfile（含 `ws`）
2. `SandboxProvider.run`(background)（Interface + 内存 + PG + Noop）
3. `Handle` 扩展 + `client.ts` 的 WebSocket reader/writer 适配

**Phase 2 — TypeScript 打通（~1d）**
4. `LspSandbox.Service` + 注入
5. `launch.spawnSandboxed` + `Typescript.spawn` 策略分支
6. URI/读取走沙箱 + URI→host 回转
7. 端到端：`apply_patch` 触发 → 沙箱诊断回传

**Phase 3 — Python 及其他（~1d/语言）**
8. Pyright → Gopls → 其余

**Phase 4 — 健壮性**
9. keepAlive 自动 renew
10. 重连 / 超时 / 多 root 端口分配
11. （可选）把 `edit`/`write` 的硬编码 `{}` 接上真实诊断

---

## 附录 A：关键 API 与位置

```
SandboxProvider.Interface              tool/sandbox-provider.ts:86-114
  runInSession                         :307(mem) / :866(pg)
  keepAlive / isKeepAlive              :346 / :826
  getEndpoint                          :370 / :943
  （新增）run(background)              —
proxyWebSocket                          server/sandbox-proxy.ts:560-617
代理路由 /session/:sid/proxy/:port      server/sandbox-proxy.ts:515
ProxyUtil.websocketTargetURL            server/proxy-util.ts:29-34
Sandbox.getEndpointUrl                  opensandbox/index.js:758-761
ExecdCommands.run(RunCommandOpts)       SDK：支持 background:true
LSP client connection（stdio→改）       lsp/client.ts:152-154
LSP open/readText/uri                   lsp/client.ts:594-670
URI→path 归一化入口                     lsp/client.ts:90-91
containsPath 守门点                     lsp/lsp.ts:211-213 / instance-context.ts:18-23
路径映射                                tool/sandbox-path.ts（toSandboxPath/toHostPath, SANDBOX_WORKDIR="/workspace"）
沙箱读文件范式                          tool/read.ts:106（sb.files.readFile）
idle 回收逻辑                           session/run-state.ts:62-73
```

## 附录 B：为什么不用 `--socket` 模式

`typescript-language-server --socket <port>` 的语义是 **server 主动连接到指定端口**（client 须先监听），方向与沙箱代理（host→sandbox）相反，且并非所有语言 server 都支持 socket 模式。`lsp-bridge` 用 `--stdio`（所有 server 通用）+ ws 透传，是统一且可移植的做法。
