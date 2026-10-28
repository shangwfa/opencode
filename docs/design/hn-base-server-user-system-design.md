# hn-base-server 通用用户体系设计（Hono + better-auth）

> ✅ **已并入 `total-design.md`（2026-10-18）**：本文保留作为背景与论证过程，实现以总设计为准。


> 决策已定：① 自建 user 为主体 + `external_identity` 绑外部源；② JWT + refresh + 黑名单；③ user 与组织都做；④ 不对接 hn-gateway SSO；⑤ 用 better-auth 简化；⑥ 落 `packages/hn-base-server`，技术栈 Hono。
> 本文为设计，未实现。

## 一、技术选型（对齐 hn-gateway 约定）

| 层 | 选型 | 依据 |
|---|---|---|
| HTTP | **Hono**（`@hono/node-server`） | 用户指定；hn-gateway 同栈 |
| ORM/DB | **drizzle-orm + pg** | hn-gateway `package.json` 同栈 |
| 校验 | **zod** | 同栈 |
| 认证 | **better-auth** | 用户指定；自带 user/session/account/org/RBAC 插件体系 |

`packages/hn-base-server`（当前为空目录）职责：**通用底座服务**——身份、认证、授权、组织、凭据归属。业务（需求/git provider/会话）在 opencode SaaS 侧引用其用户/组织 ID，不在本包内实现。

---

## 二、better-auth 能力 → 我们的需求映射

| 我们的需求 | better-auth 对应 | 备注 |
|---|---|---|
| 自建 user 为主体 | `user` 表 + `emailAndPassword` | 可加 `username` 插件 |
| external_identity 绑外部源 | `account` 表 + `socialProviders` / `genericOAuth` / `sso` | `accountLinking: {enabled:true, trustedProviders:[...]}` |
| session 认证 | `session` 表 + `bearer()` 插件 | `Authorization: Bearer <session.token>` |
| JWT + JWKS | `jwt()` 插件 | 签发标准 JWT、暴露 `/.well-known/jwks.json`、`/api/auth/token` |
| refresh | `session.updateAge` 续期 / `jwt()` 的 refresh | 见第四节 trade-off |
| 黑名单（吊销） | 删 session 行 **或** 自定义黑名单表 | 见第四节 trade-off |
| 用户+组织 | `organization()` 插件 | org / member / invitation / team + role |
| RBAC | `createAccessControl` + `adminAc/ownerAc/memberAc` + 自定义 role | 可扩展 `resource_grant` 做资源级授权 |
| API key（服务间） | `apiKey()` 插件 | 供 SaaS→base-server 调用 |
| 扩展（可插拔） | `twoFactor` / `passkey` / `magicLink` / `emailOtp` / `admin` / `multiSession` | 都是开关式插件 |

---

## 三、表结构（drizzle + pg，schema `hn_auth`）

### 3.1 better-auth 核心（由 `npx auth@latest generate` 生成，不手写）
```
user          id, name, email, emailVerified, image, createdAt, updatedAt
              + additionalFields: { role, status }
session       id, token, userId, expiresAt, ipAddress, userAgent, createdAt, updatedAt
              + activeOrganizationId          # organization 插件加
account       id, userId, providerId, accountId, accessToken, refreshToken, idToken,
              accessTokenExpiresAt, scope, password, createdAt, updatedAt   # ← external_identity 落点
verification  id, identifier, value, expiresAt, createdAt, updatedAt
```

### 3.2 organization 插件
```
organization   id, name, slug, logo, metadata, createdAt, updatedAt
member         id, organizationId, userId, role, createdAt
invitation     id, organizationId, email, role, status, expiresAt, inviterId
team           id, organizationId, name, createdAt
teamMember     id, teamId, userId, createdAt
```

### 3.3 我们补的表（业务侧 + 扩展）
```
-- 细粒度资源授权（补上现有 permission 表"无主体"的缺口）
resource_grant    id, subject_type('user'|'org'|'role'), subject_id,
                  resource_type, resource_id, action, effect('allow'|'deny'),
                  time_created, time_updated

-- JWT 黑名单（若走"纯 JWT + refresh"路径；走 bearer+session 路径可省）
token_blacklist   jti text PRIMARY KEY, user_id, expires_at, reason, time_created

-- 审计
audit_log         id, actor_type, actor_id, action, resource_type, resource_id,
                  ip, user_agent, metadata, time_created
```

