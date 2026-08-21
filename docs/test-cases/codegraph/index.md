# codegraph SaaS 集成用例（沙箱完整分析 → PG → 内置工具）

> 验证 `feat/saas-codegraph`：app 模式会话的沙箱启动后自动对 `/workspace` 代码做**完整分析**（codegraph kernel 提取 + 框架检测 + resolveReferences），结果写 PG（`codegraph_*` 表，按 `scope=app:{appId}` 隔离），并通过 8 个内置工具（`codegraph_search/node/callers/callees/impact/explore/files/affected`）暴露给 Agent。
>
> 实现：
> - `packages/opencode/src/codegraph/`：`codegraph.pg.ts`（表）、`store.ts`（读写/四层搜索/图遍历/状态机）、`indexer.ts`（30s 守护索引 + 增量 `sync()`）、`script/main.ts`（沙箱内完整分析：kernel + framework + resolver）、`tool/`（8 个内置工具）
> - `packages/opencode/migration-pg/20260820120000_codegraph/` + `20260820130000_codegraph_file_mtime/`
> - `scripts/build-codegraph-extractor.sh`（单平台目录 + 双平台 tar）
>
> **镜像内置**：extractor 由沙箱镜像 Dockerfile COPY 到 `/opt/codegraph-extractor`（构建沙箱镜像前跑 `scripts/build-codegraph-extractor.sh --target <arch>`），indexer 直接 exec `node /opt/codegraph-extractor/main.ts full`，无运行时注入。
>
> **关键设计**：
> 1. codegraph 只认 `appId`（不看 pvcMode），scope = `app:{appId}`；无 appId 的会话工具返回引导文本（非 isError）。
> 2. **完整解析在沙箱内**（有源码）：`full`（全量）/`--incremental`（`graph.sync()` 增量）都由 codegraph 自身管线产出全部边，服务端只落库。
> 3. 增量检测用文件系统 stat（mtime/size），**不信任 git status**；>1MB 文件（从未索引）不参与变更判定。
> 4. kernel 偶发重复 node id，落库前去重。

## 公共环境

> 运行前先全局加载环境：`source test-env.sh [1|2|3]`（见 [`session/00-preamble.md`](./session/00-preamble.md)）。用例直接用 `$BASE` `$PG_URL` `$MODEL`，不重复定义。
>
> codegraph 端到端依赖沙箱：**推荐组合 3（本地 PG + 本地 OpenSandbox）**——本地沙箱可 docker exec 直接排查，远端沙箱不稳定（见已知问题）。沙箱内需先克隆代码到 `/workspace`（用例 CG-1 用 `/workspace/repo`）。

---

## CG-1: 全量索引自动触发

### T42.1.1 创建 app 会话 + keep-alive + 启动沙箱 + 克隆代码

```bash
source test-env.sh 3 && source test-lib.sh

SID=$(new_sid)
curl -s -X POST "$BASE/session/$SID/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":true,"boot":true}' >/dev/null
# 沙箱起来后克隆一个小仓库（例：codegraph 自身 ~570 文件）
curl -s --max-time 180 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"git clone --depth 1 https://github.com/colbymchenry/codegraph.git /workspace/repo 2>&1 | tail -1 && ls /workspace/repo/src | wc -l"}'
```

**期望**：`exec` 返回 exit 0；stdout 含克隆信息 + 文件数（>0）。

### T42.1.2 indexer 自动触发全量索引（30s 内 state=ready）

```bash
# 轮询 codegraph_index，最多等 3 分钟
for i in $(seq 1 12); do
  ST=$(psql "$PG_URL" -t -A -c "SELECT state FROM codegraph_index WHERE scope='app:$APP_ID'" 2>/dev/null)
  [ "$ST" = "ready" ] && break
  sleep 15
done
psql "$PG_URL" -t -A -c "SELECT state, node_count, edge_count, files_done, files_total FROM codegraph_index WHERE scope='app:$APP_ID'"
```

**期望**：`state=ready`，`node_count>0`，`edge_count>0`（codegraph 仓库完整解析预期 ~1.28 万节点 / ~4.48 万边；注意边数是早期轻量方案 1.3 万的 3.3 倍——完整 resolveReferences 产 calls/imports/instantiates 全量边）。

> 注：`$APP_ID` 由用例开头创建会话时捕获（`curl ... | jq -r .appId`）。如果没显式传 appId，可改用会话的 app_id：`psql "$PG_URL" -t -A -c "SELECT app_id FROM session WHERE id='$SID'"`。

### T42.1.3 PG 落库完整（5 表）

```bash
psql "$PG_URL" -t -A <<SQL
SELECT 'nodes', count(*) FROM codegraph_node WHERE scope='app:$APP_ID'
UNION ALL SELECT 'edges', count(*) FROM codegraph_edge WHERE scope='app:$APP_ID'
UNION ALL SELECT 'files', count(*) FROM codegraph_file WHERE scope='app:$APP_ID'
UNION ALL SELECT 'refs', count(*) FROM codegraph_ref WHERE scope='app:$APP_ID';
SQL
```

**期望**：4 行都有 count>0；`files` 数量与仓库源文件数一致。

