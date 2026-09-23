# 会话级 PVC 模式（session / app）技术方案

## 1. 背景与目标

### 1.1 现状

当前远程沙箱的 PVC 持久化卷按 **sessionID** 隔离。核心逻辑在 `packages/opencode/src/tool/sandbox-provider.ts` 的 `buildVolumes(sessionID, config)`：

- 每个会话独占一份持久化空间，subPath 前缀为 `sessions/{sessionID}/...`
- 6 个会话级卷：`workspace` / `home` / `cache` / `config` / `local` / `tmp`
- PVC 模式额外挂载一个共享 `package-cache` 卷（`shared/package-cache`）
- 模式由全局环境变量 `OPENCODE_SANDBOX_VOLUME_TYPE`（`none` / `pvc` / `host`）控制

现有的本地 `Worktree.Service`（`src/worktree/index.ts`）操作的是 **opencode 主机本地磁盘**，与远程沙箱 / PVC 无关，本方案**完全不涉及**它。

### 1.2 目标

在现有「按 sessionID 隔离」的基础上，新增「按 appId 隔离」的 PVC 模式：

- **PVC 模式是会话级配置**：在创建会话时传入，持久化到 session 记录上
- **app 模式**：同一应用（appId）的所有会话**共享同一份 PVC 空间**，subPath 前缀为 `apps/{appId}/...`
- 同一 app 下的不同需求（会话）用 **git worktree** 区分，每个会话对应 `/workspace/worktrees/{sessionID}`
- **worktree 创建由 opencode 自动处理**（detach 模式、幂等、repo 不存在时降级）
- **两种模式并存**，session 模式行为完全保持不变（回归零影响）

### 1.3 职责边界

| 职责 | 归属 |
|------|------|
| 会话承载 `pvcMode` + `appId` | **opencode（本方案）** |
| 按会话 PVC 模式产出正确卷布局 | **opencode（本方案）** |
| app 模式自动创建 worktree（detach、幂等、降级） | **opencode（本方案）** |
| 提供 exec 接口（沙箱内执行命令） | opencode（已有） |
| `git clone` repo（仓库创建） | **上层服务**（通过 exec 命令实现） |
| repo 来源、凭证 | 上层服务（不在本方案） |
| 切分支 / 提交 / 推送等开发动作 | 上层服务（不在本方案） |
| 首次 clone 并发控制 | 上层服务（不在本方案） |

> **分工要点**：opencode 负责"把一个挂在 repo 上的 detached worktree 目录准备好"；上层负责"clone repo" 和 "进 worktree 后切分支开发"。opencode 不碰分支、不碰 repo 来源。

## 2. 设计

### 2.1 模式对比

| 维度 | session 模式（现有） | app 模式（新增） |
|------|---------------------|------------------|
| subPath 前缀 | `sessions/{sessionID}` | `apps/{appId}` |
| `/workspace` 指向 | `sessions/{sessionID}/workspace` | `apps/{appId}/workspace`（整个 app 空间根） |
| 隔离粒度 | 每会话独立 | 同 app 所有会话共享 |
| worktree | 无 | opencode 自动建 `/workspace/worktrees/{sessionID}`（detach） |
| 6 个会话级卷归属 | 各会话独立 | **全部按 app 共享**（B1） |
| package-cache | `shared/package-cache`（不变） | `shared/package-cache`（不变） |

### 2.2 app 模式 PVC 布局（P1：repo 在 workspace 卷内）

所有 6 个卷的 subPath 前缀统一改为 `apps/{appId}`。**repo 与 worktrees 都放在 workspace 卷内**，沙箱里同处 `/workspace` 单一挂载点，git worktree 引用主仓库 `.git` 无跨挂载点问题：

