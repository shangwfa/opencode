# SaaS CodeGraph 技术方案（opencode 仓库实现）

> 分支：`feat/saas-codegraph`（基于 `feat/opencode-1.18.18`）
> 决策记录：全异步实现；FTS 用 tsvector + pg_trgm 结合并对齐 codegraph 搜索行为；**按 `appId` 隔离（scope = `app:{appId}`，不感知 pvcMode）**；**不开发独立 API，查询能力以内置 tool 提供**（工具根据会话 ID 解析出 appId 再查图）。
>
> **实现状态（2026-08-20）：P1–P6 全部完成并通过端到端验证**（组合 3 本地 PG + 本地沙箱，codegraph 仓库 570 文件 → `ready` 12,141 节点 / 13,343 边；增量、删除清理、多会话复用、Agent 调用 codegraph_search 均验证）。实现落点：`packages/opencode/src/codegraph/` + `migration-pg/20260820*_codegraph*` + `scripts/build-codegraph-extractor.sh` + `docs/test-cases/codegraph/`。
>
> **复盘补齐（同日）**：搜索多信号重评分（`src/codegraph/search.ts`：`nameMatchBonus`/`kindBonus`/`scorePathRelevance`/测试文件降权）已接入 `store.searchNodes`；explore 接入真实 LOW_CONFIDENCE 检测（`isLowConfidenceQuery`）。实测 `extract` 搜索无测试文件混入、精确名优先。
> 参考实现：`~/code/codegraph`（colbymchenry/codegraph v1.5.0，MIT，仅作移植来源，不直接依赖该包）。

## 1. 背景与目标

为 opencode SaaS 增加代码知识图谱能力：对沙箱内源码建符号级索引（函数/类/调用关系），通过 HTTP API 供外部（Agent 编排层 / 业务方）查询，减少 LLM 探索代码的工具调用轮次。

- 索引触发：沙箱启动时自动跑，Agent 改代码后增量更新。
- 查询形态：**opencode 内置 tool**（`Tool.define` + registry 注册），Agent 在会话中直接调用；工具经 `ctx.sessionID` 解析 appId，非 app 模式会话优雅降级。
- 不存源码正文，只存图数据（符号、位置、关系）；源码读取由现有 read/grep 工具承担。

## 2. 总体架构

```
                    opencode server (pod)
┌─────────────────────────────────────────────────────┐
│  sandbox-provider.getOrCreate(sessionID)             │
│    └ 沙箱 ready 后 forkScoped CodegraphIndexer ───────┼──┐
│                                                      │  │ ①注入提取脚本+wasm
│  内置 Tools（LLM 会话中直接调用）                    │  │ ②exec 跑提取
│    codegraph_search / node / callers │  │ ③下载 ndjson 结果
│    codegraph_explore / impact        │  │ ④写 PG
│                                                      │  │ ⑤周期增量(diff 文件列表)
└─────────────────────────────────────────────────────┘  │
        │ 读 PG                                          ▼
        │                                    ┌────────────────────┐
┌───────▼──────────┐   exec/files API       │  沙箱容器            │
│  PostgreSQL       │◄───────────────────────│  /workspace 源码     │
│  codegraph_node   │    (服务端写 PG)        │  bun + 提取脚本      │
│  codegraph_edge   │                        │  tree-sitter wasm   │
│  ... + FTS 索引    │                        │  输出 ndjson        │
└───────────────────┘                        └────────────────────┘
```

**关键决策——沙箱不直连 PG**：提取脚本在沙箱内只做「读文件 → tree-sitter 解析 → 输出 ndjson」，结果经 files API 回传，由服务端统一写 PG。

理由：
1. 沙箱容器无需 PG 凭据与网络可达性（当前沙箱与 PG 的网络连通性未验证，不该成为前提）。
2. 写路径集中在服务端，scope 校验、advisory lock、迁移都在一处。
3. 沙箱被回收/中断时 PG 中不会留下半成品写入（结果文件回传成功才落库）。

代价：大仓库结果 ndjson 几十 MB，走 files API 传输（K8s 内网带宽足够，可 gzip）。

## 3. 数据模型

新建 `packages/opencode/src/codegraph/codegraph.pg.ts`，drizzle `pgTable`，全部表带 `scope` 列做隔离。

### 3.0 隔离键：scope = `app:{appId}`（纯应用维度）

