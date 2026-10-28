# hn-docs(用户端)× knowledge(后端)接口差距分析

> 定位:`packages/hn-docs` 为用户端前端,`packages/knowledge` 为对应后端。
> hn-docs 原依赖的上游服务(yddoc-api / Boss / sys 等)中,文档域接口计划由 knowledge 提供。
> 本文档梳理现状依赖、knowledge 已有能力、缺口清单与建议优先级。

## 一、hn-docs 当前上游接口依赖清单

### A. 文档核心(原 yddoc-api + Boss cornerstone/helpdoc)

| # | 接口 | 用途 | 调用方 |
|---|---|---|---|
| A1 | `GET /api/noauth/v1/yddoc/menus/getMenuTreeByBrandCode` | 菜单树(公开) | api/customer.ts、knowledge/yddoc-api.service.ts(同步) |
| A2 | `GET /api/noauth/v1/yddoc/menus/:menuId/contents` | 文档内容(公开) | api/customer.ts |
| A3 | `GET /api/noauth/v1/yddoc/oss/domain` | OSS 域名 | api/customer.ts、lib/book-open/upstream.ts |
| A4 | `GET /api/noauth/v1/yddoc/envConfig/queryByBrandCodeAndLanguageCode` | 品牌+语言环境配置 | api/customer.ts、book-open/upstream.ts |
| A5 | `GET /api/v3/cornerstone/helpdoc/alias/queryDocIdByAlias` | 别名→文档 ID(middleware 每次请求解析) | utils/verifyUrl.ts |
| A6 | `/oss/getUploadUrl` + OSS PUT | 上传地址/直传 | api/admin.ts、book-open(资源订正) |
| A7 | 草稿:`draft/add`、`draft/update`、`draft/delete`、`draft/queryByMenuId` | 草稿管理 | api/admin.ts、book-open |
| A8 | 菜单:`menu/add`、`menu/update`、`menu/delete`、`menu/enable`、`menu/disable`、`menu/queryById`、`getAdminMenuTreeByBrandCode`、排序 tuneUpOrder | 菜单管理 | api/admin.ts、book-open |
| A9 | `saveDoc`(保存/发布正文,含知识库 upsert 触发) | 发布链路 | api/admin.ts |
| A10 | `GET /boss/api/v3/manager/staff/detail` | Boss 身份(Token→userUuid+roleCodeList) | book-open authenticateBossToken |

### B. 全文搜索(`/api/noauth/v1/sys/fullIndex/**`,原独立 sys 服务)

| # | 接口 | 用途 |
|---|---|---|
| B1 | `GET /fullIndex/search` / `searchNew` | 全文搜索 |
| B2 | `GET /fullIndex/tips` | 搜索热词/提示 |
| B3 | `GET /sys/spm/record/log` | 搜索埋点 |

### C. 用户/账号(`/api/v1/**`,原 Boss/用户中心)

| # | 接口 | 用途 |
|---|---|---|
| C1 | `GET /api/v1/user/info/rich` | 用户信息 |
| C2 | `POST /api/v1/user/token/createJumpToken`、`POST /api/v1/proxy/token` | 跳转/代理 token |

### D. 学院(`/api/college/v1/**`,与知识库域无关)

- getEnterpriseClassInfo、getClientLearnStatus、getNewClientLearnStatus、book/messageList、getUserClassInfo

### E. 其他

- `GET /api/noauth/v1/ep/config/queryOem`(RPA 品牌配置)
- `GET /api/v1/sys/sceneDataSource/listBySceneCode`

## 二、knowledge 已有能力(HTTP `/api`,hono,默认 8787)

- 知识库 CRUD:`POST/GET/DELETE /api/knowledge-base[/:id]`
- 文档管理:`POST/GET/PUT/DELETE /api/knowledge-base/:id/documents[/:docId]`、chunks
- 检索:`POST /api/knowledge-base/:id/search`(semantic/keyword/hybrid + HyDE/多查询/多阶段/重排)
- yddoc 同步:`POST /sync-from-yydoc` 等三入口 + `GET /sync-task/:taskId`(已调 A1 菜单树、OSS CDN 拉内容)
- base-knowledge(独立命名空间,hash 幂等/版本锁)、database 表问答、llm-wiki、graph GraphRAG、MCP
- 统一响应 `{ code, success, message, data }`;PG(pgvector+pg_trgm),drizzle

## 三、差距清单(knowledge 需新增)

### 可直接替代/复用
| hn-docs 依赖 | knowledge 方案 |
|---|---|
| B1 全文搜索 | 已有 keyword/hybrid search(文档经同步入库后);需补对外壳接口(按 brand/language 过滤 + 渲染所需字段) |
| B2 热词 tips | 缺,需新增(可由搜索日志聚合或配置表) |
| A2 文档内容 | knowledge 存的是 chunk+embedding,非渲染原文;缺"文档平台"读接口(返回 TipTap JSON/HTML 原文) |

### 需新增的"文档平台服务"模块(建议 `src/doc-platform/`)
1. **公开读**(noauth):菜单树(A1)、文档内容(A2)、envConfig(A4)、别名解析(A5)、OSS domain(A3)
2. **管理写**(Boss Token 鉴权,复用 book-open 的角色模型或仅 Token):草稿 A7、菜单 A8、saveDoc/发布 A9、上传地址 A6
3. **Boss 身份代理**(A10):保持调 Boss,或由网关注入身份
4. **搜索外壳**:封装 hybrid search,入参对齐 `fullIndex/searchNew`,返回菜单路径/高亮
5. **热词 tips**:新表或聚合查询

### 不迁移(维持原上游)
- C 用户/账号、D 学院、E RPA/sceneDataSource、B3 埋点 —— 与知识库域无关

## 四、建议优先级

1. **P0 读取链路**:A1/A2/A4/A5(前台浏览必需,中间件依赖 A5)
2. **P1 发布链路**:A6-A9 + 发布时同步触发知识库入库(替代原"知识库 upsert 任务")
3. **P2 搜索**:B1/B2 替换(hybrid search 外壳 + tips)
4. **P3**:管理后台补全

## 五、关联说明

- hn-docs 内 `lib/book-open`(REST+MCP,文档 CRUD)当前仍依赖 Boss 上游;后端化后其 `service.ts` 可平迁到 knowledge 的 doc-platform,REST/MCP 壳留在前端或网关。
- 数据模型对齐点:knowledge 的 `documents`(chunk 维度)与文档平台的"文档/菜单树"是两套视图,建议文档平台以菜单树为主数据,入库时再派生 chunk。
