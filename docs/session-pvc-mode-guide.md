# 会话 PVC 模式使用指南

> 适用版本：`feat/session-pvc-mode` 分支
> 技术方案见 [session-pvc-mode.md](./session-pvc-mode.md)
> 测试用例见 [27-session-pvc-mode.md](./test-cases/27-session-pvc-mode.md)

---

## 一、功能概述

SaaS 沙箱支持两种 PVC（持久化卷）模式：

| 模式 | 隔离粒度 | 场景 |
|------|---------|------|
| **session**（默认） | 每会话独立空间 | 独立开发、临时任务 |
| **app** | 同应用共享空间 + worktree 隔离 | 同一项目的多需求并行开发 |

### session 模式（现有行为）

每个会话独占一份 PVC 空间，互不干扰：

```
PVC
└── sessions/{sessionID}/
    ├── workspace/  → /workspace
    ├── home/       → /home/sandbox
    └── ...
```

### app 模式（新增）

同一应用（appID）的所有会话**共享同一份 PVC 空间**，各自通过 **git worktree** 在独立目录中工作：

```
PVC
└── apps/{appID}/
    ├── workspace/  → /workspace（整个应用空间根）
    │   ├── repo/                          # 共享仓库（clone 一次）
    │   └── worktrees/
    │       ├── {sessionID-1}/             # 会话1的独立工作目录
    │       ├── {sessionID-2}/             # 会话2的独立工作目录
    │       └── {sessionID-3}/             # 会话3的独立工作目录
    ├── home/       → /home/sandbox（共享环境：npm/pnpm 缓存、工具配置）
    └── ...
```

---

## 二、API 用法

### 创建 session 模式会话（默认）

```bash
POST /session
{}
```

或显式指定：

```bash
POST /session
{ "pvcMode": "session" }
```

### 创建 app 模式会话

```bash
POST /session
{ "pvcMode": "app", "appID": "my-project-001" }
```

**必填参数**：

| 参数 | 说明 |
|------|------|
| `pvcMode` | `"app"` |
| `appID` | 应用唯一标识，不能为空或纯空白 |

**校验规则**：
- `pvcMode=app` 但不传 `appID` → HTTP 400
- `appID` 为纯空白 → HTTP 400
- `pvcMode` 非 `session`/`app` → HTTP 400

### 查询会话 PVC 配置

```bash
GET /session/{sessionID}

# 响应包含：
{
  "id": "ses_xxx",
  "pvcMode": "app",
  "appID": "my-project-001",
  ...
}
```

---

## 三、app 模式完整流程

### 典型使用场景

同一前端项目，多个需求（会话）同时开发：

```
① 编排系统：创建会话（pvcMode=app, appID=影刀官网）
② 编排系统：首次 exec clone 仓库到 /workspace/repo
③ opencode：自动创建 worktree（/workspace/worktrees/{sessionID}）
④ 编排系统：在 worktree 中切分支、开发
⑤ 编排系统：commit、push
⑥ 重复 ①-⑤ 创建更多同 appID 会话
```

### 步骤详解

#### Step 1：创建会话

```bash
SID=$(curl -s -X POST http://localhost:14096/session \
  -H 'Content-Type: application/json' \
  -d '{"pvcMode":"app","appID":"my-app-001"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
```

#### Step 2：首次 clone 仓库（仅第一次）

```bash
curl -s -X POST http://localhost:14096/session/$SID/exec \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && git clone https://github.com/user/repo.git repo"}'
```

> clone 后，opencode 自动在后续 exec / AI 消息时创建 worktree。

#### Step 3：在 worktree 中工作

```bash
# 进入自己的 worktree 目录
curl -s -X POST http://localhost:14096/session/$SID/exec \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace/worktrees/'$SID' && git checkout -b feature-A && echo hello > new-file.txt && git add . && git commit -m \"feat: add file\""}'
```

每个会话有自己的 worktree 目录（`/workspace/worktrees/{sessionID}`），独立切分支、提交。

#### Step 4：创建第二个同 appID 会话

```bash
SID2=$(curl -s -X POST http://localhost:14096/session \
  -H 'Content-Type: application/json' \
  -d '{"pvcMode":"app","appID":"my-app-001"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
```

会话 SID2 **不需要重新 clone**——共享同一 PVC 空间，`/workspace/repo` 已存在。opencode 自动为 SID2 创建独立 worktree。

---

## 四、共享与隔离

### 共享（同 appID）

| 维度 | 说明 |
|------|------|
| `/workspace/repo` | 共享仓库（clone 一次） |
| `/home/sandbox/.cache` | npm/pnpm 缓存（跨会话复用） |
| `/home/sandbox/.config` | 工具配置（跨会话一致） |
| `shared/package-cache` | 全局包缓存（跨 app 共享） |