codegraph 不感知 `pvcMode`（session/app 模式是卷路由等其他用途的概念）。判断规则只有一条：

> **会话带 `appId` → codegraph 可用，scope = `app:{appId}`；不带 → 工具返回引导文本。**

- 多会话 ↔ 一个应用（appId 即应用标识），共享一份索引；首个会话建索引，后续复用，多会话并发写由 advisory lock 单写者保证。
- 索引生命周期随应用：应用数据（PVC/代码）删除时按 scope 清理图数据。
- scope 前缀式 `app:{appId}`，advisory lock、缓存键直接用 scope 字符串。

scope 值格式：`app:{appId}` / `session:{sessionID}` 前缀式，避免两种 ID 空间碰撞，且 advisory lock、缓存键可直接用 scope 字符串。

### 3.1 表

| 表 | 列要点 | 说明 |
|---|---|---|
| `codegraph_node` | `scope, id, kind, name, qualified_name, file_path, language, start_line, end_line, start_col, end_col, docstring, signature, visibility, is_exported, is_async, is_static, is_abstract, decorators(jsonb), type_parameters(jsonb), return_type, is_generated, updated_at` + fts 生成列 | 符号。主键 `(scope, id)` |
| `codegraph_edge` | `scope, source, target, kind, metadata(jsonb), line, col, provenance` | 关系（calls/imports/extends/implements/contains/...）。`id bigserial`。**不建 FK**（批量重建性能，删除由应用层级联） |
| `codegraph_file` | `scope, path, content_hash, language, size, node_count, is_generated, indexed_at` | 文件账本，主键 `(scope, path)` |
| `codegraph_ref` | `scope, from_node_id, reference_name, reference_kind, line, col, candidates(jsonb), status` | 未解析引用（提取期产出，resolve 阶段消费） |
| `codegraph_index` | `scope, state(pending/indexing/ready/failed), files_total, files_done, nodes, edges, error, started_at, finished_at, engine_version` | 索引任务状态与进度，主键 `scope`（每次重建覆盖更新） |

