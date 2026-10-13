# @opencode/knowledge

知识库基础能力包：文档入库、分块、向量化、向量/关键词/混合检索、召回与重排，基于 **hono + PostgreSQL(pgvector + pg_trgm)**。

自影刀 `xybot-front-node-ai` 项目知识库模块迁移而来，**去除 mastra 框架依赖**（`@mastra/rag` 的 MDocument 分块能力保留使用），LLM/Embedding 走可配置的 OpenAI 兼容协议。

## 能力清单

| 能力 | 说明 | 入口 |
|---|---|---|
| 知识库管理 | 创建/列表/详情/删除（embedding 模型、默认分块策略、索引配置） | `src/rag/knowledge-base/services/knowledge-base.service.ts` |
| 文档管理 | 添加（content/url）、更新（两阶段向量替换）、删除、状态 | `src/rag/knowledge-base/services/document.service.ts` |
| 文档解析 | PDF / TXT / Markdown / HTML / URL / tiptap JSON | `src/utils/file-parser.ts` |
| 分块 | none/recursive/character/token/markdown/semantic-markdown/llm-semantic/html/json/latex/sentence | `@mastra/rag` MDocument + `src/rag/knowledge-base/services/llm-semantic-chunk.service.ts` |
| 向量化 | OpenAI 兼容 embedding（可配 baseURL/apiKey） | `src/providers/llm.ts` |
| 向量存储 | 每库一张 `kb_<id>` 物理表，pgvector + HNSW | `src/rag/knowledge-base/vector/vector-store.ts` |
| 关键词检索 | pg_trgm 相似度 + tsvector 全文 | `src/rag/knowledge-base/services/keyword-search.service.ts` |
| 混合检索 | 语义+关键词并行 → RRF/加权融合 → 重排 | `src/rag/knowledge-base/services/hybrid-search.service.ts` |
| 高级召回 | HyDE、多查询、查询增强、多阶段召回 | `src/rag/knowledge-base/services/{hyde,multi-query,query-enhancement,recall}.service.ts` |
| 重排 | LLM 相关性打分 / simple（关键词+路径+时间衰减） | `src/rag/knowledge-base/services/rerank.service.ts` |
| 文档同步 | 影刀文档平台（yddoc）同步 + 任务状态机/重试 | `src/rag/knowledge-base/services/{yddoc-api,sync-task,document-sync}.service.ts` |
| base-knowledge | 独立命名空间：hash 幂等、版本乐观锁、同步向量化、超时降级检索 | `src/rag/` |
| 知识图谱 GraphRAG | 抽取/本体/RDF/图谱检索 | `src/graph/` |
| 表问答检索 | PG 表作为知识源（表结构/行数据向量化检索） | `src/data-table/` |
| Agent 检索工具 | 普通函数 + createTool 形态（vector/graph/document/multi-kb/unified/rag） | `src/tools/` |
| MCP 服务 | kb 检索 MCP server（stdio + Streamable HTTP） | `src/mcp/` |
| 初始化脚本 | 业务文档批量入库（docs/faq/command/feature-solution） | `script/` |

## 快速开始

```bash
# 环境变量
export KNOWLEDGE_DATABASE_URL=postgresql://user:pass@host:5432/dbname  # 需要 pgvector + pg_trgm 扩展
export KNOWLEDGE_DATABASE_SCHEMA=knowledge                              # 默认 knowledge
export KNOWLEDGE_LLM_BASE_URL=https://api.openai.com/v1                 # OpenAI 兼容端点
export KNOWLEDGE_LLM_API_KEY=sk-...
export KNOWLEDGE_EMBEDDING_BASE_URL=...                                 # 默认同 LLM
export KNOWLEDGE_EMBEDDING_API_KEY=...
export KNOWLEDGE_DEFAULT_CHAT_MODEL=gpt-4o-mini
export KNOWLEDGE_DEFAULT_EMBEDDING_MODEL=openai/text-embedding-3-small

# 可选：embedding 走影刀内网代理（appreciation inner 协议，逐文本调用）
# export KNOWLEDGE_EMBEDDING_CHANNEL=inner
# export XYBOT_AI_BASE_URL=http://xybot-appreciation:8080/api/appreciation/v1
# export XYBOT_USER_HEADER='{"name":"...","tenantUuid":"...","uuid":"..."}'
# export PROXY_BIZ_CODE=... PROXY_BIZ_ID=...
# 注意：本机设了 HTTP(S)_PROXY 时，server.ts 会自动把内网主机追加到 no_proxy
# （Bun fetch 仅识别小写 no_proxy）；手动部署时也请确保包含该主机。

# 独立服务
bun run src/server.ts   # 默认 0.0.0.0:8787（KNOWLEDGE_PORT 可改）

# 测试
bun test
```

