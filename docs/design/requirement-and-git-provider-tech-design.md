# 需求（Requirement）+ Git Provider 落地 opencode SaaS —— 前后端技术方案

> ✅ **已并入 `total-design.md`（2026-10-18）**：本文保留作为背景与论证过程，实现以总设计为准。


> 前置调研见 `docs/design/requirement-concept-in-saas.md`（现状、业界借鉴、待决策点）。
> 本文给出可实施的完整方案。**未实现，仅设计**。所有「建议默认值」可讨论。

---

## 一、目标与范围

**目标**：把「需求」概念落到 opencode SaaS（PG + REST），并新增 **Git Provider** 层支持 GitLab（含自建）与 GitHub，用户配置 access token 后可**建仓库、提交代码、开 PR/MR**。

**范围内**
- 需求的 CRUD、状态机、与会话/沙箱/分支的关联
- Git Provider 抽象（GitLab + GitHub）+ 凭据配置（PAT / OAuth）
- 建仓库、提交代码、创建/查询 PR(MR)、列分支
- 前端：需求列表/详情、Git 服务连接设置页、需求对话页整合

**范围外（明确不做）**
- 业务「项目/应用」注册（跟 hn-gateway 走）
- 流水线 / 代码生成 / 部署（`run_ids`、`workflow_id`、CDN 发布）
- 飞书通知、录制上传

**关键约束（继承自项目架构）**
- SaaS **无状态**，k8s 多 pod：会话→沙箱绑定在 PG，不在进程内存
- 会话为中心，**每会话一个沙箱**，工作目录固定 `/workspace`
- SaaS 不直连沙箱网络，一切经 **OpenSandbox 控制面**（命令通道 execd / 端口网关 / 生命周期 API）
- 前端直连 REST，不用 `@opencode-ai/sdk`

---

## 二、总体架构

```
┌─ hn-app（React + Vite + shadcn）──────────────────────────┐
│ 需求列表 / 需求详情 / 需求对话 / Git 服务连接设置 / 仪表盘   │
└───────────────┬──────────────────────────────────────────┘
                │ REST + SSE（不用 SDK）
┌───────────────▼──────────────────────────────────────────┐
│ opencode SaaS（无状态，多 pod）                            │
│  ┌──────────────┐ ┌──────────────┐ ┌───────────────────┐  │
│  │ core/require │ │ core/gitprov │ │ core/credential   │  │
│  │ 需求域        │ │ ider 抽象层   │ │ 凭据（复用现有）    │  │
│  └──────┬───────┘ └──────┬───────┘ └─────────┬─────────┘  │
│         │                │                    │           │
│  ┌──────▼────────────────▼────────────────────▼─────────┐ │
│  │ core/git（已有，本地 git：clone/fetch/checkout/commit）│ │
│  └──────────────────────┬───────────────────────────────┘ │
│                         │ PG（requirement / change …）     │
└─────────────────────────┼────────────────────────────────┘
              ┌───────────▼────────────┐   ┌──────────────────┐
              │ OpenSandbox 控制面      │   │ GitLab / GitHub  │
              │ execd / 端口网关 / 生命 │   │ REST API（直连）  │
              │ 周期（沙箱内 git 操作）  │   │                  │
              └────────────────────────┘   └──────────────────┘
```

**三层职责**
1. **本地 git**：复用已有 `core/src/git.ts`（758 行，Effect service：`repo.clone/discover/create`、`sync.fetch*/checkout*`、`history.*`、`worktree.create`）→ 在**沙箱内**执行
2. **远端 git API**：新建 `core/src/gitprovider/`（建仓、PR、列分支、API 提交）→ SaaS 侧直连 GitLab/GitHub
3. **凭据**：复用已有 `credential` + `integration`（`Method = OAuth | Command | Key | Env`）

---

## 三、数据模型（PG）

> 命名避开 SaaS 现有 `project`（代码工作区，`worktree + sandboxes`）表。业务侧一律用 `requirement_*` / `git_*` 前缀。

