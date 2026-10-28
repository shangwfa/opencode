# opencode SaaS 作用域隔离（Scope Isolation）设计

> ⚠️ **DEPRECATED（2026-10-18）**：本方案（SaaS 加 `scope_id` + RLS）已被 **BFF 方案**取代。
> 最终决策见 `saas-access-control-options.md`：hn-app 不再直连 SaaS，由 hn-base-server 提供接口并代理；SaaS 保持零改动。
> 本文仅保留作为历史参考，**不要按此实现**。


> 背景：opencode SaaS 是**底层服务**（会话/沙箱/模型/文件），不应耦合「用户/组织」这类业务身份概念。
> 目标：在不引入用户体系的前提下，保证「A 拿不到 B 的数据」，同时保持底层通用性。
> 结论：**SaaS 只认不透明的 `scope_id`，身份与授权留在 hn-base-server。**

---

## 一、分层原则

```
┌─ hn-app ──────────────────────────────────────────┐
│  登录态、用户信息、组织切换（调 hn-base-server）      │
└───────────────┬───────────────────────────────────┘
                │ Bearer JWT { sub: userId, orgId, scope }
┌───────────────▼───────────────────────────────────┐
│ hn-base-server（身份/授权层）                       │
│  - 认「用户 / 组织 / 角色」                          │
│  - 签发 JWT（含 scope_id = orgId ?? userId）        │
└───────────────┬───────────────────────────────────┘
                │ 同一 JWT（SaaS 只验签，不查用户表）
┌───────────────▼───────────────────────────────────┐
│ opencode SaaS（底层，无状态多 pod）                 │
│  - 只认 scope_id（不透明字符串，不解释语义）         │
│  - 所有资源按 scope_id 隔离                        │
│  - 不查询 hn_auth schema，不依赖 base-server 在线    │
└───────────────────────────────────────────────────┘
```

**关键设计**：`scope_id` 是**不透明标识**。
- 单用户模式：`scope_id = userId`
- 组织模式：`scope_id = orgId`
- 未来换模型（team/project 级）：只改 claim 生成规则，SaaS 不动

---

## 二、认证：SaaS 如何相信这个 scope

**不能只信请求头**（客户端可伪造）。三种可选，建议 **方案 B**：

| 方案 | 做法 | 评价 |
|---|---|---|
| A. 共享密钥 HMAC | `X-Scope-Id` + `X-Signature` | 简单但密钥轮换麻烦 |
| **B. JWT + JWKS（建议）** | base-server 用 `jwt()` 插件签发，SaaS 用 `jose` 验签（`/.well-known/jwks.json`），公钥缓存 | 标准、可轮换、SaaS 无需回调 base-server |
| C. Session 透传 | SaaS 拿着 token 回调 base-server `getSession` | 每请求一次 RPC，且 base-server 故障会拖垮 SaaS |

**方案 B 细节**
```ts
// packages/server/src/middleware/scope.ts
const JWKS = jose.createRemoteJWKSet(new URL(`${env.AUTH_URL}/api/auth/jwks`))

export const scopeAuth = createMiddleware(async (c, next) => {
  const token = bearer(c.req.header("authorization")) ?? c.req.query("token")
  const { payload } = await jose.jwtVerify(token, JWKS, {
    issuer: env.AUTH_ISSUER,
    audience: env.SAAS_AUDIENCE,
  })
  c.set("scopeId", String(payload.scope ?? payload.sub))
  c.set("userId", String(payload.sub))
  await next()
})
```
- 公钥缓存 → 正常路径**零外部依赖**（只有首次/轮换时拉 JWKS）
- base-server 短暂不可用不影响已签发的 token（这正是选 B 的原因）

---

## 三、资源隔离：聚合根 + scope_id

### 3.1 只给「聚合根」加 scope_id（不污染子表）
| 聚合根 | 说明 |
|---|---|
| `session_v2` | 会话 |
| `project` | 代码工作区 |
| `sandbox` | 沙箱绑定 |
| `requirement`（业务侧） | 需求 |

子表（`session_message` / `part` / `file` / `todo` 等）**通过聚合根鉴权**，不重复加字段：
- 访问消息 → 先校验 `session_v2.scope_id`
- 访问文件 → 先校验 `session.sandbox/project` 归属