### 3.4 业务表如何挂用户/组织（在 opencode SaaS 侧，已定稿）
```sql
ALTER TABLE requirement      ADD owner_id text NOT NULL, ADD org_id text;
ALTER TABLE requirement      ADD CONSTRAINT fk_req_owner FOREIGN KEY (owner_id) REFERENCES hn_auth.user(id);
CREATE INDEX requirement_owner_idx ON requirement (owner_id);
CREATE INDEX requirement_org_idx   ON requirement (org_id);
ALTER TABLE session_v2       ADD user_id text NOT NULL, ADD org_id text;
ALTER TABLE sandbox          ADD org_id text;
ALTER TABLE git_provider_instance ADD owner_type text NOT NULL, ADD owner_id text;
ALTER TABLE git_credential   ADD owner_type text NOT NULL, ADD owner_id text;   -- 落 D10 决策
```

---

## 四、JWT + refresh + 黑名单：两条路径与建议 ⚠️

用户要求「JWT + refresh + 黑名单表」。better-auth 有两条实现路径，**语义不同，需要拍板**：

### 路径 A：`bearer()` + session 表（**建议**）
- 凭证是 **session token**（随机串），存 PG `session` 表
- `Authorization: Bearer <session.token>` —— 外观就是 JWT 式 bearer
- **吊销 = 删除/过期 session 行**，天然"黑名单"，无需额外表
- refresh = `session.updateAge`（默认每小时续期），`expiresIn` 控制总时长
- 无状态服务多 pod：所有 pod 查同一 PG session 表即可

✅ 优点：可吊销即时生效、实现最简、无需手写黑名单逻辑
⚠️ 缺点：token 不是标准 JWT（不能被第三方用 JWKS 独立验签）

### 路径 B：`jwt()` 插件（**纯 JWT + refresh + 黑名单表**）
- 签发标准 JWT（短时效，如 15min）+ refresh token（长时效）
- 每次校验要查 `token_blacklist`（多一次 PG 查询）
- 适合**跨服务/第三方**用 JWKS 独立验签

✅ 优点：标准 JWT、可被其他服务验签、可缓存公钥
⚠️ 缺点：吊销延迟（要靠黑名单）、黑名单表与清理任务、复杂度高

### 建议：**A 为主 + B 按需**
- 主链路（hn-app ↔ hn-base-server ↔ SaaS）用 **A（bearer + session）**，兼顾可吊销与多 pod
- 需要给**外部系统/CLI/第三方**发凭证时，用 **B（jwt 插件）** 暴露 JWKS
- `apiKey()` 插件用于服务间调用（长时效、可吊销、带 scope）

> 这样"JWT 形态的 bearer token + 可吊销 + refresh"都满足，且不用为日常场景维护黑名单表；黑名单表保留给纯 JWT 路径（B）使用。

---

## 五、授权模型（RBAC → 可扩展 ABAC）

### 5.1 角色（organization 插件的 access control）
```ts
import { createAccessControl } from "better-auth/plugins/access"
import { adminAc, ownerAc, memberAc } from "better-auth/plugins/organization/access"

const ac = createAccessControl({
  // 资源-动作矩阵（可按需扩展）
  requirement: ["create", "read", "update", "delete", "publish"],
  session: ["create", "read", "stop"],
  gitProvider: ["connect", "read", "createRepo", "commit"],
  member: ["invite", "update", "remove"],
})

const roles = {
  owner: ownerAc,        // 全权
  admin: adminAc,        // 管理
  member: memberAc,      // 普通
  viewer: ac.newRole({   // 自定义只读
    requirement: ["read"], session: ["read"], gitProvider: ["read"],
  }),
}
```
- 好处：**新增自定义角色不动核心**（示例里就有 `restricted` 角色），符合"可插拔"

### 5.2 资源级授权（可选，细粒度）
`resource_grant` 表做「用户/组织/角色 对 某资源 的 action 授权」，支持 allow/deny。
- 起步用 org 级 RBAC（member/admin/owner）即可
- 需要"某人只能看自己需求"→ 加 `requirement.owner_id = user.id` 过滤
- 需要"跨组织共享某需求"→ 用 `resource_grant`

### 5.3 校验入口（中间件）
```ts
// packages/hn-base-server/src/middleware/auth.ts
export const requireAuth = createMiddleware(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) throw new HTTPException(401)
  c.set("session", session)
  c.set("userId", session.user.id)
  c.set("orgId", session.session.activeOrganizationId ?? null)
  await next()
})

export const requirePermission = (resource: string, action: string) =>
  createMiddleware(async (c, next) => {
    const { user, orgId } = c.get("session")
    const ok = await checkPermission({ userId: user.id, orgId, resource, action })
    if (!ok) throw new HTTPException(403)
    await next()
  })
```