```sql
-- 1. Git Provider 实例（可多：自建 GitLab + github.com + 企业 GitHub）
CREATE TABLE git_provider_instance (
  id                 text PRIMARY KEY,
  type               text NOT NULL,            -- 'gitlab' | 'github'
  display_name       text NOT NULL,
  base_url           text NOT NULL,            -- https://gitlab.company.com / https://github.com
  api_base_url       text,                     -- 覆盖用；GitLab 自建为 {base_url}/api/v4
  auth_method        text NOT NULL,            -- 'key' | 'oauth' | 'env'
  credential_id      text REFERENCES credential(id) ON DELETE SET NULL,
  owner_type         text NOT NULL DEFAULT 'global',  -- 'user' | 'org' | 'global'
  owner_id           text,
  status             text NOT NULL DEFAULT 'active',  -- 'active' | 'invalid'
  time_created       bigint NOT NULL,
  time_updated       bigint NOT NULL
);

-- 2. Git 凭据（复用 credential 表存 secret，此表存 git 语义）
CREATE TABLE git_credential (
  id                 text PRIMARY KEY,
  credential_id      text NOT NULL REFERENCES credential(id) ON DELETE CASCADE,
  provider_type      text NOT NULL,            -- 'gitlab' | 'github'
  prefix             text NOT NULL,            -- URL 前缀，Argo 式最长匹配：https://gitlab.company.com/
  scopes             text[],                   -- 记录实际授权范围，UI 展示用
  auth_kind          text NOT NULL,            -- 'pat' | 'project_token' | 'group_token' | 'github_app' | 'oauth'
  expires_at         bigint,                   -- GitHub installation token 1h、GitLab 过期时间
  time_created       bigint NOT NULL,
  time_updated       bigint NOT NULL
);
CREATE INDEX git_credential_prefix_idx ON git_credential (prefix);

-- 3. 需求
CREATE TABLE requirement (
  id                        text PRIMARY KEY,
  title                     text NOT NULL,
  description               text,
  material_description      text,
  status                    text NOT NULL DEFAULT 'draft',  -- 见 3.1 状态机
  priority                  text,                           -- 'low'|'medium'|'high'
  kind                      text,                           -- 'regular'|'bugfix'
  create_type               text,                           -- 'form'|'chat'
  repo_url                  text,                           -- 中立仓库地址（不存 token）
  git_provider_instance_id  text REFERENCES git_provider_instance(id) ON DELETE SET NULL,
  base_branch               text,
  work_branch               text,                           -- 约定 feature/{reqId}
  session_id                text,                           -- 关联会话（见 3.2）
  time_created              bigint NOT NULL,
  time_updated              bigint NOT NULL
);
CREATE INDEX requirement_status_idx ON requirement (status);
CREATE INDEX requirement_repo_idx   ON requirement (repo_url);
CREATE INDEX requirement_session_idx ON requirement (session_id);

-- 4. 变更记录（原 merge_records，中立化为 change）
CREATE TABLE requirement_change (
  id                 text PRIMARY KEY,
  requirement_id     text NOT NULL REFERENCES requirement(id) ON DELETE CASCADE,
  provider_instance_id text REFERENCES git_provider_instance(id) ON DELETE SET NULL,
  number             bigint NOT NULL,          -- PR/MR 号（原 iid）
  url                text NOT NULL,            -- 原 web_url
  state              text NOT NULL,            -- 'opened'|'merged'|'closed'
  source_branch      text,
  target_branch      text,
  time_created       bigint NOT NULL,
  time_merged        bigint
);
CREATE INDEX requirement_change_req_idx ON requirement_change (requirement_id);

-- 5. 需求-会话关联（支持 1:N，见 3.2）
CREATE TABLE requirement_session (
  id             text PRIMARY KEY,
  requirement_id text NOT NULL REFERENCES requirement(id) ON DELETE CASCADE,
  session_id     text NOT NULL,
  role           text NOT NULL DEFAULT 'primary',  -- 'primary'|'derived'|'intake_child'
  time_created   bigint NOT NULL
);
CREATE INDEX requirement_session_session_idx ON requirement_session (session_id);
```

