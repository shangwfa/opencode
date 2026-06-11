# Workspace Routing 路径解析修复

> 修复 SaaS 沙箱模式下 `/vcs/diff` 等 API 请求中 `directory` 参数缺失时的 fallback 逻辑，确保请求能正确路由到 session 关联的工作目录。

---

## 一、问题描述

### 1.1 现象

前端调用 `/vcs/diff` 时不传 `directory` 参数，后端 `defaultDirectory()` 直接 fallback 到 `OPENCODE_DEFAULT_DIRECTORY`（通常是 `/workspace`），而不是 session 中记录的 `directory`。导致：

- 沙箱已销毁的旧 session：本地路径 `/workspace` 找不到 git repo → 返回空
- 前端 URL 中带了 `directory=/workspace/project`：但后端走本地 VCS 路径时，容器文件系统上没有这个目录 → 返回空

### 1.2 根因

`defaultDirectory()` 的 fallback 链缺少 `session.directory`：

```
url.directory → headers → OPENCODE_DEFAULT_DIRECTORY → process.cwd()
                          ^
                          这里缺少 session.directory
```

### 1.3 影响范围

| 场景 | 受影响 | 说明 |
|------|--------|------|
| 沙箱路径（有 sessionID，sandbox 存活） | ❌ 不受影响 | sandbox 内部用自己的 working directory 执行 git，忽略 `directory` 参数 |
| 本地路径（无 sessionID） | ❌ 不受影响 | 走 `OPENCODE_DEFAULT_DIRECTORY` 或 `cwd`，是正确行为 |
| 沙箱已销毁（有 sessionID，sandbox 已回收） | ✅ 受影响 | fallback 到 `OPENCODE_DEFAULT_DIRECTORY` 而不是 session 记录的 directory |

---

## 二、修复方案

### 2.1 改动文件

`src/server/routes/instance/httpapi/middleware/workspace-routing.ts`

### 2.2 具体修改

#### 修改 1：`defaultDirectory` 增加 `sessionDirectory` 参数

```typescript
// 之前
function defaultDirectory(request: HttpServerRequest.HttpServerRequest, url: URL): string {
  return url.searchParams.get("directory") || request.headers["x-opencode-directory"] || Flag.OPENCODE_DEFAULT_DIRECTORY || process.cwd()
}

// 之后
function defaultDirectory(request: HttpServerRequest.HttpServerRequest, url: URL, sessionDirectory?: string): string {
  return url.searchParams.get("directory") || request.headers["x-opencode-directory"] || sessionDirectory || Flag.OPENCODE_DEFAULT_DIRECTORY || process.cwd()
}
```

#### 修改 2：`planRequest` 透传 `sessionDirectory`

```typescript
// 之前
function planRequest(request, sessionWorkspaceID?: WorkspaceID)

// 之后
function planRequest(request, options?: { sessionWorkspaceID?: WorkspaceID; sessionDirectory?: string })
```

#### 修改 3：`routeHttpApiWorkspace` 传入 `session?.directory`

```typescript
const plan = yield* planRequest(request, { 
  sessionWorkspaceID: session?.workspaceID, 
  sessionDirectory: session?.directory 
})
```

### 2.3 Fallback 优先级（修复后）

```
URL ?directory=xxx 
  → Header x-opencode-directory 
  → Session.directory  ← 新增
  → Env OPENCODE_DEFAULT_DIRECTORY 
  → process.cwd()
```

### 2.4 向后兼容

- `workspaceRouterMiddleware`（raw router）不传 session，`options` 为 `undefined`，行为不变
- 已有 URL 带 `directory` 参数的请求，优先使用 URL 参数，不受此改动影响
- `session.directory` 的准确性由用户保证（exec clone 后 PATCH 更新）

---

## 三、测试用例

### 3.1 测试环境

- 容器镜像：`opencode-saas-sandbox-test:v79`（含本次修复）
- 本地测试环境：`localhost:14096`
- 前提：TCP 转发（PG + Sandbox API）已启动

### 3.2 用例列表