---

## 六、Hono 集成（hn-base-server 结构）

```
packages/hn-base-server/
  src/
    server.ts                 # Hono app + @hono/node-server
    auth/
      index.ts                # betterAuth({...}) 实例
      schema.ts               # drizzle schema（npx auth generate）
      access.ts               # createAccessControl + roles
      plugins.ts              # bearer/jwt/apiKey/organization/twoFactor
    middleware/
      auth.ts                 # requireAuth / requirePermission / activeOrg
    routes/
      auth.ts                 # app.all("/api/auth/*", auth.handler)
      user.ts                 # /api/user/*（个人信息、external_identity 绑定）
      org.ts                  # /api/org/*（组织、成员、邀请）
      grant.ts                # /api/grant/*（资源授权，可选）
    db/
      schema.ts               # drizzle pg schema
      migrate.ts
    config/env.ts             # BETTER_AUTH_URL / SECRET / DATABASE_URL
  drizzle.config.ts
  package.json                # hono @hono/node-server drizzle-orm pg zod better-auth
```

### 6.1 better-auth 实例（示意）
```ts
export const auth = betterAuth({
  appName: "hn-base-server",
  baseURL: env.BETTER_AUTH_URL,
  basePath: "/api/auth",
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, { provider: "pg", schema: authSchema, schemaName: "hn_auth" }),
  emailAndPassword: { enabled: true, minPasswordLength: 8 },
  account: { encryptOAuthTokens: true, accountLinking: { enabled: true, allowDifferentEmails: true } },
  session: { expiresIn: 60*60*24*30, updateAge: 60*60, cookieCache: { enabled: true, maxAge: 60*60*24 } },
  user: { additionalFields: { role: { type: "string", defaultValue: "user", input: false } } },
  trustedOrigins: [env.WEB_ORIGIN],
  plugins: [
    bearer(),                                        // Bearer session token
    jwt({ disableSettingJwtHeader: true, jwt: { issuer, audience, definePayload } }),  // 跨服务
    apiKey({ /* prefix: { apiKey: "hn_" } */ }),
    organization({ ac, roles, allowUserToCreateOrganization: true, creatorRole: "owner" }),
    // 后续可插拔：twoFactor() / passkey() / magicLink() / emailOtp() / admin()
  ],
})
```

### 6.2 路由挂载
```ts
const app = new Hono()
app.use("/api/*", cors({ origin: env.WEB_ORIGIN, credentials: true }))
app.all("/api/auth/*", (c) => auth.handler(c.req.raw))   // 必须在 catch-all 之前
app.use("/api/user/*", requireAuth)
app.use("/api/org/*", requireAuth)
app.route("/api/grant", grantRoutes)
```

---

## 七、与现有模块的整合

| 模块 | 整合方式 |
|---|---|
| `core/credential` | 扩展归属：`owner_type(user\|org\|global)` + `owner_id`；沿用已有 `metadata.orgID` 模式 |
| git provider | 实例/凭据挂 `owner_id`；校验时用当前 user/org 匹配 |
| requirement | `owner_id` / `org_id`；列表默认只看自己/本组织 |
| session_v2 / sandbox | `user_id` / `org_id`；SSE 鉴权也走 `requireAuth` |
| opencode SaaS | 通过 `Authorization: Bearer` 透传用户；SaaS 侧校验 JWKS（路径 B）或查 session（路径 A） |
| `packages/identity` | 现为空（仅 logo），可考虑迁移品牌资源或删；不要与本方案混淆 |

---

## 八、可插拔/扩展点（「拖拽性」落点）

1. **认证源插件化**：`socialProviders` / `genericOAuth` / `sso` / `passkey` / `magicLink` 全是开关式插件，新增源不动核心
2. **角色可扩展**：`createAccessControl` + 自定义 role（如 `viewer`/`restricted`），无需改表
3. **授权可演进**：RBAC → 加 `resource_grant`（资源级）→ ABAC（属性：环境/时间/标签）
4. **租户可伸缩**：user → org → team → 未来多租户（资源表已带 `org_id`）
5. **凭据归属可插拔**：`owner_type` 三档（user/org/global）
6. **JWT 形态可切**：bearer(session) ↔ jwt(标准)，第四节两条路径可并存

---

## 九、迁移路径

