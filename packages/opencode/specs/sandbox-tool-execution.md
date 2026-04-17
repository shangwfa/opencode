# Sandbox Tool Execution System

将 OpenCode 的 6 个核心工具（bash、write、read、edit、glob、grep）迁移到 OpenSandbox 沙箱中执行，实现 Session ↔ Sandbox 1:1 绑定，保证多租户场景下的安全与资源隔离。

## 架构概览

```
┌──────────────────────────────────────────────────────┐
│                   OpenCode Server                     │
│                                                       │
│  Session A ──→ SandboxProvider ──→ Sandbox A          │
│  Session B ──→ SandboxProvider ──→ Sandbox B          │
│                      │                                │
│              commandSessions Map                      │
│              (持久 bash session 复用)                   │
└──────────────────────────────────────────────────────┘
```

每个用户 Session 绑定一个独立的 Sandbox 容器。`SandboxProvider` 是 Effect Service，负责沙箱和 command session 的完整生命周期管理。

## 核心文件

| 文件 | 职责 |
|------|------|
| `src/tool/sandbox-provider.ts` | Effect Service：沙箱创建/销毁、command session 生命周期、`runInSession` 封装 |
| `src/tool/sandbox-path.ts` | 宿主 ↔ 沙箱路径双向映射（`/Users/x/project` ↔ `/workspace`） |
| `src/flag/flag.ts` | 4 个环境变量开关（`OPENCODE_SANDBOX_ENABLED/DOMAIN/IMAGE/TIMEOUT`） |
| `src/tool/{bash,glob,grep,read}.ts` | 沙箱分支使用 `sandboxProvider.runInSession()` |
| `src/tool/{write,edit}.ts` | 沙箱分支使用 `sb.files.writeFiles()` / `sb.files.readFile()` |

## SandboxProvider 接口

```typescript
interface Interface {
  getOrCreate(sessionID: SessionID): Effect<Sandbox>
  get(sessionID: SessionID): Effect<Sandbox | null>
  destroy(sessionID: SessionID): Effect<void>
  destroyAll(): Effect<void>
  runInSession(
    sessionID: SessionID,
    command: string,
    options?: { workingDirectory?: string; timeoutSeconds?: number },
    handlers?: { onStdout?, onStderr?, ... },
    signal?: AbortSignal,
  ): Effect<CommandExecution, Error>
  register(sessionID: SessionID, sb: Sandbox): Effect<void>
}
```

### 关键设计：command session 复用

```
首次调用 runInSession("ses_123", "echo hello")
  → createSession({ workingDirectory: "/workspace" })  // 创建持久 bash session
  → commandSessions.set("ses_123", sessionId)
  → runInSession(sessionId, "echo hello")              // 通过 session 执行

后续调用 runInSession("ses_123", "rg --files ...")
  → commandSessions.get("ses_123")                     // 复用已有 session
  → runInSession(sessionId, "rg --files ...")           // 无需重新建连
```

销毁时自动清理：`destroySandbox()` 内先 `deleteSession`，再 `kill` + `close`。

## 工具沙箱执行策略

### 命令执行类（bash / glob / grep / read 的目录检测）

统一走 `sandboxProvider.runInSession()`。复用持久 bash session，避免每次 HTTP+SSE 建连开销。

```typescript
// glob.ts 示例
const cmd = `rg --files --glob '${pattern}' --sortr modified '${sandboxPath}' 2>/dev/null | head -101`
const result = yield* sandboxProvider.runInSession(ctx.sessionID, cmd, { timeoutSeconds: 30 })
```

### 文件操作类（write / edit / read 的文件读取）

走 OpenSandbox Files API（`sb.files.writeFiles()` / `sb.files.readFile()`），不经过 command session。

```typescript
// write.ts 示例
yield* Effect.tryPromise(() =>
  sb.files.writeFiles([{ path: sandboxPath, data: content }])
)

// read.ts 示例
const content = yield* Effect.tryPromise(() =>
  sb.files.readFile(sandboxPath)
)
```

## 路径映射

`sandbox-path.ts` 提供双向转换：

| 函数 | 方向 | 示例 |
|------|------|------|
| `toSandboxPath(hostPath, hostWorkdir)` | 宿主 → 沙箱 | `/Users/x/project/src/a.ts` → `/workspace/src/a.ts` |
| `toHostPath(sandboxPath, hostWorkdir)` | 沙箱 → 宿主 | `/workspace/src/a.ts` → `/Users/x/project/src/a.ts` |
| `toSandboxCwd(hostCwd, hostWorkdir)` | 宿主 cwd → 沙箱 cwd | `/Users/x/project/src` → `/workspace/src` |

