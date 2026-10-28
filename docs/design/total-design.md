# 总设计：需求开发平台（hn-base-server + opencode SaaS）

> 本文是**唯一权威设计**，合并并取代此前分散的 6 份文档。
> 已定冲突：访问模型=**BFF**；授权真相=**relation_tuple**；会话归属=**元组**；Git 凭据=**元组 + 冗余字段**。
> 状态：设计定稿，待实现。日期：2026-10-18。

---

## 一、目标与边界

**产品目标**：用户/组织在平台上管理「需求」，每个需求驱动一个或多个 AI 会话；会话在沙箱中改代码，并通过 Git Provider（GitLab / GitHub）建仓、提交、开 PR。

### 1.1 职责划分（关键）
| 服务 | 职责 | 不做什么 |
|---|---|---|
| **hn-app**（React） | UI；只调 hn-base-server | 不直连 SaaS |
| **hn-base-server**（Hono） | 身份/组织/授权、业务（需求/变更）、**会话访问网关**、Git Provider | 不执行 agent |
| **opencode SaaS**（Effect） | 会话执行、沙箱、模型、文件、工具 | 不认识用户/组织 |
| **hn-gateway** | 业务项目（GitLab 项目/应用注册） | 不涉及需求与会话 |

> **业务表（需求/变更/Git）放在 hn-base-server**，因为它们是业务概念；SaaS 保持纯执行层。这是「SaaS 只认会话、上层通过用户拿会话」的落地。

### 1.2 范围外
流水线/代码生成/部署/CDN、飞书通知、录制上传、业务项目注册（归 hn-gateway）。

---

## 二、架构总览

```
┌─ hn-app（React + Vite + shadcn）─────────────────────────────┐
│ 登录/组织切换 · 需求列表/详情 · 需求对话 · Git 服务连接 · 仪表盘 │
└──────────────┬───────────────────────────────────────────────┘
               │ HTTPS + Bearer（用户态）
┌──────────────▼───────────────────────────────────────────────┐
│ hn-base-server（Hono + drizzle + pg + better-auth）           │
│  ┌───────────────┐ ┌──────────────┐ ┌──────────────────────┐ │
│  │ 身份/组织      │ │ 业务域        │ │ 会话网关（BFF）       │ │
│  │ better-auth   │ │ requirement   │ │ 代理 REST/SSE/文件    │ │
│  │ user/org/     │ │ change        │ │ 归属校验（ReBAC）     │ │
│  │ member        │ │ git provider  │ │                      │ │
│  └───────┬───────┘ └──────┬───────┘ └───────────┬──────────┘ │
│          └────────────────┼─────────────────────┘            │
│                    ┌──────▼──────┐   ┌──────────────────┐    │
│                    │ relation_   │   │ credential       │    │
│                    │ tuple       │   │ (secret)         │    │
│                    └─────────────┘   └──────────────────┘    │
└──────────────┬───────────────────────────────────────────────┘
               │ 内网 + 服务级凭证（Basic/Service Token）
┌──────────────▼───────────────┐        ┌──────────────────────┐
│ opencode SaaS（无状态多 pod） │        │ GitLab / GitHub      │
│ session / sandbox / model    │        │ REST API（直连）      │
│ project / file / tool        │        └──────────────────────┘
└──────────────────────────────┘
```

**网络约束**：SaaS **仅内网可达**，只接受 base-server 调用；用户无法绕过 BFF。

---

## 三、单一真相（Single Source of Truth）

| 关注点 | 唯一真相 | 说明 |
|---|---|---|
| 身份 / 组织成员 | better-auth（`user` / `member` / `organization`） | 不复制到元组 |
| **授权** | **`relation_tuple`** | 所有 `can()` 只查它 |
| 凭据 secret | `credential` 表 | 永不下发前端 |
| 需求 / 变更 | hn-base-server 业务表 | |
| 会话执行 / 内容 | opencode SaaS | base-server 只代理 |
| 业务项目（应用） | hn-gateway | |

