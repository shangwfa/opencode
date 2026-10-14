---
template: doc
title: Graph 实现深度审计
subtitle: 2026-10-14 · 当前工作区源码、真实 PG 探针与测试证明边界
lang: zh
style: off
---

## A 总体判断：组件丰富，核心一致性尚未达标

Graph 不是空壳。它已有 PG 属性图、实体嵌入、邻域检索、跨 chunk 合并、本体校验、RDF 存储、查询编译、冲突处理和审计追踪。

但“功能存在”不等于“生产语义可靠”。当前最大的缺口不在算法数量，而在跨库删除隔离、来源生命周期、失败原子性和分数契约。

**建议定位为：可用于受控 GraphRAG 集成验证的能力包，不宜仅凭现有测试绿灯认定多租户知识服务已验收。** 这是对已复现错误的判断，不是对线上故障发生率的推测。

- 研究对象是当前工作区，包含此前未提交的 Graph 修改；不是某个发布版本。
- Graph 目录有 129 个 TypeScript 文件：79 个非测试文件、50 个测试文件。非测试文件约 13,702 行，包含 fixture。
- 本轮不修改业务实现。新增可复现审计脚本，所有 PG 写入使用脚本新建的随机 schema，执行后仅删除该 schema。
- 未发现 `.understand-anything/knowledge-graph.json`。本报告直接沿源码调用链分析，不使用预生成知识图。

## B 实际架构：一个能力包，三条不同的入图路径

```flow LR
RAG文档处理 -> KnowledgeGraphSyncer: 可选syncToGraph
KnowledgeGraphSyncer -> GraphBuilder: 默认syncChunks
GraphBuilder -> PG属性图: 节点和边
正文 -> DocumentIngestPipeline: 转换和分块
DocumentIngestPipeline -> GraphMergePipeline: 模型抽取及跨chunk聚合
GraphMergePipeline -> PG属性图: 写节点、来源关联、边
GraphMergePipeline -> ChunkTracker: 先写来源tracking
DocumentIngestPipeline -> RDF存储: 事实及受限推理
查询 -> GraphCompletionRetriever: 种子和邻域
PG属性图 -> GraphCompletionRetriever
GraphCompletionRetriever -> 结果与上下文: 三元组、原文、解释
RDF存储 -> OntologyQueryService: 独立查询路径
```

**装配层：** `src/app.ts:22-28` 挂载 RAG、base-knowledge、database、llm-wiki，没有独立 Graph HTTP 域。Graph 有工具适配和可选 RAG 同步，因此“没有独立 HTTP 路由”不等于“没有任何集成”。

**存储层：** `graph/pg-adapter/adapter.ts:23-47` 组合 repository、traversal、PG chunk tracker、RDF store、ontology registry。PG 是事实持久化位置，CogneeGraph 是检索期间的内存投影，不是外部图数据库。适配器明确不支持 Cypher。

**关键分叉：** RAG 文档处理调用 `KnowledgeGraphSyncer.syncChunks`，不是 `DocumentIngestPipeline`。前者默认使用 GraphBuilder，不能把后者具备的 RDF、合并、检查点等特性自动归到 RAG 同步链路上。证据：`rag/knowledge-base/services/document.service.ts:220-237`、`graph/extraction/index.ts:56-94`。

## C 入库逻辑：正常路径有效，事务与重试语义不完整

### GraphBuilder

直接接受固定 extraction，为实体生成可选向量，以 KB+名称生成确定性节点 ID，再写节点、类型边、文档关联和关系。关系置信度小于 0.3 时跳过。无关系 extraction 的来源关联提前返回缺陷已经由此前修改修复。

该路径适合底层验收，但它不负责正文分块、chunk 原文落盘、完整本体编译或模型忠实度评估。它写入单值 `sourceDocumentId`；检索来源读取主要期待 `sourceDocumentIds` 数组，存在生产者与消费者契约不一致。证据：`graph/extraction/graph-builder.ts`、`graph/retrieval/graph-completion-retriever.ts:594-617`。

### DocumentIngestPipeline

按内容类型转换为 Markdown，分块并保存 chunk 原文；以默认并发 4 抽取。模型失败或为空时可使用注入的 fallback。检查点用 chunk 内容 hash 校验，避免旧内容复用。然后跨 chunk 合并、处理 functional 冲突，按适配器能力写 RDF。

正向设计包括：显式 mode、emptyExtractionChunkCount、检查点、ontology 写前校验和 RDF 失败时尝试补偿删除。

局限：模型异常被吞掉，失败 chunk 可能不入图；只要有一个 chunk 来自 LLM，整篇 mode 即为 llm。mode 不代表整篇抽取完整。当前 tracker 默认是内存实现，不会因为 PG 适配器自带 chunkTracker 就自动将其作为合并 tracking。证据：`graph/pipeline/document-pipeline.ts:224-341,353-395`。

### GraphMergePipeline

