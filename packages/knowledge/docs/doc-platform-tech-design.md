# 文档平台(doc-platform)技术方案 v2

> 状态:**待评审,未实现**
> 修订:v1 基于品牌文档站模型;**v2 按产品定位重写 —— hn-docs 是多租户知识库产品**
> 关联:[架构对齐结论](./doc-platform-alignment.md) · [接口差距分析](./hn-docs-api-gap.md)

## 0. 修订记录

| 版本 | 变化 |
|---|---|
| v2 | 产品模型修正:知识库为用户可见可管理的顶层实体;**移除品牌(brandCode)概念,保留语言(languageCode)**;访问地址用自定义 slug;不考虑旧品牌站兼容,全部新数据;知识库级公开开关 |
| v2.2 | 表设计修订:不新建知识库/文档表,复用 knowledge_bases/documents 加列扩展;新增表收敛为 menus/kb_aliases/kb_modes/document_sync_tasks |
| v2.1 | 知识库定位细化为**容器**:文档是数据源的一种(未来可扩展表/URL 等);检索模式 `mode` 可插拔(rag / llm-wiki / graph-rag),**当前仅透出 rag(默认)**,其余后端已存在(knowledge 的 llm-wiki/graph 模块)暂不接 |

## 1. 产品模型与术语

```
用户(鉴权后置)
  └─ 知识库 KnowledgeBase ×N          ← 用户创建:名称/slug/语言
       ├─ 公开开关 is_public          ← 默认私密,切公开后地址对所有人可读
       ├─ 检索模式集合 modes[]        ← 可多选配置(rag/llm-wiki/graph-rag);默认 ['rag'],UI 暂只透出 rag
       ├─ 数据源:文档(本方案)        ← 未来可扩展:表(data-table)/URL/API…
       ├─ 菜单树(文件夹/文档,拖拽排序、启停)
       ├─ 文档(编写/草稿/发布,正文入库)
       ├─ 文档级别名(公开地址路径段)
       └─ 异步派生(保存/删除时触发)  ← 按已启用模式并行处理,各模式独立状态
            rag → 向量/混合检索   llm-wiki(预留)   graph-rag(预留)
```

- **知识库**:数据容器 + 顶层租户实体,有唯一访问地址 `/{slug}`。
- **公开访问**:知识库切公开后,任何人通过地址浏览;文档级 `enable` 控制单篇可见性。
- **语言**:知识库属性(单语言树),如 `zh-cn`;影响检索分词与前端文案。
- **数据源**:当前仅文档(即本方案的菜单/文档);模型上不焊死"知识库=文档集合"。
- **多模式异步派生**:文档的保存(草稿/发布)与删除都产生"派生事件",异步 worker 按知识库启用的模式**并行**处理,各模式独立任务状态;保存接口不被模式处理阻塞。

## 2. 已锁定决策

| # | 决策 |
|---|---|
| 1 | knowledge 扩展文档平台模块;菜单/文档为主数据,chunk/向量为派生检索视图 |
| 2 | 正文(TipTap JSON)存 PG;图片/视频/附件存 OSS,正文仅存相对路径 |
| 3 | book-open 的 service 迁 knowledge,REST/MCP 壳留 hn-docs |
| 4 | 管理鉴权后置(接口预留中间件插槽,当前放行) |
| 5 | 浏览器只访问 hn-docs,knowledge 纯内网(Next rewrite 代理) |
| 6 | 存量迁移/切流不考虑,全新数据 |
| 7 | **移除品牌概念;语言保留(知识库属性)** |
| 8 | **公开地址 = 自定义 slug**(格式校验 + 保留字检查 + 唯一冲突) |
| 9 | **旧品牌站不做兼容**,新路由新数据 |
| 10 | **知识库级公开开关**(默认私密);菜单级 enable 保留 |
| 11 | **知识库 = 数据容器 + 多模式检索配置**:模式集合可多选(rag/llm-wiki/graph-rag),默认 `['rag']`,UI 暂只透出 rag;数据源保存/删除时**异步**按已启用模式并行派生 |
| 12 | **复用 knowledge_bases/documents 作为知识库与文档主表**(加列扩展),仅新增 menus/kb_aliases/kb_modes/document_sync_tasks 四张表;正文唯一存储于 documents,消除双份冗余 |