---

## CG-2: 查询能力

> 工具是 Agent 内部机制（LLM 驱动），HTTP 层不能直接调。本组用例直接验证**工具的后端**（store 层逻辑，scope 解析 + 四层搜索 + 图遍历），等价于工具 execute 的核心路径。

### T42.2.1 四层搜索（精确/驼峰/子串/trigram）

```bash
# 直接查 PG 模拟 searchNodes：先 FTS 命中（tsvector + 驼峰切分）
psql "$PG_URL" -t -A -c "
SELECT name, file_path, start_line FROM codegraph_node
WHERE scope='app:$APP_ID'
  AND fts @@ to_tsquery('simple', 'extractFromSource:* | extract:* | from:* | source:*')
LIMIT 5;"
```

**期望**：命中 `extractFromSource`（`repo/src/extraction/tree-sitter.ts` 附近）。

### T42.2.2 scope 解析 + 图遍历（模拟 codegraph_node 的 caller/callee）

```bash
# findById 等符号被谁调用（incoming calls 边）
psql "$PG_URL" -t -A -c "
WITH t AS (SELECT id FROM codegraph_node WHERE scope='app:$APP_ID' AND name='extractFromSource' LIMIT 1)
SELECT n.qualified_name, n.file_path, n.start_line
FROM codegraph_edge e JOIN codegraph_node n ON n.id=e.source AND n.scope=e.scope
WHERE e.scope='app:$APP_ID' AND e.target=(SELECT id FROM t) AND e.kind='calls'
LIMIT 5;"
```

**期望**：列出调用 `extractFromSource` 的符号位置。

### T42.2.3 工具引导文本（无 appId 会话）

```bash
SID2=$(new_sid)   # 不带 appId
# 直接调用工具入口逻辑 resolveScopeOrGuide（等价工具 execute 的第一分支）
OPENCODE_DATABASE_URL=$PG_URL bun -e "
import { resolveScopeOrGuide } from '$(git rev-parse --show-toplevel)/packages/opencode/src/codegraph/scope'
const { scope, guidance } = await resolveScopeOrGuide('$SID2')
console.log('scope:', scope, '| guidance:', guidance)
"
```

**期望**：`scope: null`，guidance 含「未绑定应用」；工具返回该文本且**不是** `isError`（工具源码 `if (!scope) return {...output: guidance}`，无 fail 路径）。

---

## CG-3: 增量同步

### T42.3.1 修改文件 → 30s 内增量落库

```bash
# 在沙箱改一个源文件（加一个函数）
curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"echo '\''function cgIncrementalProbe() { return 1; }'\'' >> /workspace/repo/src/index.ts && echo WRITTEN"}'

# 等 indexer 增量循环（stat diff → 重提取）
sleep 45
psql "$PG_URL" -t -A -c "SELECT count(*) FROM codegraph_node WHERE scope='app:$APP_ID' AND name='cgIncrementalProbe'"
```

**期望**：`1`（新符号被索引进 PG）。**注意**：`files_done/files_total` 在增量后可能不刷新（只更新改动文件）。

### T42.3.2 删除文件 → 索引清理

```bash
curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"rm /workspace/repo/src/index.ts && echo REMOVED"}'
sleep 45
psql "$PG_URL" -t -A -c "SELECT count(*) FROM codegraph_node WHERE scope='app:$APP_ID' AND file_path='repo/src/index.ts'"
```

**期望**：`0`（删除的文件从索引清除，`dropMissingFiles` 生效）。

---

## CG-4: 多会话共享 + 隔离

### T42.4.1 同 app 第二会话复用 ready 索引

```bash
SID3=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d "{\"appId\":\"$APP_ID\"}" | jq -r .id)
# 第二会话沙箱启动后，indexer 应复用 ready 索引（不重建），只做增量
psql "$PG_URL" -t -A -c "SELECT state, node_count FROM codegraph_index WHERE scope='app:$APP_ID'"
```

**期望**：`state=ready` 不变，`node_count` 不翻倍（第二会话不重复全量索引）。

### T42.4.2 不同 app 隔离

```bash
psql "$PG_URL" -t -A -c "SELECT count(*) FROM codegraph_node WHERE scope='app:other-app'"
# 期望: 0（不同 app 数据互不可见）
```

**期望**：`0`。

---

## CG-5: 增量精确同步（codegraph sync + replaceFiles）

> 增量不再全量替换：沙箱内 `graph.sync()`（content-hash diff → indexFiles(changed) → 只 resolve 变更文件 refs）→ 导出变更文件邻域 → 服务端 `replaceFiles` 按文件替换。

### T42.5.1 单文件修改 → 变更集精确 + 按文件落库

```bash
SID=$(new_sid -k)   # app 模式 + keep-alive，沙箱克隆代码后等索引 ready
APP=$(psql "$PG_URL" -t -A -c "SELECT app_id FROM session WHERE id='$SID'")

# 改一个文件
curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"echo '\''function cgSyncProbe() { return 1; }'\'' >> /workspace/repo/src/index.ts && echo W"}'

# 等 indexer 增量（30s 轮询 + sync + replaceFiles）
for i in $(seq 1 8); do
  N=$(psql "$PG_URL" -t -A -c "SELECT count(*) FROM codegraph_node WHERE scope='app:$APP' AND name='cgSyncProbe'")
  [ "$N" = "1" ] && break; sleep 10
done
echo "probe=$N"; psql "$PG_URL" -t -A -c "SELECT count(*) FROM codegraph_edge WHERE scope='app:$APP'"
```

