# OpenCode SaaS 化改造文档

## 目录

- [1. 改造背景](#1-改造背景)
- [2. 改造目标](#2-改造目标)
- [3. 改造总览](#3-改造总览)
- [4. 改造一：PostgreSQL 数据库支持](#4-改造一postgresql-数据库支持)
- [5. 改造二：远程 Sandbox 沙箱系统](#5-改造二远程-sandbox-沙箱系统)
- [6. 改造三：Sandbox PVC 持久化](#6-改造三sandbox-pvc-持久化)
- [7. 改造四：Auth PG 存储与 Provider 热加载](#7-改造四auth-pg-存储与-provider-热加载)
- [8. 改造五：容器化部署](#8-改造五容器化部署)
- [9. Bug 修复与优化](#9-bug-修复与优化)
- [10. 测试覆盖](#10-测试覆盖)
- [11. 改造后的 SaaS 架构](#11-改造后的-saas-架构)
- [12. 快速使用](#12-快速使用)
- [13. 改造文件清单](#13-改造文件清单)
- [14. 改造时间线](#14-改造时间线)

---

## 1. 改造背景

OpenCode 原本是一个**本地 CLI/TUI 工具**：
- 数据存储在本地 SQLite 文件
- 代码执行直接在宿主机上运行
- Auth 信息存储在本地 JSON 文件
- 无容器化支持

这种架构无法满足 **SaaS 多用户服务**的需求：
- 多实例部署需要共享数据库（SQLite 不支持）
- 用户代码必须在隔离容器中执行（安全隔离）
- API Key 需要在线管理，不能要求重启服务
- 需要容器化打包，方便 K8s 部署

---

## 2. 改造目标

| 目标 | 原始状态 | 改造后 |
|------|---------|--------|
| 数据库 | SQLite 本地文件 | PostgreSQL 远程数据库 |
| 代码执行 | 宿主机直接执行 | 远程 Sandbox 容器（K8s） |
| 数据持久化 | 无（sandbox 销毁即丢失） | PVC 持久化（NFS 后端） |
| Auth 管理 | 本地 JSON 文件 | PG 表 + HTTP API 热加载 |
| 部署方式 | 本地安装 | Docker 容器化 |
| Provider 更新 | 修改配置文件重启 | API 热加载，无需重启 |

---

## 3. 改造总览

```
                        SaaS 化改造 (5 大模块)
                    ┌─────────────────────────────────┐
                    │                                  │
  ┌─────────┐  ┌────┴─────┐  ┌──────────┐  ┌────────┴──────┐  ┌──────────┐
  │ 改造一   │  │ 改造二    │  │ 改造三    │  │ 改造四        │  │ 改造五    │
  │ PG 数据库│  │ 远程沙箱  │  │ PVC 持久化│  │ Auth 热加载   │  │ 容器化    │
  │          │  │          │  │          │  │              │  │          │
  │ ·db.pg.ts│  │ ·sandbox │  │ ·6卷挂载  │  │ ·auth.pg.ts  │  │ ·Docker-  │
  │ ·Schema  │  │  Provider│  │ ·状态机   │  │ ·pgLayer     │  │  file     │
  │ ·Migration│ │ ·懒加载   │  │ ·空闲回收 │  │ ·disposeAll  │  │ ·docker-  │
  │ ·Shim    │  │ ·命令队列 │  │ ·Max TTL  │  │ ·PUT/DELETE  │  │  compose  │
  └─────────┘  └──────────┘  └──────────┘  └──────────────┘  └──────────┘
```

---

## 4. 改造一：PostgreSQL 数据库支持

**Commit**: `91feb849f0` — feat(opencode): add PostgreSQL support for SaaS deployment

### 4.1 改造内容

原始 OpenCode 只支持 SQLite。改造引入了 **双数据库架构**：通过 `OPENCODE_DATABASE_URL` 环境变量自动切换。

#### 4.1.1 Dialect 判定 (`storage/db.ts`)

```typescript
export const dialect: Dialect = Flag.OPENCODE_DATABASE_URL ? "pg" : "sqlite"
```

设置 `OPENCODE_DATABASE_URL` 后，整个系统自动切换为 PG 模式。

#### 4.1.2 PG 连接适配器 (`storage/db.pg.ts`)

新增 `db.pg.ts`，使用 `postgres.js` 驱动连接 PG：

- **OID 类型覆盖**：让 PG 的 `jsonb` 返回原始字符串，兼容 SQLite 的 Drizzle 解码器
  - `OID_INT8 (20)` → bigint: serialize→string, parse→Number
  - `OID_JSON (114)` → 返回原始字符串，不做 JSON.parse
  - `OID_JSONB (3802)` → 返回原始字符串，不做 JSON.parse
- **API Shim 注入**：PG Drizzle 不提供 `.run()/.get()/.all()` 方法，通过遍历 query builder 原型链注入

#### 4.1.3 PG Schema 文件

新增所有表的 PG 版本定义（`*.pg.ts` 文件）：
- 类型映射：`integer → bigint`，`text({mode:'json'}) → jsonb`，`sqliteTable → pgTable`
- 与 SQLite Schema 保持字段级别兼容

#### 4.1.4 迁移系统

- 使用 `pg_advisory_lock(20191001)` 防止并发迁移
- 自建 `__drizzle_migrations` 表跟踪已应用迁移（SHA256 去重）
- 启动时自动执行，无需手动管理

#### 4.1.5 事务隔离级别映射

| SQLite | PG | 说明 |
|--------|-----|------|
| `deferred` | 默认（无显式级别） | 读不阻塞 |
| `immediate` | `read committed` | 避免序列化错误 |
| `exclusive` | `read committed` | 避免序列化错误 |

> **设计决策**：最终选择 `read committed` 而非 `repeatable read`，因为 PG 的 repeatable read 在并发写入时容易触发序列化错误。

### 4.2 改动文件

| 文件 | 改动 |
|------|------|
| `storage/db.ts` | 新增 `dialect`、`initialize()`、`migratePg()`、事务隔离级别映射 |
| `storage/db.pg.ts` | **新增**：PG 连接、OID 覆盖、Shim 注入 |
| `storage/schema-pg.ts` | **新增**：PG 表统一导出 |
| `storage/schema.pg.ts` | **新增**：PG Timestamps 辅助 |
| `migration-pg/` | **新增**：PG 迁移 SQL 文件 |
| `drizzle.pg.config.ts` | **新增**：PG Drizzle 配置 |
| `package.json` | 新增 `postgres` 依赖 |
| `flag/flag.ts` | 新增 `OPENCODE_DATABASE_URL` 环境变量 |
| 所有 `*.pg.ts` | 新增 PG 版表定义 |

### 4.3 后续修复

**Commit**: `caa20fc632` — fix: lazy sandbox creation and PG FK improvements

- 所有 PG FK 改为 `DEFERRABLE INITIALLY DEFERRED`，匹配 SQLite 行为
- `projectors.ts` 的 `foreign()` 函数增加 `DrizzleQueryError` 包裹处理
- PG 隔离级别从 `repeatable read` 改为 `read committed`

---

## 5. 改造二：远程 Sandbox 沙箱系统

**Commit**: `f28acfd1c5` — feat: tools in sandbox + `21143ea7ec` — feat: saas

### 5.1 改造内容

原始 OpenCode 的 `bash`、`read`、`write` 等工具直接在宿主机执行。SaaS 模式下，用户代码必须在隔离容器中运行。

#### 5.1.1 SandboxProvider (`tool/sandbox-provider.ts`)

新增 `SandboxProvider.Service`，封装 OpenSandbox SDK：

- **远程容器创建**：通过 OpenSandbox K8s Runtime 创建沙箱容器
- **命令执行**：`runInSession()` 在容器内执行 shell 命令
- **路径映射**：`sandbox-path.ts` 处理主机路径 ↔ 容器路径的双向转换
- **Layer 注入**：根据 `OPENCODE_SANDBOX_ENABLED` 选择 `SandboxProvider` 或 `NoopSandboxProvider`

#### 5.1.2 懒加载机制 (`session/prompt.ts`)

**Commit**: `caa20fc632` — fix: lazy sandbox creation and PG FK improvements

改造 `prompt.ts` 的工具解析阶段：
- `getSandbox()` 返回 `Promise<Sandbox>`，首次工具调用时才创建容器
- 并发工具调用共享同一个 Promise（`Deferred` + `claim` 模式去重）
- 如果 LLM 只回复文本不调用工具，不会创建任何容器

#### 5.1.3 命令队列 (`tool/sandbox-provider.ts`)

**Commit**: `e3e33ab59c` — fix: add per-session command queue

```typescript
// 每 session 一个 Semaphore(1)
let sem = commandSemaphores.get(sessionID)
if (!sem) {
  sem = yield* Semaphore.make(1)
  commandSemaphores.set(sessionID, sem)
}
return yield* sem.withPermit(/* runInSession */)
```

- 同一 session 内命令严格 FIFO 串行（AI SDK 的 `Promise.all` 会并发触发多个工具）
- 不同 session 之间完全并行

### 5.2 改动文件

| 文件 | 改动 |
|------|------|
| `tool/sandbox-provider.ts` | **新增**：SandboxProvider.Service、创建/销毁/命令执行 |
| `tool/sandbox-path.ts` | **新增**：主机路径 ↔ 容器路径映射 |
| `tool/registry.ts` | 根据 `OPENCODE_SANDBOX_ENABLED` 注入 Layer |
| `tool/bash.ts` | 双模式：宿主机执行 / sandbox 远程执行 |
| `session/prompt.ts` | `getSandbox()` 懒加载 + `Deferred` 去重 |
| `flag/flag.ts` | 新增 `OPENCODE_SANDBOX_ENABLED`、`OPENCODE_SANDBOX_DOMAIN` 等环境变量 |

### 5.3 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OPENCODE_SANDBOX_ENABLED` | `false` | **必须显式设为 true** |
| `OPENCODE_SANDBOX_DOMAIN` | `localhost:8080` | OpenSandbox 地址（不含协议前缀） |
| `OPENCODE_SANDBOX_API_KEY` | - | API 密钥 |
| `OPENCODE_SANDBOX_IMAGE` | 内置默认 | 沙箱容器镜像 |
| `OPENCODE_SANDBOX_TIMEOUT` | `600` | 无卷模式超时（秒） |
| `OPENSANDBOX_INSECURE_SERVER` | - | 设为 `YES` 跳过 TLS |

---

## 6. 改造三：Sandbox PVC 持久化

**Commit**: `839f2c35df` — feat(sandbox): add PVC volume support with session-scoped cleanup

### 6.1 改造内容

无 PVC 时，sandbox 销毁后所有数据丢失。对于 SaaS 场景（如长时间任务、跨 session 复用数据），需要数据持久化。

#### 6.1.1 PVC 卷挂载 (`buildVolumes()`)

每个 session 自动挂载 6 个卷到 sandbox 容器：

| 卷名 | 容器内路径 | subPath (PVC) |
|------|-----------|---------------|
| workspace | `/workspace` | `sessions/{sessionID}/workspace` |
| home | `/home/sandbox` | `sessions/{sessionID}/home` |
| cache | `/home/sandbox/.cache` | `sessions/{sessionID}/cache` |
| config | `/home/sandbox/.config` | `sessions/{sessionID}/config` |
| local | `/home/sandbox/.local` | `sessions/{sessionID}/local` |
| tmp | `/home/sandbox/tmp` | `sessions/{sessionID}/tmp` |

**卷类型**：
- `none`：无持久化（默认）
- `pvc`：K8s PVC 共享 claim，subPath 隔离
- `host`：节点本地路径

#### 6.1.2 状态机简化

从 running/paused/killed 三态简化为 **running/killed** 二态（K8s runtime 不支持 pause/resume）：

```
getOrCreate:
  无条目 → running (新建)
  killed → running (重建，PVC 数据保留)
  running + 健康 → running (复用)
  running + 不健康 → running (销毁后重建)

空闲计时器 (每 30s 轮询):
  running && idle > IDLE_KILL_SEC → killed

destroy / session 删除:
  running → 销毁 sandbox + 清理 PVC 卷
  killed → 清理 PVC 卷
```

#### 6.1.3 空闲回收 + Max TTL

**双层超时保护**：

```
L1 Idle Kill (IDLE_KILL_SEC，默认 3600s)
  ├─ 定时器每 30s 检查
  ├─ 空闲超时 → 销毁 sandbox
  ├─ PVC 数据保留
  └─ 下次请求自动重建（平均 1.8s）

L2 Max TTL (MAX_TTL_SEC，默认 3600s)
  ├─ 创建时设置 timeoutSeconds
  ├─ 无卷模式: 600s
  ├─ 有卷模式: maxTtlSeconds
  └─ 服务端强制回收（即使持续有请求）
```

#### 6.1.4 PVC 卷清理

```typescript
cleanupSessionVolume(sessionID)
  → 创建临时 sandbox 挂载根目录
  → rm -rf /cleanup/sessions/{sessionID}
  → 在 destroy() 和 destroyAll() 中触发
```

### 6.2 改动文件

| 文件 | 改动 |
|------|------|
| `tool/sandbox-provider.ts` | 新增 `buildVolumes()`、`cleanupSessionVolume()`、状态机、idle timer、max TTL |
| `flag/flag.ts` | 新增 `OPENCODE_SANDBOX_VOLUME_TYPE`、`OPENCODE_SANDBOX_PVC_CLAIM`、`OPENCODE_SANDBOX_IDLE_KILL_SEC` |

### 6.3 后续修复

删除了 `renew(30*60)` 调用——PVC 模式下不能 renew，否则会无限续命覆盖 max TTL。

---

## 7. 改造四：Auth PG 存储与 Provider 热加载

**Commit**: `a47a3ba02f` — feat(auth): add PG storage layer with hot-reload provider support

### 7.1 改造内容

原始 Auth 存储在本地 `auth.json` 文件中，修改后需要重启服务。SaaS 模式需要：
1. Auth 数据存储在 PG 中（多实例共享）
2. 通过 HTTP API 在线管理 Provider 凭证
3. 修改后立即生效，无需重启

#### 7.1.1 Auth 双层存储 (`auth/index.ts`)

```typescript
// Auth.Service 定义两个 Layer：
export const layer    = /* SQLite 文件存储 */
export const pgLayer  = /* PG 表存储 */

// 自动选择：
export const defaultLayer = Database.dialect === "pg" ? pgLayer : layer
```

消费者使用 `Auth.defaultLayer` 即可，无需关心底层存储。

#### 7.1.2 PG Auth 表 (`auth/auth.pg.ts`)

```sql
CREATE TABLE auth (
  provider_id  TEXT PRIMARY KEY,
  type         TEXT NOT NULL,    -- "oauth" | "api" | "wellknown"
  data         JSONB NOT NULL,  -- 完整认证信息
  time_created BIGINT NOT NULL,
  time_updated BIGINT NOT NULL
);
```

#### 7.1.3 Provider 热加载流程

```
PUT /auth/:providerID  {"type":"api","key":"sk-xxx"}
  │
  ├─ 1. Auth.set(providerID, info)
  │     → PG: INSERT INTO auth ... ON CONFLICT UPDATE
  │
  ├─ 2. if (Database.dialect === "pg")
  │       await Instance.disposeAll()
  │
  └─ 3. disposeAll() 内部：
        → 遍历缓存中的所有 Instance
        → ScopedCache.invalidate（清除缓存）
        → 下次请求自动重新初始化
          → Auth.all() 从 PG 读取最新凭证
          → 合并到 Provider 配置
```

**关键**：仅 PG 模式触发热加载（`Instance.disposeAll()`）。SQLite 模式不需要，因为 Provider 初始化时会读文件。

### 7.2 改动文件

| 文件 | 改动 |
|------|------|
| `auth/auth.pg.ts` | **新增**：PG auth 表定义 |
| `auth/index.ts` | 新增 `pgLayer`、`defaultLayer` 自动选择逻辑 |
| `server/control/index.ts` | PUT/DELETE `/auth` 触发 `disposeAll()` 热加载 |
| `tool/sandbox-provider.ts` | 新增 `OPENCODE_SANDBOX_API_KEY`、`USE_SERVER_PROXY` 配置 |
| `storage/db.ts` | 隔离级别改为 `read committed` |
| `tool/bash.ts` | 修复 sandbox await |

---

## 8. 改造五：容器化部署

**Commit**: `a47a3ba02f`（Dockerfile）+ `f757c4db12`（deployment.md + docker-compose.yml）

### 8.1 Dockerfile

Dockerfile 从根目录 `Dockerfile.server` 迁移到 `docker/Dockerfile`，内容不变：
- **基础镜像**: `oven/bun:1.3.11-alpine`
- **额外依赖**: `git`, `ripgrep`
- **暴露端口**: `4096`
- **WORKDIR**: `/app/packages/opencode`（使 tsconfig.json 生效）
- **健康检查**: `wget http://localhost:4096/`（30s 间隔）

### 8.2 docker-compose.yml

新增编排文件，所有环境变量支持 `${VAR:-default}` 注入。

### 8.3 文档

新增 `docs/deployment.md`：部署指南、环境变量说明、故障排查。

---

## 9. Bug 修复与优化

### 9.1 bash.ts Sandbox Await 修复

**问题**：`bash.ts` 中 sandbox 调用存在双重 catch 导致错误被吞掉。

**修复**：简化为 `Effect.tryPromise(() => ...)` 清理掉多余的 catch 层。

### 9.2 projectors.ts foreign() 修复

**问题**：PG 模式下 FK 错误被 `DrizzleQueryError` 包裹，`foreign()` 无法识别。

**修复**：增加 `DrizzleQueryError` 解包处理。

### 9.3 删除 renew(30*60)

**问题**：PVC 模式下 `renew(30*60)` 会无限续命 sandbox，使 `timeoutSeconds`（max TTL）失效。

**修复**：删除 `renew()` 调用。PVC 模式不 renew，让服务端 TTL 做硬兜底。

### 9.4 PG 并发序列化错误

**问题**：PG 默认隔离级别 `repeatable read` 在并发写入时触发序列化错误。

**修复**：隔离级别改为 `read committed`。

---

## 10. 测试覆盖

### 10.1 单元测试

| 测试文件 | 测试数 | 覆盖范围 |
|---------|--------|---------|
| `test/tool/sandbox-pvc.test.ts` | 255 行 | PVC 卷挂载、状态机、配置 |
| `test/tool/sandbox-cleanup-volume.test.ts` | 283 行 | PVC 卷清理 |
| `test/tool/sandbox-lazy-no-create.test.ts` | 123 行 | 懒加载不创建验证 |
| `test/tool/sandbox-command-queue.test.ts` | 9 pass | Semaphore 命令队列 |
| `test/tool/sandbox-provider-concurrency.test.ts` | 1 | 并发安全 |
| `test/auth/auth-pg.test.ts` | 182 行 | PG Auth CRUD（9 test） |
| `test/auth/auth-hot-update.test.ts` | 229 行 | Provider 热加载（6 test） |

### 10.2 E2E 测试

| 测试文件 | 覆盖范围 |
|---------|---------|
| `test/remote-sandbox-graded.test.ts` | 从简到难全链路任务测试 |
| `test/remote-sandbox-complex.test.ts` | 复杂任务测试 |
| `test/remote-sandbox-concurrent.test.ts` | 并发任务测试 |
| `test/remote-sandbox-pvc-lifecycle.test.ts` | PVC 生命周期测试 |
| `test/remote-sandbox-lifecycle-probe.test.ts` | Sandbox 生命周期探测 |

---

## 11. 改造后的 SaaS 架构

```
┌─────────────────────────────────────────────────────────────────────┐
│  K8s Pod                                                            │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  opencode-server container                                   │   │
│  │  bun run src/index.ts serve                                  │   │
│  │  :4096                                                       │   │
│  │                                                              │   │
│  │  ┌────────────────────────────────────────────────────────┐  │   │
│  │  │  Hono HTTP Server                                      │  │   │
│  │  │  60+ API 端点 + SSE 事件流                             │  │   │
│  │  └───────────────────┬────────────────────────────────────┘  │   │
│  │                      │                                        │   │
│  │  ┌───────────────────┼────────────────────────────────────┐  │   │
│  │  │  Agent Loop Engine (Effect TS)                          │  │   │
│  │  │  while(true): LLM 调用 → 工具执行 → 结果处理            │  │   │
│  │  │  · 20+ 内置工具 + MCP 外部工具                          │  │   │
│  │  │  · Sandbox 懒加载 + 命令队列                            │  │   │
│  │  └───────────────────┬────────────────────────────────────┘  │   │
│  │                      │                                        │   │
│  │  ┌──────────┐  ┌─────┴──────┐  ┌──────────────────────────┐│   │
│  │  │ Auth     │  │ Provider   │  │ Session/Message          ││   │
│  │  │ PG + 热  │  │ 热加载     │  │ PG 持久化               ││   │
│  │  │ 加载     │  │            │  │                          ││   │
│  │  └──────────┘  └────────────┘  └──────────────────────────┘│   │
│  └──────────┬──────────────────────┬───────────────────────────┘   │
│             │                      │                                │
└─────────────┼──────────────────────┼────────────────────────────────┘
              │                      │
              ▼                      ▼
     ┌──────────────┐      ┌────────────────┐      ┌──────────────┐
     │  PostgreSQL   │      │  OpenSandbox   │      │  PVC (NFS)   │
     │  16 张表      │      │  K8s Runtime   │      │  6 subPath   │
     │  自动迁移     │      │  按需创建/销毁  │      │  session 隔离│
     └──────────────┘      └────────────────┘      └──────────────┘
```

### 核心特性

| 特性 | 实现 |
|------|------|
| **多数据库** | SQLite（本地）/ PG（SaaS），环境变量一键切换 |
| **远程沙箱** | 代码在 K8s 容器中执行，支持 20+ 工具 |
| **PVC 持久化** | sandbox 数据跨生命周期保留，自动重建（1.8s） |
| **双层超时** | Idle Kill（主力回收）+ Max TTL（安全兜底） |
| **Auth 热加载** | HTTP API 管理 Provider 凭证，即时生效 |
| **命令队列** | Semaphore(1) 保证同一 session 串行 |
| **懒加载** | Sandbox 按需创建，文本回复不触发 |
| **容器化** | Docker 镜像 + docker-compose 编排 |

---

## 12. 快速使用

### 12.1 构建镜像

```bash
docker build -f docker/Dockerfile -t opencode-server:latest .
```

### 12.2 启动服务

```bash
docker run -d --name opencode-server -p 4096:4096 \
  -e OPENCODE_DATABASE_URL=postgresql://user:pass@pg:5432/opencode \
  -e OPENCODE_SANDBOX_ENABLED=true \
  -e OPENCODE_SANDBOX_DOMAIN=sandbox-host:30040 \
  -e OPENCODE_SANDBOX_API_KEY=your-key \
  -e OPENCODE_SANDBOX_VOLUME_TYPE=pvc \
  -e OPENCODE_SANDBOX_IDLE_KILL_SEC=60 \
  -e OPENCODE_SANDBOX_MAX_TTL_SEC=3600 \
  -e OPENSANDBOX_INSECURE_SERVER=YES \
  opencode-server:latest
```

### 12.3 添加 Provider（无需重启）

```bash
curl -X PUT http://localhost:4096/auth/moonshotai-cn \
  -H 'Content-Type: application/json' \
  -d '{"type":"api","key":"sk-xxx"}'
```

### 12.4 创建对话

```bash
SID=$(curl -s -X POST http://localhost:4096/session | jq -r '.id')
curl -X POST "http://localhost:4096/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{
    "parts":[{"type":"text","text":"写一个 hello world"}],
    "agent":"build",
    "model":{"providerID":"moonshotai-cn","modelID":"kimi-k2.6"}
  }'
```

详细部署指南见 [`docs/deployment.md`](./deployment.md)。

---

## 13. 改造文件清单

### 新增文件

| 文件 | 说明 |
|------|------|
| `storage/db.pg.ts` | PG 连接适配器 |
| `storage/schema-pg.ts` | PG 表统一导出 |
| `storage/schema.pg.ts` | PG Timestamps 辅助 |
| `auth/auth.pg.ts` | PG Auth 表定义 |
| `tool/sandbox-provider.ts` | Sandbox 生命周期管理 |
| `tool/sandbox-path.ts` | 主机/容器路径映射 |
| `migration-pg/` | PG 迁移 SQL 文件 |
| `drizzle.pg.config.ts` | PG Drizzle 配置 |
| `docker/Dockerfile` | Docker 镜像定义（从根目录 `Dockerfile.server` 迁移） |
| `docker-compose.yml` | Docker Compose 编排 |
| `docs/deployment.md` | 部署指南 |
| `docs/saas-architecture.md` | 本文档 |

### 修改文件

| 文件 | 改动内容 |
|------|---------|
| `storage/db.ts` | PG dialect、initialize()、migratePg()、事务隔离级别 |
| `auth/index.ts` | pgLayer、defaultLayer 自动选择 |
| `server/control/index.ts` | PUT/DELETE /auth 触发 disposeAll() |
| `session/prompt.ts` | getSandbox() 懒加载 + Deferred 去重 |
| `session/projectors.ts` | foreign() 增加错误解包 |
| `tool/bash.ts` | sandbox 远程执行 + await 修复 |
| `tool/registry.ts` | Sandbox Layer 注入 |
| `flag/flag.ts` | 所有新环境变量 |
| `server/instance/index.ts` | Instance 状态处理改进 |

---

## 14. 改造时间线

| 时间 | Commit | 内容 |
|------|--------|------|
| 04/17 | `91feb849f0` | **PG 数据库支持**：双数据库架构、Schema、Migration、Shim |
| 04/17 | `21143ea7ec` | **SaaS 基础**：Sandbox 工具执行 |
| 04/28 | `caa20fc632` | **懒加载 + FK 修复**：Sandbox 懒创建、PG FK DEFERRABLE、隔离级别调整 |
| 04/28 | `e3e33ab59c` | **命令队列**：Semaphore(1) 防并发冲突 |
| 04/28 | `839f2c35df` | **PVC 持久化**：6 卷挂载、状态机、空闲回收、Max TTL |
| 04/29 | `a47a3ba02f` | **Auth PG + 热加载**：PG Auth 表、disposeAll()、Dockerfile |
| - | - | **Dockerfile 迁移**：`Dockerfile.server` → `docker/Dockerfile` |
| 05/01 | `f757c4db12` | **部署文档**：deployment.md、drizzle.pg.config.ts |
| 05/01 | `043b6b7107` | **E2E 测试**：远程 sandbox 全链路测试 |
