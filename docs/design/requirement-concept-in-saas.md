# 需求（Requirement）概念落到 opencode SaaS —— 现状调研与待决策点

> 背景：**项目**概念跟 hn-gateway 走（不动）；**需求**概念需要在 opencode SaaS 中支持。
> 本文只做现状盘点 + 列出待决策问题，不给最终方案。所有结论带源码依据。

## 一、概念分层（容易混淆的三个「项目」）

| 概念 | 归属 | 证据 | 语义 |
|---|---|---|---|
| **应用 / 业务项目** | hn-gateway | `packages/hn-gateway/src/domains/platform/index.ts:211-248` | GitLab 项目，`POST /gw-api/apps/project/:appId` 创建（name=appId），apps 表 `config.gitLab` 存仓库 URL |
| **Project（opencode）** | opencode SaaS | PG 表 `project`（`id/worktree/vcs/name/icon/commands/time/sandboxes`）+ `project_directory` | **代码工作区**（worktree + 沙箱），与业务项目同名不同义 |
| **需求（Requirement）** | 外部 harness（boss） | `xybot-front-opencode-ui/src/api/requirement/types.ts:20-82` | 业务需求记录，含规格、分支、MR、关联会话 |

**hn-gateway 侧（已查证）**
- 6 张表：`apps / micro_apps / gray_features / configs / publishes / report_events`，**无 projects 表**（`src/db/schema.ts:14-91`）
- 项目 = GitLab 项目，仅在建应用时创建；通过 appId ↔ `gitLab` 与应用松耦合映射
- 与 opencode SaaS 的会话/沙箱**无关**；`requirement|需求|intake` 全包 0 命中
- 源项目用 `GET {gw}/app/:id` 拿应用详情（`api/requirement/yingdaoApps.ts:97-99`），网关地址来自 `VITE_YINGDAO_FRONT_GW_API`（`yingdaoGatewayPipelines.ts:5-8`，默认 `https://test-front-gw.yingdao.com/gw-api`）

**opencode SaaS 侧（PG 实测）**
- 有 `project` / `project_directory`（代码工作区），被 `permission` 外键引用
- **没有**任何 `requirement / intake / artifact` 相关表 → 「需求」在 SaaS 是全新概念

## 二、源项目的需求模型（`src/api/requirement/types.ts`）

核心字段（20-82 行）：

- 身份/内容：`id / title / description / material_description / feishu_url`
- 规格产物：`spec_markdown`（正文）、`spec_fragments`（分片，variant=markdown|questions）、`spec_cdn_url`（发布到 CDN 后的链接）、`subtasks`
- 归属：`target_gitlab`（仓库 URL）、`priority: low|medium|high`、`kind: regular|bugfix`
- 状态：`status: open | pending_publish | done`
- 流程：`create_type: form | chat`、`version: "v1" | "v2" | "intake"`、`workflow_id`、`run_ids[]`
- 会话：`opencode_session_id?`（**1 需求 ↔ 1 会话**）
- git：`base_branch`、`work_branch`、`merge_records[]`（`mr_web_url / source_branch / target_branch / state(opened|merged|closed) / created_at / merged_at`）

### 状态机（现状偏散）
- 三主值 `open / pending_publish / done`，文案「待处理 / 待发布 / 已发布」（`const/requirement/labels.ts:14-18`）
- **无集中状态机**，靠三处手工+事件：① 下拉框手改 → `updateRequirementV2({status})`；② 部署完成后自动置 `done`；③ 后端回 `preparing/failed`，前端轮询判定 ready
- `pending_publish` 自动置位**未找到**（只有手动/后端）
- intake 附加状态：`pending_confirm / queued / running / success / failed / preparing`