按归一化名称合并实体，类型取多数，描述取最长；关系按三元组聚合，记录 chunk 和文档集合。先写 tracking，再写属性图。

这体现了恢复意图，但**写前 tracking 不等于完整 WAL 恢复系统**。这一链路没有跨所有步骤的数据库事务，也没有在本次研究中证明可重放恢复的持久化任务状态机。

PG 的 `withClient` 只申请/释放连接，不执行 BEGIN。节点批量写入逐条执行 SQL；注入第二个节点的向量维度错误后，第一个节点仍提交。RDF add 有独立事务，不能因此认为属性图与 RDF 双写原子。证据：`graph/pg-adapter/repository.ts:46-53,287-317`、`graph/rdf/pg-quad-store.ts:46-58`。

## D 检索逻辑：召回增强很多，阈值与结果数量有硬缺陷

主路径是 query→embedding→ANN 种子→词面锚点→PG 邻域→内存距离/重要性排序→过滤→可选重排→来源与原文→上下文和解释。

优点包括：语义和词面两路种子、关系及主体过滤、superseded 过滤、实体卡、来源片段、解释持久化和可选问题分解。它不仅是单次向量最近邻查询。

| 问题 | 当前证据 | 后果 |
|---|---|---|
| 距离与相似度混用 | CogneeGraph 按 score 升序排序，minScore 按 `>=` 过滤 | 不相关向量可通过相关性门槛 |
| RRF 排名分伪装为置信度 | reranker 将融合排名分缩放后写回 score | 全不相关候选也能得到 1 或 0.984 |
| topK 后追加锚点边 | 先 slice(topK)，再追加最多 6 条锚点边 | topK=1 实测返回 3 条 |
| 补边不重做阈值检查 | 追加过程遍历 ranked，不复核 minScore | 静态代码表明阈值可被补边绕过，未单独量化 |
| 分解后的文本上下文不切换 | 子查询有向量，但 retrieveCandidates 接收原 options 的 queryText | 子查询锚点可能仍使用原始问题；质量影响待测 |

证据：`graph/knowledge-graph/cognee-graph.ts:145-180`、`graph/retrieval/reranker.ts:170-199`、`graph/retrieval/graph-completion-retriever.ts:220-226,424-459`。

性能边界：词面锚点读取全图；superseded 过滤再次读全图；GlobalGraphRetriever 读取全图后按两端向量均值乘权重排序。来源回链按结果边反复查询。代码存在全图扫描和 N+1 路径，但**没有规模压测，不能声称已经出现性能瓶颈或给出 QPS**。

GlobalGraphRetriever 的“global”不等同于经过社区检测和多层报告汇总的全局 GraphRAG。它当前主要是全关系集合排序。证据：`graph/retrieval/global-retriever.ts:37-77`。

## E 生命周期与隔离：本轮 PG 复现的七个问题

以下结果来自 `script/audit-graph-implementation.ts`，原始结果见同目录 `implementation-audit-evidence.json`。

| 优先级 | 探针 | 期望与实际 | 根因依据 |
|---|---|---|---|
| P0 | 跨库相同 documentId 删除 | 删 A 后 B 保留；实际 B 节点被删 | 来源查询及清理只按 documentId，不带 KB；UnifiedStoreEngine 主路径未缩小到目标 KB |
| P0 | chunk 前缀删除 | 删 doc1 后 doc10/doc1_extra 保留；实际全被删 | tracker 使用 `LIKE documentId%`，无分隔符边界 |
| P1 | 边多来源 upsert | 保留 source-a/source-b；实际仅 source-b | JSONB `||` 对数组字段为覆盖，不是集合并集 |
| P1 | 批量写入失败 | 失败后无新节点；实际保留第一个节点 | 属性图批量写入无事务 |
| P1 | 单文档多 chunk 删除 | 文档删除后节点清空；实际残留 1 个 | 文档引用数组包含同一文档的多个 chunk，长度被当成文档数 |
| P1 | 共享节点间独占来源边 | 删唯一边来源后清空该边；实际残留 1 条 | UnifiedStoreEngine 只随独占节点删边，不清理共享节点间的来源边 |
| P1 | 锚点检索结果上限 | topK=1 应不超过 1 条；实际 3 条 | 截断后补边，无最终预算检查 |

定位：`graph/pg-adapter/repository.ts:769-795,835-841,449-458`；`graph/unified/engine.ts:78-101,189-198`；`graph/pipeline/document-pipeline.ts:131-165`；`graph/extraction/entity-chunk-tracker.ts:107-112,156-162`。

还需注意：DocumentIngestPipeline.removeDocument 与 UnifiedStoreEngine.deleteByDocument 是两条不同删除实现。前者清理 chunk/RDF 并尝试 relation tracking；后者不会完整同步这些存储。当前不能将任一删除入口的通过结果推广到另一入口。

上述跨库风险是在同 schema、不同 KB、相同 documentId 情况下复现。RAG `documents.id` 在当前表中全局唯一，可降低该特定入口触发概率，但 Graph 公共接口允许多个 KB 使用同 documentId，因此不能将其视为图层已实现隔离。