### 3.2 迁移
```sql
ALTER TABLE session_v2 ADD scope_id text NOT NULL DEFAULT 'legacy';
ALTER TABLE project    ADD scope_id text NOT NULL DEFAULT 'legacy';
ALTER TABLE sandbox    ADD scope_id text NOT NULL DEFAULT 'legacy';
CREATE INDEX session_v2_scope_idx ON session_v2 (scope_id);
CREATE INDEX project_scope_idx    ON project (scope_id);
CREATE INDEX sandbox_scope_idx    ON sandbox (scope_id);
```
- 存量数据统一 `legacy`，单租户模式下全部可见
- 新数据写真实 scope

---

## 四、强制隔离的两道防线

### 4.1 第一道：应用层统一封装（防止手写漏 WHERE）
把「按 scope 查询」收进数据访问层，禁止业务 handler 直接 `db.select().from(session)`：

```ts
// core/src/database/repository.ts（示意）
export const scopedSessions = (scopeId: string) =>
  db.select().from(sessionV2).where(eq(sessionV2.scopeId, scopeId))

export const assertSessionInScope = async (sessionId: string, scopeId: string) => {
  const row = await db.query.sessionV2.findFirst({ where: eq(sessionV2.id, sessionId) })
  if (!row) throw new NotFoundError()
  if (row.scopeId !== scopeId) throw new NotFoundError()  // 403 → 404，避免探测存在性
  return row
}
```

**约定**：所有按 id 访问的入口，第一行就是 `assert*InScope(id, scopeId)`。
- 越权返回 **404 而非 403**（不泄露资源是否存在）

### 4.2 第二道：PostgreSQL RLS 兜底（推荐）
即使 handler 忘了过滤，数据库也不会返回别人的行：

```sql
ALTER TABLE session_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_v2 FORCE ROW LEVEL SECURITY;

CREATE POLICY session_scope_isolation ON session_v2
  USING (scope_id = current_setting('app.scope_id', true));
```

每个请求在一个事务内设置：
```ts
await db.transaction(async (tx) => {
  await tx.execute(sql`SELECT set_config('app.scope_id', ${scopeId}, true)`)  // true = 事务级
  // ... 业务查询
})
```

**权衡**
| | 应用层封装 | RLS |
|---|---|---|
| 实现成本 | 低 | 中（每请求事务 + 连接池配置） |
| 防漏能力 | 依赖纪律 | **数据库强制** |
| 性能 | 无额外开销 | 每请求 set_config（可忽略） |
| 调试 | 容易 | 报错信息偏底层 |

**建议**：先做应用层封装（P0），关键表（`session_v2` / `project` / `sandbox`）在 P1 上 RLS 兜底。

---

## 五、SSE 与特殊通道

| 通道 | 鉴权方式 | 说明 |
|---|---|---|
| 普通 REST | `Authorization: Bearer` | 标准 |
| **SSE（`/api/session/:id/event`）** | Cookie 优先；`?token=` 兜底 | `EventSource` 不能带自定义 header |
| 文件/预览代理 | 同上 + scope 校验 | `/api/session/:id/fs/*`、preview 路由 |
| Shell API | Bearer + scope | |
| MCP / Tool Host（SaaS 内部） | 不需要 scope | 由会话 id 推导，不对外暴露 |
| Sandbox 控制面调用 | 不需要 scope | 内部链路 |

**SSE 的 `?token=` 风险**：会进访问日志/Referer。
- 用**短时效专用 token**（5 分钟，`scope` 限定单会话）
- 或优先走 Cookie（同域部署时最干净）

**实现建议**：SSE 端点先做 cookie 校验，失败再读 query token；统一抽成 `resolveScope(req)`。

---

## 六、不需要 scope 的路径（避免过度设计）

- SaaS → OpenSandbox 控制面（execd / 端口网关 / 生命周期）：内部链路
- SaaS → Session MCP / Tool Host daemon：会话内
- 健康检查、metrics、`/doc`：公开
- 模型 provider 回调：按 provider 协议

**判断标准**：只有「外部入口且访问用户数据」的 HTTP 路由需要 scope。

---

## 七、灰度与兼容

1. **开关**：`OPENCODE_SCOPE_ENFORCE=off|log|on`
   - `off`：不校验（现状，兼容）
   - `log`：校验但只记日志（观察越权面）
   - `on`：强制
