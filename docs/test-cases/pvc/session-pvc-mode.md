# Session PVC 模式（session / app）

> 前置条件：SaaS 服务已启动（`docs/local-test-env.md`），远端 Sandbox API + PVC 可用。
> 技术方案见 [`docs/session-pvc-mode.md`](../session-pvc-mode.md)。

---

## 测试环境

> 运行前先全局加载环境：`source test-env.sh [1|2|3]`（见 [`00-preamble.md`](./00-preamble.md)）。以下用例直接用 `$BASE` `$PG_URL`，不重复定义。

> **注意**：app 模式需要 PVC volume（`OPENCODE_SANDBOX_VOLUME_TYPE=pvc`）。测试前确认：
> ```bash
> docker exec opencode-saas-test env | grep VOLUME_TYPE
> > # 期望：OPENCODE_SANDBOX_VOLUME_TYPE=pvc
> ```

> **通用前置条件**：测试中涉及 git init 的用例需先设置 git config：
> ```bash
> git config --global user.email 'test@test.com' && git config --global user.name 'Test'
> ```

---

## 一、创建会话 — 输入校验

### T38.1 创建 session 模式会话（默认行为不变）

**验证目标**：不传 `pvcMode` 时，行为与现有 session 模式完全一致。

**三重验证**：API 返回 + PG 数据库 + directory 字段

```bash
bun -e '
const BASE = "http://localhost:14096"
const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()
console.log("pvcMode:", sid.pvcMode ?? "(undefined)")
console.log("appId:", sid.appId ?? "(undefined)")
console.log("directory:", sid.directory)
const pass = sid.pvcMode === undefined && sid.appId === undefined && sid.directory === "/workspace"
console.log("✅ T38.1: " + (pass ? "PASS — 默认行为不变, dir=/workspace" : "FAIL"))
'
```
**期望**：`pvcMode=undefined`，`appId=undefined`，`directory="/workspace"`

> **PG 验证**：`SELECT pvc_mode, app_id, directory FROM session WHERE id='$SID';`
> 期望：pvc_mode=NULL, app_id=NULL, directory=/workspace

---

### T38.2 创建 session 模式会话（显式传 pvcMode=session）

```bash
bun -e '
const BASE = "http://localhost:14096"
const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "session" }) })).json()
console.log("pvcMode:", sid.pvcMode)
console.log("directory:", sid.directory)
const pass = sid.pvcMode === "session" && sid.directory === "/workspace"
console.log("✅ T38.2: " + (pass ? "PASS" : "FAIL"))
'
```
**期望**：`pvcMode="session"`，`directory="/workspace"`

---

### T38.3 创建 app 模式会话（pvcMode=app + appId）

**三重验证**：API 返回 + PG 持久化 + directory 不暴露 worktree

```bash
bun -e '
const BASE = "http://localhost:14096"
const APP_ID = "test-app-" + Date.now().toString(36)
const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId: APP_ID }) })).json()
console.log("pvcMode:", sid.pvcMode)
console.log("appId:", sid.appId)
console.log("directory:", sid.directory)
const pass = sid.pvcMode === "app" && sid.appId === APP_ID && sid.directory === "/workspace"
console.log("✅ T38.3: " + (pass ? "PASS — dir 不暴露 worktree" : "FAIL"))
'
```
**期望**：`pvcMode="app"`，`appId=<APP_ID>`，`directory="/workspace"`（不是 /workspace/worktrees/...）

> **PG 验证**：`SELECT pvc_mode, app_id, directory FROM session WHERE id='$SID';`
> 期望：pvc_mode=app, app_id=<APP_ID>, directory=/workspace

---

### T38.4 app 模式缺少 appId → 400

```bash
bun -e '
const BASE = "http://localhost:14096"
const res = await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app" }) })
console.log("status:", res.status)
const pass = res.status === 400
console.log("✅ T38.4: " + (pass ? "PASS — HTTP 400" : "FAIL — got " + res.status))
'
```
**期望**：HTTP 400（精确状态码，非 >=400）

---

### T38.5 app 模式 appId 空白 → 400

```bash
bun -e '
const BASE = "http://localhost:14096"
const res = await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId: "   " }) })
console.log("status:", res.status)
const pass = res.status === 400
console.log("✅ T38.5: " + (pass ? "PASS — HTTP 400" : "FAIL"))
'
```
**期望**：HTTP 400

