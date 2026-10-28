# hn-gateway（@opencode/hn-gateway）

影刀前端网关（原 `xybot-front-gateway`，NestJS BFF）的 Hono + PostgreSQL 迁移版。
应用注册/微前端托管/灰度分流/发布审批/前端上报/代理转发，**Nacos 配置中心由 PG 替代**（LISTEN/NOTIFY + TTL 缓存）。

设计文档：[DESIGN.md](./DESIGN.md)（含 Nacos→PG 逐条能力映射、hosting 责任链与原网关源码的对照依据）。

## 启动

```bash
# 开发（bun；除 ws 透传外全部可用）
GATEWAY_DATABASE_SCHEMA=hn_gateway_dev bun run src/server.ts

# 生产（node；socket.io ws 透传必须在 node 下运行——Bun 的 http server
# 在 upgrade 后裸写 socket 不可达，系 Bun 运行时限制，已实测）
bun run start:node        # = esbuild 打包 dist/server.js + node 运行
```

测试（连本地 PG，schema `hn_gateway_dev` 隔离）：

```bash
bun run test
```

## 运行时要求

| 运行时 | API/托管/灰度 | ws 透传(/socket.io) |
|---|---|---|
| Bun | ✅ | ❌（Bun http server upgrade 后裸写不可达） |
| node ≥20 | ✅ | ✅ |

## 环境变量

### 基础

| 变量 | 默认 | 说明 |
|---|---|---|
| `GATEWAY_DATABASE_URL` | 回退 `DATABASE_URL`/`OPENCODE_DATABASE_URL`/本地库 | PG 连接串 |
| `GATEWAY_DATABASE_SCHEMA` | `hn_gateway` | 业务 schema（测试 `hn_gateway_dev`） |
| `GATEWAY_PORT` / `GATEWAY_HOST` | `3101` / `0.0.0.0` | 监听 |
| `GATEWAY_ENV` | `online` | 环境标识（决定 api 网关 upstream、ELK 索引后缀） |
| `GATEWAY_LOG_LEVEL` | `info` | debug/info/warn/error |
| `GATEWAY_LOG_DIR` / `GATEWAY_LOG_FILE` | `log` / 开 | 按日轮转文件（保留 14 天） |
| `GATEWAY_METRICS` | 开 | `off` 关闭 /metrics |

### 代理与托管

| 变量 | 默认 | 说明 |
|---|---|---|
| `GATEWAY_API_TARGET` | `https://{env-}api.yingdao.com` | api-proxy upstream |
| `GATEWAY_CHATBOT_TARGET` | `http://xybot-backend-chatbot:3000` | /socket.io ws 透传 upstream |
| `GATEWAY_WS_PROXY` | 开 | `off` 关闭 ws 透传（等价原 `DISABLE_PROXY`） |
| `GATEWAY_AITOOLS_TARGET` | `http://xybot-front-node-ai-tools:3000` | internal-proxy /ai-infra-api |
| `GATEWAY_CND_DOMAIN` | 影刀 COS 桶域名 | 静态/HTML 回源域名改写 |
| `GATEWAY_DEFAULT_DOMAIN` | `test-connector.yingdao.com` | 无 Host 兜底域名（原网关同款语义） |

### 外部集成凭据（**全部 env 化，原仓库硬编码值已废除**）

| 变量 | 用途 | 迁移说明 |
|---|---|---|
| `GATEWAY_YUNXIAO_ORG_ID` / `_TOKEN` / `_ACCESS_KEY_ID` / `_ACCESS_KEY_SECRET` | 云效流水线 | 原 config.ts 硬编码，**必须配置** |
| `GATEWAY_GITLAB_API_URL` / `GATEWAY_GITLAB_TOKEN` | GitLab 代理与 /code 源码 | 同上 |
| `GATEWAY_ELK_URL` / `_NAME` / `_PASSWORD` | report 日志查询 | 同上；未配置时查询返回错误提示 |
| `GATEWAY_MEDIA_UPLOAD_URL` / `GATEWAY_MEDIA_UPLOAD_TOKEN` | upload 转投媒体服务 | **迁移期兜底原 token，上线前轮换** |
| `GATEWAY_REPORT_PRIVATE_KEY` | report 加密上报解密 | **迁移期兜底原私钥，上线前轮换** |
| `INTERNAL_GRAY_IPS` | network 灰度策略 IP 列表 | 逗号分隔，支持 CIDR |
| `GATEWAY_GRAY_API_BASE_URL` | 外部灰度规则服务 | 默认不配（规则读 PG）；配置后 `/gw-api/ap/backend-gray/:featureKey` 透传该服务 |

## 路由（与原网关一致，前端零改动）

- 管理面：`/gw-api/platform`、`/private-info`、`/nacos/*`、`/gw-api/apps`（含 `/publish/:appId`）、`/gw-api/microapps`、`/gw-api/ap`（含 `/rollback`、`/backend-gray` 双模式）、`/gw-api/pipelines`、`/gw-api/webhook/publish/callback`、`/gw-api/upload`、`/gw-api/gitlab`
- 托管链：`/api*`、`/oauth/token`（api-proxy）｜`/ai-infra-api*`、`/ai-chatbot*`（internal-proxy）｜`/app-api/info`｜静态文件｜`/exchange/sso/token`（SSO 中转页）｜`/share/share`、`/client/appstore/detail`（重定向）｜兜底 HTML（`window.YD` 注入 MICRO_APPS）
- 上报：`/report-api/*`（RSA+AES 解密、ELK 透传、PG 事件）
- 基础：`/health`、`/metrics`（Prometheus）

## 与原网关的差异

1. **多语言（locales）裁剪**（业务决策）：`/gw-api/locales`、locale 订阅、HTML 注入的 locale 合并均未迁移。
2. **Nacos → PG**：`subscribe` → LISTEN/NOTIFY + TTL；`publishSingle` → 同事务写表 + NOTIFY；namespace/group → PG schema；逐条映射见 DESIGN.md §3.1。
3. **灰度 feature 路由**：原「外部灰度服务 API + 轮询」→ PG `gray_features` 表（管理接口 `PUT /gw-api/ap/backend-gray/feature/:featureKey`）。规则查询默认读 PG；配置 `GATEWAY_GRAY_API_BASE_URL` 时透传原外部灰度服务（兼容原 `getGrayFeatureRule` 行为）。
4. **凭据 env 化**：原 config.ts 的云效/GitLab/ELK/媒体 token/上报私钥硬编码全部废除（媒体 token 与上报私钥迁移期兜底，需轮换）。
5. **SkyWalking 未迁移**：保留 `X-Trace-ID` 响应头语义（AsyncLocalStorage 生成 traceId）。
6. **响应契约保持一致**：全局响应包装（`{code:200, success:true, data, message:'Success'}`）、错误形态（`{statusCode, timestamp, url, message}`）、`/gw-api` 域名白名单（`front-gw`/health/localhost，否则"无权访问"）均已迁移；飞书告警为原版 `msg_type=post` 富文本（无节流）。

## 表结构

`apps`（应用注册，config 原样保留原 IApp JSON）、`micro_apps`（微前端注册表）、`gray_features`（灰度 feature 路由）、`configs`（平台 KV）、`publishes`（发布流水）、`report_events`（前端上报事件）。见 `src/db/schema.ts` 与 `DESIGN.md` §3。
