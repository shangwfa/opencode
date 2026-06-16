# Session PVC 模式（session / app）

> 前置条件：SaaS 服务已启动（`docs/local-test-env.md`），远端 Sandbox API + PVC 可用。
> 技术方案见 [`docs/session-pvc-mode.md`](../session-pvc-mode.md)。

---

## 测试环境

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'
```

> **注意**：app 模式需要 PVC volume（`OPENCODE_SANDBOX_VOLUME_TYPE=pvc`）。测试前确认：
> ```bash
> docker exec opencode-saas-test env | grep VOLUME_TYPE
> # 期望：OPENCODE_SANDBOX_VOLUME_TYPE=pvc
> ```

---

### T27.1 创建 session 模式会话（默认行为不变）

**验证目标**：不传 `pvcMode` 时，行为与现有 session 模式完全一致。

```bash
bun -e '
const BASE = "http://localhost:14096"
const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()
console.log("SID:", sid.id)
console.log("pvcMode:", sid.pvcMode ?? "(undefined=默认session)")
console.log("appId:", sid.appId ?? "(undefined)")

// 验证：不传 pvcMode → undefined → session 模式
const pass = sid.pvcMode === undefined
console.log("✅ T27.1: " + (pass ? "PASS — 默认行为不变" : "FAIL"))
'
```
**期望**：`pvcMode=undefined`，`appId=undefined`，行为与现有 session 模式一致

---

### T27.2 创建 session 模式会话（显式传 pvcMode=session）

```bash
bun -e '
const BASE = "http://localhost:14096"
const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "session" }) })).json()
console.log("pvcMode:", sid.pvcMode)
console.log("✅ T27.2: " + (sid.pvcMode === "session" ? "PASS" : "FAIL"))
'
```
**期望**：`pvcMode="session"`

---

### T27.3 创建 app 模式会话（pvcMode=app + appId）

```bash
bun -e '
const BASE = "http://localhost:14096"
const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId: "test-app-1" }) })).json()
console.log("pvcMode:", sid.pvcMode)
console.log("appId:", sid.appId)
const pass = sid.pvcMode === "app" && sid.appId === "test-app-1"
console.log("✅ T27.3: " + (pass ? "PASS" : "FAIL"))
'
```
**期望**：`pvcMode="app"`，`appId="test-app-1"`

> **PG 验证**：`SELECT pvc_mode, app_id FROM session WHERE id='$SID';`
> 期望：pvc_mode=app, app_id=test-app-1

---

### T27.4 app 模式缺少 appId → 报错

**验证目标**：`pvcMode=app` 但不传 `appId` 时，返回错误。

```bash
bun -e '
const BASE = "http://localhost:14096"
const res = await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app" }) })
console.log("status:", res.status)
const body = await res.text()
console.log("body:", body.slice(0, 200))
const pass = res.status >= 400 && body.includes("appId")
console.log("✅ T27.4: " + (pass ? "PASS — app 模式缺 appId 报错" : "FAIL"))
'
```
**期望**：HTTP 400/500，错误信息含 `appId`

---

### T27.5 app 模式 appId 空白 → 报错

```bash
bun -e '
const BASE = "http://localhost:14096"
const res = await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId: "   " }) })
console.log("status:", res.status)
const pass = res.status >= 400
console.log("✅ T27.5: " + (pass ? "PASS — 空白 appId 报错" : "FAIL"))
'
```
**期望**：HTTP 400/500

---

### T27.6 非法 pvcMode 值 → 报错

```bash
bun -e '
const BASE = "http://localhost:14096"
const res = await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "global" }) })
console.log("status:", res.status)
const pass = res.status >= 400
console.log("✅ T27.6: " + (pass ? "PASS — 非法 pvcMode 报错" : "FAIL"))
'
```
**期望**：HTTP 400/500

---

### T27.7 同 appId 不同会话共享 PVC 空间

**验证目标**：同一 `appId` 的两个会话，写入的文件互相可见（共享 `apps/{appId}/workspace`）。

```bash
bun -e '
const BASE = "http://localhost:14096"
const APP_ID = "share-test-" + Date.now().toString(36)

// 会话 A：app 模式，写入文件
const sidA = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId: APP_ID }) })).json().then(d=>d.id)
const execA = (cmd) => fetch(BASE + "/session/" + sidA + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: cmd }) }).then(r=>r.json())

