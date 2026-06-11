# OpenCode SaaS 就绪度分析报告

> 分析日期: 2026-05-29
> 分析范围: packages/opencode, packages/function, packages/server, packages/console, packages/containers, infra/

## 总结

**SaaS 就绪度: ~85%**（2026-05-30 修订，原评 75%）

opencode 的 SaaS 架构是有意设计的 — PG 双方言、InstanceState 隔离、SandboxProvider 框架、Workspace 路由都是为 SaaS 场景准备的成熟组件。**核心工具层（edit/glob/grep/read/write/shell/ls/apply_patch）已全面沙箱化**，移除了本地文件系统执行路径。剩余工作主要集中在 MCP stdio 隔离、GlobalBus 过滤、InstanceState TTL 和沙箱化引入的功能削减补全。

| 维度 | 评分 | 核心发现 |
|------|:----:|----------|
| PG 数据库 | 🟢 95% | 双方言完整，PG 模式功能更丰富，一个环境变量切换 |
| 并发安全 | 🟢 90% | 28 服务 InstanceState 隔离，PG 锁原语完备 |
| 沙箱隔离 | 🟢 90% | **8/8 核心工具已沙箱化**（原评 65%，edit/glob/grep 已修复） |
| API 完整性 | 🟢 90% | `opencode serve` 提供完整 REST API + WebSocket + SSE |
| 事件隔离 | 🟡 75% | `/event` 端点已通过 InstanceState 隐式隔离；`/global/event` 无过滤 |
| 内存管理 | 🟡 70% | ScopedCache 无 TTL/LRU，长时间运行有泄漏风险 |
| 安全性 | 🟡 75% | MCP stdio + 动态插件仍为风险；工具沙箱化已大幅改善 |
| 沙箱化副作用 | 🟡 70% | **新增维度** — 文件锁/格式化/BOM/LSP 集成丢失，本地模式不可用 |

---

## 一、架构总览

opencode 采用 **本地优先 + 云端增强** 的混合架构:

```
┌─────────────────────────────────────────────────────────┐
│                  SaaS 控制台层                           │
│  packages/console (SolidStart + PlanetScale MySQL)      │
│  用户管理 / 计费 / 认证 / 多租户 (上层实现)               │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│              云端 API 层 (Cloudflare Workers)             │
│  packages/function (Hono + Durable Object)               │
│  SyncServer / Share / GitHub App Token / 飞书集成         │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│           opencode 实例层 (核心运行时)                     │
│  packages/opencode (Effect HttpServer)                   │
│  Session / Agent / Tool / MCP / LSP / PTY / Sandbox      │
│  SQLite (本地) ←→ PostgreSQL (SaaS)                      │
│  本地执行 ←→ 沙箱执行 (OpenSandbox容器)                   │
└─────────────────────────────────────────────────────────┘
```

### 技术栈

| 层级 | 技术栈 | 运行时 |
|------|--------|------|
| 本地实例 | Effect HttpServer + Node.js | 每实例一个 HTTP 服务器 |
| 云端 API | Hono + Cloudflare Workers | SyncServer Durable Object |
| SaaS 控制台 | SolidStart + PlanetScale MySQL | 用户/计费/认证 |
| 前端 | SolidJS | 浏览器 Web App |
| 基础设施 | SST v3 + Cloudflare | Workers / R2 / Durable Objects |

---

## 二、PostgreSQL 数据库支持

### 2.1 双方言架构

- ORM: Drizzle ORM
- 每个实体两套 schema: `*.sql.ts` (SQLite) + `*.pg.ts` (PostgreSQL)
- 切换方式: `OPENCODE_DATABASE_URL=postgres://...` 一个环境变量
- PG shim: `db.pg.ts` 为 PG 添加了 `.run()/.get()/.all()` 兼容层

### 2.2 PG 独有表

PG 模式比 SQLite 功能更丰富:

