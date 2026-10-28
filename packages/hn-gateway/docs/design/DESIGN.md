# hn-gateway 技术实现方案（v2，经源码逐文件核对）

> 影刀前端网关（`xybot-front-gateway`，NestJS BFF）整体迁移到 `packages/hn-gateway`。
> 技术栈：**Hono（@hono/node-server + Bun 开发/测试）+ PostgreSQL（drizzle-orm）**，Nacos 配置中心由 PG 替代。
> 约定对齐 `packages/knowledge`：业务域导出 Hono 子应用、`app.route` 挂载、db 独立 schema + `ensure-schema`。
> 本版基于对原仓库 src/ 全部文件的核对（main.ts、app.module.ts、app-hosting 9 个 handler、5 个灰度策略、11 个业务模块、config.ts）。

## 0. 明确裁剪（用户确认）

- **多语言（locales）整条链路不要**：`/gw-api/locales` 接口、Nacos locale 配置订阅、HTML 注入 `window.YD` 时的 per-app locale 合并，全部不迁移。
- ELK 查询、Prometheus 指标按"保留但可开关"迁移（均为原网关已验证功能）。

## 1. 目标与非目标

**目标**
1. 行为等价：原前端**不改 URL、不改请求/响应契约**即可切到新网关。
2. Nacos 归零：应用注册、微前端列表、灰度 feature 路由、平台配置全部落 PG；多实例无状态。
3. 独立部署：`bun run src/server.ts`（`GATEWAY_PORT` 默认 3101）。

**非目标**
- 不迁移 SkyWalking agent（保留 `X-Trace-ID` 响应头语义，traceId 用 AsyncLocalStorage 生成）。
- 静态资源仍在 COS（原 `winrobot-pub-a-*.cos.ap-shanghai.myqcloud.com`，`CND_DOMAIN` 可覆写）。

## 2. 原网关功能全景（核对结果 → 迁移去向）

### 2.1 app-hosting 责任链（核心，9 个 handler 按序短路）

| # | 原 handler | 匹配条件（实测源码） | 行为 | 迁移 |
|---|---|---|---|---|
| 1 | api-proxy | `/api*`、`/oauth/token` | 转发 `https://{env-}api.yingdao.com`；过滤 host/content-length/sec-fetch-site；按业务码打日志；**业务码非 200 且 app.env.ERROR_WEB_HOOK 配置了飞书 webhook 时告警**；outbound 指标埋点 | `hosting/handlers/api-proxy.ts`（hono/proxy） |
| 2 | gateway-api | `/gw-api/*`、URL 含 `health` | 进本地管理面路由（含 localhost 检查） | `hosting/handlers/gateway-api.ts` |
| 3 | internal-proxy | `/ai-infra-api*`、`/ai-chatbot*` | 内部服务转发 | 同名，upstream 走 env |
| 4 | report | `/report-api*` | 进 report 模块；支持 `x-encrypted-data` **RSA 解密**（`PRIVATE_KEY_FOR_REPORT`） | `domains/report` |
| 5 | app-api-info | `/app-api/info` | 按 domain/baseUrl 返回宿主应用信息 | 同名 |
| 6 | static-file | `isFileRequest(path)` | 回源 `app.url/{version \|\| header.version}{path}`（COS），mime-types 设置 Content-Type | 同名；文件回源加 LRU |
| 7 | sso | `/exchange/sso/token` | 返回内联 SSO 中转页 HTML（postMessage 跨域传 token，页面内嵌） | `sso-page.ts` 静态 HTML 原样搬运 |
| 8 | redirect | `/share/share*`、`/client/appstore/detail*` | 特路重定向规则 | 同名 |
| 9 | app-hosting（兜底） | 恒真 | 见 2.2 | `hosting/handlers/app-hosting.ts` |

中间件上下文：`domain`（`domain` 头或 Host）、`version`（请求头）、cookie 解析出 `enterpriseUuid`/`uuid`；响应头写 `X-Trace-ID`；排除路径 `/socket.io/*`、`/metrics`。

### 2.2 兜底 HTML handler（微前端宿主核心，最复杂）

1. `baseRoute = path[1]`，特例 `community/assistant`、`community/rpa-flow`；按 `domain + baseRoute` 查 app，查不到返回"访问的应用不存在"。
2. **app.proxy 存在时**：整机 `http-proxy` 透传（应用级代理）。
3. 否则**版本选择**（见 2.3）→ 拼入口 HTML：`app.type === 'ssg' && path !== '/'` 时带路径，否则取 `{app.url}/{selectedVersion}` 的 `index.html`；域名改写为 `CND_DOMAIN`。
4. **HTML 改造（cheerio）**：定位内联 `window.YD=` 脚本，注入 `{...app.env, version, MICRO_APPS:[{name,baseroute,url:{url}/{version}/index.html,iframe,destroy,config}]}`（~~locale 合并~~移除）；修正 favicon 相对链接。
5. **LRU 缓存**：key = `htmlUrl::appFingerprint`（app 配置去掉 publishList 后 sha256 前 24 位）——配置变更自动换 key，天然失效，无需主动清缓存。
6. `refererStatLog`：UA 解析 + 跨域 referer 统计日志。