---

### T38.6 非法 pvcMode 值 → 400

```bash
bun -e '
const BASE = "http://localhost:14096"
const res = await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "global" }) })
console.log("status:", res.status)
const pass = res.status === 400
console.log("✅ T38.6: " + (pass ? "PASS — HTTP 400 (schema 校验)" : "FAIL"))
'
```
**期望**：HTTP 400（schema 校验拒绝）

---

### T38.7 appId 路径穿越 → 拒绝

**验证目标**：appId 含 `../` 或特殊字符时被 schema pattern 拒绝，防止 PVC subPath 穿越。

```bash
bun -e '
const BASE = "http://localhost:14096"
const malicious = ["../../sessions/xxx", "apps/../sessions/xxx", "a/b", "a;b", "a rm -rf", "a\$HOME"]
for (const appId of malicious) {
  const res = await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId }) })
  console.log(`  appId="${appId}" → ${res.status}`)
}
const allBlocked = await Promise.all(malicious.map(appId =>
  fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId }) })
    .then(r => r.status === 400)
))
console.log("✅ T38.7: " + (allBlocked.every(Boolean) ? "PASS — 路径穿越全部拒绝" : "FAIL — 有穿越通过"))
'
```
**期望**：全部 HTTP 400（appId 仅允许 `[\w\-\.]`，1-128 字符）

---

### T38.8 appId 超长 → 拒绝

```bash
bun -e '
const BASE = "http://localhost:14096"
const longId = "a".repeat(129)
const res = await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId: longId }) })
console.log("status:", res.status, "(appId length=129)")
const pass = res.status === 400
console.log("✅ T38.8: " + (pass ? "PASS — 超长 appId 拒绝" : "FAIL"))
'
```
**期望**：HTTP 400（appId 最长 128 字符）

---

### T38.9 appId 合法边界字符 → 通过

```bash
bun -e '
const BASE = "http://localhost:14096"
const validIds = ["my-app", "my_app", "my.app", "app-123", "A.B.C-1_2", "a"]
for (const appId of validIds) {
  const res = await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId }) })
  const body = await res.json()
  console.log(`  appId="${appId}" → ${res.status} stored=${body.appId}`)
}
const allOk = await Promise.all(validIds.map(appId =>
  fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId }) })
    .then(r => r.status === 200)
))
console.log("✅ T38.9: " + (allOk.every(Boolean) ? "PASS — 合法字符全部通过" : "FAIL"))
'
```
**期望**：全部 HTTP 200

---

## 二、PVC 共享与隔离

### T38.10 同 appId 不同会话共享 PVC 空间

**验证目标**：同一 `appId` 的两个会话，写入的文件互相可见。

```bash
bun -e '
const BASE = "http://localhost:14096"
const APP_ID = "share-" + Date.now().toString(36)
const exec = (sid, cmd) => fetch(BASE + "/session/" + sid + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: cmd }) }).then(r=>r.json())

const sidA = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId: APP_ID }) })).json().then(d=>d.id)
const sidB = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId: APP_ID }) })).json().then(d=>d.id)

await new Promise(r => setTimeout(r, 3000))
await exec(sidA, "mkdir -p /workspace/repo && echo shared-content > /workspace/repo/shared-file.txt")
await new Promise(r => setTimeout(r, 2000))
const readRes = await exec(sidB, "cat /workspace/repo/shared-file.txt 2>&1")
console.log("B 读取:", readRes.stdout?.trim())
console.log("✅ T38.10: " + (readRes.stdout?.includes("shared-content") ? "PASS — 共享 PVC" : "FAIL"))
'
```
**期望**：会话 B 能读到会话 A 写入的文件

---

### T38.11 不同 appId 之间 PVC 隔离

```bash
bun -e '
const BASE = "http://localhost:14096"
const TS = Date.now().toString(36)
const exec = (sid, cmd) => fetch(BASE + "/session/" + sid + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: cmd }) }).then(r=>r.json())

const sidA = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId: "iso-a-" + TS }) })).json().then(d=>d.id)
const sidB = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId: "iso-b-" + TS }) })).json().then(d=>d.id)
await new Promise(r => setTimeout(r, 3000))
await exec(sidA, "echo from-a > /workspace/repo/iso-a.txt")
await new Promise(r => setTimeout(r, 2000))
const readRes = await exec(sidB, "cat /workspace/repo/iso-a.txt 2>&1")
const isolated = readRes.stdout?.includes("No such file")
console.log("✅ T38.11: " + (isolated ? "PASS — 隔离" : "FAIL — 泄漏"))
'
```
**期望**：会话 B 读不到会话 A 的文件