| 表名 | 用途 |
|------|------|
| `sandbox` | 沙箱状态持久化（跨 Pod 重连/僵尸清理） |
| `auth` | 认证数据 |
| `session_entry` | 会话条目 |
| `user_skill` | 用户技能 |
| `session_skill` | 会话技能 |
| `session_agents` | Agent 配置 |

### 2.3 并发安全

- 连接池: postgres.js `max: 20`
- 迁移锁: `pg_advisory_lock` 多实例迁移串行化
- 行级锁: `FOR UPDATE` (事件溯源)
- 跨进程通知: `LISTEN/NOTIFY` (`bus/pg-notify.ts`)

### 2.4 关键文件

```
packages/opencode/src/storage/db.ts          # 存储层入口，dialect 选择
packages/opencode/src/storage/db.pg.ts       # PG 初始化 + shim
packages/opencode/src/storage/schema.pg.ts   # PG schema 导出
packages/opencode/src/bus/pg-notify.ts       # PG LISTEN/NOTIFY
packages/opencode/drizzle.pg.config.ts       # PG drizzle-kit 配置
packages/opencode/migration-pg/             # PG 迁移目录 (12+)
```

---

## 三、并发与实例隔离

### 3.1 InstanceState 模式

核心隔离机制。28 个服务使用 `InstanceState.make()` 按项目目录隔离:

```typescript
// instance-state.ts
ScopedCache.make<string, A, E, R>({
  capacity: Number.POSITIVE_INFINITY, // ⚠️ 无上限
  lookup: () => init(yield* context),  // key = directory
})
```

已隔离的服务: Config, Bus, LSP, MCP, Env, Session, PTY, File, Watcher, Snapshot, Format, Skill, Agent, Plugin, Permission, Provider, ProviderAuth, Question, ToolRegistry, Command, RunState, Instruction, Background, Reference, Share, VCS, Project, Status

### 3.2 进程级共享（可接受）

| 组件 | 影响 |
|------|------|
| `GlobalBus` (EventEmitter) | 所有实例事件汇总广播，下游需按 directory 过滤 |
| `AppRuntime` (ManagedRuntime) | 单一 Effect runtime，服务注册表 |
| `Flag.*` | 环境变量快照，全局配置 |

### 3.3 锁机制

| 文件 | 锁类型 | 粒度 |
|------|--------|------|
| `tool/edit.ts` | Effect Semaphore | 文件路径 |
| `snapshot/index.ts` | Effect Semaphore | gitdir |
| `tool/sandbox-provider.ts` | Effect Semaphore | sessionID |
| `reference/repository-cache.ts` | Flock 文件锁 | repo-clone 路径 |
| `storage/db.ts` | pg_advisory_lock | 迁移 |

### 3.4 实例生命周期

```
InstanceStore.load(directory)
  → Deferred 去重并发加载
  → InstanceBootstrap.run
  → 所有 InstanceState 按 directory 初始化

InstanceStore.dispose(ctx)
  → disposeInstance(directory)
  → 所有注册的 disposer 执行
  → ScopedCache.invalidate(cache, directory)
```

### 3.5 ⚠️ 内存泄漏风险

`ScopedCache` 的 `capacity: POSITIVE_INFINITY` 意味着:
- 没有 LRU 淘汰
- 没有 TTL 过期
- 实例不主动 dispose 会一直保留
- SaaS 长时间运行 + 多用户 → 内存持续增长

**建议**: 添加 idle TTL (30min) + capacity 上限 (100) + 内存压力驱逐

---

## 四、沙箱隔离系统

### 4.1 框架

基于 `@alibaba-group/opensandbox` 容器化沙箱。

```
OPENCODE_SANDBOX_ENABLED=true
  → SandboxProvider.Service 注入
  → session/tools.ts: getSandbox(sessionID) → ctx.sandbox = Promise<Sandbox>
  → 工具内: if (ctx.sandbox !== null) { /* 走沙箱路径 */ }
```

### 4.2 沙箱配置