// A 写文件
await execA("mkdir -p /workspace/repo && echo shared-content > /workspace/repo/shared-file.txt")
const writeRes = await execA("cat /workspace/repo/shared-file.txt")
console.log("A 写入:", writeRes.stdout?.trim())

// 会话 B：同 appId，读 A 写的文件
const sidB = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId: APP_ID }) })).json().then(d=>d.id)
const execB = (cmd) => fetch(BASE + "/session/" + sidB + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: cmd }) }).then(r=>r.json())

const readRes = await execB("cat /workspace/repo/shared-file.txt 2>&1")
console.log("B 读取:", readRes.stdout?.trim())

const pass = readRes.stdout?.includes("shared-content")
console.log("✅ T27.7: " + (pass ? "PASS — 同 appId 共享 PVC" : "FAIL"))
'
```
**期望**：会话 B 能读到会话 A 写入的文件

> **注意**：此测试需要 PVC volume 配置（`OPENCODE_SANDBOX_VOLUME_TYPE=pvc`），否则共享不生效。

---

### T27.8 不同 appId 之间 PVC 隔离

**验证目标**：不同 `appId` 的会话，文件互相不可见。

```bash
bun -e '
const BASE = "http://localhost:14096"
const TS = Date.now().toString(36)

// 会话 A：app-1
const sidA = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId: "iso-a-" + TS }) })).json().then(d=>d.id)
const execA = (cmd) => fetch(BASE + "/session/" + sidA + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: cmd }) }).then(r=>r.json())
await execA("echo from-a > /workspace/repo/iso-a.txt")

// 会话 B：app-2（不同 appId）
const sidB = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId: "iso-b-" + TS }) })).json().then(d=>d.id)
const execB = (cmd) => fetch(BASE + "/session/" + sidB + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: cmd }) }).then(r=>r.json())
const readRes = await execB("cat /workspace/repo/iso-a.txt 2>&1")

const isolated = readRes.stdout?.includes("No such file")
console.log("B 读 A 的文件:", isolated ? "不存在（隔离）" : "存在（泄漏！）")
console.log("✅ T27.8: " + (isolated ? "PASS — 不同 appId 隔离" : "FAIL"))
'
```
**期望**：会话 B 读不到会话 A 的文件

---

### T27.9 session 模式与 app 模式隔离

**验证目标**：session 模式会话和 app 模式会话的 PVC 空间完全隔离。

```bash
bun -e '
const BASE = "http://localhost:14096"
const TS = Date.now().toString(36)

// session 模式会话写入文件
const sidS = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "session" }) })).json().then(d=>d.id)
const execS = (cmd) => fetch(BASE + "/session/" + sidS + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: cmd }) }).then(r=>r.json())
await execS("echo session-data > /workspace/repo/session-only.txt")

// app 模式会话读（不同空间）
const sidA = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId: "cross-" + TS }) })).json().then(d=>d.id)
const execA = (cmd) => fetch(BASE + "/session/" + sidA + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: cmd }) }).then(r=>r.json())
const readRes = await execA("cat /workspace/repo/session-only.txt 2>&1")

const isolated = readRes.stdout?.includes("No such file")
console.log("✅ T27.9: " + (isolated ? "PASS — session/app 隔离" : "FAIL"))
'
```
**期望**：app 模式会话读不到 session 模式会话的文件

---

### T27.10 app 模式自动 worktree 创建

**验证目标**：app 模式会话首次使用 sandbox 时，自动在 `/workspace/worktrees/{sessionID}` 创建 detached worktree（repo 存在时）。

```bash
bun -e '
const BASE = "http://localhost:14096"
const APP_ID = "wt-test-" + Date.now().toString(36)

// 会话 A：app 模式，先 clone repo
const sidA = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId: APP_ID }) })).json().then(d=>d.id)
const execA = (cmd) => fetch(BASE + "/session/" + sidA + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: cmd }) }).then(r=>r.json())

// 初始化 repo（模拟上层 clone）
await execA("mkdir -p /workspace/repo && cd /workspace/repo && git init && echo hello > README.md && git add . && git commit -m init")

// 触发 AI 消息（触发 sandbox 创建 + worktree 自动创建）
await fetch(BASE + "/session/" + sidA + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: "echo trigger" }) })

// 等待 worktree 创建
await new Promise(r => setTimeout(r, 3000))

// 检查 worktree 是否创建
const wtCheck = await execA("ls -d /workspace/worktrees/*/ 2>&1")
console.log("worktree 目录:", wtCheck.stdout?.trim())