2. **默认 scope**：未带 token 的请求（内部/本地开发）落到 `legacy`
3. **迁移顺序**：先加字段 + 写 scope → 开 `log` 观察 → 修完漏点 → 切 `on`

---

## 八、与用户体系的边界（明确分工）

| 能力 | hn-base-server | opencode SaaS |
|---|---|---|
| 用户/组织/角色 | ✅ | ❌ |
| 登录/注册/OAuth | ✅ | ❌ |
| 签发/轮换 JWT | ✅ | ❌ |
| 验签 + 提取 scope | ❌ | ✅ |
| 资源按 scope 过滤 | ❌ | ✅ |
| 业务授权（能否建需求） | ✅（RBAC） | ❌ |
| 数据归属（owner/org） | ❌（业务表在 SaaS） | ✅ |

> SaaS 内部的 `requirement` 等业务表用 `owner_id/org_id` 做业务归属；`session/project/sandbox` 用 `scope_id` 做隔离。两者职责不同，不混用。

---

## 九、测试

- **单元**：`resolveScope`（header/cookie/query 三来源优先级）、JWT 验签失败路径、`assert*InScope` 越权返回 404
- **集成**：scope A 的 token 访问 scope B 的 session → 404（REST + SSE 都要测）
- **RLS**：故意写一个不带 WHERE 的查询，验证只返回本 scope 行
- **回归**：`legacy` scope 存量数据在 `off` 模式下行为不变
- **多 pod**：两个进程共享 JWKS 缓存与 PG，行为一致

---

## 十、结论

- SaaS **不实现用户体系**，只实现「scope 隔离」；身份/授权在 hn-base-server
- 信任链：`JWT 验签（JWKS）` → `scope_id` → `聚合根过滤` → `RLS 兜底`
- 越权一律返回 **404**（不泄露存在性）
- 灰度开关 + `legacy` 默认 scope 保证存量兼容
- 这样既满足"底层服务"的通用性，又能杜绝「拿到 session id 就能读别人数据」

## 十一、实现步骤（文件级）

> 基于当前代码结构实测：SaaS 用 Effect + `HttpApiBuilder`；已有 `middleware/authorization.ts`（HTTP Basic）与 `middleware/session-location.ts`（按 sessionID 加载会话并注入 location 上下文）。scope 校验应插在后者，而不是散落到各 handler。

### Phase 0：数据层（不改行为，可先上线）
| 动作 | 文件 |
|---|---|
| 加 migration（`scope_id` + 索引，默认 `'legacy'`） | `packages/core/src/database/migration/<ts>_add_scope_id.ts` |
| drizzle schema 加字段 | `packages/core/src/session/sql.ts`（`SessionTable`）、`project/sql.ts`、`sandbox/sql.ts` |
| `Session.Info` 加 `scopeId` | `packages/core/src/session.ts`（Info 定义处） |
| 创建会话时写入 scope | `packages/core/src/session.ts`（create 逻辑） |

```sql
ALTER TABLE session_v2 ADD scope_id text NOT NULL DEFAULT 'legacy';
ALTER TABLE project    ADD scope_id text NOT NULL DEFAULT 'legacy';
ALTER TABLE sandbox    ADD scope_id text NOT NULL DEFAULT 'legacy';
CREATE INDEX session_v2_scope_idx ON session_v2 (scope_id);
CREATE INDEX project_scope_idx    ON project (scope_id);
```

### Phase 1：请求级 ScopeContext（认证升级）
新增 `packages/server/src/middleware/scope.ts`：

```ts
// 示意：把校验后的身份放进请求级 Context
export class ScopeContext extends Context.Tag("@opencode/Scope")<
  ScopeContext,
  { scopeId: string; userId: string; enforced: boolean }
>() {}

// 来源优先级：Authorization: Bearer <jwt> → cookie → query auth_token（SSE/WS）
// 验签用 jose + remote JWKS（公钥缓存），失败 → UnauthorizedError
export const scopeLayer = Layer.effect(ScopeContext, Effect.gen(function* () {
  // 读 AUTH_JWKS_URL / AUTH_ISSUER / AUTH_AUDIENCE；未配置时返回 legacy + enforced=false
  ...
}))
```