```typescript
// sandbox-provider.ts
export const defaultConfig = {
  domain: Flag.OPENCODE_SANDBOX_DOMAIN,         // 沙箱 API 地址
  image: Flag.OPENCODE_SANDBOX_IMAGE,           // 容器镜像
  timeoutSeconds: Flag.OPENCODE_SANDBOX_TIMEOUT, // 默认 600s
  resourceLimits: { cpu: "1", memory: "2Gi" },
  volumeType: Flag.OPENCODE_SANDBOX_VOLUME_TYPE, // none | pvc | host
  pvcClaimName: Flag.OPENCODE_SANDBOX_PVC_CLAIM,
  idleKillMs: Flag.OPENCODE_SANDBOX_IDLE_KILL_SEC * 1000,
  maxTtlSeconds: Flag.OPENCODE_SANDBOX_MAX_TTL_SEC,
}
```

### 4.3 存储后端

- SQLite 模式: 内存 Map（单进程）
- PG 模式: `sandbox` 表持久化，支持跨 Pod 重连、僵尸清理、keepAlive

### 4.4 工具沙箱覆盖情况

> **2026-05-30 修订**: 核心工具已全面沙箱化。edit/glob/grep 不再穿透宿主。
> 注意：沙箱化方式是**移除本地文件系统执行路径**，而非添加条件分支。SandboxProvider 现为硬依赖。

| 工具 | 沙箱状态 | 沙箱模式行为 | 修订说明 |
|------|:---:|------|---------|
| `shell.ts` | ✅ **纯沙箱** | `SandboxProvider.runInSession()` 远程执行 | 删除 ~400 行本地 shell 逻辑 |
| `read.ts` | ✅ **纯沙箱** | `sb.files.readFile()` + `runInSession("ls")` | 移除本地 FS/PDF/图片/LSP 预热 |
| `write.ts` | ✅ **纯沙箱** | `sb.files.writeFiles()` 远程写入 | 移除 `ctx.sandbox !== null` 条件 |
| `edit.ts` | ✅ **纯沙箱** | `sb.files.readFile/writeFile` 远程读写 | **原 ❌ → 已修复**；移除锁/格式化/BOM |
| `glob.ts` | ✅ **纯沙箱** | `runInSession("rg --files ...")` | **原 ❌ → 已修复**；移除 Ripgrep 依赖 |
| `grep.ts` | ✅ **纯沙箱** | `runInSession("rg --json ...")` | **原 ❌ → 已修复**；移除 Ripgrep 依赖 |
| `ls.ts` | ✅ **纯沙箱** | `runInSession("rg --files ...")` | 移除本地 ripgrep 回退 |
| `apply_patch.ts` | ✅ **纯沙箱** | 统一沙箱读写路径 | 移除本地 FS 条件分支 |
| `repo_clone.ts` | ⏭️ N/A | git clone 到全局缓存，仅 scout agent 使用 | 默认 deny，需 experimentalScout |
| `lsp.ts` | ❌ | 依赖宿主 LSP 进程 | 沙箱内 LSP 待实现 |
| `webfetch.ts` | N/A | 纯 HTTP | 不涉及文件系统 |
| `websearch.ts` | N/A | 纯 API | 不涉及文件系统 |
| `task/plan/todo/skill` | N/A | 纯状态/调度 | 不涉及文件系统 |

### 4.5 关键文件

```
packages/opencode/src/tool/sandbox-provider.ts  # SandboxProvider 核心
packages/opencode/src/tool/sandbox-path.ts      # 宿主/沙箱路径转换
packages/opencode/src/tool/sandbox.pg.ts        # PG 沙箱注册表
packages/opencode/src/server/sandbox-proxy.ts   # HTTP/WS 反向代理
packages/opencode/src/session/tools.ts          # ctx.sandbox 注入点
packages/containers/sandbox/Dockerfile          # 沙箱容器镜像
```

---

## 五、HTTP API 服务

### 5.1 入口

```bash
opencode serve --port 3000
# → packages/opencode/src/cli/cmd/serve.ts
# → packages/opencode/src/server/server.ts (Effect HttpServer + Node.js http.createServer)
```

