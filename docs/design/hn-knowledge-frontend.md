# hn-knowledge 知识库前端技术方案

状态：待评审，仅设计，未实现。目标是为 `packages/hn-knowledge` 的后端能力设计前端（hn-app 内新增「知识」板块），参考同类产品的成熟交互。完整线框图见 [hn-knowledge-wireframes.md](hn-knowledge-wireframes.md)。

## 1. 概念模型（先对齐）

**数据源定数据，检索能力定用法**：

```
知识源（创建知识库时二选一）
├── 文档库：用户编写/上传的详细文档（doc-platform 写作 + 上传/同步）
│     └── 支持全部后处理方式，默认启用 RAG，用户按需开启：
│         RAG（vector/keyword/hybrid/metadata）· GraphRAG（图谱）· LLM-Wiki（概念化）
└── 结构化数据：数据表（字段 schema + 行 + 向量列）
      └── 混合检索（关键词+向量+filter）· 图检索（行/关系建图）
```

- **RAG**：向量/关键词/混合/元数据召回 + HyDE/多查询/rerank；文档库**默认开启**，是基础检索方式。
- **GraphRAG**：文档摄取时抽取实体/事件建图，提供图谱检索（子图/邻域/路径/溯源）。文档库**可选开启**。
- **LLM-Wiki**：把文档语料概念化成 Wiki（编译/概念/修订）。文档库**可选开启**。
- **结构化数据的检索**：混合检索（关键词 + 向量 + 条件过滤）与图检索（基于行与关系字段建图）；不做文档切分/Wiki。
- 后处理方式不是"库类型"，而是知识源创建后**按需启用的检索/加工管线**；启用后在该知识库下出现对应入口，任务进任务中心。用户可随时在库配置里调整启用组合。

## 2. 能力盘点（后端已有，前端设计的依据）

hn-knowledge 是独立 Hono 服务，六大模块 + 检索工具集：

| 模块 | 路由前缀 | 已有能力 |
| --- | --- | --- |
| 文档知识库（RAG） | `/knowledge-base`、`/base-knowledge` | KB CRUD；文档上传（file/text/metadata）、chunk 策略配置；文档/分块查询；搜索（vector/keyword/hybrid/metadata，HyDE、多查询、recall、rerank=llm/mastra/cohere/zeroentropy/simple、时间衰减、metadata filter）；API Spec 导入；yydoc / doc-platform 同步任务、失败重试 |
| LLM Wiki | `/llm-wiki` | Collection CRUD、编译任务（进度/取消/重试）、概念树导航、概念详情、搜索、lint、修订历史 + diff、答案生成/review、归档、schema 编辑、导出、活动日志 |
| 知识图谱 | `/graph` | 文档摄取（实体/事件抽取、合并管线、矛盾检测、时序冲突、真值子空间）、搜索、统计、节点关系浏览、subgraph/neighborhood/paths、边溯源、relation-types |
| 数据表 | `/database` | 表 CRUD、行 CRUD/批量、行检索（含查询接口）、向量列 query/upsert、filter |
| 文档平台 | `/doc-platform` | 文档树、块读写、资源上传会话、OSS blob 上传、菜单/搜索壳、同步 worker |
| 检索工具 | `tools/*` | unified-search、多库检索、graph-query、wiki-search、vector-query（可挂 MCP） |

检索响应已包含调试信息：`score`、`recallStage`、`reranked`、`documentId`、`chunkIndex`、`metadata`——这是「召回测试台」的数据基础。

## 3. 同类产品借鉴

| 产品 | 借鉴点 | 对应我们的页面 |
| --- | --- | --- |
| 语雀 / 飞书知识库 / Notion | 文档树 + 大纲 + 块编辑器，目录即导航 | Wiki、文档平台 |
| Dify / FastGPT / Coze 知识库 | 分段预览、**召回测试**（Top-K + 分数 + 命中分段 + 模式切换）、分段规则可视化 | 文档库详情 |
| Glean / Perplexity | 统一搜索入口，结果带来源引用与高亮，可跳回原文 | 全局搜索 |
| Gumloop Brain | 连接器同步源、索引状态、pending approval、按来源粒度启停 | 同步源管理、Agent 接入 |
| GitBook | 版本 diff、发布/草稿态 | Wiki 修订历史 |
| Obsidian / Heptabase | 图谱浏览、邻域展开、从图谱跳原文 | 知识图谱 |
| Airtable / Notion 数据库 | 表格视图、筛选、批量操作、字段类型 | 数据表 |

## 4. 信息架构

新增全局导航「知识」`/knowledge`：