## 3. 总体架构

```
                浏览器(公网)
                    │
                    ▼
┌────────────────────────────────────────────┐
│ hn-docs (Next.js)                          │
│  /kb                 知识库列表/创建/管理入口  │
│  /kb/[slug]          公开浏览(SSR)          │
│  /kb/[slug]/admin    知识库管理(菜单/编辑)    │
│  /api/doc-platform/**  薄代理(rewrite)──────┼──▶ knowledge :8787(内网)
│  /api/open/v1 /api/mcp   Open API 壳 ──────┤    ├─ /api/doc-platform/**
└────────────────────────────────────────────┘    ├─ /api/knowledge-base/**(已有)
                                                  └─ PG: knowledge schema(复用+新增表) + OSS(资源)
```

主线:创建知识库(自动建 RAG 库)→ 编写文档/调菜单(草稿)→ 发布(正文落库 + 派生 chunk/向量)→ 切公开 → 所有人经 slug 地址浏览/搜索。

## 4. 数据库设计(schema `doc_platform`,drizzle)

### 4.1 复用 `knowledge_bases` — 知识库主表(加产品化列)

**不新建知识库表**,直接扩展 rag 现有 `knowledge_bases`(全包核心表,llm-wiki/data-table 同样引用;加 nullable 列不影响现有管道):