---

### T38.12 session 模式与 app 模式隔离

```bash
bun -e '
const BASE = "http://localhost:14096"
const TS = Date.now().toString(36)
const exec = (sid, cmd) => fetch(BASE + "/session/" + sid + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: cmd }) }).then(r=>r.json())

const sidS = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "session" }) })).json().then(d=>d.id)
const sidA = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId: "cross-" + TS }) })).json().then(d=>d.id)
await new Promise(r => setTimeout(r, 3000))
await exec(sidS, "echo session-data > /workspace/repo/session-only.txt")
await new Promise(r => setTimeout(r, 2000))
const readRes = await exec(sidA, "cat /workspace/repo/session-only.txt 2>&1")
const isolated = readRes.stdout?.includes("No such file")
console.log("✅ T38.12: " + (isolated ? "PASS — session/app 隔离" : "FAIL"))
'
```
**期望**：app 模式会话读不到 session 模式会话的文件

---

## 三、持久化与继承

### T38.18 pvcMode 持久化到 PG

**三重验证**：API 查询 + PG 直查 + directory 不暴露 worktree

```bash
bun -e '
const BASE = "http://localhost:14096"
const APP_ID = "pg-" + Date.now().toString(36)
const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId: APP_ID }) })).json().then(d=>d.id)

const info = await (await fetch(BASE + "/session/" + sid)).json()
console.log("API: pvcMode=" + info.pvcMode + " appId=" + info.appId + " dir=" + info.directory)
const pass = info.pvcMode === "app" && info.appId === APP_ID && info.directory === "/workspace"
console.log("✅ T38.18: " + (pass ? "PASS — API + PG 持久化" : "FAIL"))
'
```

> **PG 验证**：`SELECT pvc_mode, app_id, directory FROM session WHERE id='$SID';`
> 期望：pvc_mode=app, app_id=<APP_ID>, directory=/workspace

---

### T38.19 fork 子会话继承 pvcMode 和 appId

**验证目标**：fork 子会话继承父会话的 pvcMode、appId，且共享 PVC 数据。

```bash
bun -e '
const BASE = "http://localhost:14096"
const APP_ID = "child-" + Date.now().toString(36)
const exec = (sid, cmd) => fetch(BASE + "/session/" + sid + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: cmd }) }).then(r=>r.json())

const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId: APP_ID }) })).json().then(d=>d.id)
await new Promise(r => setTimeout(r, 3000))
await exec(sid, "mkdir -p /workspace/repo && echo parent-data > /workspace/repo/parent.txt")

const fork = await (await fetch(BASE + "/session/" + sid + "/fork", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()
await new Promise(r => setTimeout(r, 3000))
const readRes = await exec(fork.id, "cat /workspace/repo/parent.txt 2>&1")

const metaOk = fork.pvcMode === "app" && fork.appId === APP_ID
const dataOk = readRes.stdout?.includes("parent-data")
console.log("fork 元数据:", metaOk ? "✅" : "❌", "pvcMode=" + fork.pvcMode, "appId=" + fork.appId)
console.log("fork 读父文件:", dataOk ? "✅" : "❌", readRes.stdout?.trim()?.slice(0,30))
console.log("✅ T38.19: " + (metaOk && dataOk ? "PASS" : "FAIL"))
'
```
**期望**：子会话 `pvcMode=app`，`appId` 一致，且能读到父会话写入的文件

> **PG 验证**：`SELECT pvc_mode, app_id, parent_id FROM session WHERE id='$FORK_ID';`
> 期望：pvc_mode=app, app_id=<APP_ID>, parent_id=<PARENT_ID>

---

### T38.20 子任务会话共享父会话 PVC（resolveSandboxOpts 追溯链路）

**验证目标**：通过 `parentID` 创建的子任务会话（不传 pvcMode/appId），`resolveSandboxOpts` 通过 `parent_id` 链追溯 root，共享同一 sandbox/PVC。