**字段降级规则**：`requirement.owner_id/org_id`、`git_credential.owner_type/owner_id`、`session` 上的归属字段**只是查询优化与展示**，**禁止用于授权判断**；它们与元组在**同一事务**写入。

---

## 四、数据模型

### 4.1 身份与组织（better-auth，schema `hn_auth`）
```
user(id, name, email, email_verified, image, role, status, created_at, updated_at)
session(id, token, user_id, expires_at, ip_address, user_agent, active_organization_id, ...)
account(id, user_id, provider_id, account_id, access_token, refresh_token, ...)   -- external_identity
verification(id, identifier, value, expires_at, ...)
organization(id, name, slug, logo, metadata, deleted_at, ...)
member(id, organization_id, user_id, role, created_at)
invitation(id, organization_id, email, role, status, expires_at, inviter_id)
```

### 4.2 授权（唯一真相）
```sql
CREATE TABLE relation_tuple (
  id              text PRIMARY KEY,
  resource_type   text NOT NULL,   -- org | project | requirement | session | git_provider
  resource_id     text NOT NULL,
  relation        text NOT NULL,   -- owner | editor | viewer | parent | member | admin | user
  subject_type    text NOT NULL,   -- user | org | team | public
  subject_id      text NOT NULL,   -- public 时为 "*"
  caveat_name     text,
  caveat_context  jsonb,
  expires_at      bigint,
  created_by      text,
  time_created    bigint NOT NULL
);
CREATE INDEX rt_subject_idx  ON relation_tuple (subject_type, subject_id, relation);
CREATE INDEX rt_resource_idx ON relation_tuple (resource_type, resource_id, relation);
CREATE UNIQUE INDEX rt_uniq  ON relation_tuple (resource_type, resource_id, relation, subject_type, subject_id);
```

### 4.3 业务表（hn-base-server，schema `public`）
```sql
CREATE TABLE requirement (
  id text PRIMARY KEY,
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'draft',
  priority text, kind text, create_type text,
  repo_url text,
  git_provider_instance_id text,
  base_branch text, work_branch text,
  owner_id text NOT NULL,        -- 查询/展示；授权走元组
  org_id text,                   -- 可空 = 个人资源
  project_id text,               -- 关联 SaaS project（可选）
  time_created bigint NOT NULL, time_updated bigint NOT NULL
);

CREATE TABLE requirement_change (
  id text PRIMARY KEY,
  requirement_id text NOT NULL REFERENCES requirement(id) ON DELETE CASCADE,
  provider_instance_id text,
  number bigint NOT NULL, url text NOT NULL,
  state text NOT NULL,              -- opened | merged | closed
  source_branch text, target_branch text,
  time_created bigint NOT NULL, time_merged bigint
);

CREATE TABLE requirement_session (
  id text PRIMARY KEY,
  requirement_id text NOT NULL REFERENCES requirement(id) ON DELETE CASCADE,
  session_id text NOT NULL,         -- SaaS session id
  role text NOT NULL DEFAULT 'primary',  -- primary | derived | intake_child
  time_created bigint NOT NULL
);
CREATE UNIQUE INDEX requirement_session_uq ON requirement_session (session_id);

CREATE TABLE git_provider_instance (
  id text PRIMARY KEY,
  type text NOT NULL,               -- gitlab | github
  display_name text NOT NULL,
  base_url text NOT NULL,
  api_base_url text,
  auth_method text NOT NULL,        -- key | oauth | env
  credential_id text REFERENCES credential(id) ON DELETE SET NULL,
  owner_type text NOT NULL,         -- user | org | global（冗余）
  owner_id text,
  status text NOT NULL DEFAULT 'active',   -- active | invalid
  time_created bigint NOT NULL, time_updated bigint NOT NULL
);

CREATE TABLE git_credential (
  id text PRIMARY KEY,
  credential_id text NOT NULL REFERENCES credential(id) ON DELETE CASCADE,
  provider_type text NOT NULL,
  prefix text NOT NULL,             -- URL 前缀（最长匹配）
  scopes text[], auth_kind text,
  owner_type text NOT NULL, owner_id text,   -- 冗余
  expires_at bigint,
  time_created bigint NOT NULL
);

CREATE TABLE webhook_event (
  id text PRIMARY KEY,
  provider text NOT NULL,
  event_id text NOT NULL,           -- 幂等键
  event_type text NOT NULL,
  payload jsonb,
  status text NOT NULL,             -- received | processed | failed
  error text, time_created bigint NOT NULL,
  UNIQUE (provider, event_id)
);

CREATE TABLE audit_log (
  id text PRIMARY KEY,
  actor_type text, actor_id text,
  action text NOT NULL,
  resource_type text, resource_id text,
  result text,                      -- allow | deny
  ip text, user_agent text,
  metadata jsonb, time_created bigint NOT NULL
);
```

