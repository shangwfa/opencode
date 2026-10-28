# 用户体系场景走查（验证设计覆盖度）

> 目的：用真实使用流程逐条验证 `hn-base-server-user-system-design.md` 的设计是否完备。
> 图例：✅ 设计已覆盖 ｜ ⚠️ 部分覆盖，需补充 ｜ ❌ 设计缺口

---

## 一、身份与认证

### S1. 邮箱密码注册（首个用户）
**流程**：打开注册页 → 填 email/密码 → 提交 → 建 user → session
✅ 覆盖：`emailAndPassword.enabled` + `session` 表
⚠️ 需补充：
- **首个用户角色**：建议第一个注册者自动 `role='admin'`（否则无人能管）
- **邮箱验证策略**：`emailVerified` 默认 false。内部工具可关验证；对外 SaaS 建议开启（否则可伪造邮箱抢邀请）
- **注册开关**：`disableSignUp` 配置（对外公开注册 vs 内部邀请制）

### S2. GitHub / Google 登录
**流程**：点「用 GitHub 登录」→ OAuth 回调 → 建 user + `account` 行 → session
✅ 覆盖：`socialProviders` + `accountLinking.trustedProviders`
❌ **缺口 1：账号自动合并的劫持风险**
- 场景：攻击者用未验证的 GitHub 邮箱（与受害者本地账号同邮箱）登录 → 若自动绑定 = 账号劫持
- 需定策略：**仅当 provider 返回 `emailVerified=true` 才允许自动绑定**；否则创建新账号，登录后手动绑定（`linkSocialAccount`）

### S3. OAuth 登录 ≠ Git 操作授权（概念必须分清）
**流程**：用 GitHub 登录成功，但随后要 clone 私有仓库 —— 登录用的 OAuth token **不一定**有 `repo` 权限
❌ **缺口 2：两套权限被混为一谈**
- 设计需明确：
  - **登录态**（`account` 表 OAuth token）：只用于证明"你是谁"，scope 只要 `user:email`
  - **Git 操作凭据**（`git_credential`）：单独配置的 PAT / GitHub App installation token，scope 要 `repo`/`contents:rw`
- UI 上必须是两个入口：账号绑定 vs Git 服务连接
- 可选增强：登录时同一 GitHub OAuth 提升 scope 顺带拿到 git 权限（但 GitLab 自建仍要 PAT）

### S4. Token 过期与刷新
**流程**：会话使用中 session 过期 → 前端 401 → 跳登录或静默刷新
✅ 覆盖：`session.updateAge`（活动续期）+ `expiresIn`（总时长）
⚠️ 需补充：前端 401 拦截策略（静默重试一次 → 失败跳登录），避免每个页面各写一套

### S5. 多设备 / 多 pod
**流程**：设备 1 与设备 2 登录；请求随机落到 pod A/B
✅ 覆盖：session 存 PG，所有 pod 查同一张表
⚠️ 需补充：**凭证承载方式**
- 同域部署：httpOnly Cookie + `SameSite=Lax`（防 XSS 窃取）
- 跨域/桌面端：`Authorization: Bearer`（注意 localStorage 的 XSS 面）
- 建议：Web 用 Cookie，CLI/API 用 Bearer，两者由 `bearer()` 插件同时支持

### S6. 用户被禁用 / 注销
⚠️ 需补充：
- `user.status`（如 `active|disabled`）必须**在 `requireAuth` 里校验**，不能只靠删 session
- 禁用时立即删除该用户全部 session（否则最长 30 天内仍可用）
- 注销：软删（`deleted_at`），资源保留但不可访问；硬删需先转移组织所有权

---

## 二、组织与成员

### S7. 个人用户直接使用（不建组织）
**流程**：注册 → 创建需求 → 跑会话 → 配个人 PAT
✅ 覆盖：`owner_id` 必填 + `org_id` 可空
⚠️ 需补充：个人资源也需要**凭据**；默认使用 `owner_type='user'` 的凭据

### S8. 创建组织 + 邀请成员
✅ 覆盖：`organization()` + `invitation`
⚠️ 需补充：
- **未注册用户点邀请链接**：需先注册 → 注册后自动接受邀请（需明确回调态）
- **邀请邮箱必须匹配**（防止链接转发滥用）
- `membershipLimit` / `invitationExpiresIn` 要配默认值

