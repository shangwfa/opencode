# Wiki 维护机制回归（WM 系列）

## 范围与数据依据

第一阶段实现：先生成全来源候选页，再事务发布正文、元信息、来源和受影响关系。
原文取自 RAG 已有库 `kb_yingdao_harness_zh_cn`：

- `996621057543712768`：同步与重试。
- `996621067853312000`：文档平台同步。

断言锚定已读原文：A 含“任务尚未结束时不要重复发起相同的全量同步。”；
B 含“只对失败文档发起重试，不必重新同步全部内容。”。
测试只在唯一的临时 schema 中复制、修改及删除文档；结束时核对原文未变并清理测试 schema。

模型和 embedding 使用确定性替身；Hono 通过真实 HTTP socket 提供服务，PG 为真实数据库。
此套件验证机制和执行路径，不证明真实模型的忠实度、召回质量或 Agent 答案质量。
不调用 SaaS 会话，因而不涉及 Session SSE 和 Code Mode 的生效验证。

## 用例与结果

| 用例 | 期望 | 实测 |
|---|---|---|
| WM01 首次编译 | 正文、摘要、定义、标签和两篇来源同步发布 | PASS |
| WM02 只更新 A | B 的事实保留；A 撤销事实及旧元信息不沿用；重编前不召回过时页 | PASS |
| WM03 图扩展与预算 | 关联页带正文、来源名及原文链接；topK/includeRelated 生效；首个中文页也不超估算预算 | PASS |
| WM04 页面生成失败 | 保留旧正文与哈希、标记过时；重试重新生成而非跳过 | PASS |
| WM05 跨集合关系 | 即使人为插入跨库边，默认检索不返回外库页或来源 | PASS |
| WM06 来源并发变更 | 模型调用期间原文变化，拒绝发布旧快照 | PASS |
| WM07 PG 发布失败 | 来源插入失败时正文和来源全部回滚；成功草稿数不等于发布数 | PASS |
| WM08 提取格式错误 | 不等同于合法零概念；保留旧来源 | PASS |
| WM09 删除 B | 全库重编清理 B 来源；失效概念标记 no_concepts，清除其全部关系 | PASS |
| WM10 最后来源撤销 | 合法零概念结果撤销来源；旧正文仅留作检查，不再默认检索 | PASS |
| WM11 全提取失败 | failed，不报告 completed | PASS |
| WM12 旧库迁移 | 幂等加列；基线标记 legacy，不伪造历史正文 | PASS |
| WM13 引用查询隔离 | 未验证旧页及旧关系不进入默认召回 | PASS |
| WM14 修订 API | 版本带当时正文、逐段来源和关系快照；集合外不可读 | PASS |
| WM15 伪造引用 | 不存在的 refId 或原文中不存在的 quote 阻止发布 | PASS |
| WM16 来源冲突 | 两份不同文档的证据和双方断言进入待确认页；默认问答不返回 | PASS |
| WM17 PG 任务恢复 | 过期 running 任务被新 claim token 接管；来源哈希匹配的提取检查点复用 | PASS |
| WM18 重试上限 | attempt 达上限的过期任务直接判 failed，不再被领取执行，无模型调用 | PASS |
| WM19 失败任务原地重试 | 状态 `warnings` 列出失败文档与原因（`extract a: no_json`）；`POST /compile/:id/retry` 保留任务 ID，只重做失败文档，已成功即不重复调用；人工重试重置 attempt；完成态拒绝重试 | PASS |
| WM20 页面生成遇限流 | 立即中断批次，不计为页面失败，error 指明限流；恢复后重试成功 | PASS |
| WM21 提取遇限流 | 任务立即失败，限流文档不计为提取失败数 | PASS |
| WM22 增量编译 | 零变更：0 模型调用、revision 不变；改一篇：提取/页面调用各 1 次、仅受影响概念 revision+1 | PASS |
| WM23 操作日志 | 编译事件可查（含统计与 partial 标记）；UPDATE/DELETE 被触发器拒绝；分页校验 | PASS |
| WM24 答案回写 | 伪造引文 400；合法回写入库 needs_review + 修订（answer-filed）+ 日志；默认检索不返回；重编不撤销 | PASS |
| WM25 Markdown 导出 | 含 verified 正文、回写答案标记；集合外 404 | PASS |
| WM26 用户可编辑 schema | 未配置返回默认；非法值/未知字段（含证据规则覆盖）400；配置注入提示词（上限/白名单/风格）并截断；编译记录 schemaVersion；版本递增与恢复 | PASS |
| WM27 schema 页面结构选项 | 关闭 definition/summary：提示词注入禁写指令、字段不生成不兜底（DB 置 NULL）；恢复后兜底回归 | PASS |
| WM28 schema 自动语义 lint | 开启后语义问题进 lintResults 与 warnings；审查失败（限流）记 warning 编译仍 completed；恢复默认 | PASS |
| WM29 页面级语义 lint | 单页超限降级 skipped（info）不放大失败；自动巡检零变更不发起语义调用；手动全量 >50 页 400 引导增量 | PASS |
| WM30 答案升级/归档/反查/diff | approve→compiled 进检索（repeat review 400）；修订 diff 状态与字段对比；文档反查含同步任务；归档排除检索且重编不复活，unarchive 恢复 | PASS |

