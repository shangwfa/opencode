# hn-base-server（@opencode/hn-base-server）

通用底座服务：**身份 / 组织 / 授权 + 会话访问网关（BFF）+ 需求业务 + Git Provider**。
技术栈与 `hn-gateway` 对齐：**Hono + drizzle-orm + pg + zod + better-auth**。

设计文档：`docs/design/total-design.md`（唯一权威）。

## 职责

| 能力 | 说明 |
|---|---|
| 身份与认证 | better-auth：邮箱密码、OAuth（GitHub/Google）、`bearer()` 会话令牌 |
| 组织与成员 | `organization` 插件：org / member / invitation |
| 授权 | ReBAC（`relation_tuple`），`check()` / `listObjects()`，默认拒绝 |
| 需求业务 | requirement / requirement_change / requirement_session + 状态机 |
| 会话网关 | 代理 opencode SaaS 的 REST / SSE / 文件；归属校验在代理前完成 |
| Git Provider | 建仓 / 提交 / PR(MR) / webhook；凭据加密存储 |
| 审计 | `audit_log`：关键操作 + 越权拒绝 |

## 启动

```bash
# 本地（默认连 127.0.0.1:5432/opencode-v2-up，schema hn_base）
BASE_PORT=3201 bun run src/server.ts

# 测试隔离
BASE_DATABASE_SCHEMA=hn_base_test bun run src/server.ts
```

建表：启动时执行幂等 `ensureSchema`（`src/db/ensure-schema.ts`），不依赖 drizzle-kit。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `BASE_DATABASE_URL` | 回退 `DATABASE_URL` / 本地库 | PG 连接串 |
| `BASE_DATABASE_SCHEMA` | `hn_base` | 独立 schema（避免与 SaaS 的 `account`/`user` 冲突） |
| `BASE_PORT` / `BASE_HOST` | `3201` / `0.0.0.0` | 监听 |
| `BETTER_AUTH_URL` | `http://localhost:3201` | better-auth baseURL |
| `BASE_PUBLIC_URL` | 回退 `BETTER_AUTH_URL` | 沙箱可访问的基础服务地址；Connector MCP URL 使用它 |
| `BETTER_AUTH_SECRET` | dev 占位 | 生产必须设置 |
| `WEB_ORIGIN` | `http://localhost:3001` | CORS / trustedOrigins（CSRF） |
| `OPENCODE_SAAS_URL` | `http://localhost:14096` | SaaS 内网地址 |
| `OPENCODE_PASSWORD` | 空 | SaaS 服务级凭证（HTTP Basic） |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | 空 | 配置后启用「使用 Google 继续」 |
| `GIT_GITHUB_CLIENT_ID` / `GIT_GITHUB_CLIENT_SECRET` | 空 | Git 连接 OAuth2（GitHub），与登录用 App **分开** |
| `GIT_GITLAB_CLIENT_ID` / `GIT_GITLAB_CLIENT_SECRET` | 空 | Git 连接 OAuth2（GitLab） |
| `GIT_OAUTH_BASE` | 空 | 测试用：覆盖 OAuth 端点地址（指向 mock） |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | 空 | 配置后启用「使用 GitHub 继续」 |
| `GIT_SECRET_KEY` | 从 `BETTER_AUTH_SECRET` 派生 | Git 凭据加密 + 签名 URL 的密钥 |

> better-auth 的 CSRF 校验要求请求带 `Origin`；CLI/服务间调用需显式带或加入 trustedOrigins。

## API