**期望**：`probe=1`；边总数变化极小（只按变更文件替换，非全量重写）。日志 `service=codegraph-indexer ... incremental` 显示 `changed=1`。

### T42.5.2 大文件不污染变更集（>1MB 跳过）

```bash
# codegraph 仓库含 23MB vendored parser.c——不应进 changed
curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"touch /workspace/repo/codegraph-kernel/grammars/dart/parser.c && echo T"}'
sleep 60
docker logs opencode-saas-test 2>&1 | grep -iE "incremental" | tail -3
```

**期望**：增量日志 `changed` 不含 parser.c（服务端 stat 对比过滤 >1MB）。

### T42.5.3 删除文件 → 切片清理（无全量 rebuild）

```bash
curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"rm /workspace/repo/src/index.ts && echo R"}'
sleep 60
psql "$PG_URL" -t -A -c "SELECT count(*) FROM codegraph_node WHERE scope='app:$APP' AND file_path='repo/src/index.ts'"
# 日志: incremental deletion → full dump（sync 处理删除 + full PG dump 捕获 rebinds，无 kernel 重解析）
```

**期望**：`0`（切片：`dropMissingFiles` + incremental sync + full PG dump，`isFullDump` 判定）。

### T42.5.4 增量无 .codegraph 状态 → 回退全量（fresh checkout）

```bash
# 模拟 fresh checkout：PVC 代码在但沙箱无 SQLite 状态（PG ledger 却 ready）
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"rm -rf /workspace/.codegraph && echo cleared"}'
# 手动触发增量命令（或改一个文件等 30s 循环）
curl -s --max-time 300 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && node /opt/codegraph-extractor/main.ts full --root /workspace --out /tmp/cg.ndjson.gz --progress /tmp/cg-progress.json --incremental"}'
```

**期望**：exit 0，日志含 `no .codegraph state, incremental falls back to full build`，输出节点数与全量一致（修复前 `openSync` 直接抛错 → failIndex → 下一循环全量自愈）。

---

## CG-6: 新工具面（callees/files/affected）

> 工具是 Agent 内部机制，本组验证工具**后端**（store 查询 + 输出逻辑），等价于工具 execute 核心路径。

### T42.6.1 callees（被调用者）

```bash
# 直接查 store.getCallees 等价 SQL：findById 等方法调用了谁
psql "$PG_URL" -t -A -c "
SELECT DISTINCT n2.qualified_name, n2.file_path
FROM codegraph_edge e JOIN codegraph_node n1 ON n1.id=e.source AND n1.scope=e.scope
     JOIN codegraph_node n2 ON n2.id=e.target AND n2.scope=e.scope
WHERE e.scope='app:$APP' AND e.kind='calls' AND n1.name='extractFromSource' LIMIT 5;"
```

**期望**：列出 extractFromSource 直接调用的符号（如 detectLanguage、各 extract 方法）。

### T42.6.2 files（文件树）

```bash
psql "$PG_URL" -t -A -c "SELECT count(*), count(DISTINCT language) FROM codegraph_file WHERE scope='app:$APP'"
```

**期望**：文件数 >0，多语言（typescript/yaml/go 等）。

### T42.6.3 affected（变更影响 + 测试选择）

```bash
# 某被广泛引用文件（tree-sitter.ts）的依赖者 + 测试文件占比
psql "$PG_URL" -t -A -c "
SELECT count(DISTINCT e.source) AS dependents
FROM codegraph_edge e JOIN codegraph_node n ON n.id=e.target AND n.scope=e.scope
WHERE e.scope='app:$APP' AND n.file_path='repo/src/extraction/tree-sitter.ts' AND e.kind != 'contains';"
# 测试文件依赖者（isTestFile 语义的子集：__tests__ 目录）
psql "$PG_URL" -t -A -c "
SELECT count(DISTINCT s.file_path) FROM codegraph_edge e
JOIN codegraph_node n ON n.id=e.target AND n.scope=e.scope
JOIN codegraph_node s ON s.id=e.source AND s.scope=e.scope
WHERE e.scope='app:$APP' AND n.file_path='repo/src/extraction/tree-sitter.ts' AND e.kind != 'contains'
  AND s.file_path LIKE '%__tests__%';"
```

**期望**：dependents>0（实测 40），测试文件依赖者>0（实测 17，kernel-parity 套件）。

---

## CG-7: explore 分配算法（对齐原版输出预算）

> explore 移植原版分配算法：RELEVANCE_KIND_WEIGHT 评分 + spine 调用路径加权 + CLIFF 相对裁剪 + MIN 保底。

### T42.7.1 精确查询 → spine 文件优先 + 预算分配