### 3.1 需求状态机（收敛源项目的手工散改）
```
draft ──create──▶ open ──start──▶ in_progress ──submit──▶ pending_publish ──publish──▶ done
                    │                  │                        │
                    └─────────────── cancel ─────────────────────┴──▶ archived
```
- 迁移条件由**后端校验**（不允许跳态/回退到 archived 之外的终态）
- 每次迁移写 `requirement_event`（可选，便于审计与回放）
- `pending_publish` 自动流转：PR merged → 自动 `done`（源项目这个字段没有自动流转，是明确缺陷）

### 3.2 需求 ↔ 会话关系（1:N，而非源项目的 1:1）
- 源是 `opencode_session_id` 单值；但项目接入的「子任务→子会话」是 1:N，故用关联表
- `role`：`primary`（主会话）/ `derived`（复制派生）/ `intake_child`（项目接入子任务）
- 会话本体仍在 `session_v2` 表，本表只做关联

---

## 四、后端设计

### 4.1 模块布局（对齐 V2 现状）
```
packages/core/src/
  requirement/            # 需求域（Effect service）
    index.ts  schema.ts  service.ts  state-machine.ts
  gitprovider/            # Git Provider 抽象
    index.ts  types.ts    # GitProvider 接口 + RepoRef/Change/Branch
    gitlab.ts  github.ts  # 两家实现
    resolve.ts            # resolveRepo 归一化（.git/scp//-/ 等）
    registry.ts           # byUrl/byHost 路由（Backstage 式最长前缀匹配）
  credential/             # 已有，扩展 git_credential 读取
packages/server/src/
  handlers/requirement.ts      # 新增
  handlers/git-provider.ts     # 新增
  routes.ts                    # 注册路由
packages/core/src/database/migration/
  xxxx_create_requirement.sql  # 新增 migration
```

### 4.2 Git Provider 接口（核心抽象）
```ts
// core/gitprovider/types.ts
export interface GitProvider {
  readonly type: "gitlab" | "github"
  // 只读
  listBranches(repo: RepoRef, opts?: ListOptions): Promise<Branch[]>
  getChange(repo: RepoRef, number: number): Promise<ChangeState>
  // 写入
  createRepo(input: CreateRepoInput): Promise<RepoRef>
  createChange(repo: RepoRef, source: string, target: string, opts?: ChangeOptions): Promise<Change>
  commitFiles(repo: RepoRef, branch: string, input: CommitInput): Promise<CommitRef>
  // 辅助
  resolveRepo(input: string): RepoRef
  netrc(cred: GitCredential): Promise<NetrcEntry>   // 沙箱 clone/push 用，token 不外泄
}
```
- **中立术语**：`change`（代 MR/PR）、`number`（代 iid）、`url`（代 web_url）、`owner/repo`（代 namespace+project）
- **归一化放实现内**：`.git` 剥离、scp `git@host:g/r.git`、GitLab `/-/`、GitHub `/tree/...` 各家私有格式
- 不支持的能力返回 `ErrNotImplemented`（抄 Woodpecker）

**两家实现要点**
| | GitLab | GitHub |
|---|---|---|
| API base | `{base_url}/api/v4` | `https://api.github.com`（企业版 `base_url/api/v3`） |
| 建仓 | `POST /projects`（`namespace_id`） | `POST /orgs/{org}/repos` / `POST /user/repos` |
| API 提交 | `POST /projects/:id/repository/commits`（`actions[]` 多文件） | `PUT /repos/{o}/{r}/contents/{path}`（单文件） |
| PR/MR | `POST /projects/:id/merge_requests` | `POST /repos/{o}/{r}/pulls` |
| 列分支 | `GET /projects/:id/repository/branches` | `GET /repos/{o}/{r}/branches` |
| 认证 | `PRIVATE-TOKEN: <token>` | `Authorization: Bearer <token>` |
| git 凭据 | username: token name / password: token secret | username: `x-access-token` / password: token |