### 3.2 FTS（对齐 codegraph FTS5 行为）

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- fts 生成列：simple 字典（无词干化，对齐 FTS5 unicode61），
-- 驼峰边界预切分使子词可命中；权重比例对齐 FTS5 name=20/qname=5/sig=2/doc=1
fts tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', regexp_replace(coalesce(name,''),'([a-z0-9])([A-Z])','\1 \2','g')), 'A') ||
  setweight(to_tsvector('simple', regexp_replace(coalesce(qualified_name,''),'([a-z0-9])([A-Z])','\1 \2','g')), 'B') ||
  setweight(to_tsvector('simple', coalesce(signature,'')), 'C') ||
  setweight(to_tsvector('simple', coalesce(docstring,'')), 'D')
) STORED
```

索引：

```sql
CREATE INDEX codegraph_node_fts_idx   ON codegraph_node USING GIN(fts);
CREATE INDEX codegraph_node_trgm_idx  ON codegraph_node USING GIN(name gin_trgm_ops);
CREATE INDEX codegraph_node_name_idx  ON codegraph_node(scope, name);
CREATE INDEX codegraph_node_file_idx  ON codegraph_node(scope, file_path, start_line);
CREATE INDEX codegraph_edge_src_idx   ON codegraph_edge(scope, source, kind);
CREATE INDEX codegraph_edge_tgt_idx   ON codegraph_edge(scope, target, kind);
...
```

### 3.3 搜索四层（对齐 codegraph `searchNodes`）

| codegraph (SQLite) | 本实现 (PG) |
|---|---|
| ① FTS5 BM25 前缀 | `fts @@ to_tsquery('simple', 'seg1:* \| seg2:*')`，排序 `ts_rank('{0.05,0.1,0.25,1.0}', fts, q)`（数组序 {D,C,B,A}，值域限 [0,1]，FTS5 20:5:2:1 归一化）。查询词切分复用移植来的 `splitIdentifierSegments` 逻辑，tsquery 特殊字符（`& \| ! ( ) :`）先清洗 |
| ② LIKE 子串回退 | `name ILIKE '%q%'`（走 trgm GIN） |
| ③ 编辑距离模糊 | `similarity(name, q) > 0.3`（pg_trgm 近似替代，行为不逐字对齐但同层回退） |
| ④ 精确名称补充 | `WHERE scope=$1 AND name=$2` 单独补查，防止被排名埋没 |

多信号重评分（kindBonus / pathRelevance / nameMatchBonus / 测试文件降权 / 生成文件降权）是纯 TS 逻辑，原样移植。

### 3.4 迁移

`packages/opencode/migration-pg/<时间戳>_codegraph/migration.sql`，用 `--> statement-breakpoint` 分隔。现有 `migratePg()`（`src/storage/db.ts`，advisory lock + sha256 去重）自动执行，无需改 runner。

## 4. 提取管线（直接采用 codegraph 包作提取引擎）

### 4.1 集成方式：依赖 `@colbymchenry/codegraph`，不自研提取器

codegraph v1.5+ 提供双层提取引擎，**自动优先 Rust kernel，缺失/加载失败时优雅回退 WASM 管线**（loader 契约校验 ABI/kind 表，`CODEGRAPH_KERNEL=0` 可关）：

| 层 | 实现 | 性能 |
|---|---|---|
| Rust kernel（首选） | `codegraph-kernel`（~2 万行 Rust，napi cdylib，native tree-sitter crate 静态编译，**每文件仅 1 次 JS 边界穿越**，buffer 表输出） | 快 3-10x；17+ 语言全量；native 堆无需 worker 回收 |
| WASM 回退 | `web-tree-sitter` + tree-sitter-wasms | 基线；作为 kernel 不可用时的兜底 |

沙箱提取脚本（bun）`import` 该包，调 `extractFromSource(filePath, source)` 拿 nodes/edges/unresolvedReferences 对象，转 ndjson 输出。**零提取器移植**，语言覆盖全量，自动享受上游演进（pin 版本控制耦合）。

许可：MIT，商用保留版权声明即可。

**前提验证（P2 第一项）**：沙箱基础镜像（opensandbox/code-interpreter 系）glibc 版本能否 dlopen prebuild 的 `.node`（linux-x64-gnu，napi3）。失败则回退 WASM 管线仍可用（性能降级但功能等价）；若两者皆不可用再评估自编译 kernel。

仍需从 codegraph 移植的**服务端纯逻辑**（不进沙箱）：

| 模块 | 来源 | 说明 |
|---|---|---|
| 引用解析 | `resolution/index.ts`（ReferenceResolver） | 服务端跑（消费 codegraph_ref 产出跨文件边）；一期名称匹配 + import 解析，框架 resolver 二期 |
| 搜索评分 | `search/query-utils.ts`、`query-parser.ts`、`identifier-segments.ts` | 纯函数原样移植（四层搜索的重评分逻辑） |
| 生成文件识别 | `extraction/generated-detection.ts` | 纯函数原样移植 |
| 图遍历语义 | `graph/traversal.ts` | BFS/callers/impact 的语义参考（服务端 PG 版重写） |

### 4.2 沙箱内提取/完整分析（full 模式）

沙箱脚本 `node main.ts full`（node 必须——`node:sqlite`），用 codegraph SDK 在沙箱内跑**完整本地管线**：

```
full (全量)  : rm .codegraph → initSync → indexAll（kernel 提取 + 框架检测产 route 节点）
               → resolveReferences（name-matcher + framework resolvers + 局部类型推断）
               → 导出全部 nodes/edges/files（gzip ndjson）→ 服务端 replaceGraph
incremental  : openSync → graph.sync()（content-hash diff → indexFiles(changed)
               → 只 resolve 变更文件 refs）→ 导出变更文件邻域（节点 + source/target 边）
               → 服务端 replaceFiles（按文件删旧插新）
