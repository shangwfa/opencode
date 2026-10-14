# 文档平台后端化 · 架构对齐结论

> 日期:2026-10-14
> 参与方:hn-docs(用户端前端) × knowledge(后端)
> 前置分析:[hn-docs-api-gap.md](./hn-docs-api-gap.md)
> 状态:**已对齐,未实现**

## 一、决策记录

| # | 议题 | 决策 |
|---|---|---|
| 1 | knowledge 职责边界 | **扩展文档平台模块**:菜单/文档元数据为主数据,chunk/向量表为入库时派生的检索视图 |
| 2 | 主数据归属 | **全量迁入 knowledge 的 PG,正文存文档表**;图片/视频/附件等资源继续存 OSS(正文内只留 resourcePath 相对路径);yddoc-api 逐步退役 |
| 3 | book-open 演进 | **service 层(文档 CRUD/资源订正/发布流程)迁入 knowledge**,REST/MCP 壳留在 hn-docs 改调 knowledge |
| 4 | 管理写鉴权 | **暂不考虑**,后续再定(当前 book-open 的 Boss Token 模型作为参考保留) |
| 5 | 通信拓扑 | **全经 hn-docs 代理**:浏览器只访问 hn-docs(Next rewrite/代理转发),knowledge 纯内网,不暴露公网;SSR 数据同走内网 |
| 6 | 存量迁移/切流 | **不考虑**,后续另行规划 |

## 二、目标架构

```
                    浏览器(公网)
                        │
                        ▼
┌───────────────────────────────────────────┐
│  hn-docs (Next.js)                        │
│  - SSR 页面渲染(菜单/正文/搜索)             │
│  - /api/** 薄代理层:转发 + 统一响应壳        │
│  - REST(/api/open/v1) + MCP(/api/mcp) 壳  │
└───────────────┬───────────────────────────┘
                │ 内网 HTTP(baseURL 指向 knowledge)
                ▼
┌───────────────────────────────────────────┐
│  knowledge (hono + PG, 内网)              │
│  ┌─────────────────────────────┐          │
│  │ doc-platform(新增)           │          │
│  │  菜单树 / 文档(正文入库) /     │          │
│  │  草稿·发布 / envConfig /      │          │
│  │  别名 / OSS 上传地址 / 热词    │          │
│  └──────────────┬──────────────┘          │
│                 │ 入库时派生                │
│  ┌──────────────▼──────────────┐          │
│  │ 知识库(已有):chunk/向量/      │          │
│  │ hybrid search / 重排 / Graph  │          │
│  └─────────────────────────────┘          │
│  OSS(资源,经预签名直传)                    │
└───────────────────────────────────────────┘

不再依赖:yddoc-api(文档域)、sys fullIndex(搜索域)
仍依赖(暂):无(鉴权后置;Boss 身份依赖随鉴权决策一并后置)
```

## 三、knowledge 侧新增模块(方向,非实现)

```
src/doc-platform/
  routes/          # 菜单/文档/配置/别名/搜索外壳/热词
  services/
    menu.service.ts        # 菜单树 CRUD、排序、启停
    document.service.ts    # 文档正文(表内)、草稿/发布两态
    env-config.service.ts  # 品牌+语言环境配置
    alias.service.ts       # 别名 ↔ 文档 ID(中间件高频,需缓存)
    resource.service.ts    # OSS 预签名上传地址、domain
    search-shell.service.ts# 封装 hybrid search,入参/出参对齐前端
  db/
    schema.ts              # 见下表
```

### 数据模型方向

| 表 | 说明 |
|---|---|
| `dp_brands` / `dp_env_config` | 品牌、品牌×语言环境配置 |
| `dp_menus` | 菜单树(brand/language 维度,层级、排序、启停、别名) |
| `dp_documents` | 文档主表:正文 TipTap JSON 直存(JSONB/text),资源仅存 OSS 相对路径;draft/published 两态(或 draft 表分离,实现时定) |
| `dp_search_logs` / 热词 | 搜索埋点与热词聚合(tips 替代) |
| 知识库侧(已有) | `documents`/`kb_<id>` 向量表:入库时从 `dp_documents` 派生,发布事件触发 |

要点:文档平台与知识库是**一份数据两个视图**,发布(或保存)事件驱动 chunk 派生,替代原"知识库 upsert 任务"的跨服务异步。

## 四、接口规划(对齐 gap 清单)

| 前端依赖 | knowledge 接口(草案) | 优先级 |
|---|---|---|
| 菜单树 getMenuTreeByBrandCode | `GET /api/doc-platform/menus/tree` | P0 |
| 文档内容 menus/:id/contents | `GET /api/doc-platform/documents/:id/content` | P0 |
| envConfig | `GET /api/doc-platform/env-config` | P0 |
| 别名 queryDocIdByAlias | `GET /api/doc-platform/alias/resolve` | P0(中间件高频,服务端缓存) |
| OSS domain / 上传地址 | `GET/POST /api/doc-platform/oss/*` | P1 |
| 草稿/菜单/发布 CRUD(A7-A9) | `POST/PUT/DELETE /api/doc-platform/{drafts,menus,documents}` | P1 |
| 全文搜索 fullIndex/searchNew | `POST /api/doc-platform/search`(hybrid 外壳) | P2 |
| 热词 tips | `GET /api/doc-platform/search/tips` | P2 |

hn-docs 侧改造:`api/customer.ts`、`api/admin.ts`、`utils/verifyUrl.ts` 等的 baseURL 指向内部代理路径;`lib/book-open/upstream.ts` 的 yddoc/Boss 调用替换为 knowledge 调用(随 service 迁移)。

## 五、未决事项(显式后置)

1. **鉴权**:管理写接口的 Token 校验与身份模型(决策 #4)
2. **存量数据迁移与切流**(决策 #6)
3. 草稿/版本模型细节(单表两态 vs 分表)
4. 直链 OSS 的 CORS 与预签名有效期
5. 搜索埋点 B3(spm)是否随搜索一并收编