### 4.4 SaaS 侧（**不改**）
`session_v2` / `project` / `sandbox` / `session_message` … 保持现状。

---

## 五、权限模型（ReBAC）

### 5.1 Schema（层级）
```
org#owner   = user
org#admin   = user
org#member  = user | team
org#read    = owner + admin + member
org#manage  = owner + admin

project#org    = org
project#owner  = user
project#editor = user | org->member | team
project#viewer = user | org->member | team | public
project#read   = owner + editor + viewer
project#write  = owner + editor
project#manage = owner + org->admin

requirement#owner  = user
requirement#editor = user | org->member | team
requirement#viewer = user | org->member | team | public
requirement#parent = project
requirement#read   = owner + editor + viewer + parent->read
requirement#write  = owner + editor + parent->write
requirement#delete = owner + parent->manage
requirement#share  = owner + parent->manage
requirement#run    = owner + editor

session#owner  = user
session#parent = requirement | session
session#viewer = user | org
session#read   = owner + viewer + parent->read
session#run    = owner + parent->run
session#abort  = owner + parent->run
session#share  = owner
session#delete = owner + parent->delete

git_provider#owner  = user | org
git_provider#admin  = user
git_provider#user   = user | org->member
git_provider#use         = owner + user            -- 可用于 clone/push
git_provider#read_secret = owner + admin           -- 可读 token（前端永不返回明文）
git_provider#manage      = owner + admin
```

### 5.2 接口
```ts
check(subject, permission, object, ctx?): Promise<boolean>
listObjects(subject, permission, type, ctx?, limit?, cursor?): Promise<{ ids, cursor }>
write(tuples): Promise<void>
delete(filter): Promise<void>
```
判定 = 从资源沿关系向上遍历（深度 ≤ 12）；**默认拒绝**；收回权限 = 删元组。

### 5.3 条件（Caveats）
`expires_after(now, expires_at)`、`ip_allowlist(ip, cidrs)`、`mfa(mfaVerified)`

### 5.4 写入时机（同事务）
| 时机 | 元组 |
|---|---|
| 建需求 | `owner@creator` + `parent@project`（若有）+ `viewer@org`（若组织资源） |
| 建会话 | `owner@creator` + `parent@requirement/session` |
| 建组织 | `owner@creator` |
| 共享 | `viewer/editor@subject`（可带 caveat） |
| 转移 | 删旧 owner + 写新 owner |
| 删除 | 删本资源及子资源全部元组 |

> **不变式**：`listObjects()` 结果必须与逐条 `check()` 一致（必测）。

---

## 六、访问边界与代理（BFF）

### 6.1 服务级凭证（G1）
- base-server → SaaS：**HTTP Basic**（沿用现有 `ServerAuth`，`OPENCODE_PASSWORD`），凭证仅存在于服务端 env/secret
- SaaS 网络：ClusterIP / 白名单，**仅 base-server 可访问**
- 后续可升级 mTLS；但不引入额外复杂度