**改造点**：`middleware/authorization.ts`
- 保留现有 Basic 分支（本地开发/兼容），新增 Bearer JWT 分支
- 注意现有的例外路径（PTY ticket、`/api/connector/mcp`、OAuth callback、webhook）**保持不变**
- 现有 query `auth_token` 逻辑复用于 SSE/WS

### Phase 2：隔离校验（核心，一处生效）
改 `packages/server/src/middleware/session-location.ts`——在 `sessionInfo()` 之后加一道：

```ts
const session = yield* sessionInfo(sessions, route.params.sessionID)
const scope = yield* ScopeContext
if (scope.enforced && session.scopeId !== scope.scopeId) {
  // 越权按 404 处理，不泄露存在性
  return yield* new SessionNotFoundError({ sessionID: session.id })
}
return yield* effect.pipe(instances.provide(session))
```

**为什么这一处就够**：所有会话子资源（message / part / file / todo / permission / shell / event）都经过 `SessionLocationMiddleware`，它们在拿到 location 之前就已经完成了归属校验。

**同样处理 project**：若存在 project 级中间件（`/project/:projectID`），加同样的 `scopeId` 比对；`sandbox` 通过 session 推导，不单独校验。

### Phase 3：创建路径写入 scope
- `POST /session`、`POST /session/:id/fork`、子会话创建（intake 子任务）→ `scopeId` 取 `ScopeContext`；**子会话继承父会话的 scope**
- `POST /project` → 同

### Phase 4：SSE 与代理通道
- `packages/server/src/session-stream.ts`：复用 `resolveScope`（cookie 优先，query token 兜底），校验后订阅
- preview / fs 代理路由：走同一 middleware，无需单独逻辑
- `?token=` 限定：5 分钟时效 + 单 session scope（避免日志泄露后长期可用）

### Phase 5：RLS 兜底（P1）
```sql
ALTER TABLE session_v2 ENABLE ROW LEVEL SECURITY;
CREATE POLICY session_scope ON session_v2
  USING (scope_id = current_setting('app.scope_id', true));
```
- 每请求事务内 `SELECT set_config('app.scope_id', $1, true)`
- 先在测试环境验证连接池行为（`SET LOCAL` 是事务级）

### Phase 6：灰度
| 开关 | 行为 |
|---|---|
| `OPENCODE_SCOPE_ENFORCE=off` | 不校验（默认，兼容现状） |
| `=log` | 校验但只打日志（观察越权面） |
| `=on` | 强制 404 |

**上线顺序**：Phase 0（加字段）→ 1+2 以 `log` 观察 → 修漏点 → 切 `on` → Phase 5 RLS。

### 测试清单
| 层级 | 用例 |
|---|---|
| 单测 | `resolveScope`（Bearer/cookie/query 优先级）、JWT 验签失败、`scope_id` 不匹配返回 404 |
| 集成 | A 的 token 访问 B 的 session（REST + SSE）→ 404；子资源（message/file）同样 404 |
| 兼容 | `off` 模式下 `legacy` 存量数据行为不变；Basic Auth 本地开发仍可用 |
| 多 pod | 两进程共享 PG + JWKS 缓存，行为一致 |
| RLS | 故意写不带 WHERE 的查询，只返回本 scope 行 |

### 风险与注意
1. **Effect Layer 的请求级状态**：`ScopeContext` 必须按请求创建（不能是全局单例），否则多请求串 scope
2. **例外路径**（PTY ticket / connector MCP / OAuth callback / webhook）不要误加校验，否则会断功能
3. **`legacy` 不能长期存在**：上线后要有清理计划（迁移到真实 scope）
4. **JWKS 不可达**：降级策略要明确（拒绝请求 vs 放行）——建议**拒绝**（fail-closed），并缓存上次公钥

---

## 十二、其他必须注意的点（逐条核查过代码）

### 12.1 🔴 存储层共享会绕过 scope（最容易被忽略）
`session_v2.app_id` + `pvcMode="app"` 时，**多个会话共享同一个 PVC volume 前缀**（`handlers/session.ts:60` 注释明确说明）。这意味着：
- 即使 HTTP 层 scope 隔离正确，A 的会话仍可能**物理上读写** B 的 app volume 内容
- 必须约束：`app_id` 归属某个 scope（或全局唯一且不可跨 scope 复用）
- 校验点：创建 `pvcMode="app"` 会话时，校验 `app_id` 属于当前 scope
- 如果 app_id 来自外部（hn-gateway 的 appId），需要建立 `app_id ↔ scope` 映射并强校验

