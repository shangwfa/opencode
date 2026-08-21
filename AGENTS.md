# opencode SaaS — 仓库指南

本仓库是 [sst/opencode] 的 **SaaS 定制 fork**，部署为多实例 SaaS 服务（远端 K8s），**不是本地桌面/TUI 工具**。所有开发决策以「SaaS 服务 + PG 数据库 + 远端沙箱」为前提，**只考虑 PG**。

## 文档地图（docs/）

| 文档 | 内容 |
|---|---|
| `docs/saas-architecture.md` | SaaS 化总览：PG / 远程沙箱 / PVC / Auth 热加载 / 容器化五大改造 |
| `docs/saas-usage-guide.md` | **面向接入方的 API 使用文档**：核心概念（Session/Message/Part/Agent/Sandbox/PVC）、接口说明、测试环境 `https://test-opencode.shadow-rpa.net` |
| `docs/deployment.md` | K8s 容器化部署指南 |
| `docs/local-test-env.md` | 本地测试三组合（远端/本地 PG × 远端/本地沙箱）搭建与切换 |
| `docs/upstream-merge-guide.md` | **上游合并指南**：与 upstream/dev 合并的冲突点与已知坑 |
| `docs/session-pvc-mode-guide.md` | 会话 PVC 双模式：`session`（默认）/ `app`（按业务 appId 聚合，跨会话共享卷） |
| `docs/sandbox-proxy-design.md` | 沙箱内 dev server 的 HTTP/WS 反向代理（`/session/:id/proxy/:port/`） |
| `docs/sandbox-idle-reap.md`、`docs/sandbox-session-config.md` | 沙箱空闲回收、会话级沙箱资源配置 |
| `docs/guides/session-diagnostic-guide.md` | **会话问题诊断**：按 session ID 查 PG（消息树、事件流、exec 记录）定位问题 |
| `docs/guides/exec-api-reference.md`、`docs/guides/sandbox-frontend-debug-guide.md` | exec API 参考、沙箱前端调试 |
| `docs/test-cases/` | **集成测试用例库**（见下） |

## Git 与发布

- Remotes：`origin` = github.com/shangwfa/opencode（个人备份）、`gitlab` = gitlab.shadow-rpa.net/opencode-saas/opencode（**发布源，从 GitLab 构建部署**）、`upstream` = anomalyco/opencode（上游）。
- 提交后**双推送**（origin + gitlab），发布构建基于 GitLab 分支头。
- 分支命名跟随现有习惯（如 `feat/opencode-1.18.18`、`session-watchdog`），与上游同步走 merge upstream/dev，**合并前必读 `docs/upstream-merge-guide.md`**（关键坑：SaaS 分支 `Database.use` 已异步化、projector 回调已 async 化，upstream 新代码按同步写法会在 PG 模式产生运行时 bug）。
- Commit 用 conventional 格式：`type(scope): summary`，type 取 `feat/fix/docs/chore/refactor/test`。

## 架构要点

### 双 Schema、双迁移（关键）

- **core SQLite schema**：`packages/core/src/**/sql.ts`（drizzle `sqliteTable`），配套 TS 迁移在 `packages/core/src/database/migration/`。**SaaS PG 模式下 core 迁移不执行**（`app-runtime.ts` 用 `pgDatabaseLayer` 整体替换 core Database 层）。
- **PG schema**：`packages/opencode/src/**/*.pg.ts`（drizzle `pgTable`），配套 SQL 迁移在 `packages/opencode/migration-pg/<时间戳_名称>/migration.sql`（`--> statement-breakpoint` 分隔，按 hash 去重执行）。**改 PG 表结构 = 改 *.pg.ts + 加 migration-pg 条目**，core 侧同步与否不影响 SaaS。
- 已知偏差：core SQLite 基线（schema.gen.ts）落后于 *.pg.ts（如 `pvc_mode`/`app_id` 只在 PG 侧），部分 core 单测在本地跑不过——**SaaS 场景用 HTTP 集成测试验证**（见下）。

### SaaS 运行时

- 服务镜像：根目录 `Dockerfile` → `opencode-saas-sandbox-test:<tag>`，容器内跑 opencode server（:4096）。**镜像无 CI 构建，本地 `docker build` 手动出**。
- 沙箱镜像：`packages/opencode/docker/Dockerfile` → 本地 OpenSandbox 用；组合 1 走远端 K8s 沙箱不需要。
- PG 连接经 `OPENCODE_DATABASE_URL`；多实例共享同一 PG 时请求按入口路由（本地容器 vs 远端 SaaS 互不抢锁，但共享数据）。
- 切换本地组合时注意 15432 TCP 转发指向与容器 `DATABASE_URL` 用户（远端 `app` / 本地 `local`），见 `docs/local-test-env.md`。

### 模型与 Provider

- 生产 provider：`Yd-DeepSeek` / `Yd-GLM` / `Yd-KiMi`（`@ai-sdk/anthropic` 协议，网关 `claude.shadow-rpa.net/v1`，key 内嵌在 `opencode.jsonc`，容器内位于 `/home/opencode/.config/opencode/opencode.jsonc`）。
- **测试一律用 `Yd-DeepSeek/deepseek-v4-flash`**（`$MODEL`）。本地 API key 余额不足返回 429，会触发指数退避长重试、外部表现为「消息挂死」且 stall 超时不触发——遇到先查余额。

## 测试与验证

- **集成用例（SaaS 功能首选）**：`docs/test-cases/`，按域分目录（session 17 篇 / sandbox 10 篇 / skills 8 篇 / mcps / agents / pvc / lsp / tools 等）。
  ```bash
  source docs/test-cases/test-env.sh [1|2|3]   # 加载 $BASE $PG_URL $MODEL
  source docs/test-cases/test-lib.sh           # pass/fail/summary/jexec/new_sid 等函数库
  ```
  用例执行后**更新文档内复测记录表**；新用例沿用现有格式（场景 + 命令 + 期望，编号 Txx.x.x）。