```
PVC (claimName 不变)
└── apps/{appId}/
    ├── workspace/  → /workspace                # 整个 app 空间根，单一挂载点
    │   ├── repo/                               # 上层 clone 一次 → 沙箱内 /workspace/repo
    │   └── worktrees/{sessionID}/              # opencode 自动建 → /workspace/worktrees/{sessionID}
    ├── home/       → /home/sandbox
    ├── cache/      → /home/sandbox/.cache
    ├── config/     → /home/sandbox/.config
    ├── local/      → /home/sandbox/.local
    └── tmp/        → /home/sandbox/tmp

shared/package-cache → 配置的 packageCacheMount（跨 app 共享，不变）
```

> **为什么全部卷按 app 共享（B1）**：同一 app 环境一致，npm / pip / pnpm 缓存天然复用，home 下工具配置共享。会话间代码隔离由 worktree 在 `workspace/worktrees/{sessionID}` 完成，不依赖卷级隔离。
>
> **为什么 repo 放 workspace 卷内（P1）**：repo（`/workspace/repo`）与 worktree（`/workspace/worktrees/{sessionID}`）同处一个挂载点，`git worktree add` 的相对引用与 `.git` 链接天然可用，沙箱无需挂多个点，上层 clone 目标路径简单。

### 2.3 自动 worktree 逻辑（detach + 幂等 + 降级）

app 模式会话首次使用沙箱时，opencode 在**沙箱内**执行（通过 `runInSession`）：

```sh
# repo 已 clone → 建（幂等）并使用 worktree
if [ -d /workspace/repo/.git ]; then
  if [ ! -d /workspace/worktrees/{sessionID} ]; then
    git -C /workspace/repo worktree add --detach \
        /workspace/worktrees/{sessionID} HEAD
  fi
  # 会话工作目录 = /workspace/worktrees/{sessionID}
else
  # repo 还没 clone（如项目初始化首会话）→ 跳过建 worktree
  # 工作目录留在 /workspace 根；上层 clone 后，后续会话自动建 worktree
fi
```

要点：

- **detach 模式**：`--detach ... HEAD`，opencode 只准备 detached worktree 目录，**完全不碰分支**；上层进去后自己 `git checkout -b <分支>`
- **幂等**：worktree 已存在（会话重启）则不重复创建
- **降级**：repo 不存在时跳过、不阻塞会话，避免「首会话拉代码却要先有 worktree」的死锁
- **执行位置**：放在 `session/tools.ts` 拿到 sandbox 后（业务编排层），保持 sandbox-provider「只管卷和容器」的纯粹职责

### 2.4 统一数据流

"项目初始化"与"业务开发"**不是两条流程**——opencode 侧逻辑完全一致，差异仅由"repo 是否已存在"在自动 worktree 步骤内自然分叉（幂等降级收敛）。opencode 不感知当前是哪种场景，只看 `repo/.git` 在不在。

```
① 创建会话（传入 pvcMode + appId）
     → 校验：app 模式必须有 appId（否则 InvalidPvcConfigError）
     → 持久化到 session 表（pvc_mode, app_id）

② 执行任务
     → session/tools.ts 查会话 pvc_mode / app_id
     → SandboxProvider.getOrCreate(sessionID, { pvcMode, appId })   ← 可选入参（A 方案）
     → [沙箱创建 / 复用逻辑不变，仍按 root sessionID 一对一]
     → createSandbox 透传 opts → buildVolumes 按 pvcMode 决定 subPath 前缀
       · app 模式 → 挂 apps/{appId} 空间（同 appId 共享，/workspace = apps/{appId}/workspace）
       · 否则     → 挂 sessions/{sessionID}（原逻辑不变）

③ 自动 worktree（仅 app 模式；幂等 + 降级，单一逻辑）
     if [ -d /workspace/repo/.git ]:          # repo 已就绪
         worktree 不存在则 git worktree add --detach
         cwd = /workspace/worktrees/{sessionID}
     else:                                     # repo 未就绪
         跳过, cwd = /workspace 根

④ 上层 exec（按需，唯一分叉点）
     repo 未就绪 → git clone <url> /workspace/repo      # 顺带完成"初始化"
     repo 已就绪 → cd worktree && git checkout -b <分支>  # 进入"开发"
```