```

- **沙箱内有源码**，所以 codegraph 的全部能力都生效：跨文件 calls、route→handler references、组件 usage、变量 receiver 方法调用（局部类型推断）。
- 镜像内置：extractor 由沙箱镜像 COPY 到 `/opt/codegraph-extractor`（构建沙箱镜像前跑 `scripts/build-codegraph-extractor.sh --target <arch>`），indexer 直接 exec，无运行时注入。
- 服务端只落库，不解析（无源码时 26% 解析率的下限方案已移除，全量/增量统一沙箱内完整解析）。

服务端流程（`CodegraphIndexer`）：

1. **注入**：经沙箱 files API 上传 `codegraph-extractor` 到 `/tmp/`（chmod +x）。每次索引前检查已存在则跳过（带版本号文件名，升级自动重传）。
2. **全量**：`exec: /tmp/codegraph-extractor index --root /workspace --ndjson /tmp/codegraph-out.ndjson.gz --progress /tmp/cg-progress.json`
   - 脚本内：scan（默认忽略目录表：node_modules/dist/target/vendor 等 50+，来源 codegraph）→ 逐文件 tree-sitter 解析 → ndjson 写出（每行一个 record：`{t:"file"|"node"|"edge"|"ref", ...}`）→ 进度写 progress 文件。
   - 服务端轮询 progress 文件（exec 长任务，用 `POST /session/:id/exec/async` + 周期读 progress）更新 `codegraph_index`。
3. **回传**：files API 下载 ndjson.gz，流式解压。
4. **落库**：`pgDb.transaction` 内：`pg_advisory_xact_lock(hashtext('codegraph:'||scope))` → delete 该 app 旧数据 → COPY/batch insert（1000 行/批）→ 跑移植的 ReferenceResolver（服务端执行，读 `codegraph_ref` 产出边）→ 更新 `codegraph_index.state=ready`。

### 4.3 进程模型（与原版差异）

原版 worker_threads 池（主线程 UI 不阻塞 + 每 250 文件回收 WASM 内存）在 kernel 路径下不再需要（native 堆自管理）；仅 WASM 回退路径保留回收语义：

- kernel 加载成功：单进程顺序解析，无回收。
- WASM 回退：单进程顺序解析，每 500 文件 `Bun.spawn` 自重启（对齐原版回收语义）。
- 万级文件仓库实测若超时（目标 < 3 分钟），二期再上 bun worker 池。

### 4.4 触发时序与增量同步

**触发不是只在沙箱启动时一次性执行**——沙箱刚启动时 /workspace 通常为空（代码由 Agent/编排层随后 git clone 或写入）。indexer 以循环检测驱动：

1. 启动时查 `codegraph_index`：`ready` 且工作区无大变 → 直接进增量循环。
2. `/workspace` 为空且无索引 → 不建空索引，进 watch 循环（30s）。
3. 循环内检测：工作区「空 → 大量文件」或新出现 `.git` → 触发全量索引（④⑤ 落库见 4.2）。
4. 已有索引 → **变更检测不依赖 git status**（git 盲区：`git pull`/`checkout`/`merge` 后工作树 clean）：沙箱脚本 stat 清单（path, size, mtime）+ 服务端与 `codegraph_file` 对比（>1MB 文件跳过——从未索引，不驱动变更判定）。
5. **增量走 codegraph 原生 `sync()`**：content-hash diff → indexFiles(changed) → 只 resolve 变更文件 refs → 导出变更文件邻域（节点 + source/target 边）→ 服务端 `replaceFiles` 按文件删旧插新（入边正确性由"删 target∈文件边"保证：目标节点还在则保留、删除则清除）。
6. 删除文件 → 强制全量重建（SQLite 不自动从图里删文件）。
7. 沙箱空闲/回收判定复用 idle-reap 的 zombie 判定：沙箱已被回收则循环自动退出，等下次 getOrCreate 重建（此时回到第 1 步，ready 的索引直接复用）。

## 5. 触发与调度

### 5.1 启动时机

`sandbox-provider.ts` 的 `createSandbox` 后（现仅有 `mkdir -p /workspace` 钩子）追加：

- 解析会话的 `appId`（复用 `src/session/sandbox-opts.ts` 链路，沿父会话链查 `session` 表）；**只看 appId，不看 pvcMode**。无 appId → 跳过 codegraph。
- scope = `app:{appId}`。`Effect.forkScoped` 启动 `CodegraphIndexer.ensureIndexed(scope, sandbox)`：查 `codegraph_index.state`，非 ready 则跑全量，然后进入增量循环。
- 同 app 多会话并发：advisory lock（按 scope）保证单写者；第二个会话的 indexer 检测到 lock 被持/已 ready 则只读共享。

### 5.2 进度可见

`codegraph_index` 表即进度源。索引未 ready 时各工具返回提示文本（含进度），Agent 可稍后重试或先用 read/grep。

## 6. 内置 Tool（查询能力暴露方式）

不开发独立 HTTP API。查询能力以 **opencode 内置 tool** 提供（对齐 `src/tool/read.ts`、`grep.ts` 的 `Tool.define` 模式，在 `registry.ts` 注册），Agent 在会话中直接调用。

### 6.1 scope 解析（工具入口的公共逻辑）

每个工具 execute 的第一步：

1. `ctx.sessionID` → 经 `src/session/sandbox-opts.ts` 同款链路（父会话链 + `session` 表）查出 `appId`（不看 pvcMode）→ scope = `app:{appId}`。
2. 无 appId → 返回说明文本，**不是 isError**（对齐 codegraph 的 NotIndexedError 设计：避免 Agent 学习到工具坏了而永久弃用）。
3. 结果按 sessionID 缓存（LRU，短 TTL），避免每次工具调用查 session 表。

### 6.2 工具清单（8 个，对齐 codegraph MCP + CLI）

| 工具 | 参数 | 行为（对齐 codegraph） |
|---|---|---|
| `codegraph_search` | `query, kind?, limit?` | 四层搜索 + 多信号重评分，返回符号位置清单（无源码） |
| `codegraph_node` | `symbol, file?, line?` | 符号详情：位置 + 签名 + docstring + caller/callee 概要；同名多定义全返回；附 `file:line` 供 read |
| `codegraph_callers` | `symbol, file?, limit?` | 调用者枚举（含调用类型标签），同名定义按文件分组 |
| `codegraph_callees` | `symbol, file?, limit?` | 被调用者枚举（原版 MCP 工具，补齐） |
| `codegraph_impact` | `symbol, file?, depth?` | 影响半径（重构前自查） |
| `codegraph_explore` | `query, maxSymbols?` | **移植原版分配算法**：RELEVANCE_KIND_WEIGHT 评分 + 弱 kind usage 隔离探测 + rankPenalty（测试/生成降权）+ spine 调用路径加权 + CLIFF_FRACTION 相对裁剪 + MIN 保底/权重分剩余（预算单位=符号数）；cliff 文件仍列名；LOW_CONFIDENCE 检测 |
| `codegraph_files` | `path?, format?`（tree/flat/grouped）, limit? | 索引文件树（语言+符号数），快于 Glob |
| `codegraph_affected` | `files[], includeTests?, depth?, limit?` | 变更文件影响分析：BFS 文件依赖传播，生产/测试分离（测试选择），对齐原版 CLI `affected` |

每个工具配 `codegraph_*.txt` 描述文件（对齐仓库 tool.ts + tool.txt 惯例），描述里写明：数据可能滞后于最新编辑（增量 30s 周期）、索引进度中时的行为、源码请用 read。

### 6.2.1 数据滞后透明化（对齐 codegraph issue #403 的 stale 设计）

indexer 增量循环维护「最近编辑未同步文件集」（本轮 watch 到变更、尚未落库的 path 列表，持久化在 `codegraph_index` 待同步字段）。工具响应在命中这些文件时附横幅：「以下文件刚被编辑，索引尚未同步，读其内容请用 read 工具」——让 Agent 对滞后精确知情，而非整体不信任索引。

### 6.2.2 LOW_CONFIDENCE 诚实信号（对齐 codegraph context builder）

explore 的查询只命中常见词/无区分度词（如 "data"、"handler"）时，输出末尾标记 LOW_CONFIDENCE：声明结果可能偏靶，建议改用真实符号名（camelCase/snake_case）再查或用 codegraph_search。随评分函数移植（`isDistinctiveIdentifier` 等纯函数），防止把噪声结果当完整答案。

### 6.3 权限与可见性

- 只读工具，默认允许（同 read/grep），不进 permission 询问。
- 工具注册进 `registry.ts` 的默认工具集；无 scope 的会话中调用得到引导文本（见 6.1），不做注册级隐藏（注册表是全局的，按会话动态隐藏成本高且无必要）。

### 6.4 图遍历实现

服务端 TS 实现 BFS（移植 codegraph `graph/traversal.ts` 的语义：批量 `WHERE id = ANY($1)` 拉邻居、contains/calls 优先排序、instantiates 视为调用等），带 LRU 节点缓存；二期可下推 `WITH RECURSIVE`。

## 7. 代码组织

```
packages/opencode/src/codegraph/
├── codegraph.pg.ts          # 5 张表定义
├── index.ts                 # self-export 模块（export * as Codegraph）
├── store.ts                 # PG 读写：批量落库、advisory lock、四层搜索、图遍历查询
├── resolver.ts              # 移植的 ReferenceResolver（服务端跑）
├── indexer.ts               # CodegraphIndexer：注入/exec/回传/落库/增量循环（Effect）
├── script/
│   └── main.ts              # 沙箱内提取脚本入口（依赖 @colbymchenry/codegraph，
│                            #   bun build 打包，含 kernel prebuild + wasm 双资产）
├── search/                  # 移植的查询解析/评分（纯函数）
└── tool/
    ├── codegraph-search.ts + .txt
    ├── codegraph-node.ts + .txt
    ├── codegraph-callers.ts + .txt
    ├── codegraph-explore.ts + .txt
    └── codegraph-impact.ts + .txt   # 5 个工具，registry.ts 注册