### 4.3 凭据与安全（关键）
**存储**：token 只进 `credential` 表（PG），**不落前端、不进日志、不进 URL**。
- 修正源项目的错误做法：源把 token 放 URL query（`gitlabBranches.ts:26`），会进 `ps`/日志/Referer
- 解析顺序：`git_credential.prefix` **最长前缀匹配** → 拿 `credential_id` → 读 secret（抄 Argo CD）

**下发沙箱 clone/push（三选一，建议 `.netrc`）**
```sh
# SaaS 经命令通道写入沙箱（权限 0600），用完删除
echo "machine gitlab.company.com login x-access-token password $TOKEN" > ~/.netrc
```
- 备选：`GIT_CONFIG_COUNT/GIT_CONFIG_KEY_n/GIT_CONFIG_VALUE_n` 环境注入（token 不出现在 `ps`）
- **必须**：输出侧 redact（正则匹配 token 模式），错误信息不回传 token

**授权分档（UI 上让用户选最小 scope）**
| 档位 | 能力 | GitLab scope | GitHub fine-grained |
|---|---|---|---|
| 只读 | 列分支、查 PR | `read_api` + `read_repository` | `contents:read`, `pull_requests:read` |
| 读写 | + 建仓、提交、开 PR | `api` + `write_repository` | `administration:write`, `contents:rw`, `pull_requests:rw` |

**Token 校验**：`POST /api/git-provider/:id/verify` 调 `/user`（GitHub）或 `/api/v4/user`（GitLab）验证，失败置 `status='invalid'`。

### 4.4 与沙箱的交互（遵守三段式 daemon 约定）
- **建仓/提交（API 路径）**：SaaS 直接调 GitLab/GitHub，不经过沙箱
- **改码后提交（git push 路径）**：
  1. SaaS 经**命令通道**写 `.netrc` 到沙箱（幂等，含就绪探测）
  2. 沙箱内 `core/git.ts` 的 `sync.*` + `git push`（agent 已有工作树）
  3. 完成后删除 `.netrc`
- 不新增常驻 daemon；复用现有 execd 命令通道，符合「新增沙箱内服务必须复用三段式」的约定

### 4.5 HTTP API 面
```
# 需求
GET    /api/requirement                      ?status=&repo_url=&page=      列表（分页）
POST   /api/requirement                      创建（含可选建仓）
GET    /api/requirement/:id                  详情（聚合 changes/sessions）
PUT    /api/requirement/:id                  更新（状态迁移由后端校验）
DELETE /api/requirement/:id
POST   /api/requirement/:id/changes          创建 PR/MR
GET    /api/requirement/:id/changes          PR/MR 列表
POST   /api/requirement/:id/session          绑定/创建会话（1:N）
POST   /api/requirement/:id/archive          归档

# Git Provider
GET    /api/git-provider                     实例列表
POST   /api/git-provider                     注册实例（含 token）
PUT    /api/git-provider/:id
DELETE /api/git-provider/:id
POST   /api/git-provider/:id/verify          校验 token
GET    /api/git-provider/:id/branches        ?repo=            列分支
POST   /api/git-provider/:id/repos           建仓库
POST   /api/git-provider/:id/commit          提交（API 路径）
POST   /api/git-provider/:id/clone-credential 下发沙箱凭据（用后即焚）
```
> 全部走既有 `handlers/` + `routes.ts` 注册；SSE 事件复用 `event-feed`（需求状态变更推送）。

---

## 五、前端设计（hn-app）

### 5.1 路由与页面
| 路由 | 页面 | 状态 |
|---|---|---|
| `/requirements` | 需求列表（筛选/搜索/分页） | 新建 |
| `/requirement/:id` | 需求详情（状态/分支/PR/关联会话/产物） | 新建 |
| `/settings/git-providers` | Git 服务连接（实例列表 + 授权） | 新建 |
| `/requirement-chat/:repo/:sessionId` | 需求对话 | **已有**（复用） |
| `/dashboard` | 仪表盘 | **已有**（复用，改数据源） |