> **合并关键**：第 ③ 步的幂等降级让两种场景在 opencode 侧收敛成同一套逻辑；"初始化 vs 开发"的区别只落在第 ④ 步上层的行为（clone 还是 checkout），opencode 无分叉。
>
> sandbox 按 root session 一对一复用，`opts` 只在**首次创建沙箱**时生效；后续复用已存在沙箱无需传 opts。自动 worktree 逻辑幂等，重复进入安全。

## 3. 改动清单

### 3.1 数据库 schema（2 个文件）

`src/session/session.sql.ts`、`src/session/session.pg.ts`，SessionTable 各加两列：

```ts
pvc_mode: text().$type<"session" | "app">(),   // null → 默认 session 模式
app_id: text(),                                  // app 模式必填
```

> 不加 `.notNull()`，保证旧会话兼容（null 视为 session 模式）。

### 3.2 Drizzle 迁移

```
cd packages/opencode && bun run db generate --name session_pvc_mode
```

生成 `migration/<timestamp>_session_pvc_mode/{migration.sql, snapshot.json}`。

### 3.3 Session schema（`src/session/session.ts`）

`Info`（约 line 208）增加：

```ts
pvcMode: optionalOmitUndefined(Schema.Literals(["session", "app"])),
appId: optionalOmitUndefined(Schema.String),
```

`CreateInput`（约 line 243）增加：

```ts
pvcMode: Schema.optional(Schema.Literals(["session", "app"])),
appId: Schema.optional(Schema.String),
```

### 3.4 toRow / fromRow（`src/session/session.ts`）

`fromRow`（约 line 73）增加：

```ts
pvcMode: row.pvc_mode ?? undefined,
appId: row.app_id ?? undefined,
```

`toRow`（约 line 115）增加：

```ts
pvc_mode: info.pvcMode,
app_id: info.appId,
```

### 3.5 create / createNext 透传 + 校验（`src/session/session.ts`）

- `createNext`（约 line 542）入参与 result 增加 `pvcMode` / `appId`
- `Session.create`（约 line 682）从 input 透传
- **校验**：app 模式必须有 appId，否则 fail。新增 typed error：

```ts
export class InvalidPvcConfigError extends Schema.TaggedErrorClass<InvalidPvcConfigError>()(
  "SessionInvalidPvcConfigError",
  { message: Schema.String },
) {}
```

### 3.6 buildVolumes 改造（`src/tool/sandbox-provider.ts` 核心）

签名改为接收对象：

```ts
export function buildVolumes(
  input: { sessionID: string; pvcMode?: "session" | "app"; appId?: string },
  config: SandboxConfig.Interface,
): Volume[]
```

逻辑：

```ts
if (config.volumeType === "none") return []
const useApp = config.volumeType === "pvc" && input.pvcMode === "app" && !!input.appId
const prefix = useApp ? `apps/${input.appId}` : `sessions/${input.sessionID}`
// mounts 数组结构不变，subPath 由 prefix 拼接
// host 模式 host.path 维持 /var/opencode/sessions/{sessionID}/... 不变
// package-cache 共享卷逻辑保留
```

> session 模式走原分支，行为零变化。app 模式缺 appId 时安全回退到 session 前缀。

### 3.7 getOrCreate 增加可选入参（A 方案）

`SandboxProvider.Interface.getOrCreate` 签名：

```ts
getOrCreate: (
  sessionID: SessionID,
  opts?: { pvcMode?: "session" | "app"; appId?: string },
) => Effect.Effect<Sandbox>
```