```bash
# 等价逻辑：query="extractFromSource"，spine 文件（tree-sitter.ts 定义 + Extractor 实现）应全量展示
# 验证输出含 spine 标记与文件分组（本地验证脚本方式，REPO_ROOT = 本仓库根目录）:
cat > /tmp/cg-explore-verify.ts <<'EOF'
import { runCodegraphExplore } from "${process.env.REPO_ROOT}/packages/opencode/src/codegraph/tool/codegraph-explore"
const out = await runCodegraphExplore(process.env.CG_SCOPE, "extractFromSource", 30)
console.log(out.includes("[spine]") ? "SPINE_OK" : "NO_SPINE")
console.log(out.slice(0, 200))
EOF
REPO_ROOT=$(git rev-parse --show-toplevel) CG_SCOPE="app:$APP" OPENCODE_DATABASE_URL=$PG_URL bun /tmp/cg-explore-verify.ts
```

**期望**：输出含 `[spine]` 文件（tree-sitter.ts 定义 + Extractor 实现）；调用关系段清晰。

### T42.7.2 低置信查询 → 裁剪 + cliff 列名 + LOW_CONFIDENCE

```bash
cat > /tmp/cg-explore-low.ts <<'EOF'
import { runCodegraphExplore } from "${process.env.REPO_ROOT}/packages/opencode/src/codegraph/tool/codegraph-explore"
const out = await runCodegraphExplore(process.env.CG_SCOPE, "data handler flow", 30)
console.log("LOW:", out.includes("LOW_CONFIDENCE"))
console.log("cliff:", out.includes("未展示") || out.includes("cliff"))
EOF
REPO_ROOT=$(git rev-parse --show-toplevel) CG_SCOPE="app:$APP" OPENCODE_DATABASE_URL=$PG_URL bun /tmp/cg-explore-low.ts
```

**期望**：`LOW: true`（低置信标记）；大量文件被裁剪/cliff 只列名（25 文件 → 展示 ~4）。
---

## CG-8: 索引器状态机（失败自愈 / 并发单写者 / 版本升级）

> 全部通过**手动 UPDATE codegraph_index 制造状态 + 观察下一循环（30s）**低成本构造，无需真实故障注入。前提：scope 已 ready（跑完 CG-1），沙箱存活。

### T42.8.1 failed → 下一循环自愈全量

```bash
NOW=$(python3 -c 'import time; print(int(time.time()*1000))')   # macOS date 无 %3N，用 python
psql "$PG_URL" -c "UPDATE codegraph_index SET state='failed', error='manually injected' WHERE scope='app:$APP'"
for i in $(seq 1 15); do
  ST=$(psql "$PG_URL" -t -A -c "SELECT state FROM codegraph_index WHERE scope='app:$APP'")
  [ "$ST" = "ready" ] && break; sleep 10
done
psql "$PG_URL" -t -A -c "SELECT state, node_count, edge_count, error, engine_version FROM codegraph_index WHERE scope='app:$APP'"
docker logs opencode-saas-test 2>&1 | grep codegraph-indexer | tail -2
```

**期望**：回到 `ready`，`error` 为 NULL，node/edge_count 与基线一致，日志含 `full rebuild done`（`ensureIndexed` 的 `state.state === "failed" → needsFull`）。

### T42.8.2 僵尸接管（indexing + 心跳过期 > 120s）

```bash
NOW=$(python3 -c 'import time; print(int(time.time()*1000))')
# 心跳拨回 5 分钟前，模拟写者死亡
psql "$PG_URL" -c "UPDATE codegraph_index SET state='indexing', files_done=3, files_total=577, heartbeat_at=$((NOW-300000)) WHERE scope='app:$APP'"
for i in $(seq 1 15); do
  ST=$(psql "$PG_URL" -t -A -c "SELECT state FROM codegraph_index WHERE scope='app:$APP'")
  [ "$ST" = "ready" ] && break; sleep 10
done
psql "$PG_URL" -t -A -c "SELECT state, node_count FROM codegraph_index WHERE scope='app:$APP'"
```

**期望**：`ready`（`claimIndexing` 的 `setWhere` 允许接管 `heartbeat_at < now-120s` 的 indexing 行 → 全量重建）。

### T42.8.3 claimIndexing 单写者语义（活写者不被抢占）

> 直接用 psql 复刻 store.claimIndexing 的 UPSERT（含 `setWhere`）。注意：`time_created/time_updated` 是 ORM 层 `$default`，DDL 无默认值，手写 SQL 必须显式提供；阈值须与行内心跳分开取值（同值会使 `<` 恒假）。