### S9. 成员角色变更（member → viewer）
✅ 覆盖：`createAccessControl` + 自定义角色
⚠️ 需补充：**完整权限矩阵**（见 S18）

### S10. 成员被移除 / 主动退出
**流程**：owner 移除 B；或 B 主动退出
❌ **缺口 3：B 创建的组织资源怎么办**
- 现状设计：`owner_id = B`（创建者）+ `org_id = 组织`
- 必须明确：**访问控制以 org 成员身份为准，`owner_id` 仅作"创建者"审计字段**
- 即：B 被移除后，资源仍属组织、其他成员可访问；B 不再能访问
- 同时需处理：B 若是某资源的唯一 owner 且该资源是**个人资源**（`org_id IS NULL`），则不受影响
- `owner` 角色不能直接退出组织（须先转移所有权）

### S11. 组织删除
❌ **缺口 4：org 下资源的处置未定义**
- 三个选项：① 级联删除（危险）② 软删 + 保留 N 天 ③ 强制先转移/清空
- 建议：**软删**（`organization.deleted_at`），资源进入只读，30 天后清理；删除前要求 owner 二次确认并输入组织名
- 同时：删除组织时立即失效所有成员的 `activeOrganizationId`

### S12. 多组织切换
✅ 覆盖：`session.activeOrganizationId`
⚠️ 需补充：请求必须**显式带 org 上下文**（header `X-Org-Id` 或 query），不能只信 session 默认值 —— 否则并发请求切换组织会串数据

---

## 三、资源归属

### S13. 个人资源 → 组织
**流程**：`POST /api/requirement/:id/transfer {orgId}`
✅ 覆盖：12.4 已定义
⚠️ 需补充：转移后的**凭据可用性提示**
- 若原需求用个人 PAT 跑过，转移后组织内其他成员执行时会缺少凭据
- 建议：转移时校验「目标组织是否已有可用 git 凭据」，无则提示先配置

### S14. 跨用户越权访问（猜 ID）
**流程**：B 用 A 的 requirement id 直接调 API
✅ 覆盖：`visibleScope` 过滤 + 资源级校验
❌ **缺口 5：现有 SaaS 的 session/sandbox API 没有归属概念**
- `/api/session/:id/*`、`/api/session/:id/event`（SSE）、`/api/project/*` 目前是全局可访问
- 必须补：这些 API 也要校验「会话属于当前 user/org」，否则拿到 session id 就能读别人对话
- 这是**最高优先级的安全补齐项**

### S15. 子会话（intake 子任务 / 派生会话）
✅ 覆盖：`requirement_session` 关联表（1:N）
⚠️ 需补充：子会话的 `user_id/org_id` **必须继承主会话**，SSE 鉴权同样走继承链

---

## 四、Git 凭据（最容易出问题的一组）

### S16. 个人配 PAT，用于个人资源
✅ 覆盖：`owner_type='user'`
✅ 解析顺序清晰

### S17. 组织共享凭据：A 配、B 执行
**流程**：org 配了 GitLab group token；成员 A 创建需求；成员 B 触发提交
❌ **缺口 6：运行时到底用谁的凭据**
- 若按"user 优先"，B 没有个人凭据 → 回退到 org 凭据 ✅
- 但若 A 有个人 PAT，A 创建的需求被 B 执行：按"执行者优先"会用 B 的（合理）；按"资源 owner 优先"会用 A 的（不合理）
- **建议定策略**：
  - **组织资源（`org_id != NULL`）→ 只用 org/global 凭据**，绝不使用个人凭据
  - **个人资源 → 用资源 owner 的个人凭据**，再回退 org/global
  - 这样避免"组织任务偷用某个人的 token"，也避免 A 离职后任务全挂
- 需在 UI 上提示：组织资源若只有个人凭据，会明确报「缺少组织级 git 凭据」

### S18. 多人使用同一 org token
⚠️ 需补充：
- 审计要记录「谁 + 何时 + 在哪个资源上用了哪个凭据」（不记 token 内容）
- GitLab/GitHub 侧会显示 token 的操作者是 token 所有者，无法区分真实用户 → 需在 commit message / PR 描述里带操作者信息（可选增强）