```
GET  /health

# better-auth（注册/登录/组织/OAuth 全量）
ALL  /api/auth/*

# 当前用户
GET  /api/me

# 需求
GET    /api/requirements           只返回可见的（个人 + 组织 + 共享）
POST   /api/requirements           创建（同事务写 relation_tuple）
GET    /api/requirements/:id       check(read) → 404
PATCH  /api/requirements/:id       check(write) → 404；状态迁移后端校验（409）
DELETE /api/requirements/:id       check(delete) → 404

# 需求变更（PR/MR）
POST /api/requirements/:id/changes 创建 PR/MR（in_progress → pending_publish）
GET  /api/requirements/:id/changes 变更列表

# 会话
GET  /api/sessions                    我的会话（listObjects，不转发 SaaS 全局列表）
POST /api/sessions                    创建（可挂需求，继承权限 + 写 parent 关系）
GET  /api/sessions/:id                会话元信息
GET  /api/sessions/:id/messages       消息列表
POST /api/sessions/:id/message        发送消息（prompt_async）
POST /api/sessions/:id/abort          中止
GET  /api/sessions/:id/fs?path=       文件列表
POST /api/sessions/:id/fs/sign        生成 5 分钟签名 URL（供 <img>/下载）
GET  /api/sessions/:id/fs/content     文件内容
GET  /api/sessions/:id/children       子会话
GET  /api/sessions/:id/event          SSE 透传（客户端断开时取消上游）

# 公开文件（无 header，靠签名）
GET /api/public/fs/:id/content?path=&exp=&sig=

# Git 服务连接
GET    /api/git-providers                     列表（只返回脱敏提示）
POST   /api/git-providers                     注册（先 verify 再加密存 token）
POST   /api/git-providers/:id/verify          重新校验
GET    /api/git-providers/:id/branches?repo=  列分支
POST   /api/git-providers/:id/repos           建仓
POST   /api/git-providers/:id/commit          提交（GitLab 一次多文件；GitHub 逐文件）
DELETE /api/git-providers/:id                 删除

# 组织自定义角色
GET    /api/orgs/:orgId/roles           列表
POST   /api/orgs/:orgId/roles           创建（内置角色不可覆盖）
DELETE /api/orgs/:orgId/roles/:key      删除

# 审计
GET /api/audit?limit=&action=&resourceType=   admin 查全部；普通用户只查自己

# Git webhook（公开端点，签名校验）
POST /api/git/webhook/:provider/:instanceId
```

**错误契约**：`{ code, message, field? }`；越权统一 **404**（不泄露资源存在性）。

**Git 凭据存储**：token 用 AES-256-GCM 加密存 PG；接口只返回 `secretHint`，明文永不出服务端。

**审计**：需求 CRUD、会话创建/中止、Git 服务增删、组织角色变更、越权拒绝（`result=deny`）均写入 `audit_log`；写入失败不阻塞业务。

**Caveats**（`src/lib/caveats.ts`）：`expires_after` / `mfa` / `ip_allowlist`（IPv4 CIDR）/ `time_window`；未知条件 fail-closed。

**需求状态机**（`src/lib/requirement-state.ts`，PATCH 时后端校验）：
```
draft → open → in_progress → pending_publish → done
                   ↖──────────┘         ↖──────┘
任意 → archived（终态）
```
非法迁移返回 **409 `invalid_status_transition`**。

## 第三方登录（Google / GitHub）

**配置即启用**：两个变量都设置时，`GET /api/config` 会返回该 provider，登录页自动出现对应按钮；未配置则完全不显示。

### 1. 创建 OAuth App

| Provider | 创建位置 | 回调地址（Authorization callback URL） |
|---|---|---|
| Google | Google Cloud Console → Credentials → OAuth client ID（Web application） | `http://<base-server>/api/auth/callback/google` |
| GitHub | GitHub → Settings → Developer settings → OAuth Apps → New | `http://<base-server>/api/auth/callback/github` |

> 本地：`http://localhost:3201/api/auth/callback/github`、`http://localhost:3201/api/auth/callback/google`

### 2. 启动时注入

```bash
GITHUB_CLIENT_ID=xxx GITHUB_CLIENT_SECRET=yyy \
GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy \
BASE_PORT=3201 WEB_ORIGIN=http://localhost:3002 bun run src/server.ts
```

### 3. 登录流程

```
点「使用 GitHub 继续」
  → POST /api/auth/sign-in/social { provider, callbackURL: <前端/> }
  → 浏览器跳转 GitHub 授权
  → GitHub 回调 base-server /api/auth/callback/github（校验 state、换 access_token）
  → 建立 session cookie 并 302 回前端
  → 前端 AuthProvider 调 GET /api/auth/get-session（credentials: include）
  → 从 session.token 换发 Bearer token 并持久化到 localStorage
  → 后续请求统一走 Authorization
```

**账号绑定**：better-auth `accountLinking.allowDifferentEmails=false`，不同邮箱不会自动合并，避免账号劫持；同邮箱且 provider 已验证时才合并。

## Git 服务连接（OAuth2 / Access Token）

页面：`/git-providers`。两种授权方式，**默认 OAuth2**，也可手动填 Access Token；未配置 OAuth 应用时自动引导到 Token 方式。

### OAuth2 需要单独的 OAuth 应用

> ⚠️ 不能复用登录用的 OAuth App：回调地址不同（GitHub OAuth App 只允许一个回调地址）。

| Provider | 创建位置 | 回调地址 |
|---|---|---|
| GitHub | Settings → Developer settings → **OAuth Apps** → New | `http://<base-server>/api/git-providers/oauth/callback/github` |
| GitLab | Preferences → Applications → New application（scope 勾 `api`） | `http://<base-server>/api/git-providers/oauth/callback/gitlab` |