```bash
NOW=$(python3 -c 'import time; print(int(time.time()*1000))')
THRESH=$((NOW-120000))   # 等价线上 setWhere 阈值 now-120s
STALE=$((NOW-300000))    # 行内心跳 = now-5min
CLAIM() { psql "$PG_URL" -t -A -c "
INSERT INTO codegraph_index (scope, state, files_total, files_done, engine_version, heartbeat_at, time_created, time_updated)
VALUES ('app:$APP','indexing',0,0,'codegraph-extractor-1',$NOW,$NOW,$NOW)
ON CONFLICT (scope) DO UPDATE SET state='indexing', files_total=0, files_done=0, error=NULL,
  engine_version='codegraph-extractor-1', heartbeat_at=$NOW
WHERE codegraph_index.state != 'indexing' OR codegraph_index.heartbeat_at < $THRESH
RETURNING scope;"; }
# ① 活写者（indexing + 新鲜心跳）→ 期望 0 行
psql "$PG_URL" -c "UPDATE codegraph_index SET state='indexing', heartbeat_at=$NOW WHERE scope='app:$APP'" >/dev/null
CLAIM   # 应无输出
# ② 僵尸（indexing + 心跳过期）→ 期望 1 行 app:$APP
psql "$PG_URL" -c "UPDATE codegraph_index SET heartbeat_at=$STALE WHERE scope='app:$APP'" >/dev/null
CLAIM   # 应输出 app:$APP
# ③ ready 行 → 期望 1 行（增量路径 claim）
psql "$PG_URL" -c "UPDATE codegraph_index SET state='ready' WHERE scope='app:$APP'" >/dev/null
CLAIM
# 清场：置僵尸心跳留给下一循环接管自愈
psql "$PG_URL" -c "UPDATE codegraph_index SET heartbeat_at=$STALE WHERE scope='app:$APP'" >/dev/null
```

**期望**：①空（多 pod 下活写者独占，另一 pod claim 失败转读共享）；②③各 1 行。

### T42.8.4 engine_version 不匹配 → 强制全量

```bash
psql "$PG_URL" -c "UPDATE codegraph_index SET state='ready', engine_version='codegraph-extractor-0' WHERE scope='app:$APP'"
for i in $(seq 1 15); do
  EV=$(psql "$PG_URL" -t -A -c "SELECT engine_version FROM codegraph_index WHERE scope='app:$APP'")
  [ "$EV" = "codegraph-extractor-1" ] && break; sleep 10
done
docker logs opencode-saas-test 2>&1 | grep codegraph-indexer | tail -2
psql "$PG_URL" -t -A -c "SELECT state, engine_version FROM codegraph_index WHERE scope='app:$APP'"
```

**期望**：日志含 `full rebuild done`（非 `changed=` 增量行）；`engine_version` 回到 `codegraph-extractor-1`，state=ready（升级 extractor 后旧索引自动重建的保障）。

### T42.8.5 heartbeat 存活 + 进度落盘

```bash
psql "$PG_URL" -c "UPDATE codegraph_index SET state='ready', engine_version='probe-0' WHERE scope='app:$APP'"
# 触发全量（engine 不匹配），轮询 heartbeat_at 与进度
for i in $(seq 1 30); do
  psql "$PG_URL" -t -A -c "SELECT state || ' ' || files_done || '/' || files_total || ' hb=' || heartbeat_at FROM codegraph_index WHERE scope='app:$APP'"
  sleep 1
done | awk '!seen[$0]++'
```

**期望**：序列中 `indexing` 期间 `hb=` 时间戳持续变化（heartbeat fiber 每 5s 读沙箱 progress 回写——P0 修复点回归）。**注意**：`files_done` 中间递增仅在大仓库（分钟级索引）可观测——577 文件仓库 indexAll 本体仅 1-2s，采样窗口抓不到中间态属正常；沙箱侧 progress 文件结尾为 `{"files_total":N,"files_done":N,"done":true}` 可作落盘验证。

---

## CG-9: 工具面补齐（impact / node / search kind 过滤）

### T42.9.1 impact（transitive 影响半径 + 结构边排除）

```bash
# 等价 getImpact(depth=2)：先取 extractFromSource 直接依赖者，再取它们的依赖者（排 contains/imports）
psql "$PG_URL" -t -A -c "
WITH t AS (SELECT id FROM codegraph_node WHERE scope='app:$APP' AND name='extractFromSource' LIMIT 1),
d1 AS (SELECT DISTINCT e.source FROM codegraph_edge e WHERE e.scope='app:$APP' AND e.target=(SELECT id FROM t) AND e.kind NOT IN ('contains','imports')),
d2 AS (SELECT DISTINCT e.source FROM codegraph_edge e, d1
       JOIN codegraph_node n ON n.id=d1.source AND n.scope='app:$APP'
       WHERE e.scope='app:$APP' AND e.target=n.id AND e.kind NOT IN ('contains','imports'))
SELECT (SELECT count(*) FROM d1) AS direct, (SELECT count(*) FROM d2) AS transitive;"
```

**期望**：direct>0，transitive≥direct（二级展开有新增；若 0 需检查 BFS 深度语义）。工具侧 `depth≤5` 上限由 `getImpact` 的 `maxDepth` clamp 保证。

### T42.9.2 node（容器成员 + file/line 二级过滤）

```bash
# 容器成员：class/interface 的 contains 直接子节点
psql "$PG_URL" -t -A -c "
WITH c AS (SELECT id, qualified_name FROM codegraph_node WHERE scope='app:$APP' AND kind='class' AND name='CodeGraph' LIMIT 1)
SELECT c.qualified_name, count(e.target) AS members
FROM c JOIN codegraph_edge e ON e.source=c.id AND e.scope='app:$APP' AND e.kind='contains'
GROUP BY c.qualified_name;"
# file+line 过滤（pickByFileLine 语义）：行号落在节点区间内才算命中
psql "$PG_URL" -t -A -c "
SELECT name, start_line, end_line FROM codegraph_node
WHERE scope='app:$APP' AND file_path='repo/src/extraction/tree-sitter.ts'
  AND start_line <= 100 AND end_line >= 100 ORDER BY start_line LIMIT 3;"
```

