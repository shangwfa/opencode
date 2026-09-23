# 沙箱会话级配置加载方案

## 背景

在 SaaS 模式下，opencode 服务运行在宿主机（或 K8s Pod），工具执行在隔离的沙箱容器中。用户在沙箱内 `git clone` 仓库后，仓库中 `.opencode/` 目录包含项目自定义的 agents、commands、skills、AGENTS.md 等内容。

**当前问题**：`loadInstanceState` 在宿主机侧执行，搜索的是宿主机路径上的 `.opencode/` 目录。沙箱容器内 `/workspace/.opencode/` 完全不在搜索路径上，因此这些自定义配置永远不会被加载。

## 设计目标

1. **会话级隔离**：沙箱配置属于当前 session，其他 session 不可见
2. **动态加载**：每次 session run prompt 时，从沙箱读取最新的 `.opencode/` 内容，不依赖启动时状态
3. **原有逻辑不变**：全局配置（Instance 级）正常加载，沙箱配置作为额外的会话层叠加在其上

## 配置层级

```
全局配置 (~/.config/opencode/)
    ↓ 所有 session 可见
Instance 级配置（宿主机 .opencode/、opencode.json 等）
    ↓ 所有 session 可见
Session 级配置（沙箱内 /workspace/.opencode/）
    ↓ 只对当前 session 可见，其他 session 不可见
```

合并优先级：下层覆盖上层（沙箱配置优先级最高）。

## 架构设计原则

代码库中已有 `SessionAgent`（`agent/session-agent.ts`）和 `SessionSkill`（`skill/session-skill.ts`）两套成熟的 session overlay 机制，模式一致：

- **SQLite 模式**：`noopLayer`，数据存内存 Ref，不持久化
- **PG 模式**：`layer`，数据持久化到对应数据库表，支持多 pod

**设计原则：顺着现有架构走**，每种资源类型各司其职，通过各自的 session overlay 机制注入，而不是在 `Config` 里捏一个大 overlay。好处：

- 复用已有机制，改动局部化
- PG 多 pod 天然支持，不依赖"session 固定在同一 pod"的假设
- 职责清晰，`Config` 只管配置字段，`Agent.Service` 管 agents，以此类推

## 资源类型与现状

| 资源类型 | 文件路径 | 现有 session 层 | 沙箱支持需要做的 |
|----------|----------|-----------------|------------------|
| agents | `agent/session-agent.ts` | ✅ `SessionAgent` 已实现 | 注入时调用 `Agent.sessionCreate` |
| skills | `skill/session-skill.ts` | ✅ `SessionSkill` 已实现 | 注入时调用 `Skill.sessionLoad` |
| commands | `command/index.ts` | ❌ 无 session 层 | 新建 `SessionCommand`（参考 `SessionAgent`） |
| opencode.json | `config/config.ts` | ❌ 无 session 层 | `Config` 加轻量 session overlay（仅合并 config 字段） |
| AGENTS.md | `session/instruction.ts` | ❌ 无 session 层 | `Instruction` 加 session 层 |

## 整体数据流

```
SessionPrompt.runLoop(sessionID)
    │
    ▼ [每次 loop 开始]
SandboxProvider.readOpencodeDir(sessionID)
    │  runInSession → 读取 /workspace/.opencode/ 全部文件
    │  返回 Record<string, string>（相对路径 → 文件内容）
    │
    ▼ 按文件类型分发
    ├── agents/**/*.md      → Agent.sessionCreate(sessionID, ...)      [复用已有]
    ├── skills/**/SKILL.md  → Skill.sessionLoad(sessionID, tmpDir)     [复用已有]
    ├── commands/**/*.md    → SessionCommand.upsert(sessionID, ...)    [新建]
    ├── opencode.json       → Config.setSessionConfig(sessionID, ...)  [新增轻量层]
    └── AGENTS.md           → Instruction session 层                   [新增]
    │
    ▼
LLM 请求（携带沙箱配置中的 agents/commands/skills/AGENTS.md）
```

## 详细设计

### 1. `SandboxProvider.Service` — 新增 `readOpencodeDir`

在 `Interface`（`tool/sandbox-provider.ts`）上新增方法，通过 `runInSession` 读取沙箱内 `/workspace/.opencode/` 的全部文件内容。

```typescript
export interface Interface {
  // ... 现有方法不变 ...

  /**
   * 读取沙箱内 /workspace/.opencode/ 的全部文件内容。
   * 返回 path → content 映射，path 为相对于 .opencode/ 的路径。
   * 目录不存在时返回空对象。
   */
  readonly readOpencodeDir: (sessionID: SessionID) => Effect.Effect<Record<string, string>>
}
```

**实现**：通过 `runInSession` 在沙箱内执行一条命令，将目录内容序列化为 JSON 输出，收集 stdout 后 `JSON.parse` 返回。