### 5.2 API 路由

30+ 端点组，路径: `packages/opencode/src/server/routes/instance/httpapi/groups/`

| 路由组 | 端点 |
|--------|------|
| session | CRUD + prompt/command/shell/revert/share/fork/abort (30+) |
| global | health, event(SSE), config, dispose, upgrade |
| file | 文件操作 |
| pty | PTY 创建/WebSocket |
| mcp | MCP 管理 |
| config | 实例配置 |
| workspace | 工作区管理 |
| permission | 权限管理 |
| provider | Provider 管理 |
| sync | 事件同步 |
| control | 服务控制 |

### 5.3 中间件

- `authorization.ts` — Basic Auth + auth_token query 参数
- `workspace-routing.ts` — 按 workspace 路由到本地/远程实例
- `instance-context.ts` — 加载项目实例上下文
- `proxy.ts` — 请求代理到远程实例
- `compression.ts` / `cors-vary.ts` / `error.ts`

### 5.4 认证

- 本地: Basic Auth (`OPENCODE_SERVER_PASSWORD`)
- SaaS 控制台: GitHub/Google OAuth
- API 间: GitHub App Token (JWT + OIDC)
- PTY WebSocket: 短生命周期票据

---

## 六、事件系统

### 6.1 GlobalBus

```typescript
// bus/global.ts — 进程级单例
class GlobalBusEmitter extends EventEmitter<{ event: [GlobalEvent] }> {}
export const GlobalBus = new GlobalBusEmitter()
```

所有 per-instance Bus 发布事件时同步 emit 到 GlobalBus（带 directory 字段）。

### 6.2 ⚠️ 事件泄漏风险

SSE 事件流 handler (`handlers/global.ts`) 将所有实例的事件推送给连接的客户端。客户端需根据 directory 过滤。

**建议**: 在 SSE handler 层添加 directory/workspace 过滤。

### 6.3 事件溯源

`sync/index.ts`: 聚合 ID + 序列号、投影重放、所有权声明、PG `FOR UPDATE` 行锁。

---

## 七、MCP / 插件 / LSP / PTY

### 7.1 MCP

| Transport | SaaS 可用性 | 说明 |
|-----------|:-----------:|------|
| HTTP (StreamableHTTP) | ✅ | 纯网络请求 |
| SSE | ✅ | 纯网络请求 |
| stdio | ⛔ | 在宿主 spawn 子进程，安全风险 |

**建议**: SaaS 模式禁止 stdio MCP 或改为沙箱内启动。

### 7.2 插件系统

```
plan(spec) → resolvePluginTarget(spec) → npm install → dynamic import()
```

**风险**: npm install postinstall 脚本 + 任意 JS 加载。
**建议**: SaaS 模式插件白名单 + 禁止动态安装。

### 7.3 LSP

- 通过 `lspspawn()` 在宿主启动子进程
- 按 InstanceState 隔离
- 沙箱镜像已预热 tsserver (`containers/sandbox/warmup-tsserver.mjs`)
- **建议**: 改为沙箱内启动

### 7.4 PTY

- 使用 node-pty/bun-pty 创建宿主伪终端
- WebSocket 暴露给前端
- `sandbox-proxy.ts` 已有 WS 代理能力
- **建议**: 通过 sandbox-proxy 转发到沙箱内 PTY

---

## 八、SaaS 部署配置

```bash
# 核心 — 数据库
OPENCODE_DATABASE_URL=postgres://user:pass@host:5432/opencode

# 核心 — 沙箱
OPENCODE_SANDBOX_ENABLED=true
OPENCODE_SANDBOX_DOMAIN=sandbox.internal:8080
OPENCODE_SANDBOX_IMAGE=registry.example.com/opencode-sandbox:latest
OPENCODE_SANDBOX_API_KEY=xxx
OPENCODE_SANDBOX_VOLUME_TYPE=pvc
OPENCODE_SANDBOX_PVC_CLAIM=opencode-sandbox
OPENCODE_SANDBOX_IDLE_KILL_SEC=3600
OPENCODE_SANDBOX_MAX_TTL_SEC=3600

# 服务器
OPENCODE_SERVER_PASSWORD=xxx
OPENCODE_SERVER_USERNAME=xxx

# 认证
OPENCODE_AUTH_PROVIDER=pg

# 事件总线
OPENCODE_EVENT_BUS=pg-notify

# 启动
opencode serve --port 3000
```