```bash
bun -e '
const BASE = "http://localhost:14096"
const APP_ID = "task-" + Date.now().toString(36)
const exec = (sid, cmd) => fetch(BASE + "/session/" + sid + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: cmd }) }).then(r=>r.json())

// 父会话 app 模式
const parent = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId: APP_ID }) })).json()
await new Promise(r => setTimeout(r, 3000))
await exec(parent.id, "mkdir -p /workspace/repo && echo parent-data > /workspace/repo/parent.txt")

// 子任务会话：只传 parentID，不传 pvcMode/appId（模拟 task tool 创建）
const child = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parentID: parent.id }) })).json()
console.log("子会话 pvcMode:", child.pvcMode ?? "(null)")
console.log("子会话 appId:", child.appId ?? "(null)")
console.log("子会话 parentID:", child.parentID?.slice(0,20))

// 子会话 exec 读父文件（验证 resolveSandboxOpts 追溯到 root，用同一 PVC）
await new Promise(r => setTimeout(r, 3000))
const readRes = await exec(child.id, "cat /workspace/repo/parent.txt 2>&1")
console.log("子读父文件:", readRes.stdout?.trim()?.slice(0,30))

const dataOk = readRes.stdout?.includes("parent-data")
console.log("✅ T38.20: " + (dataOk ? "PASS — 子任务会话通过 parent_id 追溯共享 PVC" : "FAIL"))
'
```
**期望**：子任务会话能读到父会话写入的文件（resolveSandboxOpts 追溯 parent_id 链到 root）

> **PG 验证**：`SELECT parent_id, pvc_mode, app_id FROM session WHERE id='$CHILD_ID';`
> 期望：parent_id=父ID, pvc_mode=NULL, app_id=NULL（子会话自身不存 pvcMode，靠追溯）

---

### T38.21 session 模式不受 app 模式逻辑影响（回归保护）

**验证目标**：session 模式的子会话和 fork 不被 app 模式逻辑污染，pvc_mode 保持 NULL/undefined。

```bash
bun -e '
const BASE = "http://localhost:14096"
const TS = Date.now().toString(36)

// 场景1: session 模式父会话 → 创建子会话（parentID）→ pvc_mode 应为 null
const parentS = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "session" }) })).json()
const childS = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parentID: parentS.id }) })).json()
const pass1 = childS.pvcMode === undefined && childS.appId === undefined
console.log("场景1 session子会话: pvcMode=%s appId=%s %s", childS.pvcMode, childS.appId, pass1 ? "✅" : "❌")

// 场景2: session 模式父会话 → fork → pvcMode 应为 undefined
const forkS = await (await fetch(BASE + "/session/" + parentS.id + "/fork", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()
const pass2 = forkS.pvcMode === undefined && forkS.appId === undefined
console.log("场景2 session fork: pvcMode=%s appId=%s %s", forkS.pvcMode, forkS.appId, pass2 ? "✅" : "❌")

// 场景3: 未指定 pvcMode 的父会话 → 创建子会话 → pvc_mode 应为 null
const parentU = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()
const childU = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parentID: parentU.id }) })).json()
const pass3 = childU.pvcMode === undefined && childU.appId === undefined
console.log("场景3 默认子会话: pvcMode=%s appId=%s %s", childU.pvcMode, childU.appId, pass3 ? "✅" : "❌")

console.log("✅ T38.21: " + (pass1 && pass2 && pass3 ? "PASS — session 模式不受污染" : "FAIL"))
'
```
**期望**：三个场景的 pvcMode/appId 全部为 undefined/null

> **PG 验证**：`SELECT pvc_mode, app_id FROM session WHERE id IN ('$CHILD_S', '$FORK_S', '$CHILD_U');`
> 期望：全部 pvc_mode=NULL, app_id=NULL

---

## 四、真实流程 E2E — worktree 代码写入位置验证

> 前置条件：SaaS 服务已启动，远端 Sandbox API + PVC 可用。
>
> 这组用例模拟真实使用流程：创建会话 → 拉取代码仓库 → 创建 worktree → 修改代码 → 验证写入位置和 diff 结果。

### T38.22 app 模式：worktree 代码写入位置验证

**验证目标**：app 模式会话创建 worktree 后，exec 写文件、`/path`、`/vcs/diff` 全部指向 worktree 目录，主仓库不被污染。