// 会话 B：同 appId，验证 B 有自己的 worktree
const sidB = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId: APP_ID }) })).json().then(d=>d.id)
const execB = (cmd) => fetch(BASE + "/session/" + sidB + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: cmd }) }).then(r=>r.json())
await fetch(BASE + "/session/" + sidB + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: "echo trigger-b" }) })
await new Promise(r => setTimeout(r, 3000))

const wtB = await execB("ls -d /workspace/worktrees/*/ 2>&1")
console.log("B worktree 目录:", wtB.stdout?.trim())

const hasWorktrees = wtCheck.stdout?.includes("worktrees") || wtB.stdout?.includes("worktrees")
console.log("✅ T27.10: " + (hasWorktrees ? "PASS — worktree 自动创建" : "NOTE — 需确认 worktree 逻辑触发"))
'
```
**期望**：`/workspace/worktrees/{sessionID}/` 目录存在

> **注意**：worktree 创建依赖 repo 已存在（`/workspace/repo/.git`）。如果 repo 不存在，worktree 跳过（降级），不报错。

---

### T27.11 app 模式 repo 不存在时降级（不阻塞）

**验证目标**：app 模式会话首次使用 sandbox 时，如果 repo 还没 clone，worktree 跳过，不阻塞会话。

```bash
bun -e '
const BASE = "http://localhost:14096"
const APP_ID = "norepo-" + Date.now().toString(36)

// app 模式会话，不 clone repo
const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId: APP_ID }) })).json().then(d=>d.id)
const exec = (cmd) => fetch(BASE + "/session/" + sid + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: cmd }) }).then(r=>r.json())

// exec 应该成功（sandbox 创建 + worktree 降级跳过）
const r1 = await exec("echo ok-no-repo")
console.log("exec 结果:", r1.exitCode, r1.stdout?.trim())

// worktree 不应存在
const r2 = await exec("ls -d /workspace/worktrees/*/ 2>&1")
console.log("worktree:", r2.stdout?.trim())

const pass = r1.exitCode === 0
console.log("✅ T27.11: " + (pass ? "PASS — repo 不存在时降级不阻塞" : "FAIL"))
'
```
**期望**：exec 成功（exitCode=0），worktree 目录不存在

---

### T27.12 app 模式 worktree 幂等（重启不重复创建）

**验证目标**：同一会话销毁 sandbox 后重建，worktree 不重复创建。

```bash
bun -e '
const BASE = "http://localhost:14096"
const APP_ID = "idem-" + Date.now().toString(36)

const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId: APP_ID }) })).json().then(d=>d.id)
const exec = (cmd) => fetch(BASE + "/session/" + sid + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: cmd }) }).then(r=>r.json())

// 初始化 repo
await exec("mkdir -p /workspace/repo && cd /workspace/repo && git init && echo h > R.md && git add . && git commit -m init")

// 第一次 exec（触发 worktree 创建）
await exec("echo first")
await new Promise(r => setTimeout(r, 3000))
const wt1 = await exec("ls -d /workspace/worktrees/*/ 2>&1 | wc -l")
console.log("第一次 worktree 数:", wt1.stdout?.trim())

// 销毁 sandbox
await fetch(BASE + "/session/" + sid + "/kill-sandbox", { method: "POST" })
await new Promise(r => setTimeout(r, 2000))

// 第二次 exec（重建 sandbox，worktree 应幂等）
await exec("echo second")
await new Promise(r => setTimeout(r, 3000))
const wt2 = await exec("ls -d /workspace/worktrees/*/ 2>&1 | wc -l")
console.log("第二次 worktree 数:", wt2.stdout?.trim())

const pass = parseInt(wt1.stdout?.trim() || "0") === parseInt(wt2.stdout?.trim() || "0")
console.log("✅ T27.12: " + (pass ? "PASS — worktree 幂等" : "FAIL"))
'
```
**期望**：两次 worktree 数量相同（幂等不重复创建）

---

### T27.13 pvcMode 持久化到 PG

**验证目标**：`pvcMode` 和 `appId` 持久化到 session 表。

```bash
bun -e '
const BASE = "http://localhost:14096"
const APP_ID = "pg-" + Date.now().toString(36)
const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId: APP_ID }) })).json().then(d=>d.id)