### 5.2 组件复用（hn-app 已有）
- `SessionTimeline` / `Composer` / `Markdown` / `FilePreviewDialog` / `ImageLightbox`
- `dashboard/components.tsx`（StatusPipeline / DistributionBar / TrendChart）
- `api/requirement/*` 的 types（`AggregateRequirement` 等，按本方案泛化字段）

### 5.3 关键组件（新增）
```
src/pages/requirement-list.tsx        需求列表（表格 + 筛选）
src/pages/requirement-detail.tsx      需求详情（StageBar + 产物 + PR 面板）
src/pages/settings/git-providers.tsx  Git 服务连接
src/components/git-provider/
  provider-form.tsx     实例配置表单（type/base_url/token）
  auth-scope-picker.tsx 授权分档（只读/读写）
  repo-picker.tsx       仓库选择（byUrl 路由）
  branch-select.tsx     分支下拉（复用源语义：default 标记）
src/components/requirement/
  status-badge.tsx      状态徽章（状态机配色）
  change-list.tsx       PR/MR 列表（state 徽章 + 链接）
  session-links.tsx     关联会话（1:N，含派生/子任务）
```

### 5.4 数据流
- REST 直连（`lib/rest.ts` 扩展），SSE 订阅需求状态变更
- 需求列表用 `use-requirements.ts`（复用 `use-requirements-all.ts` 的轮询/竞态模式）
- 表单校验：token 必填 + 实例地址格式 + scope 说明

---

## 六、关键流程时序

### 6.1 创建需求 + 建仓 + 开会话
```
用户 ─▶ hn-app POST /api/requirement {title, repo?, create_repo:{owner,name,visibility}}
SaaS  ─▶ gitprovider.createRepo（若 create_repo）→ 得 repo_url
SaaS  ─▶ INSERT requirement (repo_url, git_provider_instance_id, status='open')
SaaS  ─▶ 创建 session_v2 + sandbox（复用现有会话创建流程）
SaaS  ─▶ 命令通道写 .netrc 到沙箱 → core/git.repo.clone → 建 feature/{reqId} 分支
SaaS  ─▶ INSERT requirement_session (role='primary')
◀── 201 {id, session_id, repo_url, status}
```

### 6.2 agent 改码 → 提交 → 开 PR
```
agent（沙箱内）改文件
用户 ─▶ hn-app POST /api/requirement/:id/commit {message, push:true}
SaaS  ─▶ 命令通道写 .netrc → 沙箱 git commit + push（core/git.ts sync.*）
SaaS  ─▶ gitprovider.createChange(repo, work_branch, base_branch)
SaaS  ─▶ INSERT requirement_change (number, url, state='opened')
SaaS  ─▶ requirement.status: in_progress → pending_publish
◀── SSE 推送状态变更
```

### 6.3 PR merged → 需求完成
```
webhook / 轮询 ─▶ getChange() 返回 state='merged'
SaaS ─▶ requirement_change.time_merged = now
SaaS ─▶ requirement.status: pending_publish → done（自动流转）
SaaS ─▶ SSE 推送
```

---

## 七、测试策略（按项目要求）

**单测（vitest，纯函数优先）**
- `gitprovider/resolve.ts`：各格式归一（URL / scp / `.git` / `/-/` / `/tree/`）
- `gitprovider/registry.ts`：prefix 最长匹配路由
- `requirement/state-machine.ts`：合法/非法迁移
- `requirement/aggregate.ts`：列表聚合、状态统计（沿用 dashboard 聚合模式）
- `gitlab.ts / github.ts`：请求构造与响应归一（mock fetch）

