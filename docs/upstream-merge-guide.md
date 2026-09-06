# Upstream Merge Guide

`feat/upstream-dev` 分支基于 `upstream/dev` (`748fcb7eb`) 创建，添加了 SaaS 功能（PG 数据库、Sandbox、Session Agent/Skill 等）。需要持续从 `upstream/dev` 合并新代码。

## 合并步骤

```bash
git fetch upstream
git merge upstream/dev
# 解决冲突（见下方）
bun install                    # bun.lock 冲突直接重新安装
bun typecheck                  # packages/opencode 目录下
# 检查语义兼容性（见下方）
docker build && docker run     # 回归测试
```

## 冲突解决

### 常规冲突（每次都会有）

| 文件 | 解决方式 |
|------|----------|
| `bun.lock` | 删掉冲突标记，重新 `bun install` |
| `.dockerignore` | 手动合并两边内容 |

### 可能冲突的文件

| 文件 | 原因 | 解决方式 |
|------|------|----------|
| `packages/core/src/flag/flag.ts` | 两边都在追加 flag | 保留两边新增，SaaS flag 在文件末尾 |
| `packages/opencode/src/skill/index.ts` | Interface 扩展 | 保留 SaaS 新增的 session 方法 |
| `packages/opencode/src/agent/agent.ts` | Interface 扩展 | 同上 |
| `packages/opencode/src/session/prompt.ts` | 改动频繁 | 保留 `skills` 参数和 `sandbox: null` |

## 合并后必须检查

### 0. upstream core 测试的类型偏差（2026-09-06 v1.18.29 合并记录）

合并 v1.18.29 后 `bun typecheck`（packages/opencode）新增 ~249 个错误，**全部位于 upstream 的 core 测试文件**（`test/session-runner.test.ts`、`test/connector.test.ts`、`test/session-prompt.test.ts`、`test/session-create.test.ts`、`test/plugin/*` 等）。根因：SaaS 分支改了 core 的服务签名（`SessionV2.Service` requirements、错误类型结构、`Database` 层），upstream 后续按原签名编写的测试在 SaaS core 上类型不匹配（典型模式：`SessionV2.NotFoundError` vs `NotFoundError` 命名空间错位、R 通道 `Database.Service | SessionV2.Service` 未展开）。

**判定标准：`grep -v "test/" ` 后的 src 错误数不得高于合并前基线**（本次合并 src 错误从 59 降到 2，基线反而更健康）。这些 core 测试属于「SaaS 场景不跑 core 单测」的已知偏差域（见根 AGENTS.md），用 HTTP 集成测试验证功能，不要为消 typecheck 去逐个适配 upstream 测试（工作量大且每次合并会重置）。

### 1. Database.use 异步兼容性

SaaS 分支将 `Database.use` 从同步改为异步（返回 `Promise<T>`）。upstream 新代码如果使用 `Effect.sync(() => Database.use(...))` 模式，在 PG 模式下会产生运行时 bug（返回 Promise 对象而非查询结果）。

**每次合并后必须执行：**

```bash
grep -rn "Effect\.sync.*Database\.use\|Effect\.sync.*Database\.transaction" packages/opencode/src/
```

如果有匹配结果，将 `Effect.sync` 改为 `Effect.promise`：

```typescript
// 错误（upstream 原始写法）
Effect.sync(() => Database.use(fn))

// 正确（SaaS 适配）
Effect.promise(() => Database.use(fn))
```

### 2. SyncEvent Projector 异步兼容性

SaaS 分支将所有 `SyncEvent.project()` 回调改为 `async`，内部 `.run()/.get()/.all()` 加 `await`。upstream 新增的 projector 如果用同步写法，PG 模式下操作会丢失。

**检查：**

```bash
# 查找非 async 的 projector 回调
grep -n "SyncEvent.project(" packages/opencode/src/session/projectors.ts packages/opencode/src/session/projectors-next.ts | grep -v async
```

如果有匹配，将回调改为 `async`，内部 db 操作加 `await`：

```typescript
// 错误
SyncEvent.project(Event.Created, (db, data) => {
  db.insert(Table).values(row).run()
})

// 正确
SyncEvent.project(Event.Created, async (db, data) => {
  await db.insert(Table).values(row).run()
})
```

### 3. 同步 Generator 兼容性

