# Project V1 技术实现方案

## 1. 文档状态

- 状态：设计草案
- 范围：OpenCode SaaS 服务中的 Project 控制面
- 代码范围：`packages/opencode`
- 明确排除：`packages/console`
- 明确排除：Session、Requirement、Task 的领域设计和配置继承

## 2. 背景

当前 `project` 不是用户创建的 SaaS 业务实体，而是由本地目录和 Git 仓库自动发现的运行时对象：

- Project ID 由 Git remote、root commit 或 `global` 派生；
- `worktree`、`sandboxes`、`commands` 等字段面向本地 CLI 和 worktree；
- Project API 依赖 `InstanceContextMiddleware` 和目录路由；
- API 没有显式创建、查询单个 Project 和删除 Project；
- Agent、Skill、MCP 只支持 Session 级动态配置；
- Git remote 只用于识别本地仓库，没有远程访问验证和安全凭据模型。

Project V1 将新增一个用户显式创建的 SaaS Project 控制面。每个 Project 必须绑定一个经过访问验证的 Git 仓库。

## 3. 目标

Project V1 必须支持：

1. 显式创建、查询、更新、归档 Project；
2. Project 创建时必须提交 Git 仓库配置；
3. 支持 GitHub、GitLab 和通用 Git 服务；
4. 支持公开仓库、OAuth Token、Access Token、Basic 和 SSH Key 授权；
5. 创建前验证远程仓库可访问；
6. 安全保存 Git 凭据，不在数据库、日志和 API 中暴露明文；
7. 管理 Project 级 Agent、Skill、MCP；
8. 为未来关联 Session、Requirement、Task 提供稳定的 `prj_` ID；
9. 不破坏当前目录实例和 Session 执行链。

## 4. 非目标

Project V1 不负责：

- 创建或执行 Session；
- Requirement、Task、Workflow、Pipeline；
- Project 配置向 Session 的继承和物化；
- clone、worktree、Sandbox 和 PVC 生命周期；
- Git commit、push、创建 PR 或写 Issue；
- 多仓库 Project；
- Project 成员、组织和 RBAC；
- GitHub/GitLab OAuth 浏览器授权流程本身。

OAuth 流程可在后续提供；V1 的 Project API 接受已获得的 OAuth access token，并按凭据类型保存。

## 5. 核心设计决策

### 5.1 Project 是显式业务实体

Project ID 由服务生成，与 Git URL、Git commit 和本地目录无关：

```text
prj_<ascending-id>
```

Git 仓库可以更换，但 Project ID 永远不变。

### 5.2 Git 仓库是必需配置

Project 不能脱离 Git 仓库存在。创建请求必须包含 repository，服务必须先验证访问，再写入 Project。

第一版一个 Project 只绑定一个主仓库，因此仓库字段直接存放在 Project 记录中，而不是提前建立一对多关系。

### 5.3 Project 配置与执行配置分离

Agent、Skill、MCP 是独立资源，各自使用通用领域表，并通过表内的 `project_id` 归属 Project。表和服务不使用 Project 前缀，避免把资源实现绑定到特定 Project 版本。

V1 不修改 Agent Runner、Tool Registry 或 Session 配置解析。

### 5.4 新控制面不依赖目录实例

Project CRUD 不能使用：

- `InstanceContextMiddleware`
- `WorkspaceRoutingMiddleware`
- `x-opencode-directory`
- `?directory=`

Project 在任何 directory、workspace 或 sandbox 创建之前就必须存在。

### 5.5 凭据加密是上线前置条件

现有 `auth`、`credential` 和 `session_mcps` 都有明文 secret 问题，不能直接作为 Project Git/MCP 凭据存储。

必须先提供 `SecretStore`，再开放 Project 创建接口。

### 5.6 数据库不使用外键

按照阿里数据库建表实践，新表不创建数据库外键和 `ON DELETE CASCADE`：

