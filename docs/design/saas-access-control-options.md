# SaaS 访问边界方案对比（归属留在上层）

> ✅ **已并入 `total-design.md`（2026-10-18）**：本文保留作为背景与论证过程，实现以总设计为准。


> 用户观点：**opencode SaaS 底层跟用户没关系**；只要能「通过用户拿到会话」，上层就能拿到该会话的一切。
> 本文评估这个方向下的几种实现拓扑，选出改动最小且安全的方案。
> 前置事实：hn-app 目前**直连** SaaS REST（无 BFF）；SaaS 已有 `SessionLocationMiddleware` 按 sessionID 加载会话。

---

## 一、方向确认：哪些东西可以留在上层

| 能力 | 放哪 | 说明 |
|---|---|---|
| 用户 / 组织 / 角色 | 上层（hn-base-server） | SaaS 不感知 |
| 「用户能访问哪些会话」的判断 | 上层 | 需要一份归属索引 |
| 会话列表（我的会话） | **上层** | SaaS 的全局列表 API 不应暴露给用户 |
| 会话内容/消息/文件/沙箱 | SaaS | 按 session id 提供服务 |
| 会话内执行（agent/工具） | SaaS | 与用户无关 |

**关键**：只要「用户 → 会话」的判定在上层完成，SaaS 就只需要确认**这次请求针对的会话是被允许的**。这可以用「会话票据」实现，而不必在 SaaS 里建用户/组织模型。

---

## 二、四种方案对比

### 方案 A：BFF 代理（所有请求经上层转发）
```
用户 → hn-app → hn-base-server(BFF，校验归属) → SaaS（服务级 API key）
```
- ✅ SaaS 零改动；归属逻辑集中
- ❌ 所有请求/SSE 都多一跳；文件与 preview 代理负担大；BFF 成为性能与可用性瓶颈
- ❌ 流式输出（SSE）经 BFF 转发需要额外处理

### 方案 B：会话票据（**推荐**）
```
用户 → hn-app → base-server: 请求 ticket(sessionId) → 拿到短时效 ticket
              → SaaS: Authorization: Bearer <ticket>
SaaS 只验签 + 校验 ticket.sid === 路由里的 sessionId（不认用户）
```
- ✅ **SaaS 不改表、不建用户模型、不做 scope 过滤**
- ✅ 归属判定完全在上层（谁能拿到 ticket）
- ✅ 直连保留，无代理瓶颈
- ⚠️ 需要：上层维护归属索引；SaaS 的**全局列表 API** 不能对用户开放
- ⚠️ ticket 需要短时效 + 绑定 sessionId

### 方案 C：scope_id 表隔离（此前设计）
- ✅ 数据库级强制（可上 RLS）、列表可安全过滤
- ❌ SaaS 要加字段/迁移/RLS；引入"scope"这个半业务概念
- ❌ 与用户「底层无关」的定位冲突

### 方案 D：裸奔（SaaS 无鉴权或仅 Basic）
- ❌ 拿到 session id 即可读别人数据，不可接受

---

## 三、推荐：方案 B（会话票据）

### 3.1 票据形态
```json
{
  "typ": "session-ticket",
  "sid": "ses_xxx",        // 绑定的会话
  "sub": "user_123",       // 仅审计用，SaaS 不据此授权
  "aud": "opencode-saas",
  "exp": 1750000000,       // 短时效（如 10 分钟）
  "jti": "..."
}
```
- 由 hn-base-server 用私钥签名，SaaS 用 JWKS 公钥验签
- **SaaS 只做两件事**：验签 + `payload.sid === route.params.sessionID`
- 用户/组织语义完全不进 SaaS

### 3.2 SaaS 侧改动（很小）
改 `middleware/authorization.ts` 增加票据分支（或新增 `ticket.ts` 中间件）：

```ts
// 现有 Basic 分支保留（本地/内部）
const payload = await verifyTicket(token)          // jose + JWKS
const route = yield* HttpRouter.RouteContext
if (payload.sid !== route.params.sessionID) {
  return yield* new SessionNotFoundError({ sessionID: route.params.sessionID })
}
```

**不需要**：改表、加 scope_id、RLS、列表过滤。

### 3.3 上层需要新增什么
1. **归属索引**：`user_session { user_id, session_id, org_id?, role, time_created }`
   - 创建会话时写入（与 `requirement_session` 可复用/合并）
   - 子会话（agent 内部创建）由 SaaS 回调或创建时带上父会话归属
2. **ticket 签发接口**：`POST /api/session/:id/ticket`
   - 校验 `user_session` 中有该用户对该会话的访问权
   - 返回 10 分钟 ticket
3. **会话列表接口**：`GET /api/sessions`（从自己的索引返回，不调 SaaS 的全局列表）

### 3.4 必须处理的三条路径
| 路径 | 处理 |
|---|---|
| REST | `Authorization: Bearer <ticket>` |
| **SSE** | `?ticket=`（EventSource 不能带 header）；短时效 + 绑定 sid |
| **图片/preview/文件** | 用签名 URL（ticket 放 query）或短时效 public URL |

### 3.5 必须禁用的入口
- `GET /session`（全局列表）→ 对用户侧**不暴露**（否则泄露所有租户会话）
- 任何"按目录/项目列举"的全局接口 → 同上
- 若内部需要，用服务级 API key 且不对外

---

## 四、方案 B 的残余风险与对策