以下函数已从同步 generator 改为 async generator，upstream 新代码如果用 `for...of` 调用会编译报错（这种情况 TypeScript 能检测到）：

- `session.ts`: `listByProject()`, `listGlobal()`
- `message-v2.ts`: `stream()`

改为 `for await...of` 即可。

### 4. 公共函数签名变更

以下函数签名被 SaaS 分支修改，upstream 新代码如果调用原签名会编译报错：

| 函数 | 原签名 | 新签名 |
|------|--------|--------|
| `project.ts: list()` | `(): Info[]` | `(): Promise<Info[]>` |
| `project.ts: get()` | `(): Info \| undefined` | `(): Promise<Info \| undefined>` |
| `skill/index.ts: get()` | `(name)` | `(name, session?)` |
| `skill/index.ts: all()` | `()` | `(session?)` |
| `session/prompt.ts: LoopInput` | 无 skills 字段 | 新增 `skills` 字段 |

## 分支改动结构

### 零冲突风险（纯新增文件，占 74%）

```
packages/opencode/migration-pg/          # PG 迁移
packages/opencode/src/**/*.pg.ts          # PG Schema 定义
packages/opencode/src/agent/session-agent.ts
packages/opencode/src/skill/session-skill.ts
packages/opencode/src/tool/sandbox-provider.ts
packages/opencode/src/tool/sandbox-path.ts
packages/opencode/src/server/sandbox-proxy.ts
packages/opencode/src/bus/pg-notify.ts
packages/opencode/src/flag/flag.ts
packages/opencode/test/**
docs/**
Dockerfile, .dockerignore
```

### 低冲突风险（机械性 sync→promise 替换）

```
packages/opencode/src/session/todo.ts
packages/opencode/src/share/share-next.ts
packages/opencode/src/permission/index.ts
packages/opencode/src/worktree/index.ts
packages/opencode/src/server/shared/fence.ts
packages/opencode/src/server/projectors.ts
packages/opencode/src/cli/cmd/stats.ts
packages/opencode/src/cli/cmd/import.ts
```

### 中高冲突风险（结构性改动）

```
packages/opencode/src/storage/db.ts       # Database.use 异步化（核心）
packages/opencode/src/sync/index.ts       # SyncEvent 异步化
packages/opencode/src/session/session.ts  # async generator
packages/opencode/src/session/message-v2.ts
packages/opencode/src/session/projectors.ts
packages/opencode/src/session/projectors-next.ts
packages/opencode/src/session/prompt.ts
packages/opencode/src/skill/index.ts      # Interface 扩展
packages/opencode/src/agent/agent.ts      # Interface 扩展
```

## 回归测试

合并完成后，构建镜像并验证核心链路：

```bash
docker build -t opencode-saas:test -f Dockerfile .

docker run -d --name test \
  -p 14096:4096 \
  -e OPENCODE_DATABASE_URL="postgresql://..." \
  opencode-saas:test \
  serve --hostname 0.0.0.0 --port 4096

# 基础验证
curl http://localhost:14096/global/health
curl -X POST http://localhost:14096/session -H 'Content-Type: application/json' -d '{"title":"test"}'
# 详细测试见 docs/saas-test-cases.md
```

## 核心架构决策

| 决策 | 理由 |
|------|------|
| `Database.use` 改为 async | PG drizzle 的 `.all()/.get()/.run()` shim 返回 Promise，调用者必须 await |
| `TxOrDb = any` | 避免耦合 pg-core 和 sqlite-core 类型系统 |
| SessionAgent 用 raw SQL（postgres tagged template） | drizzle PG 的 `.all()` shim 返回 Promise，无法在同步上下文链式调用 `.map()` |
| SessionSkill 用 `Database.use`（drizzle） | 通过 `parseRow()` 处理 jsonb/bigint 类型转换 |
| Auth 用 raw SQL（postgres tagged template） | 独立于 drizzle 的轻量实现 |
| Sandbox lock 用 Effect.Semaphore | `pg_advisory_lock` 在连接池下不安全（lock/unlock 可能分配不同连接） |
| SyncEvent seq 预创建行 | `FOR UPDATE` 无法锁定不存在的行，需先 `INSERT ON CONFLICT DO NOTHING` |
| `data_migration` PG 跳过 | SQLite 专用的 `json_extract()` 语法不兼容 PG |