**期望**：members>0（类成员展开）；第二查询返回包含第 100 行的最内层节点（区间命中而非全文件命中）。

### T42.9.3 search kind 过滤（type → type_alias 映射）

```bash
# 工具入参 kind="type" 在 codegraph-search.ts 映射为 "type_alias"；验证图中该 kind 有数据
psql "$PG_URL" -t -A -c "SELECT count(*) FROM codegraph_node WHERE scope='app:$APP' AND kind='type_alias'"
psql "$PG_URL" -t -A -c "SELECT DISTINCT kind FROM codegraph_node WHERE scope='app:$APP' ORDER BY kind"
```

**期望**：type_alias 数 >0；kind 集合含 function/class/method/interface/route 等多值（过滤维度真实可用）。

---

## CG-10: 数据正确性（幂等 / stale 提示 / 级联清理）

### T42.10.1 两轮增量幂等（边不重复、计数不漂移）

```bash
# 基线
E0=$(psql "$PG_URL" -t -A -c "SELECT count(*) FROM codegraph_edge WHERE scope='app:$APP'")
# 第 1 轮：改文件 A
curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"echo \"function cgIdemProbe1(){}\" >> /workspace/repo/src/index.ts && echo W1"}'
sleep 45
# 第 2 轮：再改同一文件
curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"echo \"function cgIdemProbe2(){}\" >> /workspace/repo/src/index.ts && echo W2"}'
sleep 45
# 结果：两个 probe 都在；该文件参与的边无重复；总边数稳定（±个位数）
psql "$PG_URL" -t -A -c "
SELECT name FROM codegraph_node WHERE scope='app:$APP' AND name IN ('cgIdemProbe1','cgIdemProbe2') ORDER BY name;"
# 重复判定 key 必须含 line/col：同符号多处调用是合法多行（(source,target,kind) 粗 key 会误报数百组）
psql "$PG_URL" -t -A -c "
SELECT count(*) FROM (
  SELECT source, target, kind, line, col, count(*) c FROM codegraph_edge
  WHERE scope='app:$APP' AND (source IN (SELECT id FROM codegraph_node WHERE scope='app:$APP' AND file_path='repo/src/index.ts')
      OR target IN (SELECT id FROM codegraph_node WHERE scope='app:$APP' AND file_path='repo/src/index.ts'))
  GROUP BY source, target, kind, line, col HAVING count(*) > 1) dup;"
psql "$PG_URL" -t -A -c "SELECT count(*) FROM codegraph_edge WHERE scope='app:$APP'"
```

**期望**：probe1+probe2 都索引；`dup=0`（精确 key：replaceFiles 按文件删旧插新，无累积重复）；总边数与 E0 差值 ≤ 单文件边数（不漂移）。

### T42.10.2 stale_files 工具提示（indexStateNote 分支）

```bash
# 手动注入 stale_files（等价增量开始时 indexer 的 setStaleFiles），验证工具提示文本
psql "$PG_URL" -c "UPDATE codegraph_index SET stale_files='[\"repo/src/index.ts\"]' WHERE scope='app:$APP'"
OPENCODE_DATABASE_URL=$PG_URL bun -e "
import { indexStateNote } from '$(git rev-parse --show-toplevel)/packages/opencode/src/codegraph/scope'
const note = await indexStateNote('app:$APP')
console.log(JSON.stringify(note))"
psql "$PG_URL" -c "UPDATE codegraph_index SET stale_files='[]' WHERE scope='app:$APP'"   # 清场
```

**期望**：输出含「刚被编辑、索引尚未同步」+ 文件名（scope.ts `stale_files.length` 分支）；清场后输出空串。其余分支（indexing 进度/failed 错误）可同法注入验证。

### T42.10.3 purgeScope 级联清理（5 表全空）

```bash
# 建议对一个废弃 scope 执行（勿对正跑用例的 scope；先确认该 scope 无 running 沙箱会触发重建）。
# 例：曾卡在 indexing 的僵尸 scope app:cg-e2e
psql "$PG_URL" -t -A -c "SELECT count(*) FROM sandbox s JOIN session sess ON sess.id=s.session_id WHERE sess.app_id='cg-e2e' AND s.state='running'"   # 期望 0
OPENCODE_DATABASE_URL=$PG_URL bun -e "
import { CodegraphStore as S } from '$(git rev-parse --show-toplevel)/packages/opencode/src/codegraph/store'
await S.purgeScope('app:cg-e2e')
await S.purgeScope('app:cg-e2e')   // 幂等重跑
console.log('purged')"
psql "$PG_URL" -t -A <<SQL
SELECT 'node', count(*) FROM codegraph_node WHERE scope='app:cg-e2e'
UNION ALL SELECT 'edge', count(*) FROM codegraph_edge WHERE scope='app:cg-e2e'
UNION ALL SELECT 'file', count(*) FROM codegraph_file WHERE scope='app:cg-e2e'
UNION ALL SELECT 'ref', count(*) FROM codegraph_ref WHERE scope='app:cg-e2e'
UNION ALL SELECT 'index', count(*) FROM codegraph_index WHERE scope='app:cg-e2e';
SQL
```

