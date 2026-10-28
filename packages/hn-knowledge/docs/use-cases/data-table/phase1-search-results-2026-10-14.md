# 第一批落地结果：检索执行正确性

日期：2026-10-14。已修改业务检索编排；**不是多策略目标的全部完成**。

## 已完成

- 默认 hybrid 不再进入 semantic 的多阶段分支，实际调用 HybridSearchService 执行两路召回与融合。
- semantic 现有增强路径保留；keyword 和 hybrid 暂未支持的多阶段／扩展／HyDE／多查询组合显式 400，不默默执行成别的检索类型。
- 混合权重使用空值默认，0 不再被覆盖；全零权重在召回前拒绝。
- POST 检索新增 `data.execution`：有效 strategy、混合配置、两路结果数和是否实际融合。纯过滤为 sql-filter；过滤空候选为 none。
- GET query 仍返回数组；selectFields 与旧 items 契约保留。
- 新增物理索引注册表只读碰撞扫描，没有改名、DROP 或迁移存量索引。

execution 的 hybridWeight 是应用默认值后的传入配置，不是最终 score；rrf 不消费权重。branchResults 是各路融合前候选数，fusionApplied=false 可以表示有一路无结果，不代表两路未被调用。当前信息不能区分底层依赖故障与底层自行降级为空，这仍是后续工作。

## 已支持和暂未支持

| 检索模式 | 本批保证 | 增强能力 |
|---|---|---|
| semantic | 向量检索路径 | 原有多阶段、查询扩展、HyDE、多查询保留 |
| keyword | 真正词法检索 | 本批未实现词法扩展；请求增强显式拒绝 |
| hybrid | 真正两路与融合 | weighted、rrf、weighted-rrf、hybrid；增强组合本批未实现 |

多策略支持仍是最终目标。row / field / group / row+field 索引、exact / ANN / auto 调度、记录级聚合、可靠任务和来源导入均尚未落实，不能声称这些已经支持。

## 测试证据

| 测试 | 结果 | 证据含义 |
|---|---|---|
| 修改前的目标单测 | 11 pass / 14 fail | 先复现默认混合、零权重及非法组合问题 |
| `bun test src/data-table` | 39 pass，138 assertions | 3 文件，含检索编排及身份扫描纯逻辑 |
| `bun test test/data-table-audit-probes.test.ts` | 9 pass，20 assertions | 3 条已改成目标回归；其余仍刻画未解决问题，不作为生产门禁 |
| 四份文档脚本 | 150 PASS / 0 FAIL / 0 SKIP | lifecycle 43、rows 47、search 47、vectors 13 |
| 新 HTTP/PG 契约矩阵 | 21 pass，84 assertions | 四种融合、两种零权重、拒绝组合、GET 兼容、PG 前后不变及清理 |
| `knowledge` 注册表只读扫描 | 8 个注册 owner，0 碰撞 | 仅该 schema 当前注册表，不能否认机制潜在碰撞 |
| 测试清理后 PG | registry 0；本轮动态行／向量表 0 | 只清理本轮数据集，不删除他人残留 |
| `git diff --check`（本批文件） | 通过 | 无新增空白格式错误 |

### Docker 环境与限制

- 知识服务与 mock embedding 都在 oven/bun:1.3.14 Linux arm64 容器中运行。
- 知识服务端口：18887；embedding：18888。PG 为现有 knowledge-pg，schema 为独立的 `knowledge_dt_phase1_20261014`。
- 首次挂载宿主机 node_modules 时 PDF.js 缺少 Linux 原生 canvas，报 DOMMatrix 未定义。测试容器另装真实 Linux @napi-rs/canvas 并 preload 标准图像对象；没有修改 npm 包代码，没有 mock HTTP、PG 或检索服务。
- embedding 为确定性伪向量，不是实际语义质量评测；没有验收 PDF 路径。
- 独立知识服务测试不经过 SaaS 会话，因此未测 Code Mode 或会话 SSE；没有伪造会话执行证据。

### 最终类型检查阻塞

本批开始后两次 `bun run typecheck` 曾通过。最后一次出现当前工作区其他模块的 5 条错误：

- `src/llm-wiki/services/wiki-activity-log.service.ts` 引用未导出的 wikiActivityLog。
- `src/llm-wiki/services/wiki-compilation-plan.ts` 重复 concepts、未定义 conceptsAll 及隐式 any。

本批未修改这些文件；最终全包类型检查**未通过**。最后的错误列表没有 data-table 项，不等于可以替代全包检查通过。

另有独立 schema 首次创建时的重复初始化 pg_namespace 竞争日志；服务最终健康并完成测试。初始化问题本批未修复。

## 更严格的脚本

- DT25c 新增两路结果与 fusionApplied 断言。
- DT33 不再用 min(len, topK) 掩盖越界。
- 四份脚本响应文件使用独立临时目录；py 将历史路径字面量映射到本轮 RES 文件，避免共享响应文件。
- 两个空值不能相等即算 PASS；不隐藏 JSON／PG 错误。
- 移除了“两小时前所有 rd_dt_*”的宽泛删除；仅 trap 清理脚本创建的数据集。
- embedding 探针失败默认 FAIL；只有调用方已确认环境故障并显式设置 DT_ALLOW_EMBEDDING_SKIP=1 才允许相关 SKIP。
- DT06 的数量断言改为诚实描述：数量不变不能单独证明未重算。后续需补调用次数／任务 hash 证据。

## 复现入口

单测：在 packages/knowledge 下分别执行 `bun test src/data-table` 和 `bun test test/data-table-audit-probes.test.ts`。

新 HTTP 契约文件：`test/data-table-search-contract.e2e.test.ts`。需显式启用 KNOWLEDGE_DATA_TABLE_HTTP_E2E=1，并设置 KNOWLEDGE_DATA_TABLE_BASE_URL、KNOWLEDGE_DATABASE_URL 和独立 knowledge_dt_* schema。缺省不启用，避免无意连接或修改数据。

只读扫描：`script/audit-data-table-indexes.ts`。需显式设置 KNOWLEDGE_DATABASE_URL；schema 可由 KNOWLEDGE_DATABASE_SCHEMA 指定。碰撞退出码 1，运行失败退出码 2。

本轮原始日志：`/private/var/folders/zk/8qd0lv657wn8kvpp__hwjj400000gn/T/opencode/dt-usecase/phase1-{lifecycle,rows,search,vectors}.log`；最终类型检查日志位于同一临时根目录的 `dt-phase1-typecheck.log`。

## 下一步

先落实不可变 storageId、新索引身份与存量迁移，再做 PG 索引任务／版本发布。不能把当前 0 碰撞当作机制已安全，也不能把只读扫描当成隔离修复。字段多策略和导入能力随后按优化方案推进。