- `agent.project_id`、`skill.project_id`、`mcp.project_id` 只保存逻辑关联；
- 所有关联字段必须创建普通索引；
- 创建或更新子资源前，由 Service 层验证 Project 存在且状态可用；
- 清理 Project 数据时，由 Service 在事务中按子表到主表的顺序显式删除；
- 定时一致性任务扫描并处理孤儿数据；
- API 不依赖数据库约束错误表达业务错误。

## 6. 领域模型

```text
Project
├── Repository（必需，一对一，内嵌于 Project）
├── GitCredential（公开仓库可无，密文内嵌于 Project）
├── Agent（零到多个，通过 project_id 关联）
├── Skill（零到多个，通过 project_id 关联）
└── MCP（零到多个，通过 project_id 关联）
```

### 6.1 Project 状态

```text
active
archived
```

V1 不增加 draft。只有 Git 验证成功的 Project 才能创建，因此不存在“未完成配置”的 Project。

### 6.2 Repository Provider

```text
github
gitlab
generic
```

Provider 表示访问策略和 URL 规则，不表示 AI provider。

### 6.3 Git Auth Type

```text
none
oauth
token
basic
ssh
```

- `none`：公开仓库；
- `oauth`：OAuth access token，可带 refresh token 和过期时间；
- `token`：Personal Access Token 或 Deploy Token；
- `basic`：username/password；
- `ssh`：private key、可选 passphrase 和 known-host 信息。

## 7. 数据模型

### 7.1 物理表命名策略

当前 `project` 表仍被目录实例、Session、Workspace 和 Permission 外键依赖。本阶段不修改 Session，因此不能直接替换该表。

第一阶段新增物理表：

```text
saas_project
agent
skill
mcp
```

SQL 标识符使用下划线，因此产品概念 “SaaS Project” 对应物理表 `saas_project`，不使用需要额外引用的 `saas-project`。

`agent`、`skill`、`mcp` 使用通用资源名称，通过 `project_id` 明确归属。后续执行层接入新 Project 后，再将旧 `project` 语义迁为 checkout/location。

这不是长期双 Project 模型，而是为了隔离当前迭代范围的过渡方案。

### 7.2 saas_project

```text
id                              TEXT PRIMARY KEY
name                            TEXT NOT NULL
description                     TEXT NOT NULL DEFAULT ''
status                          TEXT NOT NULL DEFAULT 'active'

repository_provider             TEXT NOT NULL
repository_url                  TEXT NOT NULL
repository_host                 TEXT NOT NULL
repository_path                 TEXT NOT NULL
repository_default_branch       TEXT
repository_auth_type            TEXT NOT NULL
repository_credential           JSON/JSONB
repository_verified_at          BIGINT NOT NULL
repository_last_checked_at      BIGINT NOT NULL
repository_connection_status    TEXT NOT NULL DEFAULT 'verified'

metadata                        JSON/JSONB NOT NULL DEFAULT '{}'
time_created                    BIGINT NOT NULL
time_updated                    BIGINT NOT NULL
time_archived                   BIGINT
```

约束：

```text
status IN ('active', 'archived')
repository_provider IN ('github', 'gitlab', 'generic')
repository_auth_type IN ('none', 'oauth', 'token', 'basic', 'ssh')
repository_connection_status IN ('verified', 'unreachable', 'unauthorized')

repository_auth_type = 'none'
  <=> repository_credential IS NULL
```

`repository_url` 必须是移除 userinfo、query、fragment 和凭据后的 canonical URL。

`repository_credential` 保存 `SecretStore.Envelope`，不是明文 credential：

```ts
type Envelope = {
  algorithm: "aes-256-gcm"
  keyID: string
  nonce: string
  ciphertext: string
  tag: string
}
```

AAD 使用：

```text
project:<projectID>:repository
```

### 7.3 agent

字段复用当前 `session_agents`，但资源直接关联 SaaS Project：