### 6.2 路由与校验
```
hn-app ──Bearer(用户 session)──▶ base-server /api/sessions/:id/*
                                    ① requireAuth（better-auth）
                                    ② check(me, 'read'|'run'|..., session:id)
                                    ③ 转发 SaaS + Basic
```
- 无权限 → **404**（不泄露存在性）
- 子资源（消息/文件/工具）先校验 session，再转发

### 6.3 SSE 代理（G2）
- base-server `fetch` SaaS 的 SSE → Hono `streamSSE` 转发
- 心跳 15s；客户端断开 → abort 上游；单实例连接上限（如 500）+ 排队/拒绝
- 每 pod 维护连接计数（Redis 可选，用于总览指标）

### 6.4 文件 / 图片 / 预览（G2）
- 小文件（< 10MB）：流式代理，不落盘
- 大文件 / `<img>` 等无法带 header 的场景：**短期签名 URL**（HMAC，5 分钟，绑定 `session+path`），**仍指向 base-server**（不改 SaaS）
- 带宽压力后续可上 CDN/对象存储；当前不引入

### 6.5 PTY / WebSocket
- **唯一例外**：base-server 签发一次性、短时效（60s）、绑定 session 的 ticket，前端直连 SaaS PTY
- 其余全部代理
- ticket 一次性 + 绑定 session，避免拿到链接就能连

### 6.6 会话列表
- `listObjects(me, 'read', 'session')` 生成 id 列表 → 批量取 SaaS 会话元信息
- **不转发** SaaS 的 `GET /session`（全局列表）

---

## 七、Git Provider

### 7.1 抽象
```ts
interface GitProvider {
  type: "gitlab" | "github"
  listBranches(repo, opts?): Promise<Branch[]>
  getChange(repo, number): Promise<ChangeState>
  createRepo(input): Promise<RepoRef>
  createChange(repo, source, target, opts?): Promise<Change>
  commitFiles(repo, branch, input): Promise<CommitRef>
  resolveRepo(input): RepoRef
  netrc(cred): NetrcEntry
}
```
术语中立：`change`（MR/PR）、`number`、`url`、`owner/repo`。

### 7.2 能力与权限
| 能力 | GitLab | GitHub |
|---|---|---|
| 建仓 | `POST /projects` | `POST /orgs/{org}/repos` / `POST /user/repos` |
| API 提交 | `POST /projects/:id/repository/commits` | `PUT /repos/.../contents/{path}` |
| PR/MR | `POST /projects/:id/merge_requests` | `POST /repos/{o}/{r}/pulls` |
| 列分支 | `GET /projects/:id/repository/branches` | `GET /repos/{o}/{r}/branches` |
| 认证 | `PRIVATE-TOKEN` | `Authorization: Bearer` |
| 建仓所需 | `api` scope | `Administration: write` |

### 7.3 凭据解析（就近优先）
```
组织资源 → org 凭据 → global 凭据（绝不用个人凭据）
个人资源 → 个人凭据 → org → global
同层内按 URL prefix 最长匹配
```
- token 只存 `credential`，永不下发前端
- 解析失败/过期 → 明确报错，**不自动回退到他人凭据**

### 7.4 提交路径
- 建仓 + 初始化 → **API**
- agent 改码后提交 → **沙箱内 git**（base-server 经命令通道写 `.netrc`，用后即焚）

### 7.5 Webhook（G4）
```
POST /api/git/webhook/:provider/:instanceId
```
- 验签：GitHub `X-Hub-Signature-256`（HMAC-SHA256）；GitLab `X-Gitlab-Token`
- 幂等：`webhook_event(provider, event_id)` 唯一索引（`X-GitHub-Delivery` / `X-Gitlab-Event-UUID`）
- 处理：`pull_request.closed && merged` → 更新 `requirement_change` → 若全部 merged 则 `requirement.status: pending_publish → done`
- 失败：写 `webhook_event.status='failed'` + 指标告警；依赖 provider 重试

---

## 八、关键流程