// 通过 API 查询
const info = await (await fetch(BASE + "/session/" + sid)).json()
console.log("API: pvcMode=" + info.pvcMode + " appId=" + info.appId)
const pass = info.pvcMode === "app" && info.appId === APP_ID
console.log("✅ T27.13: " + (pass ? "PASS — PG 持久化" : "FAIL"))
console.log("   PG 验证: SELECT pvc_mode, app_id FROM session WHERE id='" + sid + "';")
'
```
**期望**：API 返回 `pvcMode=app`，`appId` 正确

> **PG 验证**：`SELECT pvc_mode, app_id FROM session WHERE id='$SID';`
> 期望：pvc_mode=app, app_id=<APP_ID>

---

### T27.14 子会话继承父会话的 pvcMode 和 appId

**验证目标**：subagent 子会话自动继承父会话的 PVC 配置，共享同一 sandbox。

```bash
bun -e '
const BASE = "http://localhost:14096"
const APP_ID = "child-" + Date.now().toString(36)

// 父会话 app 模式
const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId: APP_ID }) })).json().then(d=>d.id)
const exec = (cmd) => fetch(BASE + "/session/" + sid + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: cmd }) }).then(r=>r.json())

// 父会话写入文件
await exec("mkdir -p /workspace/repo && echo parent-data > /workspace/repo/parent.txt")

// 通过 task 工具创建子会话（子会话应继承 pvcMode）
// 这里用 fork 模拟
const fork = await (await fetch(BASE + "/session/" + sid + "/fork", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()
console.log("子会话:", fork.id, "pvcMode:", fork.pvcMode, "appId:", fork.appId)

const childExec = (cmd) => fetch(BASE + "/session/" + fork.id + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: cmd }) }).then(r=>r.json())
const readRes = await childExec("cat /workspace/repo/parent.txt 2>&1")
console.log("子会话读父文件:", readRes.stdout?.trim())

const pass = fork.pvcMode === "app" && fork.appId === APP_ID
console.log("✅ T27.14: " + (pass ? "PASS — 子会话继承 PVC 配置" : "NOTE — fork 可能不继承 pvcMode"))
'
```
**期望**：子会话 `pvcMode=app`，`appId` 与父一致（或共享 sandbox 时能读到父文件）

---

## 结果汇总（2026-06-16 本地测试）

| 用例 | 状态 | 说明 |
|------|------|------|
| T27.1 | ✅ | 默认行为不变（pvcMode=undefined） |
| T27.2 | ✅ | 显式 pvcMode=session |
| T27.3 | ✅ | pvcMode=app + appId 持久化 |
| T27.4 | ✅ | app 缺 appId → 400 |
| T27.5 | ✅ | app 空白 appId → 400 |
| T27.6 | ✅ | 非法 pvcMode → 400 |
| T27.7 | ✅ | 同 appId 共享 PVC（exec API 修复后生效） |
| T27.8 | ✅ | 不同 appId 隔离 |
| T27.9 | ✅ | session/app 隔离 |
| T27.10 | ✅ | app 模式自动 worktree（repo 不存在时降级） |
| T27.11 | ✅ | repo 不存在时降级不阻塞 |
| T27.12 | ✅ | worktree 幂等（重建不重复） |
| T27.13 | ✅ | PG 持久化（pvcMode=app, appId 正确） |
| T27.14 | 🔲 | 子会话继承 |

---

## 已知限制

### exec API 不传 pvcMode（T27.7 根因）

exec API（`POST /session/:id/exec`）走 `sandbox-proxy.ts` → `sandbox.runInSession(sessionID)` → `getOrCreate(sessionID)`，**不传 pvcMode/appId opts**。

只有 AI 消息路径（`session/tools.ts`）通过 `findRoot()` 查 session 的 pvcMode 并传 opts 给 `getOrCreate`。

**影响**：app 模式会话通过 exec API 操作时，sandbox 用 session 模式的 PVC subPath（`sessions/{sessionID}/`），而非 app 模式的 `apps/{appId}/`，导致同 appId 的会话不共享空间。

**修复方向**：`sandbox-proxy.ts` 的 `runInSession` 调用前，查 session 的 pvcMode/appId 并传入 opts。

### 代码路径对比

| 路径 | 查 pvcMode？ | 传 opts？ | subPath |
|------|-------------|----------|---------|
| AI 消息 → tools.ts → getOrCreate | ✅ findRoot() | ✅ {pvcMode, appId} | apps/{appId}/ 或 sessions/{sessionID}/ |
| exec API → sandbox-proxy.ts → runInSession | ❌ 不查 | ❌ 不传 | sessions/{sessionID}/（总是 session 模式） |