### API（base = harness `requirementApiBase`，即 `/boss/api/v3/harness`）
- v1：`GET/POST /requirements`、`GET/PUT/DELETE /requirements/:id`、`POST /requirements/create-with-spec-and-code-gen`、`POST /requirements/:id/publish-spec`（发 CDN）
- v2：`GET /v2/requirements/all`、`GET/PUT/DELETE /v2/requirements/:id`、`POST /v2/requirements/:id/run-ids`、`GET /requirements/aggregate/:id`
- 附属：`/v2/requirements/:id/merge-records`、`/requirements/generate-spec/jobs`、`/requirements/extract-spec-skills`、recording-uploads

### 与会话/沙箱的关系
- **原子创建**：`POST /opencode/init-session` 一次完成 OpenCode session 创建 + `reqId` 生成 + 需求落库（`api/requirement/harnessInitSession.ts:217`、`features/requirement/CONTEXT.md:67`）
- 工作分支约定 `feature/{reqId}`（`utils/requirement/paths.ts:41`）；`base_branch` 由 init-session 落库
- **阶段产物不走 REST**：产物是沙箱里的 Markdown 快照 `{stage, path, content, confirmedAt}`，继续对话时读沙箱 `/file/content`。CONTEXT.md 明确 _Avoid_: 从 Requirement 库 REST 拉产物
- MR：`createGitlabMergeRequest` 合并后 `appendMergeRecord` 写回 `merge_records`

## 三、待决策点（需要你拍板）

### D1. 需求表落 SaaS 的字段取舍
哪些进 PG？建议按「查询需要」与「产物/大文本」拆分：
- 必留：`id / title / status / priority / kind / target_gitlab / base_branch / work_branch / opencode_session_id / create_type / created_at / updated_at`
- 待定：`spec_markdown`（大文本，放 PG 还是对象存储/沙箱）、`merge_records`（子表还是 JSONB）、`run_ids / workflow_id`（流水线在外部，留引用还是不留）
- 待定：`version: v1|v2|intake` 这个字段还有意义吗？

### D2. 与会话的关系（SaaS 里 session 已是一等概念）
- 源是需求表上冗余 `opencode_session_id`；SaaS 侧正向还是反向？多会话（复制派生/迭代）要不要支持一对多？
- 项目接入的「子任务 → 子会话」是 1 需求 → N 会话，与上面的 1:1 冲突，需明确

### D3. 状态机是否重新设计
源是 3 状态 + 散落的手工改动。落 SaaS 时建议收敛成明确状态机（谁在什么条件下可以迁移到什么状态），否则会重演 `pending_publish` 无自动流转的问题。

### D4. 阶段产物的归属
源明确产物在**沙箱文件**而非需求库。SaaS 侧是否沿用（推荐：复用现有 `fs/read` 通道 + 快照），还是要求产物落 PG？影响阶段产物面板的实现。

### D5. 项目 / 仓库关联怎么表达
需求 ↔ 应用（appId，hn-gateway）↔ GitLab 仓库 URL。
- SaaS 侧存 `appId` + `target_gitlab` 两个冗余字段？还是只存 appId、仓库地址实时问网关？
- 与 SaaS 现有 `project`（worktree）表同名不同义，命名要避开（如 `biz_project` / `app_id`）

### D6. 原子创建接口
源的 `POST /opencode/init-session` 一次创建 session + reqId + 需求。SaaS 侧要不要提供同样的原子接口？涉及「创建会话 → 拉代码 → 建需求 → 开分支」的编排边界在哪（SaaS / 沙箱 / 网关）。

### D7. 项目接入（intake）流程
`createProjectIntake` → master session → 解析出子任务 → 确认 → 批量建子会话（`confirmJob` 轮询）。这条链要不要整体迁？还是先只做「单需求」，intake 后置？

### D8. 数据迁移
外部 harness 里已有的需求数据要不要迁？迁的话字段映射与兼容策略。

### D9. 配置来源
需求类功能当前依赖 harness 地址（我已改成 `VITE_BOSS_API_URL` → `window.YD.BOSS_API_URL`）。需求落 SaaS 后这块应该整体移除，改直连 SaaS REST。