```shell
node -e "
const fs=require('fs'),path=require('path'),dir='/workspace/.opencode';
if(!fs.existsSync(dir)){console.log('{}');process.exit(0);}
const r={};
(function walk(d){for(const f of fs.readdirSync(d)){const p=path.join(d,f);
fs.statSync(p).isDirectory()?walk(p):r[path.relative(dir,p)]=fs.readFileSync(p,'utf8');
}})(dir);
console.log(JSON.stringify(r));
"
```

两种实现（`layer` 和 `pgLayer`）均通过 `runInSession` 执行，实现相同。

### 2. `SessionCommand` — 新建（参考 `SessionAgent`）

新建 `command/session-command.ts`，完整照抄 `SessionAgent` 的模式：

```typescript
// command/session-command.ts
export namespace SessionCommand {
  export type Input = {
    name: string
    description?: string
    template: string
    agent?: string
    model?: string
    subtask?: boolean
    hints?: string[]
  }

  export interface Interface {
    readonly list:      (sessionID: SessionID) => Effect.Effect<Row[]>
    readonly get:       (sessionID: SessionID, name: string) => Effect.Effect<Row | undefined>
    readonly upsert:    (sessionID: SessionID, input: Input) => Effect.Effect<Row>
    readonly remove:    (sessionID: SessionID, name: string) => Effect.Effect<void>
    readonly removeAll: (sessionID: SessionID) => Effect.Effect<void>
  }

  export class Service extends Context.Service<...>()("@opencode/SessionCommand") {}

  // SQLite 模式：noopLayer（内存，list 返回 []）
  export const noopLayer: Layer.Layer<Service> = ...

  // PG 模式：layer（读写 session_commands 表）
  export const layer: Layer.Layer<Service, never, Database.Service> = ...
}
```

对应 PG 表 `session_commands`，结构参考 `SessionAgentTable`（`UNIQUE(session_id, name)`）。

`Command.Service` 的 `list()` / `get()` 增加 session overlay 合并逻辑，与 `Agent.sessionList` 完全对称：

```typescript
// command/index.ts — list 增加 session 参数
list: (sessionID?: SessionID) =>
  Effect.gen(function* () {
    const base = yield* InstanceState.use(state, (s) => s.list())
    if (!sessionID || !isPg) return base
    const rows = yield* sessionCommand.list(sessionID)
    const overlay = new Map(rows.map((r) => [r.name, rowToInfo(r)]))
    return base
      .map((c) => overlay.has(c.name) ? { ...overlay.get(c.name)! } : c)
      .concat([...overlay.values()].filter((c) => !base.some((b) => b.name === c.name)))
  })
```

### 3. `Config` — 轻量 session config 层

沙箱内 `opencode.json` / `opencode.jsonc` 可能包含 model、permissions、instructions 等配置字段（不含 agents/commands，这两者走各自的 session 层）。

`Config.Service` 增加最小化的 session config 存储：

```typescript
// config/config.ts — Interface 新增
export interface Interface {
  // ... 现有方法不变 ...

  /**
   * 返回合并了 session 级 config 的配置视图，仅对指定 session 可见。
   * 无 session config 时等价于 get()。
   */
  readonly getForSession: (sessionID: SessionID) => Effect.Effect<Info>

  /**
   * 存入 session 级 config overlay（仅 opencode.json 中的配置字段，
   * 不包含 agents/commands，这两者由各自的 session 层处理）。
   */
  readonly setSessionConfig: (sessionID: SessionID, config: Info) => Effect.Effect<void>

  readonly clearSessionConfig: (sessionID: SessionID) => Effect.Effect<void>
}
```

内部存储：内存 Map（`Map<SessionID, Info>`），无需持久化（与 `SessionAgent` noopLayer 同理，单机和多 pod 均用内存即可，原因见边界情况一节）。

`getForSession` 实现：

```typescript
const getForSession = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const base = yield* get()
    const overlay = sessionConfigs.get(sessionID)
    if (!overlay) return base
    return mergeConfigConcatArrays(base, overlay)
  })
```

### 4. `Instruction.Service` — 新增 session AGENTS.md

`systemPaths()`（`session/instruction.ts`）当前只在宿主机路径上 `findUp` 搜索 AGENTS.md。

新增 session 层：允许外部注入一段 AGENTS.md 内容，绑定到指定 sessionID，`systemPaths()` 在现有逻辑之前优先使用。

```typescript
// session/instruction.ts — Interface 新增
export interface Interface {
  // ... 现有方法不变 ...

  /**
   * 为指定 session 注入沙箱内的 AGENTS.md 内容。
   * systemPaths() 中该内容优先于宿主机路径。
   */
  readonly setSessionInstruction: (sessionID: SessionID, content: string) => Effect.Effect<void>

  readonly clearSessionInstruction: (sessionID: SessionID) => Effect.Effect<void>
}
```

`systemPaths()` 增加 session 层判断（在现有逻辑最前面）：

```typescript
const systemPaths = Effect.fn("Instruction.systemPaths")(function* (sessionID?: SessionID) {
  const paths = new Set<string>()

  // 0. session 级 AGENTS.md（沙箱注入，最高优先级）
  if (sessionID) {
    const content = sessionInstructions.get(sessionID)
    if (content) {
      // 将内容写入临时文件，加入 paths
      const tmp = path.join(os.tmpdir(), `opencode-instruction-${sessionID}.md`)
      yield* fs.writeFileString(tmp, content)
      paths.add(tmp)
      // 已有 session 级指令，跳过宿主机路径搜索
      return paths
    }
  }

  // 原有逻辑不变 ...
})
```