| 期 | 内容 |
|---|---|
| **P0** | hn-base-server 脚手架（Hono + drizzle + pg + zod）；better-auth 接入（email/password + bearer + session）；user/session/account 表；`requireAuth` 中间件；登录/注册 API |
| **P1** | organization 插件（org/member/invitation + role）；`activeOrganizationId`；业务表加 `owner_id/org_id` |
| **P2** | RBAC（access control + 自定义角色）；`resource_grant` 资源级授权；审计日志 |
| **P3** | 外部认证源（genericOAuth / SSO / 飞书）；`jwt()`+JWKS 供第三方；`apiKey()` 服务间；2FA/passkey |

---

## 十、测试策略

- **单测**：`requireAuth` / `requirePermission` 中间件；access control 角色判定；`resource_grant` 匹配；org 成员角色变更
- **e2e**（REST + PG 校验）：注册→登录→拿 bearer token→调受保护 API→401/403 边界；组织创建/邀请/接受/角色变更；token 吊销后 401
- **多 pod 校验**：两个进程共享 PG session，token 互认
- **安全**：密码哈希、token 不进日志、CORS 白名单、`trustedOrigins` 防 CSRF

---

## 十一、决策状态

### 已确认（2026-10-18）
1. **JWT 路径：A + B 组合** —— 主链路 `bearer()` + session 表（可吊销、多 pod 一致）；跨服务/第三方用 `jwt()` + JWKS。黑名单表仅为纯 JWT 路径保留。
2. **hn-base-server 边界**：只管身份/认证/授权/组织；业务表（需求/会话/git provider/凭据）仍在 opencode SaaS，通过 `owner_id / org_id` 关联。
3. **外部认证源优先级**：P3 先接 **GitHub** 与 **Google**（`socialProviders`），飞书后置。

### 待确认
- ~~组织是否强制~~ → **已确认：折中方案（见第十二节）**

---

## 十二、组织归属模型（已确认：折中方案）

**结论：`owner_id` 必填 + `org_id` 可空**，先按「user 级独立」实现，组织能力完整。

### 12.1 定稿规则
| 规则 | 内容 |
|---|---|
| 归属字段 | 资源表统一 `owner_id text NOT NULL` + `org_id text NULL` |
| 个人资源 | `owner_id = user.id`，`org_id = NULL` |
| 组织资源 | `owner_id = user.id`（创建者），`org_id = organization.id` |
| 可见性 | 个人资源仅本人可见；组织资源按 org 成员角色可见 |
| 查询 | 两条合并：`owner_id = me` **OR** `org_id IN (我的组织)` |
| 授权校验 | 个人资源：`owner_id = me`；组织资源：按 org 角色（RBAC） |

### 12.2 表字段定稿
```sql
-- 需求
owner_id text NOT NULL,     -- 创建者
org_id   text,              -- 可空；NULL = 个人资源
CREATE INDEX requirement_owner_idx ON requirement (owner_id);
CREATE INDEX requirement_org_idx   ON requirement (org_id);

-- 会话 / 沙箱
session_v2.user_id text NOT NULL, session_v2.org_id text,
sandbox.org_id text,

-- Git provider 实例与凭据（三档归属）
git_provider_instance.owner_type text NOT NULL,  -- 'user' | 'org' | 'global'
git_provider_instance.owner_id   text,
git_credential.owner_type        text NOT NULL,
git_credential.owner_id          text,
```

**Git 凭据归属三档说明**
- `user`：个人 PAT，仅本人可用（默认）
- `org`：组织共享 token，成员按角色使用（团队场景）
- `global`：运维注入（如服务级只读 token）

### 12.3 升级路径（未来要收紧为「强制 org」）
1. 加约束：`org_id NOT NULL`
2. 数据回填：为 `org_id IS NULL` 的个人用户自动创建默认组织（`{username} 的空间`），并把其个人资源迁入
3. 查询逻辑从「个人 OR 组织」退化为「按 org」，代码变更集中在查询封装层（一个函数）
4. **不需要改表结构**，只加约束 + 回填

### 12.4 实现要点
- 所有列表查询走统一封装 `visibleScope(userId, orgIds)`，避免业务代码各写一套 WHERE
- 个人资源转组织：`POST /api/requirement/:id/transfer {orgId}`（校验调用者是 owner + 目标 org 成员）
- git 凭据解析：先找 `owner_type='user' AND owner_id=me`，再找 `owner_type='org' AND owner_id IN myOrgs`，最后 `global`（就近优先，最长前缀匹配）