## 四、Git Provider 抽象（GitLab + GitHub，需用户配 access token）

### 源项目实际调用面（比预想小：只有 3 个能力）
全部经公司网关 `test-front-gw.yingdao.com/gw-api/gitlab/*` 代理，**不直连 GitLab API v4**：

| 能力 | 端点 | 位置 |
|---|---|---|
| 列分支（含 default/protected/web_url/commit） | GET `gw-api/gitlab/branches?namespaceWithPath&token` | `api/requirement/gitlabBranches.ts:3-27` |
| 创建 MR | POST `gw-api/gitlab/mr` | `api/requirement/gitlabMergeRequest.ts:38-60` |
| MR 状态（state/has_conflicts/mergeable） | GET `gw-api/gitlab/mr/status?project&iid` | `api/requirement/gitlabMergeRequest.ts:102-112` |

**未找到**：get project / create project / list members / namespaces 等 GitLab API。
**分支创建/切换不走 GitLab API**：经 harness 在沙箱内 git 完成（`create-harness-session.ts:36-37,70`）；commit 走 BOSS `/harness/opencode/git-commit`。`feature/{reqId}` 是纯字符串约定，provider 无关。

### 源项目的鉴权（不安全，且没有用户配置入口）
- token 以 **URL query 参数 `token`** 传递（`gitlabBranches.ts:26`）——会进访问日志/Referer，应改为 header
- token 来源是应用接口的 `gitlabToken` 字段（`yingdaoApps.ts:187-189`），**源项目没有用户手动配置 token 的设置入口**
- MR 网关调用不带 token，只带 header `domain: test-front-gw`

→ 「用户配置 access token」是**新需求**，不是迁移。

### GitLab 硬编码清单（需中立化）
- 术语：`merge_request` / `mr_web_url` / `iid`（`gitlabMergeRequest.ts:98`、`types.ts:48`）
- 路径：`namespace` / group-project path（`gitlabBranches.ts:6-14`、`yingdaoApps.ts:274-284`）、GitLab 专有的 `/-/` 段剥离（`gitlabMergeRequest.ts:17-20`）
- `.git` 剥离、scp 格式 `git@host:g/r.git` 归一（`gitlabMergeRequest.ts:13-36`）
- 域名 `gitlab.shadow-rpa.net` 硬编码（`publish.ts:5`、`codeReview.ts:62`、`.env:5`）
- **GitHub 零痕迹**：仅有 Copilot 的 AI provider 与图标，git 托管 100% GitLab 单实现

### SaaS 侧凭据基础设施（已具备，可复用）
- `credential` 表：`id / integration_id / label / value / connector_id / method_id / active / time_*`
- API：`POST /api/integration/{id}/connect/key`（body `{key, label}`）配 access token；另有 OAuth 全套（`connect/oauth` + `attempt/{id}/complete`）
- `Credential.Key = {type:"key", key, metadata}`，**`metadata` 自由 record** → 自建 GitLab 的 `instanceUrl` 可直接入内
- ⚠️ **现有 credential 无用户维度**（只有 `integration_id/connector_id`，与 `account` 表无关）

### Git Provider 接口（建议的抽象面）
```
GitProvider {
  id: "gitlab" | "github"
  listBranches(repo) -> { name, isDefault, isProtected, url, lastCommit? }[]
  createChange(repo, sourceBranch, targetBranch, opts) -> { number, url }   // MR / PR
  getChange(repo, number) -> { state, hasConflicts, mergeable }
  normalizeRepo(input) -> { repoPath, url }   // .git / scp / /-/ / /tree/... 各家格式归一
}
```
术语建议：MR/PR 统一叫 `change`（或 `pull_request` 中立化），`web_url`→`url`，`namespace+project`→`owner/repo`，`iid`→`number`。