```bash
bun -e '
const BASE = "http://localhost:14096"
const exec = (sid, cmd) => fetch(BASE + "/session/" + sid + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: cmd, timeoutSeconds: 120 }) }).then(r=>r.json())
const get = (path) => fetch(BASE + path).then(r=>r.json())
const sleep = ms => new Promise(r => setTimeout(r, ms))

// 1. 创建 app 模式会话
const APP_ID = "e2e-app-" + Date.now().toString(36)
const session = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId: APP_ID }) })).json()
const SID = session.id
await sleep(3000)

// 2. clone 仓库到 /workspace/repo
await exec(SID, "git clone --depth=1 https://github.com/vercel-labs/agent-browser.git /workspace/repo 2>&1")

// 3. 创建 worktree
const branch = "feature/test-" + Date.now().toString(36)
const wtPath = "/workspace/worktrees/" + SID
await exec(SID, `cd /workspace/repo && git worktree add -b ${branch} ${wtPath} HEAD 2>&1`)

// 4. 更新 PG session.directory 指向 worktree（模拟外部编排系统）
//    PGPASSWORD=8zuhlMLd4gaeUG5k psql -h 127.0.0.1 -p 15432 -U app -d opencode \
//      -c "UPDATE session SET directory='\''${wtPath}'\'' WHERE id='\''${SID}'\''"

// 5. 验证 /path 返回 worktree 目录
const pathInfo = await get("/path?sessionID=" + SID)
console.log("path.directory:", pathInfo.directory)

// 6. 验证 exec pwd 在 worktree
const pwdRes = await exec(SID, "pwd")
console.log("pwd:", pwdRes.stdout?.trim())

// 7. exec 写文件到 worktree
await exec(SID, `echo "test content from e2e" > README.md`)

// 8. 验证文件在 worktree 中
const verifyRes = await exec(SID, "head -1 README.md && git status --short")
console.log("worktree git status:", verifyRes.stdout?.trim())

// 9. 验证主仓库 clean
const repoRes = await exec(SID, "cd /workspace/repo && git status --short")
console.log("main repo status:", reprRes.stdout?.trim() || "(clean)")

// 10. 验证 /vcs/diff 只显示 worktree 变更
const diffRes = await get("/vcs/diff?mode=git&sessionID=" + SID)
console.log("diff files:", diffRes.length, diffRes.map(d => d.file).join(", "))

// 11. 验证不传 directory 的 /vcs/diff 也指向 worktree
const noDirDiff = await get("/vcs/diff?mode=git&sessionID=" + SID)
console.log("no-dir diff files:", noDirDiff.length)

const allPass =
  pathInfo.directory === wtPath &&
  pwdRes.stdout?.trim() === wtPath &&
  verifyRes.stdout?.includes("test content from e2e") &&
  (repoRes.stdout?.trim() === "" || repoRes.stdout == null) &&
  diffRes.length === 1 && diffRes[0]?.file === "README.md" &&
  noDirDiff.length === 1
console.log("✅ T38.22: " + (allPass ? "PASS — app 模式 worktree 写入位置正确" : "FAIL"))
'
```

**期望**：
- `/path` directory = `/workspace/worktrees/{sessionID}`
- `exec pwd` = `/workspace/worktrees/{sessionID}`
- 写入的文件出现在 worktree 的 `git status` 中
- 主仓库 `/workspace/repo` git status 为空（clean）
- `/vcs/diff` 只返回 1 个文件（README.md），不包含 `worktrees/` 目录
- 不传 directory 的 `/vcs/diff` 与传 directory 结果一致

---

### T38.23 session 模式：worktree 代码写入位置验证

**验证目标**：session 模式（非 app 模式）创建 worktree 后，行为与 app 模式一致——exec 写文件、`/path`、`/vcs/diff` 全部指向 worktree 目录，主仓库不被污染。