### S19. Token 过期 / 被吊销
✅ 覆盖：`expires_at` + `status='invalid'`
⚠️ 需补充：
- 运行中任务遇到 401 → 明确失败并提示「重新配置 git 凭据」，**不自动回退到其他凭据**（避免误用他人身份）
- 定时任务：提前 N 天提醒续期（可选）

### S20. 自建 GitLab + 多个实例
✅ 覆盖：`git_provider_instance` 多实例 + `base_url`
⚠️ 需补充：凭据的 `prefix` 必须精确到 host（`https://gitlab.a.com/` vs `https://gitlab.b.com/`），否则最长匹配会串

---

## 五、权限与审计

### S21. 权限矩阵（需补全）
⚠️ 当前只有示意，需确定下表：

| 资源\动作 | viewer | member | admin | owner |
|---|---|---|---|---|
| 需求 读 | ✅ 本组织 | ✅ | ✅ | ✅ |
| 需求 创建/改 | ❌ | ✅ | ✅ | ✅ |
| 需求 删除 | ❌ | 仅自己创建 | ✅ | ✅ |
| 需求 转移 | ❌ | ❌ | ✅ | ✅ |
| 会话 创建/运行 | ❌ | ✅ | ✅ | ✅ |
| 会话 读他人 | ❌ | ❌ | ✅ | ✅ |
| Git 凭据 读（脱敏） | ❌ | ✅ | ✅ | ✅ |
| Git 凭据 增删 | ❌ | ❌ | ✅ | ✅ |
| 成员 邀请/移除 | ❌ | ❌ | ✅ | ✅ |
| 组织 删除/转移所有权 | ❌ | ❌ | ❌ | ✅ |

### S22. 审计
✅ 覆盖：`audit_log` 表
⚠️ 需补充明确要记的事件：登录/登出、凭据增删改、组织成员变更、需求状态迁移、资源转移、越权拒绝（403）

---

## 六、缺口汇总（按优先级）

| # | 缺口 | 影响 | 建议 |
|---|---|---|---|
| **5** | 现有 session/sandbox/project API 无归属校验 | **安全**：拿到 id 就能读别人数据 | ✅ **已设计**：见 `saas-scope-isolation-design.md`（SaaS 只做 scope 隔离 + JWT/JWKS + 聚合根过滤 + RLS 兜底） |
| **6** | 组织资源用谁的 git 凭据未定 | 组织任务可能误用个人 token，或 A 离职后全挂 | ✅ **已确认**：组织资源只用 org/global 凭据；个人凭据只对个人资源生效 |
| **3** | 成员移除后组织资源的访问语义 | 权限混乱 | 明确「访问以 org 成员身份为准，owner_id 仅审计」 |
| **4** | 组织删除的资源处置 | 数据丢失或悬空 | 软删 + 30 天保留 + 二次确认 |
| **2** | 登录 OAuth 与 Git 操作权限混淆 | 用户以为登录了就能提交代码 | UI 分离两个入口，文档写清 |
| **1** | OAuth 自动绑定账号的劫持风险 | 账号安全 | 仅 `emailVerified=true` 才自动绑定 |
| **7** | 用户禁用/注销未纳入鉴权 | 禁用后仍可访问 | `requireAuth` 校验 `status` + 删 session |
| **8** | 权限矩阵未定稿 | 授权实现无依据 | 用 S21 表格定稿 |
| **9** | org 上下文传递方式 | 多组织串数据 | 请求显式 `X-Org-Id` |
| **10** | 子会话归属继承 | 越权/漏鉴权 | 继承主会话 + SSE 鉴权 |

---

## 七、结论

设计主体成立（身份/认证/组织/归属四层都通）。两个安全性缺口已闭合：

1. ✅ **现有 Session API 的归属校验** → 已设计为「SaaS scope 隔离」（`saas-scope-isolation-design.md`）：SaaS 不认用户/组织，只认不透明 `scope_id`；JWT/JWKS 验签 + 聚合根过滤 + RLS 兜底；越权返回 404。
2. ✅ **组织资源与个人凭据混用** → 已确认策略：组织资源只用 org/global 凭据，个人凭据只对个人资源生效。

剩余需补：S10/S11（成员移除、组织删除的生命周期语义）、S2（OAuth 自动绑定条件）、S21（权限矩阵定稿）、S22（审计事件清单）。