规则：
- 相对路径（`./foo`、`foo`）→ `/workspace/foo`
- 宿主 workdir 下的绝对路径 → 替换前缀为 `/workspace`
- 其他绝对路径 → 原样传入

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OPENCODE_SANDBOX_ENABLED` | `false` | 是否启用沙箱模式 |
| `OPENCODE_SANDBOX_DOMAIN` | `localhost:8080` | OpenSandbox 服务地址 |
| `OPENCODE_SANDBOX_IMAGE` | `opensandbox/code-interpreter` | 容器镜像（推荐 `opensandbox/code-interpreter-rg`） |
| `OPENCODE_SANDBOX_TIMEOUT` | `300` | 沙箱超时秒数 |

## 自定义镜像

默认 `opensandbox/code-interpreter` 不含 `ripgrep`，glob/grep 的沙箱模式依赖 `rg` 命令。需构建自定义镜像：

```dockerfile
FROM opensandbox/code-interpreter:latest
RUN apt-get update && apt-get install -y ripgrep && rm -rf /var/lib/apt/lists/*
```

```bash
docker build -t opensandbox/code-interpreter-rg .
```

## 性能基准

测试环境：macOS arm64，OpenSandbox 本地部署，`opensandbox/code-interpreter-rg` 镜像。

### 6 工具对比（3 轮取平均）

```
┌─────────────────────────┬─────────────────────────┬─────────────────────────┬──────────┐
│ 工具                    │ 本地 (avg)              │ 沙箱 (avg)              │ 差异     │
├─────────────────────────┼─────────────────────────┼─────────────────────────┼──────────┤
│ bash: echo hello        │            106.7ms      │             16.3ms      │  6.5x ↓  │
│ write: create file      │              2.6ms      │              6.3ms      │  2.4x ↑  │
│ read: read file         │              5.7ms      │              6.1ms      │  1.1x ↑  │
│ edit: replace text      │              2.2ms      │              5.7ms      │  2.6x ↑  │
│ glob: find *.txt        │             43.6ms      │             12.5ms      │  3.5x ↓  │
│ grep: search content    │             40.3ms      │             12.9ms      │  3.1x ↓  │
├─────────────────────────┼─────────────────────────┼─────────────────────────┼──────────┤
│ 合计                    │            201.0ms      │             59.8ms      │  3.4x ↓  │
└─────────────────────────┴─────────────────────────┴─────────────────────────┴──────────┘
```

↑ = 沙箱更慢，↓ = 沙箱更快

### 分析

- **bash/glob/grep 沙箱更快（3-6.5x）**：`runInSession` 复用持久 bash session，省去了本地每次 spawn 子进程的开销
- **write/edit 沙箱略慢（2-3x）**：本地是纯 `fs` 系统调用（<3ms），沙箱需要 HTTP API 往返（~5ms），但绝对差异仅几毫秒
- **read 基本持平**：差距 <1ms
- **总体沙箱执行仅需本地 30% 的时间**

### runInSession vs commands.run 对比

这是选择 `runInSession` 的核心依据：

| 操作 | `commands.run` | `commands.runInSession` | 提升 |
|------|---------------|------------------------|------|
| 单次 echo | ~1014ms | ~4ms | **250x** |
| rg --files | ~1021ms | ~5ms | **200x** |
| rg --json | ~1018ms | ~9ms | **113x** |

`commands.run` 每次调用都有 HTTP+SSE 建连开销（~1s），`runInSession` 通过复用已建立的 session 连接将延迟降到个位数毫秒。

## 测试

### 本地测试（不依赖沙箱）

```bash
bun test test/tool/bash.test.ts test/tool/glob.test.ts test/tool/grep.test.ts test/tool/read.test.ts
```

测试中通过 `NoopSandboxProvider.layer` 注入空实现，所有沙箱分支不会被触发。

### 沙箱 E2E 测试

```bash
OPENCODE_SANDBOX_IMAGE=opensandbox/code-interpreter-rg bun test test/tool/sandbox-e2e-all-tools.test.ts test/tool/sandbox-glob-grep.test.ts
```

E2E 测试在 `beforeAll` 中手动创建沙箱并通过 `provider.register()` 注册到 `SandboxProvider`，模拟生产环境的 Session ↔ Sandbox 绑定。

### 性能基准测试

```bash
OPENCODE_SANDBOX_IMAGE=opensandbox/code-interpreter-rg bun run test/tool/bench-local-vs-sandbox.ts
```

## 工具内部判断逻辑

每个工具通过 `ctx.sandbox` 判断执行路径：

```typescript
execute: (params, ctx) => Effect.gen(function* () {
  if (ctx.sandbox !== null) {
    // 沙箱模式：通过 sandboxProvider.runInSession / sb.files API 执行
  }
  // 本地模式：原有逻辑不变
})
```

`ctx.sandbox` 在 `src/session/prompt.ts` 的 `resolveTools()` 中注入：
- 沙箱启用时：`sandbox: sandboxProvider.getOrCreate(sessionID)` 返回 `Promise<Sandbox>`
- 沙箱禁用时：`sandbox: null`

## 约束

- **Session ↔ Sandbox 1:1 绑定**：同一个需求（Session）的所有工具操作在同一个沙箱中完成
- **数据隔离由上层处理**：不依赖 PG RLS，沙箱本身提供进程级隔离
- **镜像依赖**：glob/grep 需要 `rg` 命令，必须使用含 ripgrep 的自定义镜像
