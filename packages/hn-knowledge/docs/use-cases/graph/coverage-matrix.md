# Graph E2E 补充覆盖矩阵

本文件记录部分 E2E 缺口与已补的自动化。**以每项状态和断言证明范围为准；设计、自动化和实测通过不能混用。** 完整范围见 [全链路验收](./full-chain.md)，当前审计见 [覆盖审计](./coverage-audit.md)。实施时优先用固定 fixture、真实 PG、确定性 embedding；模型质量评估单列环境依赖。

## 数据隔离、溯源与生命周期

| 编号 | 场景与执行 | 验收断言 | 优先级 |
|---|---|---|---|
| G-GAP-01 知识库隔离 | 两个 KB 写入相同实体名但不同关系；分别读图并删除一个 KB | 任一 KB 的节点/边不包含另一 KB 数据；删除仅影响目标 KB。`graph-acceptance.test.ts` 已覆盖图读写及按 KB 删除；相同 documentId 的跨 KB 文档/chunk 清理尚待测 | 部分覆盖 |
| G-GAP-02 多来源边溯源 | 两份文档导入相同实体和业务边，检查节点-文档关联，再分别删除来源 | 删除首个来源后共享节点/边保留且第二来源关联仍在；删除最后来源后清理节点/边。`graph-acceptance.test.ts` 覆盖节点级来源关联；边级多来源 provenance 与 chunk/page 溯源仍待测 | 部分覆盖 |
| G-GAP-03 删除边界与幂等 | 删除不存在文档、重复删除、相似前缀 ID（如 doc1/doc10/doc1_extra） | 操作安全幂等；不误删其他文档及其图数据。`graph-acceptance.test.ts` 已覆盖不存在文档和相似前缀；重复删除尚待测 | 部分覆盖 |
| G-GAP-04 并发写入 | 并发导入共享节点/边的多个固定 extraction | 无重复业务节点/边、来源集合完整、频率符合实际成功导入次数；无部分写入。`graph-acceptance.test.ts` 已覆盖 3 个并发文档导入 | 已自动化 |
| G-GAP-05 失败回滚与重试 | 在批量写入中注入 DB 错误，修复后重试 | 失败事务无半成品；连接释放；重试后数据完整且无重复 | P1 |
| G-GAP-06 初始化与迁移 | 空 schema 初始化、旧 schema 升级、重复初始化 | 表/索引/新增列符合当前 schema；重复初始化不破坏已有数据或重复迁移 | P1 |

## 入库、检索与查询契约