### 对 D5（项目/仓库关联）的影响
- `target_gitlab` 建议泛化为 `repo_url` + `git_provider`（`gitlab|github`），或只存 `repo_url` 由 provider 解析
- `merge_records[]` 泛化为 `change_records[]`：`{ provider, number, url, source_branch, target_branch, state, created_at, merged_at }`
- provider 凭据与需求解耦：需求只存 repo 引用，token 由 credential 表按配置解析

### 新增待决策点
- **D10. 凭据归属**：全局共享 / 按用户 / 按组织？现有 credential 无用户维度，若要多用户各配各的 token 需要加归属字段
- **D11. provider 配置项**：GitLab 自建要 `instanceUrl`；GitHub 公有/企业版也要 base URL。是否做 `git_provider_config` 表（`{id, type, base_url, credential_id}`）
- **D12. 网关 vs 直连**：源项目全走公司网关代理。SaaS 侧是直连 GitLab/GitHub（用配的 token），还是继续走网关？直连更通用（支持 GitHub），但要处理网络/自签证书

## 五、业界实践借鉴（可直接抄的模型）

### 5.1 配置模型 → 抄 Backstage `@backstage/integration`
每个 provider 一组配置，多实例靠 `host` 区分：

- GitHub：`host` / `apiBaseUrl?`（不写则自动推导）/ `rawBaseUrl?` / `token?` / `apps?: {appId, privateKey, clientId, clientSecret, webhookSecret?, allowedInstallationOwners?}[]`
- GitLab：`host`（如 `gitlab.company.com`）/ `token?` / `apiBaseUrl?`（自建要手写 `https://host/api/v4`）/ `baseUrl?`
- 接口：`ScmIntegration { type, title, resolveUrl, resolveEditUrl }` + `ScmIntegrationsGroup { list(), byUrl(url), byHost(host) }`
- **关键设计：按 URL 路由到 provider 实例**（`byUrl` 用最长 host 前缀匹配）→ 一条需求记录只要存 `repo_url`，凭据与 provider 自动解析出来
- GitLab token 最小 scope：`api` + `read_repository` + `write_repository`

### 5.2 凭据模型 → 抄 Argo CD 的「URL 前缀模板 + 最长匹配」
- Secret 字段：`type: git|helm` / `url` / `username` / `password`（PAT 放 password，**GitHub 用 `x-access-token` 作 username**）/ `sshPrivateKey` / `insecure` / `project`（归属）
- **Credential template**：只配 URL 前缀（如 `https://github.com/`）+ 凭据，未配置的具体 repo 按**最长前缀匹配**自动套用
- 归属两层：全局 vs 项目级（`project` 字段 + `sourceRepos` 白名单）
- 借鉴点：前缀模板天然支持自建 GitLab（一个 group 一条），比 per-repo 存 token 省配置

### 5.3 能力接口 → 抄 Woodpecker CI 的 `Forge`
`Name() / URL() / Login(OAuthRequest) / Repo(remoteID, owner, name) / Branches(u, r, ListOptions) / BranchHead(branch) / PullRequests(u, r, ListOptions) / Status / Netrc(u, r) / Hook / Org`
- 中立命名：不叫 PR/MR 而叫 **`PullRequests`**；分页统一 `ListOptions`；不支持的能力返回 `ErrNotImplemented`
- **`Netrc()` 专门生成 clone 凭据**（把 forge token 转成 `.netrc`），用户/仓库挂 `ForgeID` 指向具体实例
- 多实例由 `ForgeManager` 统一管理

### 5.4 产品形态 → 双轨（商业产品常态）
- **GitHub.com 用 GitHub App 一键授权**：按仓库选范围、细粒度权限、webhook 自动、**installation token 1 小时过期**（Netlify/Netlify 明确列这些优势）
- **自建/企业实例手填 PAT + 自定义 host**（Vercel/Netlify 的 "Connect GitLab self-managed" 就是这个窗口）
- 优先级：**GitHub App > fine-grained PAT > classic PAT**（GitHub 官方）
- GitLab 没法把 token 限定到单项目（对比 GitHub App installation），只能用 group/project access token