| 用例 ID | 场景 | 请求 | 预期结果 | 验证点 |
|---------|------|------|---------|--------|
| WR-1 | 沙箱存活 + 不带 directory | `GET /vcs/diff?mode=git&sessionID={sid}` | 返回 diff 数据 | session.directory fallback 生效 |
| WR-2 | 沙箱存活 + directory=/workspace | `GET /vcs/diff?directory=/workspace&mode=git&sessionID={sid}` | 返回 diff 数据 | 显式 directory 参数生效 |
| WR-3 | 沙箱存活 + directory=/workspace/project | `GET /vcs/diff?directory=/workspace/project&mode=git&sessionID={sid}` | 返回 diff 数据 | 深层目录正确解析 |
| WR-4 | 沙箱已销毁 + 不带 directory | `GET /vcs/diff?mode=git&sessionID={old_sid}` | 返回空数组 `[]` | session.directory 正确但沙箱不存在 |
| WR-5 | 本地路径（无 sessionID） | `GET /vcs/diff?mode=git` | 返回空数组 `[]` | 本地路径行为不变 |

### 3.3 测试步骤

```bash
# Step 1: 创建 session
SID=$(curl -s -X POST http://localhost:14096/session \
  -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# Step 2: 在沙箱中创建 git repo
curl -s -X POST "http://localhost:14096/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && mkdir -p project && cd project && git init && git config user.email test@test.com && git config user.name test && echo hello > README.md && git add . && git commit -m init && echo changed >> README.md"}'

# Step 3: keepAlive
curl -s -X POST "http://localhost:14096/session/$SID/keep-alive" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}'

# WR-1: 不带 directory
curl -s "http://localhost:14096/vcs/diff?mode=git&sessionID=$SID"
# 期望: 非空数组，包含 modified 文件

# WR-2: directory=/workspace
curl -s "http://localhost:14096/vcs/diff?directory=/workspace&mode=git&sessionID=$SID"
# 期望: 非空数组

# WR-3: directory=/workspace/project
curl -s "http://localhost:14096/vcs/diff?directory=/workspace/project&mode=git&sessionID=$SID"
# 期望: 非空数组

# WR-4: 旧 session（沙箱已销毁）
curl -s "http://localhost:14096/vcs/diff?mode=git&sessionID=ses_1739dfb40ffe86la9FDc2Mq9nw"
# 期望: []（沙箱不存在）

# WR-5: 无 sessionID
curl -s "http://localhost:14096/vcs/diff?mode=git"
# 期望: []（本地路径无 git repo）
```

### 3.4 关键验证断言

```javascript
// WR-1/2/3 通用验证
d = JSON.parse(response)
assert(Array.isArray(d))
assert(d.length > 0)  // 有未提交的变更
assert(d[0].status === "modified")

// WR-4/5 验证
d = JSON.parse(response)
assert(Array.isArray(d))
assert(d.length === 0)  // 无 diff 数据
```

---

## 四、与路径泄露防护的关系

本次修复与 [20-path-leak-test.md](./20-path-leak-test.md) 是**互补**关系：

| 维度 | 路径泄露防护 (PL-x) | 路径路由修复 (WR-x) |
|------|-------------------|-------------------|
| 目标 | LLM 看到的所有路径均为 `/workspace/...` | API 请求能正确解析到工作目录 |
| 层面 | 工具输出 / system prompt / API 响应 | HTTP 请求路由 / directory 解析 |
| 文件 | `src/tool/*.ts`, `src/session/*.ts` | `src/server/routes/instance/httpapi/middleware/workspace-routing.ts` |
| 测试 | PL-1~PL-9 扫描消息中的宿主机路径 | WR-1~WR-5 验证 API 请求路由正确性 |

---

## 五、验收标准

| 层级 | 标准 |
|------|------|
| 代码 | `workspace-routing.ts` 改动通过 typecheck（533 个已知错误中无新增） |
| 沙箱路径 | WR-1/2/3：有 sessionID + sandbox 存活时，无论是否带 directory 参数，均返回 diff 数据 |
| 本地路径 | WR-4/5：沙箱已销毁或无 sessionID 时，行为正确（返回空或走默认路径） |
| 向后兼容 | `workspaceRouterMiddleware`（raw router）行为不变 |
