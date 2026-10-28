# GraphRAG 覆盖审计（2026-10-14）

## 结论

**现有目录没有全面覆盖整个 GraphRAG 链路。** 正常图构建与部分 PG 生命周期已有自动化，公开组件的单测比目录索引更广，但严格生成质量、部分一致性边界、所有扩展能力的部署链路尚无完整验收。新增 [全链路验收](./full-chain.md) 定义完整范围，不代表自动化已经完成。

审计依据：`src/graph/index.ts` 公开导出、pipeline/HTTP handlers、`src/graph` 下 50 个 `.test.ts` 文件及 `test/graph-http-contract.e2e.test.ts`，逐项对照该目录文档。50 是测试文件数，不是功能覆盖率或通过数。本次为静态覆盖审计，未重新运行这些 Graph 测试。

## 能力—现有证据—缺口

| 能力 | 当前文档/自动化依据 | 缺口与状态 |
|---|---|---|
| 图构建/重复导入/方向/关系筛选 | G-P0、G-E2E；`graph-acceptance.test.ts` | 正常路径已有，append 不等于整文严格幂等 |
| 文档转换/分块/抽取降级 | G-GAP-07；`pipeline/document-pipeline.test.ts` | 有组件测试；真实长文、原文/chunk/RDF 一致性及部署流程不完整 |
| 并发与实体合并 | G-GAP-04/14/15；`merge-pipeline.test.ts`、PG acceptance | 基础共享来源已测；失败原子性、多 pod 与 replace/delete 竞争缺少全链路 |
| 更新 replace | G-GAP-17（真实 PG、mock 抽取） | 仅断言节点和 frequency；新原文 chunk 保留、checkpoint 更新、失败后版本可见性待补 |
| 文档删除/共享来源 | G-P0-4、G-GAP-02/03/16 | 多 KB 同 documentId、精确前缀、多 chunk 和全部存储面删除仍缺端到端断言 |
| checkpoint 续传 | `document-pipeline.test.ts` 有缓存/恢复测试 | 跨进程恢复、变化内容和 replace 组合的 PG 门禁不完整 |
| 事务/回滚/迁移 | G-GAP-05/06；pipeline 有 RDF 失败组件测试 | 没有证明多存储面批量写入、故障重试和旧数据保护完整 |
| completion 与检索变体 | G-E2E-1、G-GAP-09；`retrieval/*test.ts`、`new-features.test.ts` | 组件较多，缺统一数据集下所有策略的 PG/HTTP/隔离/topK 对照 |
| minScore/rerank | G-GAP-10、`__review_probe.test.ts` | 工程约定记录 2 个已知失败；不能记全通过，本次未新跑 |
| 原文/实体卡/边来源 | `retrieval/evidence.test.ts`、trace tests；Agent 冒烟 | HTTP search 合并端点来源，不能证明边来源；严格引用与可见证据断言待补 |
| Graph HTTP 四端点 | `routes/*`、`test/graph-http-contract.e2e.test.ts` 5 个测试 | 有 Hono request + PG/真实模型契约；未证明四端点 Docker 部署、全部参数边界与故障场景 |
| Session graph agent | `agent-graphrag.md` U05/U12 冒烟、严格标准 | 脚本仍是旧词面检查；真实成功检索、纯回答、逐事实忠实性和完整引用未自动化验收 |
| V01–V12 生成质量 | 沿用 RAG 问题集，严格标准已定义 | 原语料/图被误删，严格复测 BLOCKED，不能沿用旧关键词 PASS |
| OpenAPI / Swagger | G-GAP-08、parser tests、`ApiSpecIngestPipeline` | 解析有测试；规格摄入→查询→更新→删除的独立 PG/HTTP 闭环待补 |
| 代码图/事件与时间冲突 | G-E2E-3/6、temporal tests | 基础确定性 PG 有覆盖；代码变化、仓库隔离、事件来源删除待补 |
| 结构化行与自然语言查询 | `rows/*test.ts`、RowStore/RowRetriever/NaturalLanguageRowQuery 导出 | 当前用例目录基本未映射；不能假定已进入 Graph HTTP/Agent 统一链路 |
| 会话蒸馏/全局上下文/摘要 | `new-features.test.ts`、相关 extraction 组件 | 未在目录内形成稳定用例编号；更新/删除后的消费结果待验 |
| 真值/反馈/偏好检索 | `new-features.test.ts`、`gaps.test.ts` | 有 PG/组件证据，缺完整 Agent 消费及阈值/来源联合作用验证 |
| RDF 写入/推理/查询/来源删除 | G-GAP-11；`rdf/*test.ts`、`query/*test.ts` | 多子模块有测试，不等于 named graph→推理→查询→删除联合闭环 |
| ontology 版本生命周期 | G-GAP-12、registry/turtle/query tests | 单组件覆盖较广，版本切换后图/查询/来源一致性完整验收待补 |
| trace 持久化/答案回填/回溯 | `retrieval/trace-persister.test.ts`、公开 API | 文档索引缺失；同题 execution、跨 pod、删除后回溯需集成验收 |
| 子图/路径/指标/可视化/RDF 导出 | G-E2E-7/8，semantic-map、visualizer tests | 部分基础 PG 已覆盖；所有公开查询方法边界、隔离和特殊字符未统一门禁 |
| 故障恢复/资源与多 pod | 新增环境事故回归，独立 Wiki HTTP test | 回归证明防再误删与进程不崩；不证明 Graph 全链路恢复、并发或性能达标 |

