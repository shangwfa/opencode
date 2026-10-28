# Graph 用例索引（PG E2E）

> 本目录包含 `packages/knowledge/src/graph` 的部分图谱写入、查询、维护与消费验收，**目前未全面覆盖所有功能或整个链路**。当前已有 `/api/graph` ingest/delete/search/stats 四类 HTTP 接口；组件/PG、Hono request、Docker HTTP 与 Agent 质量验收分开报告。
> 测试框架为 Bun `bun:test`。需要 PG；未设置 `DATABASE_URL` 时对应测试会自动 skip。图表和测试数据位于专用 schema，测试结束清理。

## 用例与实现映射

完整范围先看 [`full-chain.md`](./full-chain.md)（33 个主链路 + 13 个扩展场景，验收设计），现有覆盖与缺口看 [`coverage-audit.md`](./coverage-audit.md)。新增设计不代表新增自动化或 PASS。

| 用例 | 覆盖 | 自动化依据 |
|---|---|---|
| G-P0-1~5 | 建图方向/来源、重复导入、关系过滤、按文档删除、时间冲突 | [`graph-acceptance.test.ts`](../../../src/graph/e2e/graph-acceptance.test.ts) |
| G-E2E-1~9 | 跨文档补全、实体合并、时间线、删除、ontology、代码图、子图/边类型、可视化/RDF、矛盾检测 | [`graph.e2e.test.ts`](../../../src/graph/e2e/graph.e2e.test.ts) |
| G-RAG-1 | 使用 RAG 已有 `kb_yingdao_harness_zh_cn` 文档作为只读原文，固定锚定抽取后验证图和来源关联 | [`rag-corpus.e2e.test.ts`](../../../src/graph/e2e/rag-corpus.e2e.test.ts)（opt-in） |
| G-RAG-2 | 使用 RAG 库全量 36 篇文档元数据构建文档-目录图，验证删除隔离与源数据只读 | [`rag-corpus.e2e.test.ts`](../../../src/graph/e2e/rag-corpus.e2e.test.ts)（opt-in） |
| Agent GraphRAG | saas 会话 graph agent 编排：查询理解→沙箱调 `/api/graph/search`→证据筛选→生成 | [`agent-graphrag.md`](./agent-graphrag.md)（脚本内嵌，复制即执行） |
| 数据 fixture | 后端服务图与事实冲突样例 | [`backend-services.ts`](../../../src/graph/e2e/fixtures/backend-services.ts) |
| G-GAP-01~17 | 隔离、溯源、并发、失败恢复、检索变体、RDF/本体查询、文档/API 入库与更新删除等补充验收 | [`coverage-matrix.md`](./coverage-matrix.md)（分项说明自动化与证明边界） |
| Graph HTTP | 四端点 Hono request + PG/真实模型契约 | [`graph-http-contract.e2e.test.ts`](../../../test/graph-http-contract.e2e.test.ts)（5 个测试；不等于 Docker 部署全链路） |
| 关系浏览 HTTP | relations/subgraph/neighborhood/paths/provenance/relation-types 六端点 | [`test/graph-browse-http.e2e.test.ts`](../../../test/graph-browse-http.e2e.test.ts)（21 测试，Hono+PG 与 Docker HTTP 双模式实测通过；[`routes/browse.ts`](../../../src/graph/routes/browse.ts)） |
| 全链路范围 | 源数据→转换/抽取→多存储面→检索/证据→Agent/引用→更新删除→恢复；公开扩展能力 | [`full-chain.md`](./full-chain.md)（待补齐自动化） |
| 覆盖审计 | 功能、自动化、历史证据及缺口逐项对照 | [`coverage-audit.md`](./coverage-audit.md) |

历史实测：固定验收 + 扩展图 E2E **19 PASS / 0 FAIL**（当时版本、本地 PG，确定性 extraction）。当前两个文件已定义 22 个测试，旧记录不代表当前全部通过；本次覆盖审计未重跑。
RAG 真实语料用例单独实测：**2 PASS / 0 FAIL**（三篇事实文档 + 全量 36 篇元数据图；源内容 hash 前后一致）。

固定 P0 验收准则详见 [`acceptance.md`](./acceptance.md)。历史验收设计说明见 [`GRAPH_ACCEPTANCE.md`](../../../src/graph/e2e/GRAPH_ACCEPTANCE.md)。

> 注意：补充矩阵中的 G-GAP 状态按条目区分；部分自动化不代表整项覆盖。完成自动化并在 PG 环境实际运行后，才能更新为已覆盖。

## 执行

```bash
cd packages/knowledge
DATABASE_URL='postgresql://postgres:ab123456@127.0.0.1:55432/knowledge' \
  bun test src/graph/e2e/graph-acceptance.test.ts src/graph/e2e/graph.e2e.test.ts

# 单独启用 RAG 真实文档只读数据源用例（要求该数据库已存在 RAG 测试语料）
KNOWLEDGE_GRAPH_RAG_E2E=1 \
DATABASE_URL='postgresql://postgres:ab123456@127.0.0.1:55432/knowledge' \
  bun test src/graph/e2e/rag-corpus.e2e.test.ts
```

需要 PostgreSQL；如环境没有 pgvector，可使用项目约定镜像启动测试库：

```bash
docker run -d --name knowledge-pg -p 55432:5432 \
  -e POSTGRES_PASSWORD=ab123456 pgvector/pgvector:pg16
```

测试结果以 Bun 实际输出为准。PG 不可用或未配置时不得将 skip 记为通过；图机制用例使用固定 extraction，不调用真实 LLM。G-RAG 用例只读查询 RAG 语料，以原文锚点或文档元数据构造确定性图数据；不会修改或删除 RAG 文档/向量。