### 5.5 安全 → clone 鉴权三段式（AI agent 产品踩过的坑）
1. **不要把 token 嵌 URL**（会进 `ps`、日志、报错信息）
2. 走 **credential helper**（回填 `username=x-access-token` + `password=$TOKEN`）或 `GIT_CONFIG_COUNT/GIT_CONFIG_KEY_n/GIT_CONFIG_VALUE_n` 环境注入 → token 不出现在 `ps`
3. token 只存服务端，进沙箱用**短时效派生 token**；输出侧做 token 模式 redact
- GitLab 的 API 凭据（`PRIVATE-TOKEN`）与 git 凭据（username: token name / password: token secret）是**两套**，要分别处理

## 六、给我们的设计建议

### 6.1 三张概念表（或两张）
```
git_provider_instance { id, type(gitlab|github), base_url, api_base_url?, auth_method(key|oauth|env), credential_id, created_at }
git_credential        { id, owner_type(user|org|global), owner_id?, prefix(url 前缀), auth_type, secret_ref, scope_note, expires_at? }
```
- 需求记录只存 `repo_url`（+ `git_provider_instance_id` 可选），**不存 token**
- `git_credential` 按 `prefix` 最长匹配解析（抄 Argo），自建 GitLab 靠 base_url + prefix

### 6.2 Provider 接口（对齐 Woodpecker 命名，含建仓/提交能力）
```ts
interface GitProvider {
  readonly type: "gitlab" | "github"

  // —— 只读（源项目已有）——
  listBranches(repo, opts?: ListOptions): Promise<Branch[]>   // { name, isDefault, isProtected, url, lastCommit? }
  getChange(repo, number): Promise<ChangeState>               // { state, hasConflicts, mergeable, url }

  // —— 写入（本次扩展）——
  createRepo(input: CreateRepoInput): Promise<RepoRef>        // { owner?, name, visibility, initReadme?, defaultBranch? }
  createChange(repo, source, target, opts): Promise<Change>   // MR/PR 统一叫 change
  commitFiles(repo, branch, opts: { message, actions: FileAction[], startBranch? }): Promise<CommitRef>

  // —— 沙箱/解析 ——
  resolveRepo(input: string): RepoRef                          // .git / scp / GitLab /-/ 等各家格式归一
  netrc(cred): Promise<NetrcEntry>                             // 给沙箱 clone/push 用，token 不暴露给前端
}
```
术语：`change`（替代 MR/PR）、`number`（替代 iid）、`url`（替代 web_url）、`owner/repo`（替代 namespace+project）。

### 6.2.1 建仓库 + 提交代码：API 对照（已查证官方文档）
| 能力 | GitHub | GitLab |
|---|---|---|
| 建仓库（组织） | `POST /orgs/{org}/repos` | `POST /projects`（`name/path/**namespace_id**/initialize_with_readme`） |
| 建仓库（个人） | `POST /user/repos` | `POST /projects/user/:user_id`（仅 admin） |
| **API 提交**（多文件） | `PUT /repos/{owner}/{repo}/contents/{path}`（单文件） | `POST /projects/:id/repository/commits`（`actions[]` 一次多文件 create/update/delete/move/chmod） |
| 建分支 | commit API 的 `start_branch` | 同上 `start_branch`/`start_sha` |
| 认证 header | `Authorization: Bearer` | `PRIVATE-TOKEN` |
| git clone/push 鉴权 | `x-access-token` 作 username + token | `username: token name` / `password: token secret` |
| **建仓所需权限** | fine-grained PAT → **`Administration: write`**；classic → `repo` scope | **`api` scope** |
| 文件/PR 权限 | `contents:rw` / `pull_requests:rw` | `api`（含 `write_repository`） |