---

## 九、修复优先级

### P0 — 安全阻断（沙箱穿透）

> **2026-05-30 更新**: P0 #1-3 已完成。核心工具不再穿透宿主。

| # | 问题 | 文件 | 状态 | 修复方案 | 工作量 |
|---|------|------|:----:|---------|--------|
| 1 | ~~edit 无 sandbox 分支~~ | `tool/edit.ts` | ✅ 已完成 | 已沙箱化（`sb.files.readFile/writeFile`） | ~2d |
| 2 | ~~glob 无 sandbox 分支~~ | `tool/glob.ts` | ✅ 已完成 | 已沙箱化（`runInSession("rg --files")`） | ~1d |
| 3 | ~~grep 无 sandbox 分支~~ | `tool/grep.ts` | ✅ 已完成 | 已沙箱化（`runInSession("rg --json")`） | ~1d |
| 4 | MCP stdio 宿主执行 | `mcp/index.ts` | ❌ 未修复 | SaaS 模式禁止 stdio 或沙箱内启动 | 0.5-1d |

### P1 — 功能完善

| # | 问题 | 文件 | 修复方案 | 工作量 |
|---|------|------|---------|--------|
| 5 | `/global/event` 无过滤推送 | `handlers/global.ts` | SSE handler 添加 directory/workspace 过滤（注：`/event` 端点已通过 InstanceState 隐式隔离，无需修改） | 0.5d |
| 6 | InstanceState 无 TTL | `instance-state.ts` | idle timeout + capacity 上限 | 1-2d |
| 7 | 插件 npm install 安全 | `plugin/loader.ts` | 白名单 + 禁止动态安装 | 1d |
| 8 | LSP 宿主子进程 | `lsp/lsp.ts` | 沙箱内 `tsserver --socket 2087` + sandbox-proxy 端口转发 | 1-2d |
| 9 | PTY 宿主伪终端 | `pty/index.ts` | sandbox-proxy WS 代理 | 1-2d |

### P2 — 改进项

| # | 问题 | 文件 | 修复方案 | 工作量 |
|---|------|------|---------|--------|
| 10 | clipboard 固定临时文件名 | `cli/.../clipboard.ts` | mkdtemp / UUID | 0.5h |
| ~~11~~ | ~~repo_clone 无沙箱分支~~ | `tool/repo_clone.ts` | **N/A — 仅 scout subagent 使用，默认 deny，共享全局缓存设计合理** | ~ |
| 12 | 文件监视器无沙箱方案 | `file/watcher.ts` | 沙箱内 inotify 或轮询 | 1d |
| 13 | 代码格式化宿主执行 | `format/formatter.ts` | 沙箱内运行 formatter | 0.5d |
| 14 | 服务器认证升级 | `server/auth.ts` | Basic Auth → JWT/OAuth2 | 2-3d |

### 工作量估算

- P0: ~~约 4-5 天~~ **约 0.5-1 天**（仅剩 MCP stdio）
- P1: 约 5-8 天
- P2: 约 4-6 天（移除 repo_clone）
- **总计: 约 2 周**

P0 已基本完成。完成 P1 后 SaaS 就绪度可达 90%+。

---

## 十、沙箱化副作用风险（2026-05-30 新增）

工具层沙箱化采用「移除本地文件系统路径」策略，引入以下风险：

### 10.1 文件锁移除

`edit.ts` 原有 `Semaphore` 按文件路径互斥锁定，防止并发编辑同一文件产生竞态。沙箱化后锁机制被移除。

