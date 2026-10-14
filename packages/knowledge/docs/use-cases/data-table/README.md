# 数据表（data-table）用例索引（e2e）

> 深度审核见 [implementation-review-2026-10-14.md](./implementation-review-2026-10-14.md)。149 PASS 是基础断言通过，不代表产品完整性或生产架构验收通过；审核发现默认 hybrid 执行路径、组合过滤、索引一致性等更深层问题。

> 同类产品官方资料对照见 [industry-comparison-2026-10-14.md](./industry-comparison-2026-10-14.md)，包含字段策略、导入适配、过滤召回与 PG 落地建议。

> 分阶段落地方案见 [optimization-plan-2026-10-14.md](./optimization-plan-2026-10-14.md)，明确修改位置、API 兼容、索引任务与版本发布、存量迁移和验收门槛；实施进度以本批报告为准。

> 最新进度：[第一批检索执行修复与 Docker 验收](./phase1-search-results-2026-10-14.md)。原 149 条断言新增 DT25c 后为 150 条；另有 21 个 HTTP/PG 策略契约用例。多策略索引与可靠任务尚未实现。
>
> 真实形态数据实测：[OpenAPI 接口 / RPA 指令 / CSV 订单](./real-data-search-2026-10-14.md)（v1：36 PASS；v2 多向量化策略：35 PASS；OpenRouter 真实语义：7 PASS / 2 OBSERVE）。已支持 `vectorStrategy: row|field|row+field`、`searchFields` 字段限定、字段边界序列化（F05 修复）、零相关过滤与空结果契约（F09 修复）。遗留：F07 行级聚合、生产质量阈值默认值。

> `packages/knowledge` 数据表业务域（结构化数据：数据集 → 动态物理表 → 行 → 行级 chunk 向量）的全链路 e2e 用例。
> 对应源码：`src/data-table/{routes,services,db,types}`；路由挂载于 `/api/database`。
> 与 [../rag/](../rag/README.md)（文档类知识源）、[../llm-wiki/](../llm-wiki/README.md)（Wiki）并列；编号 `DT*` 全局唯一。
> 判定规则遵循 [../rag/evaluation-rubric.md](../rag/evaluation-rubric.md)：期望先行、确定性断言优先、环境阻塞记 SKIP 不伪造、证据可复现。

## 文件目录

| 文件 | 用例段 | 覆盖内容 | 实测（2026-10-14） |
|---|---|---|---|
| [lifecycle.md](./lifecycle.md) | DT01~DT10 | 数据集生命周期：三件套创建/回滚、列表与详情、元数据 PATCH、加列/删列/NOT NULL 迁移、删除清理 | **43 PASS / 0 FAIL**（修复后） |
| [rows.md](./rows.md) | DT11~DT20 | 行 CRUD：批量写入与向量化、未知列忽略、校验负例、分页与 filter、行详情、批量更新（事务回滚）、批量删行、数据集不存在语义 | **47 PASS / 0 FAIL**（修复后） |
| [search.md](./search.md) | DT21~DT34 | 检索矩阵：filter-only、filter 语义、semantic/keyword/hybrid、组合检索、selectFields、旧请求兼容、GET query、topK、跨库隔离 | **47 PASS / 0 FAIL**（新增执行路径断言） |
| [vectors.md](./vectors.md) | DT35~DT40 | 向量直连通道：upsert/query、filter、minScore、维度校验、与行 chunk 共存 | **13 PASS / 0 FAIL** |

合计 **150 PASS / 0 FAIL**。首轮实测发现的 5 个 FAIL（4 类缺陷）已在源码修复并回归通过，见下文「已修复缺陷」。本轮另修复混合编排和权重问题；完整产品能力尚未全部验收。

## 环境分层

| 环境 | 行为 | 用例范围 |
|---|---|---|
| 服务或 PG 不可达 | 脚本首行探测后 `SKIP` 退出 | 全部 |
| 服务与 PG 可用，embedding 不可用 | 探针失败默认 FAIL；确认环境故障并显式设置 `DT_ALLOW_EMBEDDING_SKIP=1` 后才允许 SKIP | 仅契约负例与 zod 校验（DT13/14/20/28/32）可跑 |
| 服务与 PG 可用，embedding 可用（真实或 mock） | 全量执行 | 全部 |

> 写入行必然触发向量化（`POST /rows`、带 `dataSource` 建库），因此 embedding 通道是数据类用例的前置。
> 探针：每个脚本先建 `rd_dt_probe_<ts>` 带 1 行 dataSource 的数据集，HTTP 200 即视为可用。

## 共享运行环境

```bash
# 1. PG（pgvector + pg_trgm；缺 pg_bigm 时自动降级 trigram，启动日志会提示，属预期）
docker run -d --name knowledge-pg -p 55432:5432 -e POSTGRES_PASSWORD=ab123456 pgvector/pgvector:pg16

# 2. 确定性 mock embedding（离线、可复现；算法与 test/database-e2e.test.ts 一致）
#    保存下方 mock-embedding.ts 后：bun run mock-embedding.ts
MOCK_EMB_PORT=18788 bun run mock-embedding.ts &

# 3. 知识服务（embedding 指向 mock；no_proxy 需含本机，避免代理劫持 127.0.0.1）
cd packages/knowledge
KNOWLEDGE_PORT=18787 KNOWLEDGE_HOST=127.0.0.1 \
KNOWLEDGE_DATABASE_URL=postgresql://postgres:ab123456@127.0.0.1:55432/knowledge \
KNOWLEDGE_DATABASE_SCHEMA=knowledge \
KNOWLEDGE_EMBEDDING_BASE_URL=http://127.0.0.1:18788/v1 \
no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost' \
bun run src/server.ts &
```