**实现路径选择（待定 D15）**：
- **A. API 提交**（GitLab `commits` API / GitHub `contents` API）：适合初始化仓库、种子文件、小改动；一次请求多文件、无需沙箱、无需 git 凭据
- **B. 沙箱内 `git commit + push`**：适合大批量改动、分支操作、复用 agent 已有的工作树；需要下发 git 凭据（`.netrc` / `GIT_CONFIG_*`）
- 建议：**建仓 + 初始化用 A；agent 改码后提交用 B**（与现有「harness 在沙箱内 git 完成分支创建」一致）

**权限风险提醒**：建仓库需要 `Administration: write`（GitHub）或 `api` scope（GitLab），这是全权 token。建议 UI 上区分「只读（列分支/看 PR）」与「读写（建仓/提交/建 PR）」两档，用户按需选择最小 scope。

### 6.3 UI 形态
- 「Git 服务连接」页：列表（provider 实例 + 归属 + 连接方式 + 状态）
- 两个入口：**授权连接（OAuth / GitHub App 安装）** 与 **手动填写 token（+ 实例地址）**
- token 校验按钮（用最小 scope 调 `/user` 或 `/api/v4/user` 验证）

### 6.4 安全要求（必须）
- token 不进 URL、不进日志、不返回前端
- 沙箱 clone 用 `credential helper` / `GIT_CONFIG_*` env 注入，用完即弃
- 输出侧 redact（token 模式匹配）
- 优先用短时效 token（GitHub installation token / GitLab project token），支持过期时间字段

## 七、待决策点（结合业界实践更新）

- **D10. 凭据归属**：抄 Argo 的两层（全局 + 项目级），建议先做 **组织级 + 用户级**，项目级后置
- **D11. provider 实例与凭据的关系**：一个实例多个凭据（前缀匹配）还是一对一？建议**一对多**（抄 Argo template）
- **D12. 鉴权通道**：SaaS 直连 GitLab/GitHub（用配的 token），还是继续走公司网关代理？**建议直连**（网关代理只支持 GitLab 且 token 走 query 不安全），但要处理自建实例网络
- **D13. 鉴权方式优先级**：GitHub 走 GitHub App 还是只支持 PAT？（App 体验好但要建应用、配私钥；PAT 简单但权限粗）建议**先 PAT（fine-grained）→ 再加 GitHub App**
- **D14. clone 凭据下发机制**：`.netrc` / credential helper / `GIT_CONFIG_*` env，选哪个进沙箱？（影响 AGENTS.md 里的三段式 daemon 约定）
- **D15. 提交代码走 API 还是沙箱 git push**：见 6.2.1，建议「建仓+初始化走 API、agent 改码后提交走沙箱 git」
- **D16. 建仓职责边界（与 hn-gateway 重叠）**：hn-gateway 已有 `POST /gw-api/apps/project/:appId` 建 GitLab 项目（`src/domains/platform/index.ts:211-248`，用它自己的 gitlab-client）。SaaS git provider 的 `createRepo` 是另一条路径。需要定：
  - (a) **hn-gateway 独占建仓**（业务项目/应用建仓），SaaS 只提供底层能力给非项目场景（如需求临时仓库）；
  - (b) **SaaS git provider 统一建仓**，hn-gateway 改调 SaaS；
  - (c) 两者按域分开（应用仓库走网关、需求/沙箱仓库走 provider）。
  建议 (c)：避免改动 hn-gateway，但要明确各自的仓库命名/namespace 约定，避免同名冲突。

## 八、建议的讨论顺序

先 D5（概念与命名）→ D10/D11（凭据归属与匹配）→ D12/D13（通道与鉴权方式）→ D1（字段）→ D2/D3（关系与状态）→ D4/D6（产物与接口）→ D7/D8（intake 与迁移）。