### 2.3 前端版本灰度（策略管理器）

优先级：**请求头 version（最高，测试用）** → 策略按 priority 升序：

| 策略 | priority | 数据来源（→ PG 后） |
|---|---|---|
| backend-gray | 50 | app.backendGray.{enabled,featureKey,version} + **featureKey 路由配置轮询**（原 Nacos 轮询→PG TTL 缓存）；**Java String.hashCode 32 位分桶**算法须逐位复刻 |
| user-enterprise | 100 | app.canary[]（enterpriseUuid→users[].uuid→version），用中间件解析的 cookie |
| network | 150 | app.internalCanary.{enabled,version} + env `INTERNAL_GRAY_IPS`（ip-range-check） |
| percent | 175 | app 内百分比配置（哈希/取模，需按原实现复刻） |
| 兜底 | - | app.version |

### 2.4 管理面路由全量清单（URL 全部原样保留）

```
/gw-api/platform  /gw-api/private-info  /gw-api/platform/cached        # 平台配置读取（原 Nacos APP_LIST 聚合）
/gw-api/nacos/status|refresh|resubscribe|cache/fix|app/:appId/update  # 配置运维接口（替代为 PG 读写+缓存失效）
/gw-api/apps        GET 列表 | POST /:appId 建/改 | POST /project/:appId
/gw-api/apps        GET /domain/:domain | GET /:appId
/gw-api/apps        POST /publish/:appId | GET /publishList/:appId      # 发布=写 version+publishList
/gw-api/microapps   GET / POST / GET /:appId                            # micro_app_list CRUD
/gw-api/ap          GET /:id | GET /version | POST /rollback
/gw-api/ap          POST /backend-gray | GET /backend-gray/:featureKey  # 后端灰度 feature 路由管理
/gw-api/pipelines   GET / | GET /:pid | POST /:pid | GET /:pid/run/:rid
                    POST /:pid/retry/:rid/:jid | GET /:pid/log/:rid/:jid  # 云效
/gw-api/webhook     POST /publish/callback                              # 审批回调：_status=approved → 更新 publishList.approval/step(env) → 发布配置 → 缓存随 fingerprint 失效
/gw-api/upload      POST /file | POST /text                             # 转投 boss-api shadow-rpa media getPubUploadUrl+PUT，返回 readUrl（token 改 env）
/gw-api/gitlab      GET namespace|branches|members                      # GitLab API v4 代理
/report-api         POST / | GET /code/:filePath/:ref | GET /app/:appId/:version
                    GET /log/:traceId | POST /search | POST /customSearch # 日志/检索走 ELK 透传（env 配置地址账号）
/app-api/info       GET
/health             GET（加 PG 连通性）
/metrics            GET（Prometheus，绕过 hosting 链）
~~/gw-api/locales~~  不迁移
```

### 2.5 横切设施

| 设施 | 原实现 | 迁移 |
|---|---|---|
| 全局响应包装/异常 | ResponseFormatterInterceptor + HttpExceptionFilter | Hono 中间件 + `app.onError`，响应结构保持一致 |
| 指标 | @xybot/prom-metrics：/metrics、Http 指标、异常指标、outbound 指标 | prom-client 重实现同名指标（http_request_duration/exception/outbound），`GATEWAY_METRICS=off` 可关 |
| 日志 | winston 控制台 + 按日轮转文件（14d），ELK JSON 格式 | 结构化 JSON + 同名轮转文件，字段对齐（span/traceId/domain/reqPath）便于 ELK 无缝 |
| 前端上报 | RSA 解密 + ELK 落日志 + 飞书告警（span==='http' 时解析 req/res） | 解密用 node:crypto 私钥解（替代 jsencrypt），日志与告警语义保留 |
| socket.io | http-proxy ws 到 `xybot-backend-chatbot:3000`（`DISABLE_PROXY` 可关） | `@hono/node-server` upgrade 透传；实现期验证，不通则独立 ws 入口 |
| CORS/代理/body | enableCors、trust proxy、10mb json limit、ValidationPipe | hono/cors + ` hono/adapter`；body limit 中间件；zod 校验 |
| SSO 中转页 | utils/sso.ts 内嵌 HTML | 原样搬运为静态字符串，勿改逻辑 |
| referer 统计 | analytics.util（UAParser） | 保留，ua-parser-js |