```text
id                              TEXT PRIMARY KEY
project_id                      TEXT NOT NULL
name                            TEXT NOT NULL
description                     TEXT
mode                            TEXT NOT NULL DEFAULT 'all'
prompt                          TEXT
permission                      JSON/JSONB NOT NULL DEFAULT '[]'
model                           JSON/JSONB
temperature                     REAL
top_p                           REAL
steps                           BIGINT
color                           TEXT
variant                         TEXT
options                         JSON/JSONB NOT NULL DEFAULT '{}'
time_created                    BIGINT NOT NULL
time_updated                    BIGINT NOT NULL
```

约束：

```text
INDEX(project_id)
UNIQUE(project_id, name)
mode IN ('primary', 'subagent', 'all')
```

### 7.4 skill

```text
id                              TEXT PRIMARY KEY
project_id                      TEXT NOT NULL
name                            TEXT NOT NULL
description                     TEXT NOT NULL
content                         TEXT NOT NULL
resources                       JSON/JSONB NOT NULL DEFAULT '[]'
time_created                    BIGINT NOT NULL
time_updated                    BIGINT NOT NULL
```

约束：

```text
INDEX(project_id)
UNIQUE(project_id, name)
```

继续使用现有 `SkillResource` 限制：

- 单文件最大 512 KiB；
- bundle 最大 1 MiB；
- 最多 64 个 resource；
- 禁止绝对路径和 `..` 路径穿越。

### 7.5 mcp

```text
id                              TEXT PRIMARY KEY
project_id                      TEXT NOT NULL
name                            TEXT NOT NULL
type                            TEXT NOT NULL
command                         JSON/JSONB
url                             TEXT
enabled                         BOOLEAN NOT NULL DEFAULT true
timeout                         BIGINT
environment_keys                JSON/JSONB NOT NULL DEFAULT '[]'
header_keys                     JSON/JSONB NOT NULL DEFAULT '[]'
secrets                         JSON/JSONB
time_created                    BIGINT NOT NULL
time_updated                    BIGINT NOT NULL
```

约束：

```text
INDEX(project_id)
UNIQUE(project_id, name)
type IN ('local', 'remote')
local  => command IS NOT NULL AND url IS NULL
remote => command IS NULL AND url IS NOT NULL
```

`secrets` 是加密 Envelope，明文内容为：

```ts
type McpSecrets = {
  environment: Record<string, string>
  headers: Record<string, string>
}
```

API 只返回 `environmentKeys`、`headerKeys` 和 `hasSecrets`，不返回明文或密文。

MCP secret AAD 使用：

```text
project:<projectID>:mcp:<mcpID>
```

## 8. 高内聚模块划分

Schema、Git 验证、加密和持久化 Service 集中在 `packages/opencode/src/saas-project/`，不修改 `packages/core` 和公共 Schema 包：

新增：

```text
packages/opencode/src/saas-project/index.ts
packages/opencode/src/saas-project/project.pg.ts
packages/opencode/src/saas-project/git.ts
packages/opencode/src/saas-project/secret.ts
packages/opencode/src/server/routes/instance/httpapi/groups/saas-project.ts
packages/opencode/src/server/routes/instance/httpapi/handlers/saas-project.ts
```

新 API 组只使用全局 Authorization，不使用 Instance 和 Workspace 中间件。

## 9. SecretStore

### 9.1 配置

新增环境变量：

```text
OPENCODE_SECRET_KEY_ID
OPENCODE_SECRET_KEY
```

要求：

- `OPENCODE_SECRET_KEY` 解码后必须为 32 bytes；
- 缺失密钥不影响旧服务启动，但需要保存 Git/MCP secret 的操作明确失败；
- 测试使用显式测试 Layer，不隐式生成生产密钥；
- 日志只能记录 key ID，不能记录 key、nonce、ciphertext 或输入 secret。

### 9.2 加密

使用 AES-256-GCM：