- `createSandbox` 透传 opts 给 `buildVolumes`
- 两个 layer（sqlite `layer` + `pgLayer`）的 `createSandbox` / `getOrCreate` / `getOrCreateUnlocked` 同步改
- 内部其它调用点（`runInSession` / `runDetached` / `interrupt` / `getEndpoint` 内部的 `getOrCreate(sessionID)`）保持不传 opts → 复用已存在沙箱，不受影响

### 3.8 调用方接入 + 自动 worktree（`src/session/tools.ts`）

`getSandbox()`（约 line 63）：

1. 查会话的 `pvc_mode` / `app_id`，传入 `getOrCreate(sandboxSessionID, { pvcMode, appId })`
2. app 模式下，拿到 sandbox 后执行自动 worktree 逻辑（2.3 的脚本，幂等 + 降级），通过 `runInSession` 在沙箱内执行
3. 解析出会话工作目录（worktree 建成 → `/workspace/worktrees/{sessionID}`；否则 → `/workspace`）供后续工具使用

> 子会话沿用 root session 的沙箱与 PVC 空间和 worktree（与现有 `findRootSessionID` 行为一致）。

## 4. 测试计划

`test/tool/sandbox-pvc.test.ts` 扩展（纯函数 `buildVolumes`，无需真实沙箱）：

- **app 模式**：subPath 前缀为 `apps/{appId}`，7 个卷（6 会话级 + package-cache）claimName 一致
- **app 模式缺 appId**：安全回退到 session 前缀
- **session 模式回归**：与现有断言完全一致（保护原行为）
- **host / none 模式**：不受 pvcMode 影响
- **同 app 不同 session**：6 个卷 subPath 相同（共享验证）
- **不同 app**：subPath 不同（隔离验证）
- **package-cache**：app 模式下仍为 `shared/package-cache`

自动 worktree 脚本（纯字符串构造，可单测命令拼接）：

- 命令含 `--detach`、目标路径 `/workspace/worktrees/{sessionID}`、源 `HEAD`
- 含 `repo/.git` 存在性判断（降级）
- 含 worktree 目录存在性判断（幂等）

Session schema 层：

- `CreateInput` 接受 `pvcMode` / `appId`
- app 模式缺 appId → `InvalidPvcConfigError`
- `toRow` / `fromRow` 往返保持字段

## 5. 兼容性与回滚

- **向后兼容**：新字段可空，旧会话 `pvc_mode = null` 等价于 session 模式
- **回归保护**：session 模式所有路径不变，`buildVolumes` 旧分支逻辑原样保留；自动 worktree 仅在 app 模式触发
- **回滚**：删除新字段引用 + 回退迁移即可，无数据破坏（新字段为 nullable 增量）

## 6. 决策记录

| 决策点 | 选择 | 理由 |
|--------|------|------|
| A. buildVolumes 取数方式 | getOrCreate 增加可选入参 | sandbox-provider 不反向依赖 session 表，分层干净 |
| B. app 模式卷归属 | 全部 6 卷按 app 共享（B1） | 同 app 环境一致、缓存复用；会话隔离交给 worktree |
| 配置存储 | session 表新增字段 | 模式是会话级配置，随会话创建传入 |
| appId 来源 | 创建会话时一起传入 | 上层服务控制，opencode 只承载与消费 |
| repo clone | 上层服务通过 exec 执行 | opencode 不碰 repo 来源 / 凭证 |
| worktree 创建 | opencode 自动处理 | 会话启动即就绪，体验更顺 |
| worktree 分支 | detach 模式，不碰分支 | 分支由上层 `checkout -b` 处理 |
| worktree 路径 | P1：repo 与 worktrees 同在 workspace 卷 | 单一挂载点，git worktree 引用天然可用 |
| repo 不存在 | 跳过建 worktree（幂等降级） | 避免首会话拉代码与 worktree 的死锁 |
| 自动 worktree 执行位置 | session/tools.ts（业务层） | sandbox-provider 保持只管卷与容器 |
| 模式切换 | session 级 pvcMode 字段 | 与全局 volumeType 正交，per-session 控制隔离粒度 |