### 8.1 建需求（含建仓）
```
hn-app → POST /api/requirements {title, repo?, createRepo?}
base-server:
  事务开始
  1. (可选) gitprovider.createRepo → repo_url
  2. INSERT requirement（owner_id, org_id, repo_url, status='open'）
  3. write tuple: (requirement, id, owner, user, me)
                 (requirement, id, parent, project, pid)  [可选]
                 (requirement, id, viewer, org, myOrg)    [组织资源]
  事务提交
→ 201 {id, repo_url, status}
```

### 8.2 开需求会话
```
POST /api/requirements/:id/sessions
base-server:
  1. check(me, 'run', requirement:id)
  2. 调 SaaS 创建 session（Basic）
  3. 写 requirement_session
  4. write tuple: (session, sid, owner, user, me) + (session, sid, parent, requirement, rid)
  5. 命令通道：写 .netrc → clone → 建 feature/{reqId} 分支
→ 201 {sessionId}
```

### 8.3 对话（SSE）
```
GET /api/sessions/:id/event
base-server: check(me,'read',session:id) → 代理 SaaS SSE
```

### 8.4 提交与开 PR
```
POST /api/requirements/:id/commit {message}
base-server: check(me,'write',req) → 沙箱 git commit/push（.netrc）
           → gitprovider.createChange → INSERT requirement_change
           → status: in_progress → pending_publish
```

### 8.5 PR merged
```
GitLab/GitHub webhook → 验签 → 幂等 → 更新 change.state='merged'
→ 全部 merged → status='done' → SSE 通知前端
```

---

## 九、安全

| 项 | 要求 |
|---|---|
| 会话凭证 | httpOnly Cookie（Web，SameSite=Lax）或 Bearer（CLI） |
| Git token | 不进 URL/日志/前端；`.netrc` 用后即焚；输出脱敏 |
| 服务凭证 | Base 密码仅存 secret；SaaS 仅内网 |
| 越权 | 统一 404；内部记录审计 |
| 邀请 | 邮箱必须匹配；过期时间；一次性 |
| OAuth 绑定 | 仅 `emailVerified=true` 才自动合并账号 |
| 字段脱敏 | `read_secret` 权限才可读 token（且前端仍不返回明文） |
| 审计 | 登录、凭据增删、权限变更、越权拒绝、webhook 失败 |

---

## 十、可观测性（G6）

| 类型 | 内容 |
|---|---|
| 日志 | 结构化（span/event），含 requestId、userId、orgId、sessionId；**不含 token** |
| 指标 | 登录成功/失败、授权拒绝数、代理延迟（p50/p95/p99）、SSE 连接数、SaaS 错误率、webhook 失败数、Git API 错误 |
| 审计 | `audit_log`，高风险操作必记 |
| 告警 | 授权拒绝率突增、SSE 连接打满、webhook 连续失败、SaaS 5xx |

---

## 十一、错误契约（G7）

```json
{ "code": "requirement_not_found", "message": "需求不存在或无权访问", "field": null }
```
| 状态 | 语义 |
|---|---|
| 400 | 参数/格式错误（含 `field`） |
| 401 | 未认证 / 会话过期 |
| 403 | 已确认资源存在但明确禁止（如组织角色不足） |
| **404** | **资源不存在 或 跨租户无权访问**（不泄露存在性） |
| 409 | 冲突（重复建仓、并发写、状态迁移非法） |
| 429 | 限流 |
| 500 | 服务端错误（含 traceId） |

---

## 十二、部署与配置（G8）

```
k8s（同集群）
  hn-base-server  Deployment × N（无状态，水平扩展）
  opencode-saas   Deployment × M（仅 ClusterIP，白名单 base-server）
  PG              共享实例，schema 隔离：hn_auth / public
  Redis（可选）    权限缓存、SSE 连接计数
```
| 环境变量 | 说明 |
|---|---|
| `BASE_DATABASE_URL` / `BASE_DATABASE_SCHEMA` | PG（默认 `hn_base`，测试 `hn_base_dev`） |
| `BETTER_AUTH_URL` / `BETTER_AUTH_SECRET` | better-auth |
| `OPENCODE_SAAS_URL` / `OPENCODE_PASSWORD` | SaaS 内网地址与服务凭证 |
| `WEB_ORIGIN` | CORS / trustedOrigins |
| `GIT_WEBHOOK_SECRET` | webhook HMAC |