**期望**：5 行全 0（应用删除场景的数据级联；对不存在/已清 scope 幂等）。注意若直接 psql 预置 index 行需显式给 `time_created/time_updated`（DDL 无默认，仅 ORM 层 `$default`）。

---

## 已知问题

- ~~引用解析无源码限制~~（**已消除**）：full 模式在沙箱内（有源码）跑 codegraph 完整 resolver，`obj.method()`/route→handler/组件 usage 全部可解析。服务端不再做解析，只落库。
- **远端沙箱不稳定**（组合 1）：`Sandbox.kill` 对已死沙箱可能超时（`Request timed out`），导致 getOrCreate 卡在清理阶段无法重建。绕过：`psql "$PG_URL" -c "DELETE FROM sandbox WHERE session_id='$SID'"` 清掉卡死行。**本地沙箱（组合 3）无此问题**。
- **keep-alive 沙箱 + idle-reap**：`OPENCODE_SANDBOX_IDLE_KILL_SEC=30` 时非 keep-alive 沙箱 30s 即回收，索引长任务可能被打断。**跑 codegraph 用例务必先 keep-alive**（`new_sid -k`）。
- **codegraph kernel 偶发重复 node id**：部分语言（如 Dart 嵌套函数）同一符号以 `hostFn::localFn` 与 `localFn` 两个 qualified_name 产出相同 id hash → PG 主键冲突。store 层已按 id 去重（保留首个）。
- **本地沙箱架构**：Apple Silicon 沙箱是 arm64，需 `build/codegraph-extractor-linux-arm64.tar.gz`（build 脚本已产双平台）；indexer 按 `uname -m` 选 bundle。
- **勿手动并发跑 extractor**：两个进程同时 `rm/init` 同一 `.codegraph` SQLite 会互拆表（实测 `no such table: unresolved_refs`）。indexer 的 claimIndexing 单写者已防并发；手动调试前确认无 indexer 任务进行中（state 非 indexing / 等一轮循环）。
- **`codegraph_index.time_created/time_updated` DDL 无默认值**：仅 drizzle ORM `$default` 填充。psql 手写 INSERT/UPSERT（如 T42.8.3 复刻 claim）必须显式提供两列。

---

## 复测记录