## 原文档中过强与过时的说法

1. README/补充矩阵原称“没有 HTTP 路由”，已不符合当前代码；已有 `/api/graph` 四端点，但测试层次必须区分组件 HTTP 与真实部署 HTTP。
2. G-GAP-16 在 `graph-acceptance.test.ts:318–342` 通过 GraphBuilder 预置图；GraphBuilder 本身没有 RDF 写入，测试未先证明 RDF 存在，删后查询为零不能证明 RDF 删除生效，也没有断言 chunk/tracker 全清理。
3. G-GAP-17 在 `graph-acceptance.test.ts:345–379` 使用真实 PG、mock EntityExtractor；只核验节点名字/frequency，不足以证明原文/checkpoint/替换失败语义。
4. Graph HTTP 契约以 Hono `app.request` 执行，不是已部署 Docker Graph 接口测试；旧脚本仅用随机 KB，清理的文档 ID 是常量且未按 KB 限定，不能直接在共享业务 schema 上跑。
5. 19 PASS 是旧版本历史报告；当前两个核心 E2E 文件定义了 13+9 个测试，不能据旧报告推断新版本 22 个测试通过。
6. 全量真实语料构图、检索词面评测、Agent 冒烟和语义正确性是不同门禁。来源 ID 在回答中出现、实体名在原文共现、节点/边条数不变，都不能分别替代引用忠实性、关系忠实性或全表只读检查。

## 当前适用门禁

- **有自动化的组件/PG 场景**：继续保留，并明确其输入是否 mock、是否真实 PG、是否部署 HTTP。
- **新增全链路设计**：C01–C33、X01–X13 均需逐条补对应自动化和运行证据；文档存在不计入实现覆盖。
- **已知缺陷**：阈值与重排不得放宽期望；生命周期/替换边界先补失败断言再修实现。
- **环境阻塞**：真实 36 篇语料严格 Agent 门禁仍 BLOCKED；防再发修复的 42 单测/20 PG E2E/1 Docker HTTP 不算 Graph 功能或生成质量通过数。

优先级：安全与一致性（更新删除/来源/检查点/事务/分数）→ Docker Graph HTTP 与 Agent 可见证据 → 严格 V 系列 → 扩展公开能力 → 多 pod 与性能。