| 编号 | 场景与执行 | 验收断言 | 优先级 |
|---|---|---|---|
| G-GAP-07 文档入库主链路 | 经 `DocumentIngestPipeline` 输入文档，执行提取、建图、查询与删除 | 入库结果、节点/边、来源关联和删除结果相互一致；失败状态不留下不完整图 | P0 |
| G-GAP-08 API 规格入库 | 对 OpenAPI/Swagger 固定 fixture 分别执行解析、入库、依赖查询 | endpoint/method/schema/operation 关系可查询；非法规格返回可判定错误且不污染已有图 | P1 |
| G-GAP-09 检索变体对照 | 同一固定图分别运行 triplet/local/global/completion/hybrid/round-robin 及 temporal 检索 | 契约字段、KB 隔离、topK 上限、关系/主体过滤和空结果正确；排序断言使用确定性向量 | P1 |
| G-GAP-10 分数阈值与重排 | 覆盖有/无 rerank、相关/不相关向量、minScore 边界 | 相关性阈值语义一致，不相关结果不能因融合/重排被抬高；作为缺陷回归，修复前标 BLOCKED | P0 |
| G-GAP-11 RDF 写入、推理、查询、删除闭环 | 抽取写入 named graph；执行父类/domain/inverse/functional/disjoint 推理，再执行 ontology query 和来源删除 | 推理结果、冲突、SPARQL 子集查询及 statement provenance 正确；删除一个来源不误删其他来源事实 | P1 |
| G-GAP-12 Ontology 版本生命周期 | 注册/读取/切换 ontology 版本，使用版本执行校验和查询 | active 版本唯一且选择正确；版本切换不串数据；无效版本输入有明确失败结果 | P2 |
| G-GAP-13 仅实体入库来源 | 构建只有 entities、没有 triplets 的 extraction，再按文档查询来源并删除 | 节点仍建立文档关联；按文档删除时节点及来源关联均清理。`graph-acceptance.test.ts` 已覆盖；曾发现 GraphBuilder 在无关系时提前返回，修复后 PG 回归通过 | 已自动化 |
| G-GAP-14 并发导入去重 | 并发执行多个相同 extraction，各自带不同 documentId | 节点和边去重、频率累加正确、每个文档关联均存在。`graph-acceptance.test.ts` 已覆盖 3 路并发 | 已自动化 |
| G-GAP-15 边来源跨篇并集 | 两篇文档各写同一条业务边 | 边 `sourceDocumentIds` 并集保留（对齐节点 `mergeNodePropertiesSql` 既有模式）；曾实测覆盖缺陷已修复，`graph-acceptance.test.ts` 覆盖 | 已自动化（已修复） |
| G-GAP-16 删除同步清理 | 两篇共享图数据后删除一篇 | 现有 PG 测试断言共享节点 frequency 回减、关联清理；未预置并证明 RDF 非空，也未断言原文/tracker 全清理，不能宣称完整同步删除已验 | 部分自动化；全链路待补 |
| G-GAP-17 文档更新替换 | 同文档内容变更后重摄入 | 现有真实 PG + mock 抽取测试覆盖 append/replace 的节点与 frequency；原文 chunk、checkpoint、失败版本可见性尚待补 | 部分自动化，opt-in；非完整替换验收 |

## RAG 真实文档数据源用例

| 编号 | 数据源 | 执行与验收 | 状态 |
|---|---|---|---|
| G-RAG-1 影刀 Harness 文档入图 | RAG 已有库 `kb_yingdao_harness_zh_cn` 中的会话复制（`994499662063226880`）、Skill 配置（`987902908331687936`）、MCP 配置（`987903017838411776`）原文 | 只读读取 RAG `documents`；入图前检查固定事实确实存在于原文；以确定性 extraction 写入独立 Graph schema；断言节点/关系/文档来源关联；前后比较源文档 content hash 不变 | 已自动化，opt-in |
| G-RAG-2 全量文档目录图 | 同一 RAG 知识库全量 36 篇真实文档及 `docName`/`parentPath` 元数据 | 建立文档节点→目录节点关系；验证 36 篇来源关联和目录共享；按单篇文档删除后只移除目标文档图数据；前后比较全库 content hash 不变 | 已自动化，opt-in |

## 测试方法与状态规则

- 每个用例应有独立 KB/测试 schema 或唯一 fixture 标识，使用 `afterAll` 清理；不触碰真实知识库。
- PG 用例通过实际 PG 验证持久化结果；mock 只能用于故障注入，不可替代最终 DB 状态断言。
- 并发/失败注入需断言执行过程（事务/重试/回滚）与最终数据，不只检查返回值。
- 检索质量断言必须先固定输入图和向量；涉及真实 LLM 的抽取忠实度单列 LLM-GATE，不能作为确定性 P0 门禁。
- G-GAP-10 对应已知 `minScore` / rerank 分数语义缺陷（见 `packages/knowledge/AGENTS.md`）。缺陷未修复前可记录 BLOCKED/已知失败，不得放宽期望或报 PASS。
- 当前已有 Graph HTTP 四端点及 Hono request 契约测试。本矩阵主要验证模块/PG；HTTP 参数边界、状态码、序列化和 Docker 部署与 Agent 证据链应另行验收，不能混算覆盖。
- 完成一项后，在本表追加自动化测试文件/用例名、执行命令及 PASS/FAIL/SKIP 实测结果；未执行的保持待测。
