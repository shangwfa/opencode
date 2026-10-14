# Wiki HTTP 契约矩阵（WS 系列）

> 参照 [../rag/search.md](../rag/search.md) 的契约矩阵形式，覆盖 llm-wiki 对外请求面：
> search（参数边界/空态/隔离/预算/排序）、compile（状态机与任务透传）、collections/concepts/navigate/lint、revisions（分页与版本边界）。
> 判定规则同 [../rag/evaluation-rubric.md](../rag/evaluation-rubric.md)：期望先行、确定性断言优先、环境阻塞不伪造。

## 范围与数据依据

- 数据源：复制 RAG 已有库 `kb_yingdao_harness_zh_cn` 中两篇原文（`996621057543712768`、`996621067853312000`）到唯一临时 schema；结束核对原文未变并清理。
- 模型使用确定性替身（与 [maintenance.md](./maintenance.md) 同一套，页面输出为瘦身协议 blockIndex+anchor）；Hono 走真实 HTTP socket，PG 为真实数据库。
- 本套件验证 **HTTP 契约与执行路径**，不证明真实模型忠实度或检索质量（真实问句见 [questions.md](./questions.md)）。
- 语义依据：zod schema（`WikiSearchRequestSchema`）、各 route 的显式 400/404 分支、`wiki-retrieval.service` 的 80/15/5 预算分配、`wiki-search.service` 的精确名排序。

## 用例与结果

| 用例 | 验证点 | 实测 |
|---|---|---|
| WS01 search 契约负例 | 缺 query/knowledgeBaseId、`topK<=0`、`depth∈{0,4}`、`budgetTokens<=0` 均 400 | PASS |
| WS02 topK 边界与结构 | `topK=1` 恰好 1 条；结果含 concept/relatedConcepts/sourceDocumentIds，来源为 a、b | PASS |
| WS03 空态契约 | 未编译库 search 与 budgetTokens 检索均 200 空结构，非错误；预算分配回显 totalBudget | PASS |
| WS04 越库隔离 | 人为插入外集合已验证概念后，search 与预算检索结果只含本集合概念 | PASS |
| WS05 includeRelated | `false` 时 relatedConcepts 恒空；默认开启时返回图扩展关联（文档平台同步） | PASS |
| WS06 预算检索契约 | budgetTokens=8000 → 分配 6400/1200/400；citedPages 带 citationIndex/正文/来源；totalEstimatedTokens ≤ 预算 | PASS |
| WS07 编译任务契约 | 创建返回 pending+taskId；状态可查；不存在 taskId 404；运行中重复编译 400（挂起页面生成复现窗口） | PASS |
| WS08 概念详情契约 | conceptId/slug 双通道；缺参 400；不存在 404；relatedConcepts 与 sourceDocumentIds 齐全 | PASS |
| WS09 集合契约 | 详情回读 knowledgeBaseId；列表按 KB 过滤唯一；不存在 404 | PASS |
| WS10 修订 API 契约 | 默认分页（page=1/pageSize=20）；`page=0`、`pageSize∈{0,101,1.5}`、`revision∈{abc,-1}` 400；`revision∈{0,999}` 与不存在 concept 404 | PASS |
| WS11 导航与 lint 契约 | navigate 计数正确；graph-stats 边数与度数 ≥1；lint 结构完整且类型合法；已知 `no_outlinks`（文档平台同步）如实报告 | PASS |
| WS12 任务状态透传 | 单文档模式返回 `documentId='a'`、全量模式返回 null；`attempt≥1`，完成态保留 | PASS |
| WS13 精确名排序 | 口语长句 + 多个含核心词的长名概念竞争时，概念名=问句连续子串（+120）的概念排第一（Q07 真实缺陷回归） | PASS |
| WS14 语义 lint | 合法 LINT 块与结构问题一起透出；NO_ISSUES 仅结构；无效输出降级 skipped（不伪装）；限流原文透出 | PASS |
| WS15 任务列表与取消 | `GET /compile?collectionId` 按集合过滤分页（缺参 400）；取消挂起任务 → failed(cancelled)，worker 放行后不发布；重复取消 400 | PASS |

源文件：[test/wiki-search-contract.e2e.test.ts](../../../test/wiki-search-contract.e2e.test.ts)。

## 内嵌执行脚本

依赖与 [maintenance.md](./maintenance.md) 相同：本地 PG、现有 RAG 原文、含 Bun 的测试镜像；数据库地址从容器视角配置。

```bash
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
IMAGE="${WIKI_TEST_IMAGE:-opencode-saas-sandbox-test:slim}"
DATABASE="${WIKI_TEST_DATABASE_URL:-postgresql://postgres:ab123456@host.docker.internal:55432/knowledge}"
docker run --rm \
  -v "$ROOT:/repo:ro" \
  -w /repo/packages/knowledge \
  -e "KNOWLEDGE_DATABASE_URL=$DATABASE" \
  --entrypoint bun "$IMAGE" \
  test --isolate --timeout 30000 test/wiki-search-contract.e2e.test.ts
```

2026-10-14 实测：**14 PASS / 0 FAIL**（Docker HTTP/PG，确定性模型，瘦身协议）；与 maintenance 套件合并跑 40 PASS ×3 连跑稳定，各自使用唯一临时 schema。

## 说明与边界

- `navigate` 系列对不存在的 collection 返回 200 空结构（服务层查询空集不抛错），不是 404；本套件按实际行为断言。
- WS04 的外集合概念必须挂在真实 `wiki_collections` 行上（外键）；测试先插临时集合再清理。
- WS07 的重复编译 400 依赖 `pending/running` 窗口：测试用挂起页面生成（holdPage）稳定复现。
- WS10 的 `revision=0` 404 是因为本集合无 legacy 基线；旧库迁移场景由 maintenance WM12 验证。
- WS12 的 `attempt` 断言放在完成态之后；人工重试会重置 attempt（见 maintenance WM19）。
- WS13 复现 Q07 缺陷形态：插入 3 个含核心词的长名概念（同步任务验证/API/写入），断言 `同步任务` 仍排第一；排序加分见 [search.md](./search.md) 机制表。
- lint 语义审查（includeSemantic）需要可用 chat 端点，不在本套件范围。