## 3. PG Schema（替代 Nacos）

schema 名 `hn_gateway`（测试 `hn_gateway_dev`，`GATEWAY_DATABASE_SCHEMA` 切换）。

**关键决策：app 配置保留原 IApp JSON 形态**（appId/url/version/env/canary/internalCanary/backendGray/microApps/proxy/type/publishList…），避免语义转换引入偏差；PG 列只做检索索引。

```sql
-- 应用注册表（原 Nacos APP_LIST + 每 appId dataId）
CREATE TABLE apps (
  app_id     TEXT PRIMARY KEY,
  domain     TEXT NOT NULL,                 -- 宿主域名
  base_route TEXT NOT NULL DEFAULT '',      -- 首段路径；community/assistant 等特例原样存
  config     JSONB NOT NULL,                -- ★ 原 IApp JSON 原样
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  version    INT NOT NULL DEFAULT 1,        -- 乐观锁：incremental/full 写入时 +1，冲突则 409
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (domain, base_route)
);

-- 微前端子应用注册表（原 Nacos micro_app_list dataId）
-- 注意：宿主 HTML 注入的 MICRO_APPS 源仍是 apps.config.microApps（与原 IApp 形态一致），
-- 本表是 /gw-api/microapps 管理的独立注册表
CREATE TABLE micro_apps (
  app_id       varchar(255) PRIMARY KEY,
  name         varchar(255) NOT NULL,
  baseroute    varchar(255) NOT NULL DEFAULT '',
  url          varchar(512) NOT NULL,
  micro_version varchar(255) NOT NULL DEFAULT '',
  iframe       boolean NOT NULL DEFAULT FALSE,
  destroy      boolean NOT NULL DEFAULT FALSE,
  config       jsonb NOT NULL DEFAULT '{}',
  enabled      boolean NOT NULL DEFAULT TRUE,
  row_version  integer NOT NULL DEFAULT 1,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- 后端灰度 feature 路由（原 Nacos 灰度 dataId 轮询对象）
CREATE TABLE gray_features (
  feature_key TEXT PRIMARY KEY,
  config      JSONB NOT NULL,               -- 原 GrayFeatureRouteConfig 原样
  version     INT NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 平台级 KV（private-info、平台兜底配置等）
CREATE TABLE configs (
  key        TEXT PRIMARY KEY,              -- 'platform' | 'private-info' | ...
  value      JSONB NOT NULL,
  version    INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 变更通知：所有写操作在同一事务内执行 NOTIFY gateway_config_changed, '<table>:<key>'

-- 发布/审批记录（webhook 审批回调、publish 操作流水；publishList 仍以 config 内为准）
CREATE TABLE publishes (
  id         TEXT PRIMARY KEY,
  app_id     TEXT NOT NULL,
  env        TEXT NOT NULL,
  version    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'running',
  operator   TEXT,
  detail     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 前端上报事件（ELK 之外落一份可查；/log/:traceId 与 /search 仍走 ELK）
CREATE TABLE report_events (
  id         BIGSERIAL PRIMARY KEY,
  app_id     TEXT, trace_id TEXT NOT NULL, level TEXT DEFAULT 'error',
  message    TEXT, payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON report_events (trace_id, created_at);
```

**读路径**：`getAppByDomain(domain, baseRoute)` → 进程内缓存未命中回源 PG（新应用天然可见，等价原「动态订阅新 appId」）；`/gw-api/nacos/*` 运维接口映射见 3.1。

### 3.1 Nacos 能力 → PG 等价映射（逐条对齐，功能不减）

| 原 Nacos 能力（源码核实） | 用途 | PG 等价实现 |
|---|---|---|
| `subscribe(dataId, callback)` 变更推送 | 配置变更秒级生效 | **PG LISTEN/NOTIFY**：管理面写表后 `NOTIFY gateway_config_changed`，所有实例 LISTEN 收到即失效对应内存缓存；无状态多副本同步生效 |
| APP_LIST 变更 → 延迟 resubscribe 新 appId | 应用动态上下线 | 免订阅：缓存未命中即查 PG，新增应用即刻可服务；删除应用靠 NOTIFY 失效 |
| resubscribe 重试定时器 | 订阅链路自愈 | **30s TTL 轮询兜底**（即使 NOTIFY 丢失也最终一致）+ PG 断连重试 |
| `publishSingle(dataId, group, content)` 写回 | webhook 审批、microapps CRUD、ap 发布/回滚 | 管理面 API 直写 PG：full 覆盖 / incremental 用 JSONB `\|\|` 合并；行级 `version` 乐观锁防并发覆盖 |
| gray feature 路由 setInterval 轮询 | 后端灰度 | 30s TTL 轮询 `gray_features` + 写后 NOTIFY 即时失效 |
| namespace（test/online）+ group（XYBOT_FRONT） | 环境隔离 | PG schema 隔离：`hn_gateway` / `hn_gateway_dev`（env 变量切换），group 语义由表名承担 |
| `setCachedConfig`（修缓存） | 运维兜底 | `/gw-api/nacos/cache/fix` 直写 PG 并 NOTIFY |
| `forceUpdateConfig` / `forceResubscribe` | 运维刷新 | 同一接口语义：清空内存缓存 → 重读 PG；type=all/config 保留（locale 不存在） |
| `getServiceStatus` | 连接监控 | `/gw-api/nacos/status` 返回 PG 连通性、缓存条数、最近一次 NOTIFY/失效时间 |
| 配置 JSON 校验（invalid-content 日志） | 防脏配置 | zod 校验 IApp 形态 + JSONB 约束，拒绝非法配置落库 |