1. 每次加密生成 96-bit 随机 nonce；
2. credential 先由 Effect Schema 编码为 UTF-8 JSON；
3. 使用 Project ID 和用途作为 AAD；
4. 保存 key ID、nonce、ciphertext 和 auth tag；
5. 解密后只在 Git 调用的最小 Effect scope 内存在；
6. 支持 key ring 解密旧 key，并使用当前 key 写入。

### 9.3 API 语义

更新 secret 时：

- 字段省略：保留现有 secret；
- `null`：删除 secret，仅当 auth type 改为 `none` 时允许；
- 提供新值：替换并重新验证仓库。

## 10. Git URL 安全策略

### 10.1 允许格式

```text
https://host/owner/repository.git
ssh://git@host/owner/repository.git
git@host:owner/repository.git
```

拒绝：

- `file:`；
- `git:` 明文协议；
- URL userinfo 中携带密码/token；
- query 和 fragment；
- 以 `-` 开头的输入；
- URL 中嵌入换行、NUL 或 shell 控制字符；
- 未在 allowlist 中的协议和端口。

### 10.2 Provider 判断

- `github` 默认要求 `github.com`；
- `gitlab` 默认要求 `gitlab.com`；
- 自建 GitHub Enterprise/GitLab 使用 `generic`，后续再增加 provider host 配置；
- generic 保存 host/path，但不因 provider 不识别而拒绝合法 Git 服务。

### 10.3 SSRF 防护

generic HTTPS/SSH 在验证前执行：

- DNS 解析；
- 禁止 loopback、link-local、multicast 和 metadata IP；
- 默认禁止 RFC1918 私网地址；
- 连接前后验证解析结果，防 DNS rebinding；
- 如部署必须访问内网 Git，通过显式 host allowlist 开放。

## 11. Git 访问验证

### 11.1 命令

使用只读验证：

```text
git ls-remote --symref --exit-code <canonical-url> HEAD
```

要求：

- timeout 默认 15 秒；
- stdout/stderr 分别限制 64 KiB；
- `GIT_TERMINAL_PROMPT=0`；
- `GCM_INTERACTIVE=Never`；
- 空仓库允许验证成功；
- 不通过 clone 验证；
- 网络验证期间不持有数据库事务。

### 11.2 HTTPS 认证

禁止：

- token 拼进 URL；
- token 放入 `git -c http.extraHeader=...` 参数；
- token 写入持久 Git config；
- token 出现在异常 message、trace attributes 或 permission metadata。

通过一次性 credential helper/askpass 和匿名文件描述符传递 secret。子进程退出后立即关闭 FD 和清理 helper。

### 11.3 SSH 认证

- 临时目录权限 `0700`；
- private key 文件权限 `0600`；
- `BatchMode=yes`；
- 禁止 `StrictHostKeyChecking=no`；
- GitHub/GitLab 使用内置可信 host key；
- generic 要求调用方提交 host fingerprint 或服务 allowlist；
- 使用 `Effect.acquireRelease` 保证取消、超时和异常时清理临时文件。

### 11.4 错误分类

```text
RepositoryInvalidUrl
RepositoryHostDenied
RepositoryTimeout
RepositoryUnauthorized
RepositoryNotFound
RepositoryUnreachable
RepositoryHostKeyMismatch
```

公共错误只返回安全摘要，不回传原始 Git stderr。

## 12. HTTP API

### 12.1 Project CRUD

```text
POST   /saas/project
GET    /saas/project
GET    /saas/project/:projectID
PATCH  /saas/project/:projectID
DELETE /saas/project/:projectID
POST   /saas/project/:projectID/repository/verify
PUT    /saas/project/:projectID/repository
```

`DELETE` V1 执行软归档，不删除 Agent、Skill、MCP。

底层同时实现不公开的 `SaasProject.purge`，在单个数据库事务中显式执行：

```text
DELETE FROM mcp WHERE project_id = ?
DELETE FROM skill WHERE project_id = ?
DELETE FROM agent WHERE project_id = ?
DELETE FROM saas_project WHERE id = ?
```

删除顺序由 Service 固定，任何一步失败都回滚。数据库不负责级联。