| 新增列 | 类型 | 说明 |
|---|---|---|
| slug | varchar(64) UNIQUE NULL | 访问地址段;`^[a-z0-9][a-z0-9-]{2,63}$`,保留字黑名单(api/admin/kb/static/_next…) |
| language_code | varchar(32) NULL | 知识库语言,如 `zh-cn`(检索分词、文案用) |
| is_public | boolean default false | 公开开关(决策 #10) |
| owner_id | varchar(64) NULL | 预留(鉴权后置) |
| settings | jsonb | 扩展配置(AI 助手开关等) |

现有列(name/description/embedding_model/default_chunk_strategy/…)语义不变:产品创建知识库 = 插入本表并初始化索引配置,**rag 模式下本表即检索后端实体,不再需要第二张知识库表**。

### 4.2 复用 `documents` — 文档主表(加 CMS 列)

**不新建文档表**,扩展 rag 现有 `documents`;正文全项目只存这一处:

| 新增列 | 类型 | 说明 |
|---|---|---|
| menu_id | varchar(64) NULL | → menus.id;**NULL=纯语料文档**(现有 API 直接添加,非文档平台管理),非空=文档平台文档 |
| content_json | jsonb NULL | 发布正文(TipTap 结构化,渲染源) |
| draft_content_json | jsonb NULL | 草稿正文(未发布不进检索) |
| published_at | timestamp NULL | |

现有列语义衔接:
- `content`(text,现有)= 发布正文的 markdown/纯文本派生(**分块输入**,发布时由 pipeline 从 content_json 生成,现有 chunk/status 状态机不变)
- `status`(现有)= 派生进度:`draft` → `published` → `processing` → `indexed` / `failed`
- 直接 API 添加的语料(content 直传、menu_id 空)与文档平台文档同表共存,互不干扰

### 4.3 新增 `menus` — 菜单树(kb 内)

| 列 | 类型 | 说明 |
|---|---|---|
| id | varchar(64) PK | 服务端生成 |
| kb_id | varchar(64) | → knowledge_bases.id |
| parent_id / previous_id | varchar(64) NULL | 树 + 兄弟链表排序(沿用现有前端语义) |
| name | varchar(255) | |
| type | varchar(16) | `folder` / `doc` |
| icon_url | text | |
| slug | varchar(255) NULL | 文档路径段(kb 内唯一,公开地址 `/kb/{kbSlug}/{菜单slug链}`) |
| enable | boolean default true | 文档级可见性 |
| doc_unique_id | varchar(64) | 与 id 同值(book-open 契约字段) |
| created_at / updated_at | timestamp | |

索引:`(kb_id, parent_id)`、`(kb_id, slug)`。

### 4.4 新增 `kb_aliases` — 别名(kb 内唯一)

alias varchar(255) PK(全局唯一,含 kbSlug 语义或拼接规则,实现时定);kb_id、menu_id。

### 4.5 新增 `kb_modes` — 知识库×检索模式(多选配置)

| 列 | 类型 | 说明 |
|---|---|---|
| kb_id + mode | 联合 PK | mode ∈ `rag` \| `llm-wiki` \| `graph-rag` |
| enabled | boolean default true | 模式级启停 |
| backend_id | varchar(255) NULL | 非 rag 模式的后端实体:llm-wiki→wiki collection id;graph-rag→graph kb id;**rag 模式为空**(后端即 knowledge_bases 自身)。启用时同步创建(幂等) |
| config | jsonb | 模式特定配置(如 rag 的 chunk 策略覆盖) |
| created_at / updated_at | timestamp | |

创建知识库默认插入 `('rag', enabled=true)`(backend_id 空);后续可追加/停用模式。

### 4.6 新增 `document_sync_tasks` — 派生任务(模式级异步状态)

| 列 | 类型 | 说明 |
|---|---|---|
| id | varchar PK | |
| document_id / kb_id | varchar(64) | |
| mode | varchar(16) | 任务所属模式 |
| operation | varchar(16) | `upsert` / `delete` |
| published | boolean | upsert 时的发布标记(草稿保存不进索引,§7) |
| status | varchar(16) | `pending`/`processing`/`synced`/`failed` |
| attempts / error | integer / text | 重试与错误 |
| created_at / updated_at | timestamp | |

> 与现有 `sync_tasks`(kb 级批量同步,config/progress/failedDocuments)粒度不同,不复用;前者管"一次批量导入",本表管"单文档×单模式的异步派生"。

### 4.7 表清单汇总

| 表 | 来源 | 说明 |
|---|---|---|
| `knowledge_bases` | **复用+加列** | 知识库 = RAG 后端实体(rag 模式) |
| `documents` | **复用+加列** | 文档主数据,正文唯一存储 |
| `menus` | 新增 | 菜单树 |
| `kb_aliases` | 新增 | 别名 |
| `kb_modes` | 新增 | 多模式配置 |
| `document_sync_tasks` | 新增 | 派生任务明细 |

统一放 knowledge 现有 schema,**不再单建 doc_platform schema**;`kb_<id>` 向量表与 chunk 均为 documents 的派生物,存储零冗余。

> 相比 v2 删除:`dp_knowledge_bases`/`dp_documents`(与现有表同语义重复)、`dp_envs`(品牌概念移除);热词/埋点不做。

## 5. API 设计(`/api/doc-platform`)

统一响应 `{ code, success, message, data }`。**管理接口挂 `/kb-admin` 段,公开读挂 `/kb` 段**(为后置鉴权留清晰切面)。

### 5.1 知识库管理(`/kb-admin/knowledge-bases`,鉴权后置)

| 接口 | 说明 |
|---|---|
| `POST /` `{name, slug, languageCode, modes?}` | 创建;modes 默认 `['rag']`(数组,UI 暂只透出 rag);按 modes 逐个写入 `kb_modes` 并**同步创建各模式后端实体**(rag→knowledge_bases;llm-wiki→collection;graph-rag→graph kb,幂等) |
| `GET /` | 我的知识库列表(owner 后置时=全量) |
| `GET /:kbId` | 详情 |
| `PATCH /:kbId` `{name?, slug?, description?, settings?}` | 更新;slug 变更做唯一/保留字校验 |
| `DELETE /:kbId` | 删除(级联菜单/文档/向量,二次确认由前端做) |
| `POST /:kbId/public` `{isPublic}` | 公开开关 |

### 5.2 公开读(`/kb/:kbSlug/...`,is_public=false 返回 404)

| 接口 | 出参 data |
|---|---|
| `GET /tree` | 菜单树(enable 过滤):`[{id, name, type, iconUrl, slug, menuTrees, path}]` |
| `GET /documents/:menuId/content` | `{ contentType, content }` — content 为**内联正文**(序列化 TipTap JSON),不再是 OSS 指针 |
| `GET /search?q=&page=` | hybrid 搜索(P2) |
| `GET /search` | 见 §7.1(P2) |

### 5.3 知识库管理-菜单/文档(`/kb-admin/knowledge-bases/:kbId/...`)

| 接口 | 说明 |
|---|---|
| `POST /menus` `{name, type, parentId?, previousId?, iconUrl?, slug?}` | 新建节点(folder 或 doc) |
| `PUT /menus/:menuId` | 改名/图标/slug |
| `DELETE /menus/:menuId` | 删除子树 |
| `POST /menus/reorder` `{menuId, targetParentId, targetPreviousId}` | 拖拽排序 |
| `POST /menus/:menuId/enable` `POST .../disable` | 文档级启停 |
| `GET /menus/tree` | 管理树(含禁用项、草稿标记) |
| `PUT /documents/:menuId/draft` `{contentType, content}` | 保存草稿 |
| `DELETE /documents/:menuId/draft` | 丢弃草稿 |
| `GET /documents/:menuId` | `{draft, published, publishedAt, kbSyncStatus}` |
| `POST /documents/:menuId/publish` `{contentType, content, plainTextContent}` | 发布(触发 §7 派生) |
| `POST /oss/upload-url` `{fileName, fileType, fileSize, kbId, menuId?}` | 预签名直传 |
| `GET /oss/domain` | 资源域名 |

### 5.4 Open API 契约(§8 book-open 迁移后)

以 `docUniqueId` 为文档主键的 documents CRUD / blocks / resource-upload-sessions,出入参维持 `docs/book-open-api.md`,实现层换成 documents/menus 读写。kb 维度通过文档归属解析。

## 6. knowledge 模块结构

```
src/doc-platform/
  index.ts                  # createDocPlatformApp(): /kb + /kb-admin + /open
  routes/{public,admin,search,open}.routes.ts
  services/
    knowledge-base.service.ts   # KB CRUD + 按 modes 创建各模式后端实体(幂等)
    sync-worker.service.ts      # 派生任务异步消费(进程内队列,按 mode 分发)
    menu.service.ts             # 建树/兄弟链表排序/启停
    document.service.ts         # 草稿/发布/正文读写
    alias.service.ts            # 别名(缓存)
    resource.service.ts         # OSS 预签名/domain
    publish-pipeline.service.ts # 保存/删除→派生任务生成(§7,写入任务表后由 worker 消费)
    search-shell.service.ts
  auth/middleware.ts            # 占位 passthrough(决策 #4)
  db/schema.ts
```
- `src/app.ts` 挂载 `.route("/doc-platform", app)`;建表并入 `initDatabase()`(幂等)。
- 与 rag 模块关系:仅调用其公开 service(document upsert / search / knowledge-base create),不侵入。

## 7. 数据源保存 → 多模式异步派生

**触发点**:文档的保存(草稿/发布)与删除,即所有数据源写操作。

```
写操作(保存草稿 / 发布 / 删除)
  1. 事务:documents / menus 落库
  2. 同事务内写入派生任务:为 kb 启用的每个 mode 插一行 document_sync_tasks
     (upsert 或 delete;草稿保存的 upsert 任务带状态标记 draft,published 带版本)
  3. 立即返回保存结果 —— 保存不被模式处理阻塞
  4. 异步 worker(进程内队列,串行消费同一文档、并行不同文档):
     a. 取任务,置 processing
     b. 按 mode 分发:
        - rag(当前唯一实现):
            upsert:提取纯文本/标题(复用 book-open content.ts)→ rag document upsert
                    (two-phase 向量替换,chunk 取 kb_modes.config)
                    metadata = { kbId, menuId, docUniqueId, languageCode, menuPath[], published }
            delete:rag deleteDocument
        - llm-wiki(预留):wiki re-compile        ← 接入时实现,置 failed(NOT_IMPLEMENTED)
        - graph-rag(预留):graph ingest          ← 接入时实现,同上
     c. 任务置 synced/failed(attempts+1,error 落库);聚合更新 documents.status(indexed/failed)
  5. 重试:failed 任务经接口/定时重扫(复用 sync_tasks 状态机语义)
```

语义细节:
- **草稿保存**产生 upsert 任务但 `published=false` 标记:rag 模式仅更新 metadata 中的草稿时间,**不入检索索引**(未发布内容不泄漏到 AI 检索);发布时以 `published=true` 再触发,内容进索引。
- **删除**产生 delete 任务:所有启用模式清理对应向量/图谱数据。
- **停用某模式**(enabled=false):新任务不再生成,历史派生数据保留(重启用后增量补)。
- mode!=rag 分支当前直接 failed(NOT_IMPLEMENTED),表与任务流先立住,接入新模式只补 worker 分支。

### 7.1 检索按模式聚合

| mode | 检索实现(均已存在于 knowledge) |
|---|---|
| rag | hybrid-search.service(向量+关键词+RRF+重排) |
| llm-wiki | llm-wiki wiki-search(预留) |
| graph-rag | graph search(预留) |

`/kb/:kbSlug/search` 外壳统一入参,按知识库**启用的模式并行检索后融合**(复用 RRF;单模式即直通);当前仅 rag 分支可用。

## 8. hn-docs 改造清单

| 位置 | 改造 |
|---|---|
| `next.config.js` | rewrite `/api/doc-platform/:path*` → `KNOWLEDGE_INTERNAL_URL/...` |
| `pages/kb/index.tsx` | **新增**:知识库列表 + 创建对话框(名称/slug/语言) |
| `pages/kb/[kbSlug]/index.tsx` | **新增**:公开浏览页(SSR:tree+首篇/指定文档),复用 PcMenu/RightContentV2/MobileDoc 组件,入参从 brand/language 换 kbSlug |
| `pages/kb/[kbSlug]/admin/...` | **新增**:管理页(菜单树管理 + XybotEditor 编辑),复用现有 Menu/XybotEditor/DropdownMenu |
| `api/` | 新增 `api/docPlatform.ts`(kb CRUD/菜单/文档);customer.ts 的 yddoc 读接口随旧路由一并退役 |
| `utils/getDocData.ts` | 内联 JSON 直通分支(content 以 `{` 开头直解析,否则走 OSS,双形态兼容) |
| `lib/book-open` | upstream.ts(470 行,调 yddoc/Boss)替换为 knowledge client;**service.ts(939 行)迁至 knowledge**;rest.ts/mcp.ts/schemas.ts/openapi.ts 壳不动 |
| 旧路由 | `pages/[brandCode]/[languageCode]/`、api/admin.ts、api/knowledgeBase.ts(同步任务改 knowledge 内部直调)、verifyUrl 品牌别名逻辑 → **M4 移除** |
| 不动 | request.ts 框架、Editor UI、styles、埋点、学院/RPA/用户(维持原上游) |

## 9. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M1 骨架+读链路** | dp 建表;KB CRUD(含 RAG 1:1);公开读 tree/content;hn-docs:`/kb` 列表+创建页、`/kb/[slug]` 浏览页、rewrite、getDocData 直通 | 建库→(手动插数据)→slug 地址可浏览;契约快照测试 |
| **M2 编写链路** | 菜单 CRUD/排序/启停、草稿、发布派生;`/kb/[slug]/admin` 管理页接通;book-open service 迁移 | 页面建菜单→写文档→发布→公开地址可见;kb_sync_status=synced;book-open 单测全绿 |
| **M3 搜索** | 搜索外壳;前端搜索组件接 kb 维度 | kb 内搜索带面包屑 |
| **M4 清理** | 旧品牌路由/旧 api 移除;yddoc 文档域依赖清零 | grep 无残留 |

## 10. 实现前需核对的契约点

1. `MenuData.menuTrees` 树形结构消费方式(组件深依赖,新接口保持同构)
2. XybotEditor 对 `contentJson` 的具体要求(TipTap JSON schema、blockId 规则)
3. 上传接口出参(前端 upload.ts 消费字段)
4. 现有 plain_text_content 的提取规则(saveDoc 入参由前端传,后端需复算校验?)

## 11. 未决事项

1. 鉴权(决策 #4):owner 归属、管理接口保护方式 —— 插槽已预留
2. 别名全局唯一 vs kb 内唯一(默认 kb 内;kb_aliases 主键设计随之调整)
3. 知识库删除的级联策略(向量清理复用 KB delete cascade)
4. 跨库搜索/门户聚合(P3+)
