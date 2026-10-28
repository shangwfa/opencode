# llm-wiki 用例索引（e2e）

> `packages/knowledge` Wiki 业务域（概念编译 · 检索 · 导航）的全链路 e2e 用例。
> 数据源使用 **RAG 已有文档库** `kb_yingdao_harness_zh_cn`（36 篇影刀 Harness 文档）。
> 变更测试仅复制原文到临时 schema；不修改或删除真实库。
> 用例编号全局唯一（`WM*`/`WS*`），跨文件引用不断链；判定规则遵循 [../rag/evaluation-rubric.md](../rag/evaluation-rubric.md)：
> 期望先行、确定性断言优先、环境阻塞记 BLOCKED/SKIP 不伪造、证据落盘可复现。

## 环境分层（关键）

Wiki 编译依赖 **LLM**；机制回归与真实模型效果评估分开判定。

| 环境 | 编译行为 | 用例范围 |
|---|---|---|
| 模型调用失败 | 提取或页面草稿失败时终态 `failed`，不发布本轮页面 | 失败保护、重试及计数 |
| 确定性测试模型 | 原文复制 + Docker 中真实 HTTP + PG | 维护机制、HTTP 契约、隔离、预算与执行路径 |
| 真实模型 | 实际知识编译与问答 | 原文忠实度、事实完整性和检索效果；本轮未重测 |

## 文件目录

| 文件 | 用例段 | 覆盖内容 | 实测 |
|---|---|---|---|
| [maintenance.md](./maintenance.md) | WM01~WM30 | 全来源维护、证据/修订/冲突、隔离、租约/检查点、失败治理、增量编译、日志、答案回写与升级、归档、导出、schema、页面级语义 lint | **31 PASS / 0 FAIL**（Docker HTTP/PG，确定性模型） |
| [search.md](./search.md) | S01~S17 | 检索行为：词法命中与分词、可见性与来源新鲜度、图扩展、预算裁剪、证据回溯（非向量检索，RAG 检索矩阵不适用） | 单测 29 PASS；S05/S06/S07/S10/S13/S14/S17 由 e2e 覆盖；S01/S03/S04 待补 e2e |
| [questions.md](./questions.md) | Q01~Q13 | 多样化问题类型（沿用 RAG V 系列原文与事实）改为 Wiki 概念页检索：概念覆盖与命中分开判定 | **13 PASS / 0 FAIL**（2026-10-14，azure/gpt-5.5 编译，175 verified 概念；Q07 排序缺陷已修复） |
| [search-contract.md](./search-contract.md) | WS01~WS14 | HTTP 契约矩阵：search 参数边界/空态/隔离/预算分配/精确名排序、compile 状态机与任务透传、concepts/navigate/lint（含语义）、revisions 分页与版本边界 | **14 PASS / 0 FAIL**（Docker HTTP/PG，确定性模型） |
| [collection-compile.md](./collection-compile.md) | WL01~WL10 | 历史探针与已发现的断言缺陷 | 已停用，不作为验收证据 |

## 已知覆盖缺口（未脚本化，按需补充）

1. 多 pod 故障演练（进程强杀、PG 短暂不可用、租约竞争）：WM17 只覆盖单实例内的过期租约接管。
2. 手动全量语义巡检的异步任务化（>50 页的大库）：当前 400 引导走编译自动增量巡检。
3. 接口权限/多租户鉴权：服务层无鉴权，由 SaaS 层统一管控（部署边界，非本包实现）。
4. schema 版本历史查询接口：活动日志（schema_updated 事件含完整 config）可兜底。

