# Wiki 检索行为用例：词法命中 · 可见性 · 图扩展 · 预算

> 用例段：S01~S17。对象是 `POST /llm-wiki/search` 的**检索行为**，而非请求面契约（契约见 [search-contract.md](./search-contract.md)，WS 系列）。
> 与 RAG 检索矩阵（[../rag/search.md](../rag/search.md)）的区别：Wiki 检索**不是向量检索**，没有 `searchType`、`filter`、`rerank`、`hyde`、`fusionMethod`、`minScore`、`pgVectorConfig`，这些用例不适用，不做迁移。
> 判定规则同 [../rag/evaluation-rubric.md](../rag/evaluation-rubric.md)：期望先行、确定性断言优先、未自动化的用例不计 PASS。

## 检索机制（用例依据）

| 环节 | 实现 | 代码位置 |
|---|---|---|
| 分词 | 英文按空白/标点切分；中文 ≥3 字生成 bigram 与单字；停用词过滤 | `wiki-search.service.ts` `tokenizeQuery` |
| 字段评分 | 整句命中：名称 50 / 标签 30 / 摘要 20 / 定义 10 / 正文 6；单词命中：20 / 12 / 8 / 4 / 2 | `wiki-search.service.ts:104-108` |
| 精确名 | 整句=概念名 +200；**概念名作为问句连续子串（≥2字）+120**（口语长句修复，WS13/Q07） | `wiki-search.service.ts:128-131` |
| 全文补充 | `ts_rank` 对名称/摘要/定义加权 ×15 | `wiki-search.service.ts:129` |
| 可见性 | 仅 `status='compiled' AND citation_status='verified'`；`_index` 因 `derived` 状态天然排除 | `wiki-search.service.ts:143-145`，`wiki-compiler.service.ts:864` |
| 来源新鲜度 | 任一来源缺失、跨库或哈希与当前文档不一致 → 整页不返回 | `wiki-search.service.ts:146-153` |
| 图扩展 | 仅取前 5 个种子；关联页同集合、verified；关联分 = 种子分 × 0.5 | `wiki-retrieval.service.ts:83-92` |
| 预算 | 80% 正文页 / 15% 索引 / 5% 系统；超出时首页裁剪并标 `truncated` | `wiki-retrieval.service.ts:41-43, 259` |

## 用例

| 用例 | 验证点 | 覆盖来源 | 实测 |
|---|---|---|---|
| S01 概念名命中 | 查询等于概念名时，该概念排第一 | WS13（口语长句 + 长名概念竞争场景） | PASS |
| S02 中文分词 | 中文查询生成 bigram；英文按空格切分；停用词不参与；空查询返回空 | 单测 `tokenizeQuery` ×4 | PASS（单测） |
| S03 字段权重排序 | 同时命中名称与正文的概念排在仅命中正文的概念之前 | 单测 `searchConceptsScored`（tsvector 加权结构）；e2e 未单独断言 | PASS（单测） |
| S04 精确名置顶 | 口语长句下，概念名作为问句连续子串（+120）压过仅含该词的长名概念 | WS13（Q07 真实缺陷回归） | PASS |
| S05 可见性过滤 | 未验证（legacy）页与 `_index` 页不进入结果 | WM13（legacy 页不召回）、WS11（计数排除 `_index`） | PASS |
| S06 来源新鲜度 | 来源哈希与当前文档不一致时，该概念整页不返回；原文更新后可重新召回 | WM02（撤销事实后旧页不召回） | PASS |
| S07 跨库隔离 | 外集合概念（即使 PG 中挂着关系）不进入本库结果与预算上下文 | WS04、WM05 | PASS |
| S08 topK 截断 | `topK=1` 恰好 1 条 | WS02；单测 `应该使用自定义 topK` | PASS |
| S09 空态 | 无集合或无命中：200 + 空结果，不报错；预算检索返回空 `citedPages` | WS03；单测 `知识库没有集合时` | PASS |
| S10 图扩展带入关联 | 默认开启时，种子概念的关联页进入 `relatedConcepts` 与 `citedPages` | WM03、WS05 | PASS |
| S11 关闭图扩展 | `includeRelated=false` 时不返回关联概念，结果中 `relatedConcepts` 为空 | WS05；单测 `includeRelated 为 false` | PASS |
| S12 图深度边界 | `depth` 限制在 1~3；超出 400；遍历层数上限为 3 | WS01（400）；单测 `深度应该被限制在 3 以内` | PASS |
| S13 关联页不越界 | 关联页必须同集合且 verified；其它集合的关联页不进入上下文 | 单测 `禁止把其他集合的关联页加入上下文`；WM05 | PASS |
| S14 预算分配 | `budgetTokens=8000` 时分配 6400 / 1200 / 400；总估算不超预算 | WS06；单测 `默认预算应为 4000 tokens` | PASS |
| S15 超大首页裁剪 | 首个中文页面超出页面预算时裁剪并标 `truncated=true`，总量不超预算 | WM03（预算 300）；单测 `超大首个中文页面不能突破预算` | PASS |
| S16 证据回溯 | 每个引用页带来源文档 ID、名称与原文链接，可回到原文核对 | WM03（`docName`/`docUrl` 断言） | PASS |
| S17 旧版本关系不扩展 | `origin='legacy'` 或 `source_revision` 过期的关系不参与图扩展 | WM13 | PASS |

## 未覆盖与补充计划

- **S01、S03、S04 未自动化**：这三条依赖字段权重与精确名加分的相对顺序，目前只有单测验证 SQL 返回结构，没有 e2e 断言排序。补充方式：在 `test/wiki-search-contract.e2e.test.ts` 中建 3 个概念（名称精确命中、仅正文命中、名称与标签命中），断言返回顺序。补充前不得写 PASS。
- **不迁移的 RAG 用例**：`searchType`/`filter`/`rerank`/`hyde`/`fusionMethod`/`pgVectorConfig` 相关的全部用例（原 R5.2~R5.14、R10）不适用于 Wiki 检索。
- **不评估答案质量**：本文件只断言检索机制（命中、过滤、扩展、预算），不评估模型生成的概念或页面是否忠实于原文，该部分见 [maintenance.md](./maintenance.md) 的边界说明与真实模型 LLM-GATE。

## 执行方式

已自动化的用例（S02/S05~S17）由以下两部分执行：

```bash
# 单测（无需 PG）
cd packages/knowledge && bun test --isolate src/llm-wiki/__tests__/wiki/wiki-search.service.test.ts src/llm-wiki/__tests__/wiki/wiki-retrieval.service.test.ts

# HTTP/PG e2e（Docker，确定性模型）
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
docker run --rm \
  -v "$ROOT:/repo:ro" \
  -w /repo/packages/knowledge \
  -e "KNOWLEDGE_DATABASE_URL=postgresql://postgres:ab123456@host.docker.internal:55432/knowledge" \
  --entrypoint bun opencode-saas-sandbox-test:slim \
  test --isolate --timeout 30000 test/wiki-search-contract.e2e.test.ts test/wiki-maintenance.e2e.test.ts
```

实测结果以各自套件的最近一次运行为准（WS 套件与 WM 套件的结果见 [README.md](./README.md)）。本文件不另行记录数字，避免与套件结果不一致。