```
/knowledge                       总览：统计、最近活动、全局搜索入口
/knowledge/bases                 知识库列表（卡片/网格）
/knowledge/bases/:id             文档库详情：文档列表 + 分段预览 + 召回测试
/knowledge/bases/:id/docs/:docId 文档详情
/knowledge/wiki                  Wiki：Collection 列表 + 编译任务
/knowledge/wiki/:id              Wiki 阅读/编辑：概念树 + 概念详情 + 修订
/knowledge/graph                 图谱浏览与检索
/knowledge/tables                数据表列表
/knowledge/tables/:id            表格视图 + 自然语言查询
/knowledge/tasks                 同步/编译/索引任务中心
```

### 4.1 总览

- 统计卡：知识库数、文档数、分块数、待索引/失败数、图谱实体/关系数。
- 全局搜索框（unified-search）：跨库/Wiki/图谱搜索，结果分组（文档 / 概念 / 实体），带分数、来源引用、命中片段高亮，点击跳转到对应详情锚点。
- 最近活动：同步任务、编译任务、文档更新（数据来自 sync-task 状态与 wiki activity log）。

### 4.2 知识库列表

- 卡片视图（参考 Dify）：名称、数据源类型、启用能力徽标（RAG/GraphRAG/Wiki 或 混合/图检索）、文档/分块数、最后同步时间、状态徽标。
- 创建向导：① 数据源类型（文档库 / 结构化数据）→ ② 数据源配置（文档库：切分策略/嵌入模型；结构化：字段 schema/向量列）→ ③ 启用检索与后处理（文档库默认 RAG，可加 GraphRAG、LLM-Wiki；结构化：混合检索、图检索）。
- 每卡菜单：重命名、库设置（含能力启用组合调整）、同步源管理、删除（二次确认 + 影响提示）。

### 4.3 知识库详情 · 文档库（核心页）

Tab 按启用能力显隐：文档 | 分段&召回测试 | 图谱(GraphRAG) | Wiki | 任务。默认三栏：文档列表（左）｜分段预览（中）｜配置/测试（右）。

- 文档列表：搜索、状态筛选（已索引/索引中/失败）、批量删除、拖拽上传、粘贴文本、URL、API Spec 导入。
- 文档详情：预览 + chunk 分段预览（`chunk-list`/`chunk-get`），每段显示 token/字符数、向量化状态、所属文档元数据；支持编辑元数据。
- **召回测试台**（重点功能）：
  - 输入 query；切换 vector / keyword / hybrid / metadata 模式；
  - 展示 Top-K 结果卡片：分数、命中分段全文、documentId/chunkIndex、元数据标签；
  - 高级开关：HyDE、多查询、rerank 模型选择、recallTopK/rerankTopK、时间衰减、metadata filter；
  - 展示管线耗时与阶段标记（`recallStage`、`reranked`），rerank 前后排序对比；
  - 支持保存测试用例集，回归对比（同一 query 在参数调整前后的命中变化）。
- 分段规则面板：切分策略、chunk 长度分布直方图、重叠设置。

### 4.4 Wiki（文档库可选后处理能力，库内 Tab）

- Wiki 概览：编译任务进度条（进度/取消/重试）、概念数、lint 问题数。
- 阅读视图（参考 GitBook/语雀）：左侧概念树（navigate）、中间 Markdown 渲染、右侧大纲 + 引用来源。
- 概念详情：答案 review、归档/恢复、修订历史列表 + diff 视图（`revisions/:revision/diff`）。
- lint 报告面板：问题列表 → 跳转概念；schema 编辑（高级，JSON 表单）；导出。
- 搜索：wiki-search 结果带概念路径与命中片段。

### 4.5 图谱（文档库 GraphRAG / 结构化 图检索，库内 Tab）

- 图谱画布（力导向）：节点按类型着色、大小按度数；点击节点 → 邻域展开（neighborhood）、右侧面板显示属性/关系/溯源（edges/provenance 回到原文 chunk）。
- 工具条：搜索定位、relation-types 筛选、subgraph 选择、paths 起终点查询、缩放/居中、布局切换。
- 统计侧栏：实体/关系类型分布（graph-stats）。
- 大图性能：>2k 节点默认降采样/分层加载，提供「聚焦子图」而非全图渲染。

### 4.6 知识库详情 · 结构化数据

- 检索模式切换：混合检索（关键词+向量+filter）｜图检索（行/关系建图）｜NL 查询（`rows-search`/`query`，条件回显）。
- Airtable 风格表格：行编辑、批量选择/更新/删除（batch 接口）、列筛选（filter）、排序。
- 向量列：upsert/query 面板（高级功能）。

### 4.7 任务中心与 Agent 接入