**影响**: 同一进程内多个并发 edit 操作同一文件理论上可能竞态。
**实际风险**: 低。SaaS 场景下不同用户的 edit 在不同沙箱容器里天然隔离；同一 session 内的并发 edit 已被 `prompt_async` 消息队列串行化。

### 10.2 格式化/BOM 处理丢失

`edit.ts`/`write.ts` 原有 `Format.Service`（写入后自动格式化）和 `Bom`（UTF-8 BOM 标记处理）。沙箱化后均被移除。

**影响**: AI 写入的文件不会自动格式化，BOM 标记可能丢失。
**实际风险**: 低。AI 生成的代码格式通常规范；如需格式化可通过沙箱 shell 命令补做。BOM 是边缘场景。

### 10.3 LSP 集成断开

`read.ts`/`edit.ts`/`write.ts` 原有与 LSP 的交互（`lsp.touchFile` 文件预热、诊断信息收集）。沙箱化后这些调用全部被移除，`diagnostics` 字段硬编码为 `{}`。

**影响**: AI 编辑完代码后无法获得实时类型错误、未定义变量等 LSP 诊断反馈。

**修复方案: 通过沙箱 TCP 端口转发重启 LSP 链路**

OpenSandbox exec API 是单向的（POST 命令 → SSE 流式返回输出，不支持运行时 stdin 写入），无法直接代理 stdio 双向通信。因此改用 TCP 端口转发：

```
宿主 LSP 客户端 (lsp.ts)
    ↓ TCP 连接
sandbox-proxy.ts (端口转发，已有能力)
    ↓ HTTP/WS 代理
沙箱容器内
    typescript-language-server --socket 2087
    ↑ 源码文件就在 /workspace，直接可用
```

实现步骤：
1. `lsp/launch.ts` 在沙箱模式下改用 `SandboxProvider.runInSession()` 启动 `typescript-language-server --socket 2087`（`background: true` + `keepAlive`）
2. 宿主通过 `SandboxProvider.getEndpoint()` 获取沙箱端口映射
3. `lsp.ts` 的连接从 `stdio pipe` 改为 `TCP socket`
4. `sandbox-proxy.ts` 已有端口转发能力，直接复用

沙箱镜像 `warmup-tsserver.mjs` 已预热了 `typescript-language-server`，无需额外安装。

工作量: 1-2d

### 10.4 本地模式不可用

所有工具现在**强制依赖 SandboxProvider**。`SandboxProvider.Service` 通过 `Effect.serviceOption` 获取，如果不可用会直接报错（而非回退到本地执行）。

**影响**: 本地开发模式下 `opencode` 无法正常使用文件操作工具。
**修复方案**:
- 方案 A: 恢复双模式架构（`if (ctx.sandbox !== null)` 条件分支），保留本地执行路径
- 方案 B: 为本地模式提供 `NoopSandboxProvider`（已存在于代码中），将沙箱操作代理到本地文件系统

### 10.5 read.ts 功能缩减

`read.ts` 移除了以下原有功能：PDF/图片附件处理、目录列表（`fs.readDirectory`）、模糊匹配建议（"Did you mean?"）、LSP 预热。

**影响**: AI 读取图片/PDF 会失败，目录列表改为 `ls` 命令模拟。
**修复方案**: 沙箱容器内安装 PDF/图片处理工具，或通过 `runInSession` 调用 `file` 命令检测类型。

### 10.6 shell.ts 功能大幅缩减

`shell.ts` 从 428 行缩减到 31 行，移除了：`ChildProcess` 本地执行、`tree-sitter` 语法解析、`BashArity` 权限检测、PowerShell/Cygwin 适配。

**影响**: Shell 工具不再有命令级权限检测（仅依赖沙箱容器隔离）。
**修复方案**: 在沙箱层面实现命令白名单/黑名单，或接受沙箱级隔离作为安全保障。

---

## 十一、edit.ts 修复示例（已过时 — 仅供参考）

> **注意**: 此示例已完成实现。当前 `edit.ts` 已全面沙箱化，采用比原始方案更激进的方式——完全移除本地文件系统路径，而非添加条件分支。

