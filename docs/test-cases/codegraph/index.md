# codegraph SaaS 集成用例（沙箱提取 → PG → 内置工具）

> 验证 `feat/saas-codegraph`：app 模式会话的沙箱启动后自动对 `/workspace` 代码做符号级索引（codegraph Rust kernel），结果写 PG（`codegraph_*` 表，按 `scope=app:{appId}` 隔离），并通过 5 个内置工具（`codegraph_search/node/callers/explore/impact`）暴露给 Agent。
>
> 实现：
> - `packages/opencode/src/codegraph/`：`codegraph.pg.ts`（表）、`store.ts`（读写/四层搜索/图遍历/状态机）、`indexer.ts`（30s 守护索引 + 增量 stat-diff）、`script/main.ts`（沙箱内 kernel 提取）、`tool/`（5 个内置工具）
> - `packages/opencode/migration-pg/20260820120000_codegraph/` + `20260820130000_codegraph_file_mtime/`
> - `scripts/build-codegraph-extractor.sh`（单平台目录 + 双平台 tar）
>
> **镜像内置（2026-08-20 改造）**：extractor 由沙箱镜像 Dockerfile COPY 到 `/opt/codegraph-extractor`（构建沙箱镜像前先跑 `scripts/build-codegraph-extractor.sh --target <arch>`），indexer 直接 exec `/opt/codegraph-extractor/main.ts`，**不再运行时注入**。解决了"沙箱重建后增量路径缺 extractor"的 bug。
>
> **关键设计**：
> 1. codegraph 只认 `appId`（不看 pvcMode），scope = `app:{appId}`；无 appId 的会话工具返回引导文本（非 isError）。
> 2. 沙箱内只解析，PG 写由服务端做（沙箱不连 PG）。
> 3. 增量检测用文件系统 stat（mtime/size），**不信任 git status**（pull/checkout 后工作树 clean，git 盲区）。
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

**期望**：`state=ready`，`node_count>0`，`edge_count>0`（codegraph 仓库预期 ~1.2 万节点 / 1.3 万边）。

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
# 工具在无 appId 会话中返回引导文本而非报错（NotIndexedError 语义）
# 触发一次 AI 消息让其尝试调用 codegraph_search，或直接验证 scope 解析:
psql "$PG_URL" -t -A -c "SELECT app_id FROM session WHERE id='$SID2'"
```

**期望**：`app_id` 为空 → 工具返回「当前会话未绑定应用，codegraph 不可用」引导文本，且**不是** `isError`。

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

## 已知问题

- ~~引用解析无源码限制~~（**已消除**）：full 模式在沙箱内（有源码）跑 codegraph 完整 resolver，`obj.method()`/route→handler/组件 usage 全部可解析。服务端不再做解析，只落库。
- **远端沙箱不稳定**（组合 1）：`Sandbox.kill` 对已死沙箱可能超时（`Request timed out`），导致 getOrCreate 卡在清理阶段无法重建。绕过：`psql "$PG_URL" -c "DELETE FROM sandbox WHERE session_id='$SID'"` 清掉卡死行。**本地沙箱（组合 3）无此问题**。
- **keep-alive 沙箱 + idle-reap**：`OPENCODE_SANDBOX_IDLE_KILL_SEC=30` 时非 keep-alive 沙箱 30s 即回收，索引长任务可能被打断。**跑 codegraph 用例务必先 keep-alive**（`new_sid -k`）。
- **codegraph kernel 偶发重复 node id**：部分语言（如 Dart 嵌套函数）同一符号以 `hostFn::localFn` 与 `localFn` 两个 qualified_name 产出相同 id hash → PG 主键冲突。store 层已按 id 去重（保留首个）。
- **本地沙箱架构**：Apple Silicon 沙箱是 arm64，需 `build/codegraph-extractor-linux-arm64.tar.gz`（build 脚本已产双平台）；indexer 按 `uname -m` 选 bundle。

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