- 单测：`bun test test/<域>/...`，**必须从 `packages/opencode` 目录跑**（根目录有 guard）。
- 类型检查：`bun typecheck`（包目录内，勿直接 `tsc`）。基线存在既有错误，**以「不新增」为准**（前后对比 error 数）。
- 验证新代码需重建镜像：`docker build -t opencode-saas-sandbox-test:<tag> -f Dockerfile .` 后按 local-test-env.md 重启容器。

## 已知坑（实战记录）

- `docker logs` **不覆盖 prompt/LLM 路径**（只见 watchdog、sandbox-provider 等 service）；排查会话问题按 `docs/guides/session-diagnostic-guide.md` 查 PG（`message`/`event`/`exec_log` 表），别指望容器日志。
- PG bridge 下 drizzle `$onUpdate` **不生效**：`PATCH /session/:id` 改标题不刷新 `time_updated`；「最后活动时间」只由发消息等显式 `touch` 刷新。
- exec/action 记录：handler 层 `logAction` 无序号前缀（`action-<ts>`），sandbox-proxy 的带计数器（`exec-<n>-<ts>`）——计数器量级可区分不同实例。
- 消息 ID 前缀是时间编码，跨回绕边界后字典序翻转，**UI 排序勿按 ID**，用 `time_created`。
- LLM 流有 stall 保护（`OPENCODE_LLM_STALL_TIMEOUT_SEC`，默认 300s）、Runner 有陈旧 run 接管（`OPENCODE_SESSION_STALE_RUN_SEC`，默认 1800s），见 `docs/test-cases/session/llm-stall-recovery.md`；HTTP 层 `waitForSessionLock` 有超时（`OPENCODE_SESSION_LOCK_TIMEOUT_SEC`，默认 60s，超时返回 503），PG 连接带语句级超时（`OPENCODE_PG_STATEMENT_TIMEOUT_MS`，默认 30000ms）防 run 挂死占锁。

## 代码风格指南

### 通用原则

- 逻辑尽量写在一个函数内，除非需要组合或复用
- 不要过早抽取单次使用的辅助函数。除非该辅助函数被复用、隔离了真正复杂的边界、或有一个能提升调用方可读性的独立命名，否则直接在调用点内联
- 尽量避免 `try`/`catch`
- 避免 `any` 类型
- 尽量用 Bun API，如 `Bun.file()`
- 依赖类型推断；除非导出或清晰性需要，避免显式类型标注和接口
- 优先用函数式数组方法（flatMap、filter、map）而非 for 循环；filter 上用 type guard 保持下游类型推断
- 在 `src/config` 新增配置模块时，遵循文件顶部的 self-export 模式（如 `export * as ConfigAgent from "./agent"`）
- Effect generator 中，先把 service 绑定到具名变量再调用方法。不要用嵌套 service yield，如 `yield* (yield* Foo.Service).bar()`

只使用一次的值直接内联，减少变量总数。

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### 解构

避免不必要的解构。用点访问保留上下文。

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### 导入

- 禁止 import 别名。不要 `import { foo as bar } from "..."` 或 `resolve as pathResolve` 这类重命名导入
- 禁止 star 导入。不要 `import * as Foo from "..."` 或 `import type * as Foo from "..."`
- 需要命名空间风格的值时，按名导入模块自身导出的命名空间，如 `import { Project } from "@opencode-ai/core/project"`，然后引用 `Project.ID`
- 重模块（仅部分代码路径需要）优先动态导入，尤其是启动敏感的入口。动态导入的绑定解构放在所需的最窄作用域顶部；不要写 `await import("./module").then((mod) => mod.value())` 或 `(await import("./module")).value()` 这类内联链。分支专属的导入保留在分支内以保持懒加载

### 变量

`const` 优先于 `let`。用三元或提前返回代替重新赋值。

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### 控制流

避免 `else`。优先提前返回。

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### 复杂逻辑

函数有多个校验分支或支撑细节时，让主函数读起来是主流程，把细节下移到后面的小辅助函数。

- 辅助函数靠近其支撑的代码，置于主导出下方（若可读性更好）
- 不要把简单表达式过度抽象成一堆单次使用的辅助函数；仅当它命名了一个真实概念（如 `requireConfig`、`readMetadata`）时才抽取
- 辅助函数不要返回 `Effect`，除非它真的执行副作用。同步的解析、校验、选项构建保持同步
- 解析不可信 JSON 字符串时，优先用 Effect schema 辅助（如 `Schema.UnknownFromJsonString`、`Schema.decodeUnknownOption`），而非手写 `JSON.parse` 包 `Effect.try`
- 注释只写给非显然的约束和反直觉行为，不给显然的赋值和控制流加注释

### Schema 定义（Drizzle）

字段名用 snake_case，列名就无需以字符串重定义。PG 表定义在 `*.pg.ts`，改列必须同步加 `migration-pg` 迁移。

```ts
// Good
const table = pgTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  time_created: bigint().notNull(),
})

// Bad
const table = pgTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: bigint("created_at").notNull(),
})
```

### 测试

- 尽量避免 mock，除非别无选择才用 globalThis.\*
- 测试真实实现，不要在测试里复制逻辑
- 测试不能从仓库根目录跑（guard：`do-not-run-tests-from-root`）；从包目录（如 `packages/opencode`）跑
- SaaS 功能（PG 专属列/行为）优先写 `docs/test-cases/` 集成用例而非 core 单测；集成用例用 `test-lib.sh` 的 `new_sid`/`jexec`/`pass`/`fail` 函数