- 任务中心：同步任务（yydoc/doc-platform）、Wiki 编译、索引向量化；状态、进度、失败明细、单条/批量重试。
- Agent 接入：知识库作为 agent 可用知识源的挂载开关（对应 `tools/*` 检索工具），显示调用统计；参考 Gumloop Brain 的「连接一次、agent 可搜」。

## 5. 技术实现

### 5.1 架构

复用现有链路：`hn-app`（React + Tailwind + shadcn 风格组件）→ `hn-base-server`（BFF，REST + 权限）→ `hn-knowledge`（独立服务）。

- hn-base-server 新增 `/api/knowledge/*` 路由族，代理到 hn-knowledge，注入用户/组织归属；**不**让前端直连 hn-knowledge。
- 权限：接入现有 `assertPermission` 与 `relation_tuple`；`RESOURCE_TYPES` 增加 `knowledge_base`、`wiki_collection`、`data_table` 动作（read/write/manage）。组织自定义角色可直接表达「谁能看哪个库」。
- 服务发现/地址：hn-base-server 侧配置 `KNOWLEDGE_URL`；健康探测失败时前端显示降级提示（连接器板块已有同类模式）。

### 5.2 前端技术

- 路由：react-router，新增 `pages/knowledge/*`，与 connectors 页面同构（列表 + 详情 + 弹窗）。
- 数据层：`base-api.ts` 增加 `knowledgeApi`，分页用游标；搜索请求防抖 300ms + 取消（AbortController）。
- 图谱可视化：P1 先用 `d3-force` + SVG（可控、无重依赖），交互为邻域展开；性能验证后再评估 `force-graph`/WebGL。**不**引入 Neo4j Bloom 级重型方案。
- 表格：TanStack Table（若引入成本可接受）或现有 table 组件扩展；行内编辑 + 批量操作条。
- 编辑器：文档/Wiki 预览用 Markdown 渲染（tiptap-static-renderer 已在依赖中）；块编辑（doc-platform blocks）P2 再做，先只读 + 元数据编辑。
- 上传：multipart + 进度条，复用 `resource-upload-sessions`/OSS blob 上传；大文件分片由后端能力决定，前端预留进度 UI。
- 状态：轻量 hooks + 缓存失效（现有 pattern），不引入 Redux。

### 5.3 性能与体验

- 文档/分块列表虚拟滚动（长列表）。
- 搜索结果服务端分页；召回测试限 TopK ≤ 50。
- 图谱默认抽样；邻域展开按需请求。
- 所有破坏性操作二次确认 + 影响面提示（删除库会连带文档/分块/向量）。

### 5.4 测试与验收

- hn-app 纯逻辑单测：搜索参数构造、筛选、树导航、diff 渲染等（沿用 connectors.test.ts 模式）。
- 浏览器验收：创建库 → 上传文档 → 索引完成 → 召回测试命中 → 跳转原文；Wiki 编译 → 概念浏览 → diff；图谱节点 → 溯源。
- PG 后检：文档/分块/向量行数、删除级联、任务状态流转。
- 搜索质量：沉淀 query 用例集（参考 `docs/use-cases/rag/evaluation-rubric.md`），作为回归基线。

## 6. hn-docs 融合方案

hn-docs 是 Next.js 14 文档平台前端（面向读者/编辑者：帮助中心、文档站），与本方案的「知识工程台」（面向管理员/开发者/Agent）是**同一知识源的两个消费入口**，不应合并成一个 SPA。

### 6.1 hn-docs 已有能力

- **文档树与菜单**：DocumentAdd / DirectAdd / AliasSetting / QuickStart、面包屑、多语言（zh-CN/en-US）、移动端（MobileDoc）。
- **XybotEditor**：Tiptap 富文本编辑器，一级 blockId（`blk_<uuid>`）寻址，draft/publish 双态，分享、图片预览、文档同步、上传。
- **AI Search**：流式回答（StreamdownRenderer）+ **FilesSource 来源引用卡片**。
- **SearchPortal / SearchResult**、LearningCenter（教程/工单/学院）、BookAiAssistant。
- **book-open API + MCP**（`/yddoc/api/open/v1`、`/yddoc/api/mcp`）：文档树/文档/blocks CRUD、启停、资源上传、`list_documents`/`get_document`/`create_document`/`update_document`/`get_block`/`update_block`/`set_document_enabled`/`delete_document`/`create_resource_upload`。
- **微前端能力**：`@micro-zoe/micro-app` + `micro-app-runtime.ts`（具备嵌入能力，但本方案**不采用嵌入**，两前端独立）。

关键事实：hn-knowledge 的 `doc-platform` 模块即 book-open 服务端迁移；`publishMode=publish` 会触发知识库 upsert——**hn-docs 内容进知识库的通道已经打通**。

### 6.2 分工与融合点