参照 `read.ts` 的沙箱分支模式:

```typescript
// edit.ts execute 函数内，在 lock 之前添加:
if (ctx.sandbox !== null) {
  const sandboxProviderOpt = yield* Effect.serviceOption(SandboxProvider.Service)
  if (sandboxProviderOpt._tag === "Some") {
    const sandboxProvider = sandboxProviderOpt.value
    const sb = yield* Effect.tryPromise({
      try: () => ctx.sandbox!,
      catch: (e) => new Error(`Sandbox init failed: ${e}`)
    })
    const sandboxPath = toSandboxPath(filePath, instance.directory)

    // 读取沙箱内文件
    const oldContent = yield* Effect.tryPromise({
      try: () => sb.files.readFile(sandboxPath),
      catch: () => new Error(`File not found: ${filePath}`)
    })

    // 计算新内容（复用现有 replace 逻辑）
    const newContent = replace(oldContent, params.oldString, params.newString, params.replaceAll)

    // 写入沙箱
    yield* Effect.tryPromise({
      try: () => sb.files.writeFile(sandboxPath, newContent),
      catch: (e) => new Error(`Write failed: ${e}`)
    })

    // diff + metadata + 返回结果
    const diff = createTwoFilesPatch(filePath, filePath, oldContent, newContent)
    return { title: filePath, metadata: { diff }, output: "Edit applied successfully." }
  }
}
// else 走现有的本地文件系统路径
```

---

## 附录: 完整功能 SaaS 兼容性矩阵

> **2026-05-30 修订**: 核心工具状态已更新。

| 功能域 | 状态 | 说明 |
|--------|:----:|------|
| AI 对话/Session | ✅ | PG 持久化 + SSE 实时推送 |
| 多 Provider 支持 | ✅ | API Key 存 PG |
| 文件 读/写/列表 | ✅ | **已全面沙箱化**（read/write/ls 纯沙箱路径） |
| Shell 执行 | ✅ | **纯沙箱** — 本地执行路径已移除 |
| 代码编辑 (edit) | ✅ | **已沙箱化**（原 ⚠️） |
| 代码搜索 (glob/grep) | ✅ | **已沙箱化**（原 ⚠️） |
| Git 补丁应用 | ✅ | 已沙箱化 |
| Web 搜索/抓取 | ✅ | 纯 HTTP API |
| 会话分享 | ✅ | R2 存储 + API |
| 事件同步 | ✅ | PG NOTIFY + 事件溯源 |
| 权限系统 | ✅ | DB 规则引擎 |
| 子代理任务 | ✅ | 进程内调度 |
| 技能系统 | ✅ | HTTP 下载 + 缓存 |
| 远程 MCP | ✅ | HTTP/SSE transport |
| Workspace 路由 | ✅ | 本地/远程代理 |
| 文件锁 (edit 并发) | ⏭️ | Semaphore 被移除，但 SaaS 场景下沙箱 session 隔离 + 消息队列串行化已覆盖 |
| 格式化/BOM | ⏭️ | Format.Service 不再被调用，AI 写入不自动格式化；影响低，可在沙箱 shell 补做 |
| LSP 智能感知 | ⚠️ | 工具不再调用 LSP；方案：沙箱内 tsserver --socket + sandbox-proxy 端口转发（1-2d） |
| PTY 终端 | ⚠️ | 需沙箱内 PTY |
| 本地 MCP (stdio) | ⚠️ | 需禁止或沙箱内启动（仅剩的 P0 风险） |
| 插件系统 | ⚠️ | npm install 安全性 |
| 文件监视 | ⚠️ | 需替代方案 |
| 本地模式运行 | ⚠️ | **新增风险** — 无 SandboxProvider 时工具报错 |
| 代码格式化 | ⚠️ | 需沙箱内工具链 |
| Repo 克隆 (scout) | ⏭️ | 仅 scout subagent 使用，默认 deny，对 SaaS 无影响 |
