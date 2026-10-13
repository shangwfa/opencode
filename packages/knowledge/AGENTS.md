# @opencode/knowledge 工程约定

## 定位

知识库基础能力包：文档解析/分块/向量化/检索（向量、关键词、混合）、召回重排、文档同步、base-knowledge 命名空间、知识图谱 GraphRAG。独立 hono 服务形态，也可挂载到其它 hono 应用。数据面 PostgreSQL + pgvector + pg_trgm。

Agent能力后续由opencode saas来提供

支持三种检索的能力

- RAG
- graph
- ll-wiki

数据源

- 文档(用户编写的文档)
- 数据表（结构化数据）

## 技术选型（迁移决策，勿回退）

- HTTP：hono（官方最佳实践：每业务域导出 `new Hono()` 子应用，`app.route(prefix, subApp)` 挂载，`app.ts` 导出 `AppType` 供 hono/client RPC；路由 handler 内联在路径定义处，不做 RoR 式 Controller）
- DB：`pg`（node-postgres）+ `drizzle-orm@0.44`（仅业务表）+ 裸 SQL（建表/向量/检索）
- 向量：**自研 `src/rag/knowledge-base/vector/vector-store.ts`（PgVectorStore）**，不引入 @mastra/pg。metadata filter 语义见 `src/rag/knowledge-base/vector/filter.ts`（MongoDB 风格）
- 分块：`@mastra/rag` 的 MDocument（唯一保留的 mastra 包，package.json 明确声明）
- LLM/Embedding：OpenAI 兼容（`src/providers/llm.ts`，`KNOWLEDGE_LLM_BASE_URL`/`KNOWLEDGE_EMBEDDING_BASE_URL` 可配）
- **禁止**出现 `@mastra/core`、`@mastra/pg`、`mastra` 等运行时依赖（注释除外）

## 目录

```
src/
  app.ts server.ts index.ts   # hono 装配（app.route 挂载 + 导出 AppType）/ 独立入口 / 对外导出
  data-table/                 # 数据表业务域：routes/services/db/types/index.ts
  llm-wiki/                   # Wiki 业务域：routes/services/db/types/index.ts
  rag/                        # RAG 业务域：base-knowledge + knowledge-base/{routes,services,types,vector}
  graph/                      # 知识图谱 GraphRAG 业务域
  config/env.ts               # 全部环境变量入口（新增配置必须加在这里）
  config/*.ts                 # 检索/时间衰减常量
  db/                         # drizzle schema + initDatabase()
  providers/llm.ts            # OpenAI 兼容 provider
  tools/ mcp/                 # Agent 工具与 MCP 适配器
  utils/                      # 跨业务域纯工具；不要放领域流程/服务实现
test/                         # bun test（e2e 需 KNOWLEDGE_DATABASE_URL）
```

业务代码按领域聚合；跨域调用通过领域 `index.ts` 暴露的 facade，避免依赖其他域的内部目录。HTTP 路由只负责请求校验/响应适配，业务流程留在所属领域的 services；每个域的 `routes/index.ts` 导出该域 Hono 子应用（`xxxApp`）与 `AppType`。

## 环境变量

见 `src/config/env.ts` 顶部注释。数据库 `KNOWLEDGE_DATABASE_URL`（回退 `DATABASE_URL`/`OPENCODE_DATABASE_URL`）；schema `KNOWLEDGE_DATABASE_SCHEMA`（默认 `knowledge`）。

## 测试

- 框架 `bun test`（不是 vitest）。模块 mock 用 `mock.module()`，被测模块用 top-level await 动态 import。
- 纯逻辑测试直接跑：`bun test test/`
- PG/e2e：`KNOWLEDGE_DATABASE_URL=postgresql://... bun test test/e2e.test.ts`（需要 pgvector + pg_trgm 扩展；未设置环境变量时自动 skip）。本地 Homebrew PG 14 默认无 pgvector，可用 docker：`docker run -d --name knowledge-pg -p 55432:5432 -e POSTGRES_PASSWORD=ab123456 pgvector/pgvector:pg16`
- 修改检索/分块行为时先补测试再改代码。

## 已知约束

1. `KNOWLEDGE_DATABASE_URL` 为空时 import `src/db/index.js` 会抛错（沿用源项目行为），服务入口必须先设环境变量。
2. 每个知识库一张物理向量表 `kb_<id>`，由 `initDatabase`/`createIndex` 幂等创建；删除知识库会 DROP 向量表。
3. rerank 默认 `model='llm'`（`LLMRelevanceScorer`：LLM 打出 1.0/0.5/0.0 绝对相关性分），失败自动回退 simpleRerank（0.6×召回分 + 0.2×词法覆盖 + 元信息加成；输入恒为绝对分故输出仍具绝对语义）；`mastra` 枚举保留兼容、同 'llm' 路径。分数语义约定：RRF 融合分只定序不外泄（融合层恢复两路原生绝对分，任一路为空时单路降级），质量阈值三类型统一 `MIN_RELEVANCE_SCORE=0.2`。
4. `graph/` 目录为 GraphRAG 独立模块，`rag/knowledge-base/services/document.service` 的 `syncToGraph` 为可选链路，失败不影响主流程。
5. PG 镜像无 pg_bigm 时中文关键词检索自动降级 trigram（启动日志有提示）；生产建议带 pg_bigm 的镜像。
6. `KNOWLEDGE_EMBEDDING_CHANNEL=inner` 时 embedding 走影刀内网代理（带重试与并发上限）；本机有 HTTP(S)_PROXY 时 `server.ts` 自动把内网主机追加到小写 `no_proxy`（Bun fetch 仅识别小写，且支持运行时修改）。

## 已知缺陷（源项目固有，探针标记，暂缓修复）

`src/graph/__review_probe.test.ts` 有 2 个失败用例（源工程 vitest 跑同样失败），根因相同、涉及全局 score 语义体系，按「核心逻辑不动」暂缓：

- **minScore 语义反转**：`Triplet.score` 是距离分（越小越好），而 `minScore` 过滤按相似度语义（`>=`）——传 minScore 的图检索结果不正确。涉及 `cognee-graph` 的 score 定义与 `graph-completion-retriever`/`hybrid-retriever`/`round-robin-hybrid-retriever` 等多个 score 消费方，修复需统一语义并全量回归。
- **rerank 置信度未参与 minScore**：rerank 的 RRF 融合分（恒为正的排名分）被写回 score，全不相关的结果无法被 minScore 拦截。

其余 4 个探针缺陷已修复：跨库隔离透传、边来源按边缓存、删除文档清理孤儿边、checkpoint 内容 hash 校验。