真实 embedding 端点可替换第 2 步：去掉 `KNOWLEDGE_EMBEDDING_BASE_URL` 覆盖并配置 `KNOWLEDGE_EMBEDDING_*`，用例不改。

可用环境变量覆盖脚本默认值：`BASE`（默认 `http://127.0.0.1:18787/api`）、`PGC`（容器名，默认 `knowledge-pg`）、`PGDB`（默认 `knowledge`）、`SCH`（schema，默认 `knowledge`）。

### mock-embedding.ts

```ts
/**
 * 确定性 mock embedding 服务（OpenAI 兼容 /embeddings）。
 * 算法与 packages/knowledge/test/database-e2e.test.ts 的 pseudo() 一致：
 * bag-of-tokens FNV 哈希 → 1536 维归一化向量，文本 token 重叠越多 cosine 越高。
 */
const DIM = 1536

function pseudo(text: string): number[] {
  const vec = new Array<number>(DIM).fill(0)
  for (const tk of String(text).toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean)) {
    let h = 2166136261
    for (let i = 0; i < tk.length; i++) {
      h ^= tk.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    vec[Math.abs(h) % DIM] += 1
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1
  return vec.map((v) => v / norm)
}

Bun.serve({
  port: Number(process.env.MOCK_EMB_PORT || 18788),
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method === "POST" && url.pathname.endsWith("/embeddings")) {
      const body: any = await req.json().catch(() => ({}))
      const input: string[] = Array.isArray(body.input) ? body.input : [body.input]
      return Response.json({
        object: "list",
        model: body.model || "mock",
        data: input.map((t, i) => ({ object: "embedding", index: i, embedding: pseudo(String(t)) })),
        usage: { prompt_tokens: 0, total_tokens: 0 },
      })
    }
    return new Response("not found", { status: 404 })
  },
})
```

## 执行方式

四个用例 md 内嵌各一块 bash 脚本（自包含，只清理本轮创建的数据集），提取后执行：

```bash
cd packages/knowledge/docs/use-cases/data-table
for f in lifecycle rows search vectors; do
  awk '/^```bash$/{f=1;next} /^```$/{f=0} f' $f.md > /tmp/run-$f.sh
  zsh /tmp/run-$f.sh > /tmp/$f.log 2>&1; echo "$f exit=$?"; grep -E '^(FAIL|SKIP|━━━)' /tmp/$f.log
done
```

- **必须用 zsh 执行**（macOS 默认 shell）。macOS 自带 `/bin/bash` 为 3.2，在 `"$(...)"` 中嵌套含 `\"` 的 JSON 时会错误拆分 body（表现为 `JSON Parse error`），本目录脚本在 bash 3.2 下不可靠。
- 每条用例输出 `PASS <编号> <描述>` / `FAIL <编号> <描述> expect=[..] got=[..]`，结尾汇总，退出码为 FAIL 数。
- 四个文件**串行执行**，勿与容器启停并行（同一 PG 上的并发会导致假失败）。

## 已修复缺陷（源码已修改，用例回归通过）

| 缺陷 | 用例 | 修复 |
|---|---|---|
| A. 删列 `DROP COLUMN` 未加引号，驼峰列物理残留 | DT07b | `services/database.service.ts` `migratePhysicalTableColumns`：`DROP COLUMN IF EXISTS "${name}"` |
| B. 更新列 `SET` 未加引号，保留字列更新 400 | DT18j | `services/database.service.ts` `executeRowUpdate`：`sets.push(\`"${key}" = ...\`)` |
| C. 页码/每页数 0 被放行 | DT03f1、DT15d | `routes/list.ts`、`routes/rows-list.ts`：去掉 `validated.page &&` 等 falsy 短路，zod 已保证为数字，范围校验直接生效 |
| D. keyword 默认参数返回 400 | DT24c | `services/database-rows-search.ts`：未显式指定时 keyword 默认关闭多阶段；`types/database.types.ts`：`recallConfig.enableMultiStage` 去掉 `.default(true)`，使"未指定"保持 undefined |

单测：`src/data-table/services/database-rows-search.test.ts` 新增 keyword 默认行为与 schema 默认值两条回归用例，`bun test src/data-table` 共 18 pass。

## 历史缺陷记录（首轮实测）

以下 4 类缺陷为首轮 e2e 实测发现的问题（A~D），修复前的表现与根因见上表。

## 观察（行为如实断言，非失败）

1. 删行 `DELETE /rows/batch` 含不存在 id 时报 404，但同批真实行已删（非事务整体回滚）；与批量更新的整体回滚语义不一致（DT19e）。
2. `POST /rows` 对不存在的数据集返回 400，其它行接口返回 404（DT20f）。
3. filter 未知键：行列表（`GET /rows`）返回 500，检索（`POST /rows/search`）返回 400（DT16e / DT22h）。
4. `GET /query` 的 `page/pageSize` 按源码推断会被 zod 剥离（`RowsSearchRequestSchema` 无此字段），即 GET 版本不分页；本轮未单独设用例验证，待补。
5. 向量与行的 chunk id 形态：`<rowId>__c<chunkIndex>`；`kb_*` 表主键为 `vector_id`（非 `id`）。