### 12.2 子会话 / 派生会话的 scope 必须继承
- `parent_id` 子会话（agent 内部创建、intake 子任务）**没有 HTTP 请求上下文**，不能从 header 读 scope
- 规则：子会话 `scope_id = 父会话.scope_id`，在 `Session.create` 内部继承，不依赖调用方传参
- `fork_session_id` 同上

### 12.3 会话导入/导出（`SessionTransfer`）
- `import` 别人导出的会话时，**scope 必须设成导入者的 scope**（而不是导出数据里的原 scope），否则要么看不到、要么越权
- 导入前校验 `parentID` 存在且同 scope

### 12.4 项目复制 / worktree
- `experimental/project/{id}/copy`、`worktree.create` 产生的新 project 要写入当前 scope
- `project_directory` 是 project 的子资源，通过 project 鉴权即可

### 12.5 PTY ticket 必须绑 scope
- PTY connect 走 ticket 绕过 Basic 校验（现有设计），但 **ticket 本身要绑定 session 的 scope**
- 否则拿到 ticket URL 就能连别人的终端
- ticket 应短时效 + 一次性（现有实现是否已如此需确认）

### 12.6 连接池 + RLS 的经典陷阱
- `set_config('app.scope_id', $1, true)` 是**事务级**：没有显式事务时会失效（静默不隔离）
- 必须确保每请求都包在事务里；且连接归还池前事务已结束
- 建议：上线 RLS 前先写一个"故意不带 WHERE"的测试验证隔离真的生效

### 12.7 灰度期间新旧 pod 混跑
- 旧 pod 不写 scope、也不校验 → 新 pod 写入的会话旧 pod 读不到（如果旧 pod 也加了过滤）或反之
- 顺序必须是：**先全量升级到"写 scope 但不校验"（Phase 0）→ 再逐 pod 开 `log` → 最后开 `on`**
- 不能跳过 Phase 0 直接开 `on`

### 12.8 JWT 相关
- **时钟偏移**：`jwtVerify` 要配 `clockTolerance`（如 30s），否则多机部署偶发 401
- **密钥轮换**：JWKS 支持多 `kid`，轮换时新旧并存；缓存 TTL 不宜过长（建议 10 分钟）
- **`audience` 必须校验**：防止 base-server 签发给其他服务的 token 被 SaaS 接受
- **`scope` claim 缺失时**：不要默认放行，按 `sub` 处理或拒绝

### 12.9 客户端差异
- hn-app（Web）：Cookie 或 Bearer
- CLI / 桌面端：直连 SaaS，可能没有用户体系 → 本地单用户模式走 `off` + `legacy`
- 第三方集成（connector）：走已有 engine token，不走 scope

### 12.10 可观测性
- **越权尝试要记录**（虽然对外返回 404）：`scope_id`、`resource_id`、`user_id`、IP、UA → 便于发现攻击
- 指标：`scope_mismatch_total`、`jwt_verify_failure_total`、`jwks_fetch_errors_total`
- 日志**不得包含** token 原文（含 query `?token=` 的情况）

### 12.11 数据清理与存量
- `legacy` scope 的存量会话要在切 `on` 之前完成归属（否则用户突然看不到历史会话）
- 建议：按 project 的目录/创建者归属回填；无法判定的人工确认
- 回填要有 dry-run 报告

### 12.12 越权语义的一致
- 统一 **404**（不泄露存在性），但**不要**把"参数非法"也变成 404（否则调试困难）
- 区分：资源不存在 / 资源存在但无权限 → 都 404；参数格式错误 → 400



- SaaS **不实现用户体系**，只实现「scope 隔离」；身份/授权在 hn-base-server
- 信任链：`JWT 验签（JWKS）` → `scope_id` → `聚合根过滤` → `RLS 兜底`
- 越权一律返回 **404**（不泄露存在性）
- 灰度开关 + `legacy` 默认 scope 保证存量兼容
- 这样既满足"底层服务"的通用性，又能杜绝「拿到 session id 就能读别人数据」