**建表**：幂等 `ensure-schema`（对齐 hn-gateway），启动期执行；测试用独立 schema。

---

## 十三、存量迁移（G5）

1. 创建默认组织（`legacy`）或按 `app_id` 映射组织
2. 现有 `project` / `session` 归属：
   - 有 `app_id` → 映射到已配置组织
   - 无 → `legacy` 组织
3. 写 `relation_tuple`：`(project, id, viewer, org, legacy)`；`(session, id, viewer, org, legacy)`
4. **dry-run 报告**：统计将归属的 project/session 数量、无法判定的条目
5. 可回滚：迁移写入 `migration_batch` 标记，支持按批撤销
6. 上线后提供「认领」入口：管理员把 legacy 资源转给真实组织

---

## 十四、测试策略

| 层 | 内容 |
|---|---|
| 单测 | schema 校验、`check` 判定矩阵、caveat 边界、`resolveRepo` 归一化、prefix 最长匹配、状态机迁移 |
| 集成 | `listObjects` 与 `check` 一致性；组织→项目→需求→会话继承链；共享/过期/删除 |
| 代理 | SSE 断连 abort、大文件签名 URL 过期、PTY ticket 一次性 |
| e2e（接口级） | 注册→登录→建需求→建会话→SSE 对话→提交→PR→webhook→done；**每步校验 PG** |
| 安全 | 跨租户越权 → 404；token 不入日志；禁用用户立即失效 |
| 迁移 | dry-run 报告正确；回滚可用 |
| 多 pod | 会话/权限/限流行为一致 |

---

## 十五、分期

| 期 | 内容 | 验收 |
|---|---|---|
| **P0** | better-auth（注册/登录/bearer/session）；组织 + 角色；`relation_tuple` + `check`；需求 CRUD；会话列表/详情（只读代理） | 登录可用；需求 CRUD；越权 404 |
| **P1** | 会话创建/对话（REST+SSE 代理）；文件代理；`.netrc` 下发；Git 凭据配置（PAT + verify） | 完整对话闭环 |
| **P2** | Git：建仓、提交（API + 沙箱双路径）、PR、webhook、需求状态自动流转 | 建仓→提交→PR→merged→done |
| **P3** | `listObjects` 优化、自定义角色、caveats、审计面板、存量迁移、多 pod 压测 | 生产可用 |

---

## 十六、决策记录（ADR 摘要）

| # | 决策 | 理由 |
|---|---|---|
| 1 | 需求业务放 hn-base-server，SaaS 保持执行层 | SaaS 与用户无关；上层通过用户拿会话 |
| 2 | 采用 BFF 而非 scope_id/票据 | 归属判定集中一处；SaaS 零改动 |
| 3 | 授权用 ReBAC（`relation_tuple`） | 多级继承与共享是核心场景；纯 RBAC 会角色爆炸 |
| 4 | `owner_id/org_id` 仅查询字段 | 避免双真相；授权只走元组 |
| 5 | 不建 `user_session` 表 | `listObjects` 已能表达；避免三套归属 |
| 6 | JWT 走 bearer+session 为主、jwt/JWKS 为辅 | 可吊销 + 多 pod 一致 |
| 7 | Git 凭据组织资源只用 org/global | 避免个人 token 混用与离职失效 |
| 8 | 大文件/图片用短期签名 URL（仍指向 base-server） | 兼容 `<img>`，不改 SaaS |
| 9 | PTY 用一次性 ticket 直连 | WebSocket 代理成本高；ticket 绑定 session |
| 10 | 建表用幂等 ensure-schema | 与 hn-gateway 一致 |
