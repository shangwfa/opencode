# RAG 用例索引（e2e）

> `packages/knowledge` 文档类知识源的全链路 e2e 用例。结构化数据（表问答）见 `test/database-e2e.test.ts`，
> 图谱见 `src/graph/e2e/`，不在本目录范围。
>
> 用例编号全局唯一（`R*`），跨文件引用不断链；全部断言基于 2026-10 实测行为，执行不符记 `FAIL`。
> **测试脚本直接内嵌在各 md 文件中**（bash + curl + psql），整块复制到终端即可执行，结尾输出 PASS/FAIL 汇总。

## 文件目录

| 文件 | 用例段 | 覆盖内容 | 实测 |
|---|---|---|---|
| [base.md](./base.md) | R1~R3、R6、R9 | 生命周期、入库通道（含文档管理/chunk 接口、pdf/docx）、分块策略、更新删除、PG 一致性 | 49 PASS / 1 SKIP |
| [search.md](./search.md) | R5、R10.1~R10.2 | 检索矩阵（三类型×融合全枚举×重排×召回×filter×minScore×HyDE/多查询×ef/probes×topK 边界）与降级 | 39 PASS |
| [embedding.md](./embedding.md) | R4、R10.3 | 向量化通道（标准 / inner）、重试与并发、no_proxy 防御 | 4 PASS / 1 SKIP |
| [sync-yddoc.md](./sync-yddoc.md) | R7 | 影刀同步（主/单篇/doc-platform 三通道、任务状态机、幂等、retry、错误路径） | 17 PASS |
| [base-knowledge.md](./base-knowledge.md) | R8 | base-knowledge（409 幂等、version 递增、tiptap 对象、excludeDocumentIds、timeoutMs 边界、ns 自动清理） | 21 PASS |
| [user-scenarios.md](./user-scenarios.md) | U01~U16 | **用户视角**：以已有影刀 Harness 真实文档库为数据，12 个真实问句 × semantic/hybrid 验证关键事实与来源，外加知识库隔离、分类过滤、范围外问题观察、PG 只读一致 | 18 PASS / 9 FAIL（缺陷 A/B 均已修复；剩余为排序与分块质量观察）/ 1 OBSERVE |
| [various-questions.md](./various-questions.md) | V01~V13 | **问题类型多样化**：数字限制、口语改写、流程步骤、英文工具名、条件选择、角色权限、概念定义、否定排除、版本要求、API 细节、极短查询 | 21 PASS / 4 FAIL（含"一事实多文档"断言边界的诚实记录） |
| [full-coverage.md](./full-coverage.md) | W01~W16 | **36 篇全量覆盖·读者角色版**：按平台用户/接入开发者/方案借鉴者/运营维护者四类真实读者场景造问句（口语化、与原文词汇重合低，难度最高） | 17 PASS / 14 FAIL（全部归因为排序与分块质量观察；含 hybrid 词法信号双刃剑案例） |
| [can-answer-judge.md](./can-answer-judge.md) | L3 判官 | **can-answer@5**：经 opencode saas（glm-5.3）判定 79 项检索结果"仅凭前 5 条片段能否回答用户问题"，输出 L2×L3 对照矩阵 | can-answer@5 = 81%（初测，未经人工校准抽检）；L2✓L3✗=0、L2✗L3✓=13（等价证据/拼接可答占 L2 失败 46%）、真失败 19% |
| [evaluation-rubric.md](./evaluation-rubric.md) | 评估准则 | **四层判定体系与指标基线**（L1 机制/L2 召回/L3 可答/L4 无害）、判官协议与三步校准（重复稳定性/顺序敏感/分歧抽检）、MRR 与统计效力声明、复现步骤与变更规则 | 全体系准则文档（检索质量回归的规范依据） |
| [metadata-search.md](./metadata-search.md) | M01~M10 | **元信息检索与组合能力**：纯元信息召回（searchType=metadata）、任意检索 × filter 组合、hybridWeight×fusionMethod 权重契约、管理面文档元查询、越库隔离 | 24 PASS |
| [agent-rag.md](./agent-rag.md) | Agent RAG | **Agent 版 RAG 管道**：Session Agent 承担分词→检索→证据筛选→生成（V2 agents 契约、沙箱检索通道、与页面 RAG 模式分工） | 端到端 35s 跑通，回答有据引用 |

> SKIP 均为已知实现限制（html 策略 sections 未透传）或环境条件（暂无向量表），非失败。

## 已知覆盖缺口（未脚本化，按需补充）

1. MCP `kb-document-search`（stdio / Streamable HTTP）与 Agent 工具层（`src/tools/*` 六个检索工具）——工具/协议层，建议独立用例文件。
2. 并发场景（并发同步/写入/检索）、同步失败→retry 恢复链路（需故障注入）。
3. filter 高阶运算符（`$ne/$nor/$size`/深嵌套）HTTP 层只测高频子集，完整语义见 `test/vector-filter.test.ts`。

## 共享运行环境

脚本面向**已启动的知识服务**执行（真实或 mock 向量环境均可），默认连本机：

```bash
# 启动服务（示例：inner embedding 通道）
KNOWLEDGE_PORT=18787 \
KNOWLEDGE_DATABASE_URL=postgresql://postgres:ab123456@127.0.0.1:55432/knowledge \
KNOWLEDGE_EMBEDDING_CHANNEL=inner XYBOT_AI_BASE_URL=http://xybot-appreciation:8080/api/appreciation/v1 \
XYBOT_USER_HEADER='{"name":"...","tenantUuid":"...","uuid":"..."}' PROXY_BIZ_CODE=... PROXY_BIZ_ID=... \
bun run src/server.ts

# PG（脚本内 docker exec 断言数据一致性）
docker run -d --name knowledge-pg -p 55432:5432 -e POSTGRES_PASSWORD=ab123456 pgvector/pgvector:pg16
```

可用环境变量覆盖脚本默认值：`BASE`（默认 `http://127.0.0.1:18787/api`）、`PGC`（容器名）、`PGDB`、`SCH`（schema）。

## 判定语义

- 每条用例输出 `PASS <编号> <描述>` / `FAIL <编号> <描述> expect=[..] got=[..]`，结尾汇总并以 fail 数作为退出码。
- 环境阻塞（服务未起、PG 未起、内网代理不可达、外网不可达）不计 FAIL：相应用例标注 SKIP 条件，**不得伪造通过**。
- 模式 B（inner 真实链路）的自动化用例在 `test/sync-inner-e2e.test.ts`，由 `KNOWLEDGE_INNER_E2E=1` 显式开启。

## 实测注意（踩过的坑，执行前先读）

1. **KB id 一律取服务端返回值**：`normalizeIndexName` 会连字符转下划线且**整串转小写**（`zh-CN` → `zh_cn`），自行拼接会 404（R1.5）。
2. **重复文档 id 是 400 冲突，不是 upsert**（R2.6）；**base-knowledge 同 id 同内容重复创建是 409**（R8.2）。
3. 两个命名空间响应字段不同：knowledge-base 检索为 `data.results`，base-knowledge 检索为 `data.items`。
4. **Bun fetch 仅识别小写 `no_proxy`**（支持运行时修改）；本机有 HTTP(S)_PROXY 时内网主机会被代答成 502——server 启动已自动注入（R4.4），手工起进程时仍需注意。
5. **全量测试与容器/环境变更禁止并行执行**（曾因同时 `docker start` 导致 53 个批量假失败）。
6. 新增/变更检索行为时：先在对应文件补用例编号，再改代码（工程约定：先补测试再改行为）。