配置后重启：

```bash
GIT_GITHUB_CLIENT_ID=xxx GIT_GITHUB_CLIENT_SECRET=yyy \
GIT_GITLAB_CLIENT_ID=xxx  GIT_GITLAB_CLIENT_SECRET=yyy \
BASE_PORT=3201 WEB_ORIGIN=http://localhost:3002 bun run src/server.ts
```

`GET /api/config` 会返回 `gitOAuth: { github: true, gitlab: true }`，前端据此启用 OAuth2 选项。

### 流程

```
选服务类型 → 授权方式 OAuth2（默认）/ Access Token
OAuth2：GET /api/git-providers/oauth/:provider/start（带登录态）
        → 302 provider 授权页
        → 回调 /api/git-providers/oauth/callback/:provider?code&state
        → state 签名校验 → 换 token → verify 身份 → 加密存库 + 写元组
        → 302 前端 /#/git-providers?connected=<id>
Access Token：POST /api/git-providers（先 verify 再加密入库）
```

- state 用 HMAC 签名（含 userId/provider/baseUrl/scope/10 分钟过期），无需额外表
- GitLab 的 access_token 2 小时过期（返回 refresh_token，当前先存不自动刷新）
- token 始终 AES-256-GCM 加密存 PG，接口只返回脱敏串

## 授权模型（ReBAC）

- 唯一真相：`relation_tuple`
- 权限定义：`src/authz/schema.ts`（新增资源/权限只改这里）
- 组织成员关系直接查 `member` 表；自定义角色走 `org_role.permissions`
- `parent->perm` 沿 parent 关系递归（深度上限 12）
- 默认拒绝；收回权限 = 删除元组，立即生效

## 测试

```bash
# 单测（真实 PG，独立 schema）
BASE_DATABASE_SCHEMA=hn_base_test bun test

# e2e（需先启动服务）
BASE_DATABASE_SCHEMA=hn_base_dev bun run test/e2e/org-flow.mjs       # 组织协作
BASE_DATABASE_SCHEMA=hn_base_dev bun run test/e2e/git-flow.mjs       # Git 连接（mock GitLab）
BASE_DATABASE_SCHEMA=hn_base_dev bun run test/e2e/session-flow.mjs   # 需求→会话→代理→级联
BASE_DATABASE_SCHEMA=hn_base_dev bun run test/e2e/git-write-flow.mjs # 建仓→提交→MR→webhook→done
BASE_DATABASE_SCHEMA=hn_base_dev bun run test/e2e/p3-flow.mjs        # 审计/自定义角色/签名URL
```

存量会话迁移：

```bash
BASE_DATABASE_SCHEMA=hn_base_dev bun run scripts/migrate-legacy.mjs --org <orgId>           # dry-run
BASE_DATABASE_SCHEMA=hn_base_dev bun run scripts/migrate-legacy.mjs --org <orgId> --apply   # 写入
BASE_DATABASE_SCHEMA=hn_base_dev bun run scripts/migrate-legacy.mjs --org <orgId> --rollback # 回滚
```
幂等（唯一索引），并写入审计。

## 已验证（2026-10-18）

- **单测 61 例**：授权判定矩阵、`listObjects`/`check` 一致、过期/删除失效、`resolveRepo` 多格式、AES-GCM 加解密与脱敏、状态机、webhook 签名、caveats（CIDR/时间窗）、签名 URL
- 注册 → 登录 → bearer → `/api/me`
- 需求 CRUD；跨用户 404；列表隔离
- 组织：成员可见性、移除即失效、角色权限边界
- 会话：创建（owner+parent 元组）、代理读取、他人 404、删除需求级联收回
- Git：注册（响应不含明文）→ 建仓 → 提交（多文件）→ 开 MR → webhook merged → 需求 done；幂等、错误签名 401、provider 不匹配 400
- 审计：操作落库、越权 deny、普通用户只能看自己
- 自定义角色：`auditor` 可读不可管理
- 签名 URL：可生成、无需 header、篡改/过期失效
- 迁移：dry-run / apply / 幂等 / rollback

## 未覆盖

- **沙箱内 `git commit/push` + `.netrc` 下发**：依赖 OpenSandbox 命令通道，本地无沙箱可验
- `listObjects` 目前是「候选集 + 逐条 check」，大数据量需改为批量内存判定
- `GET /api/sessions` 逐个取 SaaS 元信息，未接 SaaS 批量接口
- 前端（hn-app）尚未切换到 base-server 的 `/api/*`（仍直连 SaaS）