### 12.2 创建请求

```json
{
  "name": "opencode",
  "description": "OpenCode SaaS",
  "repository": {
    "provider": "github",
    "url": "https://github.com/anomalyco/opencode.git",
    "defaultBranch": "dev",
    "auth": {
      "type": "token",
      "token": "secret"
    }
  },
  "metadata": {}
}
```

`auth` 是判别联合：

```ts
type RepositoryAuthInput =
  | { type: "none" }
  | { type: "oauth"; accessToken: string; refreshToken?: string; expiresAt?: number }
  | { type: "token"; token: string; username?: string }
  | { type: "basic"; username: string; password: string }
  | { type: "ssh"; privateKey: string; passphrase?: string; hostFingerprint: string }
```

### 12.3 Project 响应

```json
{
  "id": "prj_...",
  "name": "opencode",
  "description": "OpenCode SaaS",
  "status": "active",
  "repository": {
    "provider": "github",
    "url": "https://github.com/anomalyco/opencode.git",
    "host": "github.com",
    "path": "anomalyco/opencode",
    "defaultBranch": "dev",
    "authType": "token",
    "hasCredential": true,
    "connectionStatus": "verified",
    "verifiedAt": 0,
    "lastCheckedAt": 0
  },
  "metadata": {},
  "time": {
    "created": 0,
    "updated": 0
  }
}
```

响应永远不包含：

- token/password/private key；
- encrypted envelope；
- 原始 Git stderr；
- 包含凭据的 URL。

### 12.4 Project Agent API

```text
GET    /saas/project/:projectID/agents
PUT    /saas/project/:projectID/agents/:name
DELETE /saas/project/:projectID/agents/:name
```

### 12.5 Project Skill API

```text
GET    /saas/project/:projectID/skills
PUT    /saas/project/:projectID/skills/:name
DELETE /saas/project/:projectID/skills/:name
```

### 12.6 Project MCP API

```text
GET    /saas/project/:projectID/mcps
PUT    /saas/project/:projectID/mcps/:name
DELETE /saas/project/:projectID/mcps/:name
```

这些 API 分别调用 `AgentStore`、`SkillStore`、`McpStore`，并将路径中的 `projectID` 作为资源归属。

所有 PUT 使用各表的 `(project_id, name)` upsert，支持幂等重试。

## 13. 创建 Project 流程

```text
HTTP decode
  -> 生成 prj_ ID
  -> 校验 name/metadata
  -> GitRemote.parse + canonicalize
  -> provider/url 一致性校验
  -> SSRF/host-key 校验
  -> GitVerification.verify（使用请求中的临时凭据）
  -> SecretStore.encrypt（非 none）
  -> DB transaction
       -> INSERT saas_project
  -> 返回脱敏 Project.Info
```

网络验证失败时不产生 Project 记录。

并发重复创建相同仓库默认允许。V1 没有可靠 tenant/owner 模型，不能定义正确的仓库唯一范围，因此不增加 `UNIQUE(repository_url)`。

## 14. 更新仓库流程

`PUT /saas/project/:projectID/repository` 必须提交完整 repository 配置：

1. 查询 Project；
2. 解析和验证新仓库；
3. 使用新凭据完成 `ls-remote`；
4. 加密凭据；
5. 单事务替换 repository 字段；
6. 更新 `time_updated`、`verified_at` 和 `last_checked_at`。

验证失败时保留旧仓库配置，不进入半更新状态。

`POST /repository/verify` 使用已存凭据重新验证，并更新 connection status：

- 成功：`verified`；
- 认证失败：`unauthorized`；
- 网络或服务失败：`unreachable`。

## 15. 服务与 Effect 结构

### 15.1 Service

```text
SecretStore.Service
GitRemote.Service
GitVerification.Service
SaasProject.Service
AgentStore.Service
SkillStore.Service
McpStore.Service
```

业务方法使用 `Effect.fn("SaasProject.create")`、`Effect.fn("AgentStore.upsert")` 等命名 effect。