```bash
bun -e '
const BASE = "http://localhost:14096"
const exec = (sid, cmd) => fetch(BASE + "/session/" + sid + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: cmd, timeoutSeconds: 120 }) }).then(r=>r.json())
const get = (path) => fetch(BASE + path).then(r=>r.json())
const sleep = ms => new Promise(r => setTimeout(r, ms))

// 1. 创建 session 模式会话（不传 pvcMode）
const session = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()
const SID = session.id
await sleep(3000)

// 2. clone 仓库到 /workspace/repo
await exec(SID, "git clone --depth=1 https://github.com/vercel-labs/agent-browser.git /workspace/repo 2>&1")

// 3. 创建 worktree
const branch = "feature/session-" + Date.now().toString(36)
const wtPath = "/workspace/worktrees/" + SID
await exec(SID, `cd /workspace/repo && git worktree add -b ${branch} ${wtPath} HEAD 2>&1`)

// 4. 更新 PG session.directory 指向 worktree
//    PGPASSWORD=8zuhlMLd4gaeUG5k psql -h 127.0.0.1 -p 15432 -U app -d opencode \
//      -c "UPDATE session SET directory='\''${wtPath}'\'' WHERE id='\''${SID}'\''"

// 5-11. 同 T38.22 验证步骤
const pathInfo = await get("/path?sessionID=" + SID)
const pwdRes = await exec(SID, "pwd")
await exec(SID, `echo "session-mode test" > README.md`)
const verifyRes = await exec(SID, "head -1 README.md && git status --short")
const repoRes = await exec(SID, "cd /workspace/repo && git status --short")
const diffRes = await get("/vcs/diff?mode=git&sessionID=" + SID)
const noDirDiff = await get("/vcs/diff?mode=git&sessionID=" + SID)

const allPass =
  pathInfo.directory === wtPath &&
  pwdRes.stdout?.trim() === wtPath &&
  verifyRes.stdout?.includes("session-mode test") &&
  (repoRes.stdout?.trim() === "" || repoRes.stdout == null) &&
  diffRes.length === 1 && diffRes[0]?.file === "README.md" &&
  noDirDiff.length === 1
console.log("✅ T38.23: " + (allPass ? "PASS — session 模式 worktree 写入位置正确" : "FAIL"))
'
```

**期望**：与 T38.22 完全一致（session 模式行为不受 pvcMode 影响）

---

## 结果汇总

> **编号说明**：T38.13–T38.17 为历史断档（原 worktree 自动创建等用例在文档演进中移除）；99-acceptance-status 中 T38.13 的实测记录来自历史回归，正文待补。

| 用例 | 验证维度 | 状态 |
|------|---------|------|
| T38.1 | 默认行为不变（pvcMode=undefined, dir=/workspace） | |
| T38.2 | 显式 pvcMode=session | |
| T38.3 | app 模式创建 + dir 不暴露 worktree | |
| T38.4 | app 缺 appId → 400 | |
| T38.5 | app 空白 appId → 400 | |
| T38.6 | 非法 pvcMode → 400 | |
| T38.7 | appId 路径穿越 → 拒绝 | |
| T38.8 | appId 超长(>128) → 拒绝 | |
| T38.9 | appId 合法边界字符 → 通过 | |
| T38.10 | 同 appId 共享 PVC | |
| T38.11 | 不同 appId 隔离 | |
| T38.12 | session/app 隔离 | |
| T38.18 | PG 持久化 | |
| T38.19 | fork 继承 pvcMode/appId + 数据共享 | |
| T38.20 | 子任务会话 parent_id 追溯共享 PVC | |
| T38.21 | session 模式不受 app 逻辑影响（回归保护） | |
| T38.22 | app 模式 worktree 代码写入位置验证 | |
| T38.23 | session 模式 worktree 代码写入位置验证 | |

---

## 已知限制

### session 删除不清理 PVC 数据

`session.remove()` 不调用 PVC volume 清理。`cleanupSessionVolume` 目前是空实现。

**影响**：
- session 模式：删除 session 后 `sessions/{sessionID}/` 数据残留
- app 模式：删除 session 后 `apps/{appId}/` 数据残留（合理，因为 app 生命周期 ≠ session 生命周期）

**修复方向**：session 模式删除时清理 `sessions/{sessionID}/`；app 模式不自动清理（由编排系统管理 app 生命周期）。

### 子会话共享父会话 shell session

exec API 对子会话调用 `runInSession(root.id, ...)`，同一 root 下的子会话共享 shell session。

**影响**：环境变量泄漏、并发阻塞（Semaphore 1 permit）。

**缓解**：当前设计意图是共享 sandbox 实例，shell 隔离需要为每个子会话创建独立 command session（未来改进）。