| 风险 | 对策 |
|---|---|
| ticket 泄露 | 短时效（10min）+ 绑定 sid + 可吊销（jti 黑名单，可选） |
| 全局列表 API 忘了关 | 上线前审计所有「无 sessionID 的会话类路由」；默认拒绝 |
| 子会话归属丢失 | 创建子会话时必须带上父会话的归属（SaaS 内部继承 sid 链） |
| 文件/预览 URL 长期有效 | 签名 URL 短时效，禁止永久链接 |
| 多 pod | JWKS 公钥缓存，无状态 |
| 票据覆盖不到的运维接口 | 内部接口用服务级 key，且网络层隔离 |

---

## 五、与「项目/需求」的关系

- **项目**（业务应用）跟 hn-gateway 走，不涉及本节
- **需求** → 会话的映射在上层（`requirement_session`），签 ticket 前校验
- 一个需求多会话（1:N）时，ticket 按具体 sessionId 签发，不按需求

---

## 七、最终决策：BFF（hn-base-server 提供新接口，hn-app 调用）

> 前文的「会话票据」「scope_id 表隔离」**不采纳**。
> 决策：**opencode SaaS 保持纯底层（不感知用户）；hn-base-server 新增会话访问接口，hn-app 调用 base-server，由 base-server 校验归属后再调 SaaS。**

### 7.1 拓扑
```
hn-app ──(用户身份 Bearer)──▶ hn-base-server ──(服务级凭证)──▶ opencode SaaS
                                 │
                                 ├─ 校验 user → session 归属
                                 ├─ 维护归属索引 user_session
                                 ├─ 代理 REST / SSE / 文件
                                 └─ 会话列表（自己的索引）
```

### 7.2 新接口（hn-base-server 提供）
```
# 会话归属与列表（不经过 SaaS 的全局列表）
GET    /api/sessions                       列出当前用户/组织可访问的会话
GET    /api/sessions/:id                   会话元信息（含归属、所属需求）
POST   /api/sessions                       创建会话（内部创建 SaaS session + 写归属）
DELETE /api/sessions/:id                   删除会话（校验归属）

# 会话内容代理
GET    /api/sessions/:id/messages          消息列表
GET    /api/sessions/:id/messages/:mid     单条消息
POST   /api/sessions/:id/message           发送消息（含 prompt/agent/model）
POST   /api/sessions/:id/abort             中止
GET    /api/sessions/:id/event             SSE 流式事件（代理转发）
GET    /api/sessions/:id/fs/*              文件读取（代理）
POST   /api/sessions/:id/shell             执行命令（代理）
GET    /api/sessions/:id/preview/*         预览/产物代理
GET    /api/sessions/:id/tools|mcp|skills  会话配置（代理）

# 授予/撤销访问（组织协作）
POST   /api/sessions/:id/grants            共享给组织/成员
DELETE /api/sessions/:id/grants/:grantId
```

### 7.3 归属校验（唯一判断点）
- 入口统一中间件：`requireSessionAccess(sessionId)`
  - 按 `user_session` 索引判断：`user_id` 本人 或 `org_id` 成员
  - 无权限 → **404**（不泄露存在性）
- 子会话：创建时继承父会话归属（写 `user_session`）
- 会话列表：只查 `user_session`，**不转发 SaaS 的 `GET /session`**

### 7.4 SaaS 侧鉴权（保持简单）
- base-server → SaaS 用**服务级凭证**（沿用现有 `ServerAuth`：Basic 或换成 service token）
- SaaS **不需要**用户/组织/票据概念
- **必须**：`GET /session` 等全局列表接口不对最终用户暴露（SaaS 只接受 base-server 调用）
- 网络层：SaaS 只在内网可达（或白名单 base-server 出口）

### 7.5 代理实现要点
| 能力 | 实现 |
|---|---|
| REST | Hono 转发（`fetch` + 透传状态码/头部），不缓冲大响应 |
| **SSE** | base-server 用 `fetch` 读 SaaS 流 → Hono `streamSSE` 原样转发；保持心跳、客户端断开时 abort 上游 |
| 文件/图片 | 流式转发（`ReadableStream`），**不落盘**；限制单文件大小 |
| 大文件下载 | 同上；若带宽压力大，后续可改为「短期签名直连 URL」 |
| **PTY / WebSocket** | 需要代理 upgrade（`@hono/node-server` 支持）；或改为 base-server 签发一次性直连票据（唯一例外） |

### 7.6 必须在 base-server 做的三件事
1. **归属索引**：`user_session { user_id, session_id, org_id?, role, time_created }`
   - 创建会话时写；删除时清理
   - 与 `requirement_session` 合并（一个需求多会话）
2. **服务凭证管理**：SaaS 的 service token 不落前端
3. **审计**：记录谁访问了哪个会话（不记内容）

### 7.7 取舍（明确接受）
| 代价 | 说明 |
|---|---|
| base-server 成为热点 | 所有会话流量经过它 → 需要水平扩展 + 连接数规划 |
| SSE 长连接 | base-server 要持有与 SaaS 等量的长连接 |
| 带宽 | 文件/图片代理占带宽（后续可切签名 URL） |
| 延迟 | 多一跳（内网，通常可接受） |
| PTY/WS | 代理 upgrade 有实现成本（或为票据例外） |

**收益**：SaaS 完全不需要改（保持纯底层），用户/归属/列表/授权全部集中在一个服务，模型清晰、演进不影响 SaaS。

### 7.8 与 HaSaaS 现有代码的关系
- `hn-base-server`（当前空目录）新建：Hono + drizzle + pg + zod + better-auth
- SaaS 侧**零改动**（除网络暴露策略与「全局列表不对外」）
- hn-app 的 `lib/rest.ts` 改为指向 base-server 的 `/api/sessions/*`（而非 SaaS 直连）