HTTP handler 只负责：

- 读取 typed payload；
- 调用 Service；
- 将领域错误映射为公开 HttpApi 错误。

handler 不直接执行 Git、SQL、加密或路径校验。

### 15.2 Layer

Project 控制面是 process-global 服务，不使用按 directory 缓存的 `InstanceState`。

```text
SaasProject.layer
  -> Database.Service
  -> SecretStore.Service
  -> GitRemote.Service
  -> GitVerification.Service

AgentStore.layer
SkillStore.layer
McpStore.layer
  -> Database.Service
  -> SecretStore.Service
```

Git 子进程使用 Effect 平台 `ChildProcessSpawner`；临时文件和 FD 使用 scoped resource 管理。

## 16. Authorization 限制

当前 Authorization 只是全服务 Basic password，不提供 user、tenant 或 project owner identity。

因此 V1 的权限语义只能是：

- 通过服务 Authorization 的调用方可以访问全部 Project；
- Project 表暂不增加伪造的 `user_id`；
- 不能仅依据请求中的 `userId` 建立所有权，因为该值不是可信认证主体。

在正式多租户开放前，必须新增可信 Principal/Actor 中间件，并为 Project 增加 tenant/owner 逻辑关联字段和索引。该工作独立于本次 Project 领域实现，但属于生产安全前置项。

## 17. 数据库迁移

### 17.1 PostgreSQL

新增独立 PG SQL migration，并同步 `project.pg.ts` 风格的 PG schema。

迁移必须包含：

- 不创建外键和数据库级联；
- `agent.project_id`、`skill.project_id`、`mcp.project_id` 普通索引；
- 每张资源表的 `UNIQUE(project_id, name)`；
- Agent mode 和 MCP type check constraint；
- JSONB defaults；
- bigint timestamps；
- MCP secret JSONB 字段只保存加密 Envelope。

### 17.2 不迁移旧 Project 数据

现有 Project 行只有本地 `worktree/vcs`，数据库无法证明远程仓库 URL和访问凭据。V1 不自动将其迁入新 Project。

后续可提供“认领旧项目”流程，但必须由调用方提交 repository 和 credential，并通过远程验证。

## 18. 现有 API 处理

当前这些接口继续服务旧目录 Project：

```text
GET  /project/current
POST /project/git/init
GET  /project/:projectID/directories
```

为避免修改旧路由，控制面使用独立前缀：

```text
/saas/project
/saas/project/:projectID
```

## 19. 可观测性

记录：

- `projectID`；
- provider、host 和 canonical path；
- 验证阶段和耗时；
- 安全错误分类；
- DB 操作结果；
- credential key ID。

禁止记录：

- repository 原始输入 URL；
- authorization header；
- token、password、private key、passphrase；
- Git 完整命令行；
- Git 原始 stderr；
- MCP environment/header values；
- encrypted envelope。

## 20. 测试方案

### 20.1 Project Schema

- `prj_` ID 创建和非法 ID 拒绝；
- name 长度和空白校验；
- repository provider/auth 判别联合；
- metadata 大小限制；
- API 响应不含 secret 字段。

### 20.2 Git URL

- GitHub HTTPS/SSH canonicalize；
- GitLab group/subgroup path；
- generic HTTPS/SSH；
- 拒绝 file/git scheme；
- 拒绝 URL userinfo/query/fragment；
- 拒绝 loopback、metadata 和私网地址；
- DNS rebinding 防护；
- provider 与 host 不匹配。

### 20.3 Git Auth

- none 公共仓库；
- oauth/token/basic/ssh 成功；
- 无效 token；
- SSH host key mismatch；
- timeout 和取消清理；
- token 不出现在 args、日志、error 和响应；
- 临时 key/helper 被清理。

### 20.4 SecretStore

- encrypt/decrypt round trip；
- AAD 不匹配无法解密；
- ciphertext 篡改失败；
- key rotation；
- 未配置 key 时公开仓库操作可用、secret 写入明确失败；
- DB 中不存在明文片段。