**e2e（REST 接口 + PG 校验 + SSE）**
1. 起本地 SaaS + PG + **fake GitLab/GitHub 服务**（本地 mock，返回确定响应）
2. `POST /api/git-provider`（注册 + token）→ `verify` 通过
3. `POST /api/requirement`（含建仓）→ 校验 PG：`requirement` 行、`git_provider_instance_id` 正确
4. `POST /api/requirement/:id/session` → 校验 `requirement_session`、`session_v2`、`sandbox`
5. 订阅 `GET /api/session/:id/event`（SSE）→ 发消息 → 断言流式输出（思考/工具/文本）
6. `POST /api/requirement/:id/commit` → 校验 `requirement_change` 行、状态迁移
7. 负面用例：非法状态迁移返回 4xx、token 无效时 `status='invalid'`

**关键约定**（继承 AGENTS.md）
- 全程通过接口测试，不直连 DB 断言业务（PG 只做最终校验）
- 用例执行期间订阅 SSE 流式输出实时观察
- 提问自动应答，保证用例跑完
- code-mode 默认开启，需验证生效

---

## 八、分期里程碑

| 期 | 内容 | 交付 |
|---|---|---|
| **P0** | 数据模型 + migration；需求 CRUD + 状态机；Git Provider 抽象（只读：列分支/查 PR）；凭据配置（PAT + verify） | 可用的列表/详情页 + Git 服务连接页 |
| **P1** | 建仓库（API）；提交代码（API + 沙箱 git 双路径）；创建 PR/MR；`.netrc` 下发 | 完整「建仓→改码→提交→开 PR」闭环 |
| **P2** | 需求对话页整合（阶段产物面板、状态机接入）；需求-会话 1:N（派生） | 对话驱动的需求开发 |
| **P3** | GitHub App / OAuth 授权；组织级凭据；`pending_publish` 自动流转 webhook | 生产可用 |

---

## 九、待决策点与建议默认值

| # | 问题 | 建议默认值 | 备注 |
|---|---|---|---|
| D1 | `spec_markdown` 等大文本 | 阶段产物走**沙箱文件**（源项目做法），PG 只存 `artifact_path` 快照 | 影响产物面板 |
| D2 | 需求-会话关系 | **1:N** 关联表（`requirement_session`） | 覆盖 intake 子任务 |
| D3 | 状态机 | 收敛为 7 态 + 后端校验迁移 | 修复 `pending_publish` 无自动流转 |
| D5 | 命名 | 业务侧全用 `requirement_*` / `git_*` 前缀，避开 SaaS `project` | |
| D10 | 凭据归属 | **用户级 + 全局** 两档（`owner_type`） | 项目级后置 |
| D11 | provider↔凭据 | **一对多**（prefix 最长匹配） | 抄 Argo CD |
| D12 | 鉴权通道 | **SaaS 直连** GitLab/GitHub | 网关代理只支持 GitLab 且 token 走 query |
| D13 | GitHub 鉴权 | 先 **fine-grained PAT**，P3 再加 GitHub App | |
| D14 | clone 凭据下发 | **`.netrc`**（命令通道写入，用后即焚） | 备选 `GIT_CONFIG_*` env |
| D15 | 提交路径 | **建仓+初始化走 API，agent 改码后走沙箱 git** | |
| D16 | 建仓职责 | **按域分开**：应用仓库走 hn-gateway，需求/沙箱仓库走 provider | 需约定 namespace 防撞名 |

---

## 十、风险与注意事项

1. **建仓权限很重**（`Administration: write` / `api` scope）→ UI 必须分档 + 明确告知
2. **token 泄漏面**：不进 URL、不进日志、输出 redact、`.netrc` 用后即焚、优先短时效 token
3. **自建 GitLab 网络可达性**：SaaS pod 要能访问 `base_url`（k8s 出网策略）
4. **API 提交 vs git push 的语义差异**：API 提交不产生本地 commit 记录（GitLab `commits` API 会，但 GitHub `contents` 是单文件），大批量改动必须走 git push
5. **与 hn-gateway 的仓库命名**：约定 `namespace` 分工，避免同名建仓冲突
6. **状态机迁移幂等**：多 pod 并发下用 PG 行锁或乐观锁（`time_updated` 版本）