### 5. `SessionPrompt` — 每次 prompt 前统一刷新

在 `runLoop`（`session/prompt.ts`）的 `while` 循环开始处，增加沙箱配置分发逻辑：

```typescript
const runLoop = Effect.fn("SessionPrompt.run")(function* (sessionID, skills?) {
  while (true) {
    // ── 新增：从沙箱读取 .opencode/ 并分发到各 session 层 ──────────
    if (sandboxEnabled && maybeSandboxProvider) {
      const files = yield* maybeSandboxProvider
        .readOpencodeDir(sessionID)
        .pipe(Effect.orElseSucceed(() => ({}) as Record<string, string>))

      yield* syncSandboxConfig(sessionID, files)   // 见下方
    }
    // ───────────────────────────────────────────────────────────────

    // 现有逻辑不变 ...
  }
})
```

`syncSandboxConfig` 负责按文件路径分发到各 session 层：

```typescript
const syncSandboxConfig = Effect.fn("SessionPrompt.syncSandboxConfig")(
  function* (sessionID: SessionID, files: Record<string, string>) {
    // 先清空上一次的 session 配置，保证动态刷新语义
    yield* Effect.all([
      agent.sessionClear(sessionID),
      skill.sessionClear(sessionID),       // 若 Skill.Service 提供 sessionClear
      command.sessionClear(sessionID),
      config.clearSessionConfig(sessionID),
      instruction.clearSessionInstruction(sessionID),
    ], { concurrency: "unbounded" })

    // 写临时目录（供 Skill.sessionLoad 使用）
    const tmp = path.join(os.tmpdir(), `opencode-sandbox-${sessionID}`)

    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(tmp, rel)
      yield* fs.mkdirp(path.dirname(full))
      yield* fs.writeFileString(full, content)
    }

    // 按类型分发
    yield* Effect.all([
      // agents/**/*.md → SessionAgent
      loadAgentsFromDir(sessionID, tmp),

      // skills/**/SKILL.md → SessionSkill（复用现有 sessionLoad）
      skill.sessionLoad(sessionID, tmp),

      // commands/**/*.md → SessionCommand
      loadCommandsFromDir(sessionID, tmp),

      // opencode.json / opencode.jsonc → Config session layer
      loadSessionConfig(sessionID, tmp),

      // AGENTS.md / CLAUDE.md → Instruction session layer
      loadSessionInstruction(sessionID, files),
    ], { concurrency: "unbounded" })
  }
)
```

刷新失败时通过 `Effect.orElseSucceed` 降级，不影响 prompt 继续执行。

## 边界情况

| 场景 | 处理方式 |
|------|----------|
| 非 SaaS 模式（无沙箱） | `sandboxEnabled = false`，跳过所有沙箱配置逻辑，行为与现在完全相同 |
| `/workspace/.opencode/` 不存在 | `readOpencodeDir` 返回 `{}`，`syncSandboxConfig` 清空 session 层后不注入任何内容 |
| 读取沙箱超时 / 失败 | `Effect.orElseSucceed(() => ({}))` 降级，本次 prompt 使用上一次的 session 层缓存 |
| session 销毁 | 在现有 session 销毁路径中调用各 session 层的 `clear` 方法，临时目录一并清理 |
| `Config` session config 多 pod | `Config` session config 存内存 Map 即可：session 与沙箱是一一绑定的，workspace routing 保证同一 session 的请求始终落在同一 pod |
| overlay 中的 plugin | 暂不支持（plugin 需要 npm install，安全边界复杂） |

## 不在本方案范围内

- **沙箱内 `config.instructions` 中的 URL 类型指令**：URL 在宿主机侧可直接 fetch，不受影响
- **沙箱内的 Plugin**：plugin 需要 `npm install`，暂不支持
- **宿主机侧文件监听自动重载**：本方案以"每次 prompt 主动拉取"代替文件监听

## 实现步骤

> 根据实际情况决定各步骤是否实现及实现顺序。

1. **`SandboxProvider.readOpencodeDir`**：在 `layer` 和 `pgLayer` 中各自实现，通过 `runInSession` 读取沙箱内容
2. **`SessionCommand`**：新建 `command/session-command.ts` + 对应 PG 表，`Command.Service.list/get` 增加 session overlay 合并
3. **`Config.setSessionConfig` / `getForSession`**：在 `Config.Service` 上增加轻量 session config 层
4. **`Instruction.setSessionInstruction`**：在 `Instruction.Service` 上增加 session AGENTS.md 注入
5. **`SessionPrompt.syncSandboxConfig`**：在 `runLoop` 开始处统一调度上述各步骤，按文件类型分发
6. **session 销毁清理**：在现有 session 销毁路径中挂载各 session 层的 `clear` 调用