### 20.5 Project CRUD

- 创建前验证；
- 验证失败无 DB 行；
- get/list/update/archive；
- 仓库更新失败保持旧值；
- verify 更新连接状态；
- 并发创建和并发更新；
- SQLite/PG 行为一致。

### 20.6 Agent/Skill/MCP

- CRUD 和 upsert；
- 同 Project 同名覆盖；
- 不同 Project 同名隔离；
- Project 删除时 Service 显式清理关联资源；
- 不存在的 Project 创建资源返回领域 404，不依赖数据库约束错误；
- 孤儿资源巡检和清理；
- Skill resource 限制；
- MCP local/remote check constraint；
- MCP API 脱敏；
- secret 省略、删除和替换语义；
- 日志无 secret。

### 20.7 HTTP

- Project API 无 directory header 也可调用；
- 不触发 `InstanceStore.load`；
- typed 400/401/404/409/422/503；
- OpenAPI 无 secret response schema；
- SDK 生成契约测试。

## 21. 错误与 HTTP 状态

| 领域错误 | HTTP |
|---|---:|
| ProjectNotFound | 404 |
| ProjectArchived | 409 |
| RepositoryInvalidUrl | 400 |
| RepositoryHostDenied | 422 |
| RepositoryUnauthorized | 422 |
| RepositoryNotFound | 422 |
| RepositoryTimeout | 504 |
| RepositoryUnreachable | 503 |
| RepositoryHostKeyMismatch | 422 |
| ProjectConfigConflict | 409 |
| SecretStoreUnavailable | 503 |

## 22. 实施阶段

### 阶段 1：安全基础

1. 实现 `SecretStore`；
2. 实现 Git URL canonicalize 和 SSRF 策略；
3. 为 Git Service 增加 auth-aware `ls-remote`；
4. 完成 secret 泄漏测试。

### 阶段 2：Project 核心

1. 增加 Project ID 和 Schema；
2. 增加本机 PostgreSQL 表和 migration；
3. 实现 Project Service；
4. 实现无 InstanceContext 的控制面 API；
5. 生成 Client SDK。

### 阶段 3：Project 配置

1. 实现通用 `agent` 表、`AgentStore` 和 Project Agent API；
2. 实现通用 `skill` 表、`SkillStore` 和 Project Skill API；
3. 实现通用 `mcp` 表、`McpStore`、Secret 和 Project MCP API；
4. 完成隔离、应用层清理、孤儿巡检和脱敏测试。

### 阶段 4：兼容性验证

1. 保持旧目录 Project route 不变；
2. 验证旧 Session 和目录 Project 测试；
3. 明确旧 Project 物理表后续迁移方案；
4. 不在本阶段接入 Session。

## 23. 验收标准

Project V1 完成必须同时满足：

1. 无 Git repository 的请求无法创建 Project；
2. Git 不可访问或凭据错误时不写入 Project；
3. Project ID 使用稳定 `prj_` ID；
4. Project API 不依赖 directory/instance；
5. DB、API、日志和进程参数均不出现明文 secret；
6. `agent`、`skill`、`mcp` 通过 `project_id` 支持 CRUD、项目隔离和应用层清理；
7. 本机 PostgreSQL migration、Schema 和 Service 行为一致；
8. 旧 Session 和目录实例测试不回归；
9. OpenAPI 和生成 SDK 不暴露 secret；
10. 多租户开放前明确完成 Principal/owner 权限模型。

## 24. 后续演进点

不在 V1 实现，但数据模型应允许：

- Project 多仓库；
- GitHub/GitLab OAuth browser flow；
- 凭据跨 Project 复用；
- Project owner/member/RBAC；
- Project clone/checkouts/workspaces；
- Session 关联 Project；
- Project 配置向 Session 物化；
- Requirement、Task 和 Workflow；
- Git push、PR 和 Issue 集成。