源文件：[test/wiki-maintenance.e2e.test.ts](../../../test/wiki-maintenance.e2e.test.ts)。

## 内嵌执行脚本

依赖本地 PG、现有 RAG 原文，以及包含 Bun 的测试镜像。数据库地址从 Docker 容器视角配置。
PDF 解析不在本套件范围，替身会在误调用 PDF 时直接报错。

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
  test --isolate --timeout 30000 test/wiki-maintenance.e2e.test.ts
```

2026-10-14：Docker HTTP/PG **31 PASS / 0 FAIL**；Wiki+providers 单测 **166 PASS**；联合回归 **774 PASS / 0 FAIL**。
接口完备性修复（P0~P2）：集合列表 knowledgeBaseId 过滤（曾跨库泄漏）、任务列表（GET /compile?collectionId）、任务取消（fencing 终止）、
答案人工升级（approve/reject）、概念归档/恢复（重编不复活）、文档→概念反查、修订 diff；wiki_schemas 加 FK 级联（删集合清配置）。
真实库验证：列表过滤 1 条且全部归属该 KB、任务历史 7 条含 schemaVersion、反查 6 概念（camelCase）、schema 孤儿 0。
`bun run typecheck` 通过。本轮未运行 Graph 套件。

## 明确边界及后续阶段

- 本轮草稿全成功后批量发布；任何草稿失败都不发布本批，不支持部分页面成功发布。
- `pagesGenerated` 为成功草稿数，`pagesPublished` 才是本轮发布数。
- 索引和 lint 在页面发布后执行；失败记录 warnings，索引失败时不沿用旧索引正文。
- 来源超过现有 30000 字符限制时拒绝静默截断；分层汇编尚待实现。
- 删除来源需要显式全库重编；尚未接入文档变更事件自动触发。
- 逐字引文、版本绑定与冲突双方证据已校验；逻辑蕴含仍需语义审查和人工抽查。
- 旧页面采用 revision=0 legacy 基线，不伪称拥有编译时的历史原文。
- 修订快照保存原始文档内容；生产保留周期与数据规模需单独治理。
- PG 持久任务支持 pending/过期 running 领取、唯一 claim token fencing、心跳续租和恢复扫描；恢复测试确认提取检查点可复用。
- 重试上限 `MAX_ATTEMPTS=5`：达到上限的过期 running 任务由恢复扫描直接判 failed（error=Max compile attempts exceeded），防止毒丸任务被无限接管；失败正常落库的任务不会进入下一轮扫描。
- 任务状态接口透传 `documentId`（单文档模式）与 `attempt`；租约丢失（fencing 预期）与真实编译失败分级记录日志（warn/error）。
- 提取失败按原因分类（`truncated` 输出预算耗尽、`no_json`、`invalid_output`、`llm_error`），写入任务 `warnings`，日志只记元数据不记正文。
- 供应商速率限制（错误码 1302）不属于内容失败。限流错误（429/1302/速率限制文案，含 cause 链识别）在提取与页面生成两处**快速失败**：立即中断批次、不计为内容失败、任务 error 指明限流；已成功页面的检查点保留，恢复后原地重试。
- **瘦身协议**：页面证据由模型指认（blockIndex + 原文开头 5~15 字锚点），服务器从源材料 manifest 回填完整引文与 refId 并校验锚点真实存在；旧协议（refId+quote）向后兼容。单页输出量约降至原来的 1/5~1/10（实测约 3 秒/页）。
- **部分发布**：页面生成尝试 ≥10 且顽固失败页 ≤5% 时发布成功页，失败概念标记 failed 不产新修订；小批量（<10 页）仍整批失败（保护测试语义）。系统性失败（限流）由快速失败先行拦截。
- 并发恒定不再按 attempt 递减（限流已由快速失败保护）；人工重试重置 attempt（MAX_ATTEMPTS 上限仅约束恢复器自动接管）。
- chat 模型可走影刀内网会话代理（`KNOWLEDGE_LLM_CHANNEL=inner`，模型按 `provider/model-id` 前缀路由渠道 openai/azure/deepseek/qwen/chatglm，见 `providers/conversation-proxy.ts`）；Bun fetch 需小写 `no_proxy` 含内网主机。
- 检查点按任务和来源哈希保存，成功后删除；失败时保留。人工重新创建新任务不会跨 task 复用失败任务的 checkpoint。
- `startRecovery()` 已在独立知识服务 app 初始化时启动；挂载进 SaaS 的集成方须确保启动该 service recovery worker。
- 仍需在真实多 pod 部署中演练进程强杀、PG 短暂不可用、租约续期失败与高并发竞争；当前 HTTP/PG 测试模拟过期租约接管，不替代 K8s 故障演练。

测试时发现各域并发创建新 schema 会输出命名空间唯一约束警告。
本套件先创建自有 schema 再启动各域；未修改其它业务域的初始化逻辑。