### 隔离（同 appID 不同会话）

| 维度 | 隔离方式 |
|------|---------|
| **git 分支** | 各自 worktree 独立切分支 |
| **git commit** | 各自独立的 commit 历史 |
| **工作目录** | `/workspace/worktrees/{sessionID}` 各自独立 |
| **sandbox 容器** | 不同沙箱实例（进程隔离） |
| **repo 主分支** | 不受 worktree 分支影响 |

### 跨 appID 隔离

不同 `appID` 的会话 PVC 路径完全不同（`apps/app-1/` vs `apps/app-2/`），文件系统隔离。

### session/app 隔离

session 模式（`sessions/{sessionID}/`）与 app 模式（`apps/{appID}/`）路径完全不同。

---

## 五、自动 Worktree 机制

### 触发时机

| 操作 | 是否触发 worktree |
|------|-----------------|
| AI 消息（write/edit/read/bash 工具调用） | ✅ |
| exec API（`POST /session/:id/exec`） | ✅ |
| exec/async API | ✅ |
| fork 会话 | ❌（fork 不继承 pvcMode） |

### 脚本逻辑（幂等 + 降级）

```bash
if [ -d /workspace/repo/.git ]; then      # repo 已存在？
  if [ ! -d /workspace/worktrees/{sessionID} ]; then  # worktree 不存在？
    git -C /workspace/repo worktree add --detach /workspace/worktrees/{sessionID} HEAD
  fi
fi
```

- **repo 不存在**（首次会话，还没 clone）→ 跳过，不阻塞
- **worktree 已存在**（会话重启）→ 跳过，不重复创建
- **repo 存在但没有 commit**（git init 但没 commit）→ `HEAD` 无效，worktree 创建失败，不影响会话

### sandbox 销毁后重建

sandbox 被 idle 销毁后重建时：
- PVC 数据持久（worktree 目录保留）
- 重建后自动触发 worktree 脚本 → worktree 已存在 → 跳过
- 无需手动恢复

---

## 六、环境要求

### 必须配置

```bash
OPENCODE_SANDBOX_VOLUME_TYPE=pvc          # 必须，app 模式仅 pvc 生效
OPENCODE_SANDBOX_PVC_CLAIM=<claim-name>   # PVC claim 名称
```

### 不生效的情况

| 配置 | app 模式行为 |
|------|-------------|
| `VOLUME_TYPE=none` | 不挂载任何卷，app 模式无效（安全回退） |
| `VOLUME_TYPE=host` | 使用本地目录，app 模式无效（安全回退） |
| `VOLUME_TYPE=pvc` + 缺 appID | 安全回退到 session 模式 |

---

## 七、注意事项

### 1. repo 初始化必须有有效 commit

```bash
# ✅ 正确（有 commit，HEAD 有效）
git init && echo h > R.md && git add . && git -c user.email=t@t.com -c user.name=t commit -m init

# ❌ 错误（没有 commit，HEAD 无效，worktree 创建失败）
git init
```

### 2. exec API 不需要手动管理 worktree

opencode 在每次 exec 时自动确保 worktree 存在（幂等）。编排系统只需：
1. 首次 clone repo 到 `/workspace/repo`
2. 后续 exec 正常使用

### 3. keepAlive 与 sandbox 生命周期

app 模式会话默认 `keep_alive=false`。sandbox 在 idle 后被销毁，PVC 数据持久。重建后自动恢复 worktree。

如需保持 sandbox 存活（如启动 dev server）：

```bash
POST /session/{sessionID}/keep-alive {"enabled": true}
```

### 4. 子会话（subagent）自动共享

subagent 通过 `findRoot()` 沿 parent_id 链向上查 root 会话的 pvcMode/appID，自动共享父会话的 sandbox 和 PVC 空间。

### 5. 编排系统 git 操作建议

执行 git add/commit 前清理残留锁（幂等安全）：

```bash
rm -f /workspace/repo/.git/index.lock && git add -A && git commit -m "msg"
```

---

## 八、快速验证

```bash
# 1. 创建两个同 appID 会话
SID1=$(curl -s -X POST http://localhost:14096/session -H 'Content-Type: application/json' -d '{"pvcMode":"app","appID":"test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
SID2=$(curl -s -X POST http://localhost:14096/session -H 'Content-Type: application/json' -d '{"pvcMode":"app","appID":"test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 2. 会话1 写文件
curl -s -X POST http://localhost:14096/session/$SID1/exec -H 'Content-Type: application/json' -d '{"command":"echo shared > /workspace/repo/test.txt"}'

# 3. 会话2 读文件（应能读到）
curl -s -X POST http://localhost:14096/session/$SID2/exec -H 'Content-Type: application/json' -d '{"command":"cat /workspace/repo/test.txt"}'

# 期望输出：shared
```