## HTTP API（前缀 `/api`）

- `POST /api/knowledge-base` 创建知识库
- `GET /api/knowledge-base` / `GET /api/knowledge-base/:id` 列表/详情
- `DELETE /api/knowledge-base/:id`
- `POST /api/knowledge-base/:id/documents` 添加文档（触发分块+向量化）
- `GET|PUT|DELETE /api/knowledge-base/:id/documents/:docId`
- `GET /api/knowledge-base/:id/documents/:docId/chunks[/:chunkIndex]`
- `GET /api/knowledge-base/:id/chunks`
- `POST /api/knowledge-base/:id/search` 检索（semantic/keyword/hybrid + HyDE/多查询/多阶段/重排）
- `POST /api/knowledge-base/sync-from-yydoc` 等同步系列 + `GET /api/knowledge-base/sync-task/:taskId`
- `POST|PUT|DELETE /api/base-knowledge/:knowledgeBaseId/documents[/:documentId]`
- `POST /api/base-knowledge/:knowledgeBaseId/search`
- `POST /api/base-knowledge/:knowledgeBaseId/api-spec`
- `/api/database/**` 表问答/表行检索（14 条路由）
- `/mcp/kb-document-search` MCP Streamable HTTP；stdio：`bun run src/mcp/server.ts`

统一响应：`{ code, success, message, data }`。

## 嵌入到其它 hono 服务

```ts
import { createKnowledgeApp } from "@opencode/knowledge/app"
const knowledge = await createKnowledgeApp({ initDatabase: false })
app.route("/", knowledge)
```

## 数据库对象

- **前置要求**：PostgreSQL 需安装 **pgvector**（`vector` 扩展）与 **pg_trgm** 扩展。缺 vector 时向量检索会启动失败并给出安装指引（`CREATE EXTENSION vector` 需超级用户或相应权限）。
- 业务表（`KNOWLEDGE_DATABASE_SCHEMA`）：`knowledge_bases`、`documents`、`sync_tasks`
- base-knowledge 表：`base_knowledge_spaces`、`base_knowledge`、`bk_<hash>` 向量表
- 向量表：`kb_<normalized_kb_id>`（`vector_id VARCHAR PK, embedding vector(dim), metadata JSONB`，HNSW cosine）
- 扩展依赖：`vector`（pgvector）、`pg_trgm`、`unaccent`（可选，keyword 检索用）

启动时 `initDatabase()` 自动建表（幂等）。

## 与源项目的差异

1. 无 mastra 依赖：`registerApiRoute`→Hono 子应用（`new Hono().verb(path, handler)`，各域 `routes/index.ts` 导出 `xxxApp` + `AppType`，`app.route()` 挂载）、`@mastra/pg` PgVector→`src/rag/knowledge-base/vector/vector-store.ts`、rerank 的 Mastra agent 打分器→`LLMRelevanceScorer`（纯 generateText 打分）。
2. LLM 走标准 OpenAI 兼容端点（可配置）；Embedding 默认标准端点，可选 `KNOWLEDGE_EMBEDDING_CHANNEL=inner` 走影刀内网代理（自源工程 `handleEmbedding` 迁移，带重试与并发上限）。
3. `zhipu/embedding-3` 分支的 `createZhipuEmbeddingModel` 未定义 bug 已修复（统一走 createEmbeddingModel）。
4. agent_configs/agent_versions 表不再随包创建（与知识库无关）。
5. 默认 schema 从 `test` 改为 `knowledge`。