## F 本体与 RDF：有真实实现，但不是完整语义平台

本体层有类型/关系约束、版本 registry、Turtle 解析、选择相关本体子集和写前过滤。RDF 层有 PG quad 存储、named graph、来源字段和查询 plan→SQL 执行。

推理实现覆盖父类、等价类、domain/range、inverse，以及 functional/disjoint 冲突检查。它不是通用 OWL 推理器。DocumentIngestPipeline 当前把本轮抽取 facts 传给推理函数，而不是全库事实；因此不能据此证明跨文档冲突全部被发现。

查询解析器明确支持受控 SPARQL 子集，不是完整 SPARQL。查询服务区分 PG native 与可移植执行器。两条执行路径的完整等价性、本体版本迁移和多来源 RDF 删除仍需专门 PG E2E。

证据：`graph/rdf/reasoner.ts:21-91`、`graph/query/ontology-query-plan.ts:20-46`、`graph/query/ontology-query-service.ts:22-35`、`graph/pipeline/document-pipeline.ts:369-395`。

## G 测试结果：绿灯证明正常路径，不证明所有边界

| 本轮测试组 | 实测 | 证明范围 |
|---|---|---|
| graph/e2e 三个文件 | 21 PASS / 0 FAIL | 固定建图、共享删除、并发及真实 RAG 数据读取等已设断言 |
| pipeline、query、RDF 选定测试 | 32 PASS / 0 FAIL | 单元/组件级逻辑，多处模型或存储使用 mock；不是全量 Graph 测试 |
| 已有 review probes | 4 PASS / 2 FAIL / 9 SKIP | 两个分数缺陷仍复现；9 个专用 PG 探针未启用 |
| 新增随机 schema PG 审计 | 7 项不满足期望 | 七个负向边界的真实数据库结果，不是环境阻塞 |

**必须修正此前语料测试的理解：**

- G-RAG-1 读取三篇真实原文，核对事实子串，然后手工构造三条确定性关系。它没有调用真实 LLM，也未执行正文 ingest/search 问答链路。
- G-RAG-2 读取 36 篇文档的 docName/parentPath，构建 36 条目录关系。它证明元数据图和该样本删除路径，不证明 36 篇正文的语义抽取质量。
- 两项使用 content hash 核对源内容不变；没有把 metadata、向量全表和最终 Agent 答案纳入同一断言。
- 所以不能报告“36 篇文档 GraphRAG 已全链路可答”，也不能报告 Graph 相比 RAG 的召回收益。
- 覆盖矩阵中的 G-GAP-04/14 属于重复描述；“并发正常写入通过”不能证明失败原子性。

复现命令应从 `packages/knowledge` 执行，使用专用测试 PG：

```bash
KNOWLEDGE_GRAPH_RAG_E2E=1 DATABASE_URL='<测试PG连接串>' bun test src/graph/e2e/
bun test --isolate src/graph/pipeline/document-pipeline.test.ts src/graph/query/ src/graph/rdf/reasoner.test.ts src/graph/rdf/fact-writer.test.ts
bun test src/graph/__review_probe.test.ts
DATABASE_URL='<测试PG连接串>' bun run script/audit-graph-implementation.ts
```

审计脚本把结果写到 stdout 的 JSON；发现不符项时记录 FAIL，不以进程退出码充当通过判定。检查 findings.status。

## H 建议顺序：先收敛契约，再扩大语料质量评估

1. **先修隔离和数据破坏风险。** 所有来源查询、chunk/checkpoint/tracker/RDF 删除统一使用明确 KB+document 身份；区分租户授权与库过滤，不能把可选 KB 参数当权限校验。
2. **统一来源模型和删除入口。** 统一 sourceDocumentId/sourceDocumentIds、chunk ID 分隔符和 distinct 文档引用计数；共享事实删除以剩余支持来源为依据。
3. **确定事务与任务边界。** 设计入库 run 状态及幂等键。属性图批次事务不能替代属性图/RDF/tracker 的一致性协议；补偿删除不应误删此前成功摄入的同文档数据。
4. **分离分数与排序。** 明确 distance、relevance、rankScore 和 evidenceWeight。最终过滤、锚点补边和 topK/token 预算在同一收尾步骤执行。
5. **再评估真实文档收益。** 用 36 篇原文执行真实正文摄入，核对模型抽取事实与来源；复用 RAG U/V/W 问题，按 hit@K、fact coverage、来源准确性和 can-answer 比较。没有测量结果前不承诺优于 RAG。
6. **最后补服务化与规模证据。** 在业务需要时增加 Graph 域 HTTP 契约、任务恢复及观测；测图规模、投影上限、延迟、数据库往返和全图扫描成本。

本报告只给建议，未自动修复这些新发现的问题。先沉淀为门禁测试、讨论一致性契约，再逐项修改更稳妥。