| 关注点 | 入口 | 融合方式 |
| --- | --- | --- |
| 内容生产（编辑/发布/分享） | hn-docs | 不重写编辑器；hn-app 提供「在文档平台中打开」跳转 |
| 内容消费（阅读/AI 问答） | hn-docs | AI Search 引用来源与召回测试台共用「来源引用卡片」规范 |
| 知识资产管理（索引/召回测试/图谱/Wiki/数据表/任务） | hn-app「知识」 | 本方案主体 |
| 同步链路 | doc-platform → KB | 任务中心展示 publish→upsert 任务；同步源管理页展示 doc-platform 来源 |
| Agent 工具 | book-open MCP + 检索工具 | 「Agent 接入」页并列展示，均可挂载 |
| 文档树数据结构 | menu.ts / document-tree | 前端树组件设计共享 |

### 6.3 融合方式（已定）

**两个前端系统保持独立，只把产品业务串起来**：不做微前端嵌入、不做合并。hn-docs 管内容生产/消费，hn-app「知识」管知识资产/调试/治理，通过跳转、API 互通、共享数据契约衔接：

1. **跳转串联**：hn-app 文档详情提供「在文档平台中打开」（带文档/块定位参数）；hn-docs 反向提供「知识库索引状态」入口回 hn-app。
2. **API 互通**：hn-app 经 hn-base-server BFF 读 doc-platform 元数据（树/文档/块/启停状态）用于展示索引与同步状态；写操作（编辑/发布）一律跳 hn-docs 完成，hn-app 不做块编辑。
3. **共享契约**：文档树、blockId、来源引用卡片的数据结构两边对齐（book-open API 为准）；AI Search 引用卡片与召回测试台结果卡片字段统一（documentId/chunkIndex/命中片段/分数）。
4. **链路贯通**：publish→upsert 任务在 hn-app 任务中心可见可追溯；Agent 接入页并列挂载 book-open MCP 工具与 hn-knowledge 检索工具。
5. **鉴权**：跳转携带一次性 ticket 或共享会话（具体方案见风险），链接直达目标文档/块。

### 6.4 分期调整

- P0：文档库详情「在文档平台中打开」跳转；任务中心显示 doc-platform 来源。
- P1：Wiki + 任务中心。
- P2：文档详情只读预览 + 跳 hn-docs 编辑（不自研块编辑、不嵌入）；来源引用卡片字段对齐。
- P3：Agent 接入把 book-open MCP 工具 + hn-knowledge 检索工具一起挂载；反向入口（hn-docs → hn-app 索引状态）。

### 6.5 融合风险

1. **鉴权打通**：hn-docs 用 Boss token（`Authorization: Bearer`），hn-app 用 hn-base-server 登录态。两个系统跳转需要免登（ticket 互认 / 统一 SSO / 网关注入），这是串联体验的关键前置。
2. 跳转定位：深链到具体文档/块的 URL 约定需两边共同定义并保持稳定。
3. 两套设计语言（antd / Tailwind）并存，不做统一；跳转处明确「离开知识台进入文档平台」的上下文提示，避免用户迷失。
4. 移动端/多语言是 hn-docs 独有能力，hn-app 侧不覆盖，边界保持清晰。

## 7. 分期

| 期 | 范围 | 交付判据 |
| --- | --- | --- |
| P0 | 总览、知识库列表/创建（数据源 + 能力启用）、文档上传与分段预览、RAG 检索、**召回测试台** | 浏览器端到端跑通一次检索调试 |
| P1 | LLM-Wiki 能力页（树/概念/修订 diff/lint）、任务中心 | Wiki 编译到阅读闭环 |
| P2 | 图谱能力页（文档库 GraphRAG + 结构化图检索，浏览/溯源）、结构化数据视图（混合检索/NL） | 图谱邻域+溯源跳转；表格批量编辑 |
| P3 | Agent 挂载、协作/权限细化、搜索质量评估与用例回归 | 挂载后 agent 检索命中 |

## 8. 风险与开放问题

1. **hn-knowledge 部署形态**：独立服务还是并入 base-server？前端方案不依赖该决定，但 BFF 需要稳定地址与鉴权打通（hn-knowledge 现有 auth 机制需确认）。
2. 图谱大图渲染性能未实测；2k 节点是预估阈值，需压测后定。
3. 向量检索依赖 pgvector 与嵌入模型配置；多模型（`embeddingModel`）选择 UI 需与后端配置一致。
4. 词表/概念命名（wiki schema）是开放编辑还是受控，影响 Wiki UI 复杂度。
5. `docs/use-cases/*` 中的验收契约（search-contract、graph-browse-contract 等）应作为前端字段来源，实现前逐条核对响应结构。