**写路径收敛（迁移检查项）**：原所有配置生产者（发布平台前端、webhook、microapps、ap 管理）都经网关 API 写 Nacos → 迁移后统一改为写 PG，**不存在绕过网关的写方**；如发现外部工具直写 Nacos，必须改为调网关 API（上线前逐个排查）。

**一致性说明**：NOTIFY 使多实例生效延迟≈原 Nacos push；TTL 兜底保证最坏 30s 收敛，与原「轮询+订阅」双通道语义对齐。写入用 `version` 乐观锁 + `updated_at`，避免原 last-write-wins 丢更新。

## 4. 目录结构

```
packages/hn-gateway/src/
  server.ts  app.ts  config/env.ts  logger.ts
  db/{schema.ts,ensure-schema.ts,index.ts}
  hosting/
    middleware.ts  trace.ts  html-cache.ts  sso-page.ts
    handlers/{api-proxy,gateway-api,internal-proxy,report,app-api-info,static-file,sso,redirect,app-hosting}.ts
    strategies/{manager,base,backend-gray,user-enterprise,network,percent}.ts
    utils/{analytics,cookie,file,version,crypto}.ts
  domains/{apps,microapps,ap,pipelines,webhook,upload,gitlab,report,health,app-api,platform}/
  integrations/{yunxiao-client,gitlab-client,feishu-alert,elk-client,media-upload}.ts
  test/
```

## 5. 实施阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 | 脚手架 + PG 建表 + /health + /metrics + 全局响应/异常/日志/trace + **LISTEN/NOTIFY 缓存失效通道** | 建表成功、指标可抓、NOTIFY 跨实例失效验证 |
| P2 | app 配置域：apps/gray_features/configs CRUD（full/incremental + 乐观锁）+ `/gw-api/platform\|private-info\|nacos/*` 语义 | 接口 + PG 断言；写后 NOTIFY 即时生效断言 |
| P3 | hosting 链全 9 handler：api-proxy（含飞书告警）、HTML 注入 window.YD（无 locale）、fingerprint 缓存、static-file、sso 中转页、redirect、internal-proxy | 假 COS + 假上游 e2e；注入结果快照比对 |
| P4 | 5 路灰度（含 Java hashCode 分桶、请求头 version）| 策略命中矩阵单测 |
| P5 | 业务域：apps 发布/回滚、microapps、ap、pipelines、webhook 审批、upload、gitlab、report（解密+ELK 透传+PG 事件） | 逐域 e2e |
| P6 | socket.io ws 透传验证、日志轮转、原 xybot 前端指新网关冒烟 | 冒烟通过 |

## 6. 测试策略

- 单测：灰度策略矩阵（含 hashCode 分桶向量）、缓存 fingerprint、cookie/加密解密、isFileRequest、HTML 注入。
- e2e：`app.fetch()` + 真实端口；假 COS（本地文件服务）+ 假上游；断言 HTTP 结果、上游收到的请求、PG 落库三方一致。
- 兼容锚点：原仓库 `*.spec.ts` 中的断言语义逐条对照迁移（原项目测试较全，handler/strategy 均有 spec）。

## 7. 风险与迁移注意

1. **硬编码凭据**（config.ts 中云效 token/AK、gitlab token、上传 Bearer、RSA 私钥、ELK 账号）：全部转 env，README 列清单。
2. **window.YD 注入**是子应用引导关键，注入格式必须逐字段快照回归（除 locale 字段）。
3. **Java hashCode / percent 取模**算法逐位复刻，避免灰度错流。
4. ws 透传是唯一未验证技术点（P6 前置验证）。
5. ~~灰度一致性~~ 已由 LISTEN/NOTIFY + TTL 兜底方案覆盖（见 3.1）；NOTIFY 连接需独立 pg client（连接断开自动重建，重建后全量失效缓存一次）。