```

构建：`package.json` 加 `build:codegraph-script`（bun build 产物进 `docker/` 或运行时从服务端文件系统读）。wasm 语法文件随提取脚本打包。

风格对齐 opencode AGENTS.md：self-export、避免解构、Effect 内具名 service、注释只写非显然约束。移植文件顶部保留 codegraph MIT 版权与来源注释。

## 8. 实施阶段

| 阶段 | 内容 | 验收 | 状态 |
|---|---|---|---|
|---|---|---|
| P1 | 表 + 迁移 + store.ts（CRUD/搜索/遍历查询）+ 冒烟 | 本地 PG：migration 跑通；四层搜索与 CLI 输出一致 | ✅ |
| P2 | 沙箱脚本（codegraph kernel，双平台 bundle）+ 打包 | 沙箱内 kernel 加载成功；ndjson 符号数一致 | ✅ |
| P3 | indexer.ts（Effect 服务，claim/heartbeat/zombie 自愈）挂载 AppLayer | 会话启动 → 索引自动到 ready | ✅ |
| P4 | 5 个内置 tool + registry 注册 | Agent 会话内调用返回符合预期；无 appId 返回引导文本 | ✅ |
| P5 | 增量循环（stat+hash 对比）+ stale 文件集 + 单写者 + 删除清理 | 改文件 20s 内落库；删除文件首循环清理 | ✅ |
| P6 | Dockerfile 集成（双平台 bundle 入镜像）+ 端到端验证 | 组合 3 端到端跑通（Agent 实测 codegraph_search 返回精确定位） | ✅ |

## 9. 风险与开放问题

| # | 问题 | 处理 |
|---|---|---|
| 1 | ndjson 回传体量 | gzip + K8s 内网；实测 570 文件 → 1.1MB gz（114k 行），可接受 |
| 2 | exec 长任务被 idle-reap 回收 | 用例须先 keep-alive（`new_sid -k`）；沙箱保活后无此问题。**远端沙箱 kill 卡死**（已死沙箱 kill 超时）→ 手动清 `sandbox` 行绕过 |
| 3 | 增量检测 git 盲区 | stat+hash 文件对比（不信任 git status）；删除文件清理 bug（`changed=0` 提前 return 导致 dropMissingFiles 不执行）已修复 |
| 4 | tsquery 特殊字符注入/抛错 | 清洗函数 + 单测覆盖（`c++`、`a&&b` 等） |
| 5 | explore 无源码正文，Agent 多一次 read 往返 | 工具返回精确 file:line，Agent 用 read 单次区间读取；二期可选 codegraph_file 加 content 列 |
| 6 | 同 appId 会话的代码是否同一份 | codegraph 只认 appId，不感知 pvcMode。若业务上同 appId 的会话未共享同一份代码（卷配置问题），索引会以首个索引时快照为准——代码一致性由业务侧的 appId 使用约定保证。本地 docker PVC 不跨容器共享 subPath，共享语义以远端 K8s PVC 为准 |
| 7 | 大仓库首次索引分钟级 | 不阻塞会话（forkScoped 后台跑），期间工具返回"索引中(进度 x/y)"提示文本，Agent 可先用 read/grep |
| 8 | codegraph 上游演进 / kernel ABI | pin 包版本；升级走集成测试（符号数对拍） |
| 9 | kernel 偶发重复 node id（Dart 嵌套函数等） | store 落库前去重（保留首个）；实测 12,141 节点去重 6 个 |
| 10 | 本地 docker PVC 不跨容器共享 subPath | 本地组合 3 下同 app 第二会话沙箱看不到代码（不影响索引复用，`ready` 数据稳定）；共享语义以远端 K8s PVC 为准 |