| 日期 | 用例 | 结果 | 备注 |
|---|---|---|---|
| 2026-08-20 | T42.1.1/1.2/1.3 全量索引 + 落库 | ✅ | 组合 3 本地沙箱；codegraph 仓库 570 文件 → `ready`，12,141 节点 / 13,343 边 |
| 2026-08-20 | 镜像内置改造 | ✅ | extractor 放沙箱 `/opt/codegraph-extractor` 后 indexer 直接 exec 成功（stat 572 文件）；走 /opt 路径全量重建 `ready` 12019 节点；无 /opt 的旧镜像沙箱增量报错（证明沙箱必须内置） |
| 2026-08-20 | 引用解析（name-matcher 移植） | ✅ | 88,583 refs → 解析 23,604（26.65%）；产 15,182 calls 边；增量单文件 224ms；幂等无重复边 |
| 2026-08-20 | **沙箱内完整解析（full 模式）** | ✅ | 用 codegraph 自身 `indexAll+resolveReferences`（node:sqlite）在沙箱内跑完整分析：12,802 节点 / 44,815 边（**calls 21,726** / imports 3,765 / instantiates 778 / extends 84），边数为轻量方案 3.3 倍；route→handler references 边验证通过；消除"无源码"限制 |
| 2026-08-20 | T42.2.1/2.2/2.3 搜索 + 遍历 + 引导文本 | ✅ | 四层搜索命中 `extractFromSource`；scope 解析 `app:cg-e2e`；无 appId 返回引导 |
| 2026-08-20 | Agent 实测 codegraph_search | ✅ | 消息让模型查 `extractFromSource` → 回复「repo/src/extraction/tree-sitter.ts 第 6684 行」，与 store 直查一致（Yd-DeepSeek/deepseek-v4-flash） |
| 2026-08-20 | T42.3.1 增量同步 | ✅ | 改 `src/index.ts` 加 `cgIncrementalProbe` → 20s 内落库（日志 `changed=1 incremental`） |
| 2026-08-20 | T42.3.2 删除清理 | ✅ | `rm src/index.ts` → 容器重启后首循环清掉 117 节点（修复 dropMissingFiles 提前 return 的 bug） |
| 2026-08-20 | T42.4.1/4.2 多会话复用 + 隔离 | ✅ | 同 app 第二会话沙箱启动后 `ready nodes=12141` 稳定不重建；`app:other-app` 0 节点（本地 docker PVC 不跨容器共享 subPath，代码共享待远端 K8s 验证） |
| 2026-08-20 | 增量精确（sync + replaceFiles） | ✅ | 单文件增量 3.4s（vs 全量 24.6s）；写放大 44,815→2,556 边（1/17）；>1MB parser.c 不再污染 changed；改文件 probe 落库 + 边按 slice 再平衡 |
| 2026-08-20 | 服务端简化 resolver 移除 | ✅ | 增量/全量统一沙箱内完整解析，resolver.ts 删除 |
| 2026-08-20 | explore 分配算法移植 | ✅ | `extractFromSource` → spine 文件（tree-sitter.ts + Extractor 实现）全量；`data handler flow` → 25 文件裁剪到 4 + cliff 列名 + LOW_CONFIDENCE |
| 2026-08-20 | callees/files 工具 | ✅ | callees 30 个被调用者；files 577 文件多语言分布 |
| 2026-08-20 | affected 工具 | ✅ | tree-sitter.ts → 40 依赖者、17 测试文件（kernel-parity 套件）；生产/测试分离 |
| 2026-08-20 | P0/P1 硬化 | ✅ | heartbeat 改读沙箱 progress；失败 failIndex；增量 claim+stat 预检；replaceFiles 后 finishIndexRecount；CALL_KINDS 去 imports；affected 路径归一 pathMatches；typecheck codegraph 路径无新增错误 |
| 2026-08-20 | 单测 path+search | ✅ | `bun test test/codegraph/path-search.test.ts` 8 pass（pathMatches 边界、filterByFilePath、isTestFile、name/kind/path 评分、LOW_CONFIDENCE） |
| 2026-08-20 | 删除切片 | ✅ | 删文件不再全量 rebuild：incremental sync + full dump（捕获 definitionDelta rebinds），PG 按 dropMissingFiles + replaceGraph（无 kernel 重解析）；`T42.5.3` 改为 `deletedPaths` 列表 + isFullDump 判定 |
| 2026-08-20 | Agent E2E 新工具 | ✅ | `codegraph_callees`→30 被调用者（含 `detectLanguage`）、`codegraph_files`→54 文件（flat）、`codegraph_affected`→23 生产文件（tree-sitter.ts depth1）、`codegraph_explore`→`extractFromSource` 核心+6提取器（Yd-DeepSeek v4-pro, app:cg-init-test） |
| 2026-08-21 | exec 端点修复 | ✅ | 根因：`OPENCODE_SANDBOX_IMAGE` 默认指向私有 registry 镜像（本地 404 → 沙箱创建挂死 → exec UnknownError）；容器显式传 `OPENCODE_SANDBOX_IMAGE=opencode-opensandbox:slim` 后 exec 恢复 |
| 2026-08-21 | T42.5.3 删除切片 E2E | ✅ | 建 probe（3 节点 12809/44822）→ `rm` → 下一循环 `changed=0 deleted=4 incremental` → `incremental deletion → full dump`（6s，vs 全量 ~25s）→ PG 精确回基线 12806/44819，probe 节点/文件记录全清 |
| 2026-08-21 | T42.5.4 fresh checkout 回退 | ✅ | 修复前：无 `.codegraph` 时 `openSync` 抛错 → failIndex → 下一循环全量自愈（浪费一轮）；修复后：检测状态缺失 → 日志 `falls back to full build` → 全量 577 文件 12806 节点 exit 0 |
| 2026-08-21 | filterByFilePath 语义修正 + 单测扩充 | ✅ | 无匹配从「返回全部」改为「返回空 + 工具提示未找到」（callers/callees/impact/node 四工具行为更准确）；`store-traversal.test.ts` 20 pass（isZombie 边界、CALL_KINDS/DEPENDENT_FILE_EDGE_KINDS 语义、BFS 深度/环安全/自环、impact 排结构边） |
| 2026-08-21 | CG-8 状态机四用例 | ✅ | T42.8.1 failed→60s 自愈回 ready 基线；T42.8.2 僵尸（心跳-5min）→80s 接管全量；T42.8.3 claim UPSERT 三态：活写者 0 行/僵尸 1 行/ready 1 行；T42.8.4 engine 不匹配→强制全量回 extractor-1；T42.8.5 heartbeat 存活（hb 每 5s 推进，进度中间态 577 文件仓库 <2s 不可采样，progress 落盘 done:true 验证）。附带：runFullIndex 补 `full rebuild done` 日志 |
| 2026-08-21 | CG-9 工具面补齐 | ✅ | T42.9.1 impact：extractFromSource direct=34 / transitive 新增 2；T42.9.2 node：CodeGraph 类 92 成员、file/line 区间命中内层节点 extractNameRaw(98-192)；T42.9.3 type_alias=540、kind 25 种 |
| 2026-08-21 | CG-10 数据正确性 | ✅ | T42.10.1 两轮增量幂等：probe1+2 都在、精确 key（含 line/col）dup=0——注意粗 key (s,t,kind) 会把多处调用点误报为重复（全库 calls 2808 组「重复」实为合法多行）；T42.10.2 stale/indexing 提示文本两分支验证；T42.10.3 purgeScope 幂等、5 表全 0（僵尸 scope app:cg-e2e 顺带清理） |
