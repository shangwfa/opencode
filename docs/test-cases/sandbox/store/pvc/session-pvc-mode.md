# Session PVC 模式（session / app）（V2）

> 前置条件：V2 SaaS 服务已启动（`docs/local-test-env.md`），OpenSandbox + PVC 可用。
> 技术方案见 [`docs/session-pvc-mode.md`](../../../session-pvc-mode.md)。
> 部署前置检查（volumeType 语义）见 [`sandbox-pvc.md`](./sandbox-pvc.md) 的 T5.0。
> 自动执行入口：[`scripts/session-pvc-mode-v2.mjs`](../../scripts/session-pvc-mode-v2.mjs)。
>
> **V2 已知语义差异**：
> 1. shell 命令 cwd 固定为沙箱内 `/workspace`（V1 默认 session.directory）；worktree 场景命令内自行 `cd`。
> 2. 子会话/fork 继承语义与 V1 演进后一致：创建时直接继承落库（T38.20）。
> 3. fork 前置条件：V2 fork 需要至少一条已投影消息（`ForkEmptyError`），用例先执行一条 shell 命令。
>
> **`GET /api/session/:sessionID/vcs/diff` 沙箱代理**：session-scoped 路由（`server.session-vcs` group，挂 sessionLocationMiddleware），在会话沙箱内以 `session.directory` 为 cwd 执行 git（`core/sandbox/vcs-diff.ts` 生成 heredoc node 脚本，支持 working/branch/committed 三模式 + base，含 untracked；沙箱未启用返回 503）。`GET /api/vcs/diff` 维持 location-scoped 本地实现不变。
>
> **V2 实现落点**：schema（`session-pvc-mode.ts`/`session.ts`/`session-event.ts`/`session-app-id.ts`）、core（`session/sql.ts` `pvc_mode` 列 + migration `20260924062455`、projector Created/projectFork 继承、`session.ts` 创建继承、`sandbox/volumes.ts` buildVolumes、`sandbox/config.ts` volumeType（仅 `pvc` 默认/`snapshot`）、`sandbox/vcs-diff.ts`、provider createSandbox 卷挂载）、protocol（create payload + `session-vcs` group）、server（`validPvcConfig` 400 校验、`session-vcs` handler）。

## V2 API 语义映射

| V1 | V2 |
|---|---|
| `POST /session` | `POST /api/session`（响应 `{data}`） |
| `POST /session/:id/exec` | `POST /api/session/:id/shell`（204）+ `GET /api/experimental/session/:id/log` 读 `session.shell.ended` 输出 |
| `POST /session/:id/fork` | `POST /api/session/:id/fork`（需先有一条已投影消息作为 boundary） |
| `GET /path?sessionID=` | `GET /api/session/:id` → `data.location.directory` |
| `GET /vcs/diff?sessionID=` | `GET /api/session/:sessionID/vcs/diff`（session 路径参数，沙箱内以 session.directory 为 cwd 执行 git） |
| `POST /session/:id/keep-alive` | `POST /api/experimental/session/:id/keep-alive` |
| PG 表 `session` | PG 表 `session_v2` |

## 测试环境

> 公共环境变量 `$BASE` `$PG_URL` 由 [`test-env.sh`](../../test-env.sh) 提供（`source test-env.sh [1|2|3]`）。
> V2 API 需要 Basic 认证：`AUTH="opencode:<password>"`（与部署配置一致）。
> 命令执行 helper（`v2exec`）与认证变量定义见 [`sandbox-pvc.md`](./sandbox-pvc.md) 通用变量节。

> **注意**：app 模式需要 PVC volume。测试前按 [`sandbox-pvc.md`](./sandbox-pvc.md) T5.0 确认 `OPENCODE_SANDBOX_VOLUME_TYPE=pvc`。

> **通用前置条件**：测试中涉及 git init 的用例需先在沙箱内设置 git config：
> ```bash
> v2exec "git config --global user.email test@test.com && git config --global user.name Test"
> ```

---

## 一、创建会话 — 输入校验

### T38.1 创建 session 模式会话（默认行为不变）

**验证目标**：不传 `pvcMode` 时，行为与现有 session 模式完全一致。

**三重验证**：API 返回 + PG 数据库 + directory 字段

```bash
SID=$(curl -s -u "$AUTH" -X POST "$BASE/api/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin)['data'];print(d['id'])")
curl -s -u "$AUTH" "$BASE/api/session/$SID" | python3 -c "
import json,sys
d=json.load(sys.stdin)['data']
print('pvcMode:', d.get('pvcMode'))
print('appId:', d.get('appId'))
print('directory:', d['location']['directory'])
assert d.get('pvcMode') is None and d.get('appId') is None and d['location']['directory']=='/workspace'
print('PASS: 默认行为不变, dir=/workspace')"
```
**期望**：`pvcMode=null`，`appId=null`，`directory="/workspace"`

> **PG 验证**：`SELECT pvc_mode, app_id, directory FROM session_v2 WHERE id='$SID';`
> 期望：pvc_mode=NULL, app_id=NULL, directory=/workspace

---

### T38.2 创建 session 模式会话（显式传 pvcMode=session）

```bash
curl -s -u "$AUTH" -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
  -d '{"pvcMode":"session"}' | python3 -c "
import json,sys
d=json.load(sys.stdin)['data']
assert d['pvcMode']=='session' and d['location']['directory']=='/workspace'
print('PASS: pvcMode=session, dir=/workspace')"
```
**期望**：`pvcMode="session"`，`directory="/workspace"`

---

### T38.3 创建 app 模式会话（pvcMode=app + appId）

**三重验证**：API 返回 + PG 持久化 + directory 不暴露 worktree

```bash
APP_ID="test-app-$(date +%s | md5 | head -c 8)"
curl -s -u "$AUTH" -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
  -d "{\"pvcMode\":\"app\",\"appId\":\"$APP_ID\"}" | python3 -c "
import json,sys
d=json.load(sys.stdin)['data']
assert d['pvcMode']=='app' and d['appId']=='$APP_ID' and d['location']['directory']=='/workspace'
print('PASS: app 模式创建, dir 不暴露 worktree')"
```
**期望**：`pvcMode="app"`，`appId=<APP_ID>`，`directory="/workspace"`（不是 /workspace/worktrees/...）

> **PG 验证**：`SELECT pvc_mode, app_id, directory FROM session_v2 WHERE id='$SID';`
> 期望：pvc_mode=app, app_id=<APP_ID>, directory=/workspace

---

### T38.4 app 模式缺少 appId → 400

```bash
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -u "$AUTH" -X POST "$BASE/api/session" \
  -H 'Content-Type: application/json' -d '{"pvcMode":"app"}')
[ "$STATUS" = "400" ] && echo "PASS: HTTP 400" || echo "FAIL: got $STATUS"
```
**期望**：HTTP 400（精确状态码，非 >=400）

---

### T38.5 app 模式 appId 空白 → 400

```bash
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -u "$AUTH" -X POST "$BASE/api/session" \
  -H 'Content-Type: application/json' -d '{"pvcMode":"app","appId":"   "}')
[ "$STATUS" = "400" ] && echo "PASS: HTTP 400" || echo "FAIL: got $STATUS"
```
**期望**：HTTP 400

---

### T38.6 非法 pvcMode 值 → 400

```bash
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -u "$AUTH" -X POST "$BASE/api/session" \
  -H 'Content-Type: application/json' -d '{"pvcMode":"global"}')
[ "$STATUS" = "400" ] && echo "PASS: HTTP 400 (schema 校验)" || echo "FAIL: got $STATUS"
```
**期望**：HTTP 400（schema 校验拒绝）

---

### T38.7 appId 路径穿越 → 拒绝

**验证目标**：appId 含 `../` 或特殊字符时被 schema pattern 拒绝，防止 PVC subPath 穿越。

```bash
python3 - <<'EOF'
import urllib.request, base64, json
BASE = "http://localhost:14096"
auth = base64.b64encode(b"opencode:<password>").decode()
malicious = ["../../sessions/xxx", "apps/../sessions/xxx", "a/b", "a;b", "a rm -rf", "a$HOME"]
blocked = []
for appId in malicious:
    req = urllib.request.Request(BASE + "/api/session", method="POST",
        data=json.dumps({"pvcMode": "app", "appId": appId}).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Basic " + auth})
    try:
        urllib.request.urlopen(req)
        blocked.append(False)
    except urllib.error.HTTPError as e:
        blocked.append(e.code == 400)
    print(f'  appId="{appId}" blocked={blocked[-1]}')
assert all(blocked), "存在穿越通过"
print("PASS: 路径穿越全部拒绝")
EOF
```
**期望**：全部 HTTP 400（appId 仅允许 `^[A-Za-z0-9_.-]{1,128}$`）

---

### T38.8 appId 超长 → 拒绝

```bash
python3 - <<'EOF'
import urllib.request, base64, json
BASE = "http://localhost:14096"
auth = base64.b64encode(b"opencode:<password>").decode()
req = urllib.request.Request(BASE + "/api/session", method="POST",
    data=json.dumps({"pvcMode": "app", "appId": "a" * 129}).encode(),
    headers={"Content-Type": "application/json", "Authorization": "Basic " + auth})
try:
    urllib.request.urlopen(req)
    print("FAIL: 129 字符 appId 被接受")
except urllib.error.HTTPError as e:
    assert e.code == 400
    print("PASS: 超长 appId 拒绝 (HTTP 400)")
EOF
```
**期望**：HTTP 400（appId 最长 128 字符）

---

### T38.9 appId 合法边界字符 → 通过

```bash
python3 - <<'EOF'
import urllib.request, base64, json
BASE = "http://localhost:14096"
auth = base64.b64encode(b"opencode:<password>").decode()
valid = ["my-app", "my_app", "my.app", "app-123", "A.B.C-1_2", "a"]
results = []
for appId in valid:
    req = urllib.request.Request(BASE + "/api/session", method="POST",
        data=json.dumps({"pvcMode": "app", "appId": appId}).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Basic " + auth})
    resp = urllib.request.urlopen(req)
    stored = json.load(resp)["data"]["appId"]
    results.append(resp.status == 200 and stored == appId)
    print(f'  appId="{appId}" -> {resp.status} stored={stored}')
assert all(results)
print("PASS: 合法字符全部通过")
EOF
```
**期望**：全部 HTTP 200 且回显一致

---

## 二、PVC 共享与隔离

### T38.10 同 appId 不同会话共享 PVC 空间

**验证目标**：同一 `appId` 的两个会话，写入的文件互相可见。

```bash
APP_ID="share-$(date +%s | md5 | head -c 8)"
SID_A=$(curl -s -u "$AUTH" -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
  -d "{\"pvcMode\":\"app\",\"appId\":\"$APP_ID\"}" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])")
SID_B=$(curl -s -u "$AUTH" -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
  -d "{\"pvcMode\":\"app\",\"appId\":\"$APP_ID\"}" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])")

sleep 3
SID=$SID_A; v2exec 'mkdir -p /workspace/repo && echo shared-content > /workspace/repo/shared-file.txt'
sleep 2
SID=$SID_B; OUT=$(v2exec 'cat /workspace/repo/shared-file.txt')
echo "$OUT" | grep -q shared-content && echo "PASS: 共享 PVC" || echo "FAIL: [$OUT]"
```
**期望**：会话 B 能读到会话 A 写入的文件

---

### T38.11 不同 appId 之间 PVC 隔离

```bash
TS=$(date +%s | md5 | head -c 8)
SID_A=$(curl -s -u "$AUTH" -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
  -d "{\"pvcMode\":\"app\",\"appId\":\"iso-a-$TS\"}" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])")
SID_B=$(curl -s -u "$AUTH" -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
  -d "{\"pvcMode\":\"app\",\"appId\":\"iso-b-$TS\"}" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])")
sleep 3
SID=$SID_A; v2exec 'echo from-a > /workspace/repo/iso-a.txt'
sleep 2
SID=$SID_B; OUT=$(v2exec 'cat /workspace/repo/iso-a.txt 2>&1')
echo "$OUT" | grep -q "No such file" && echo "PASS: 隔离" || echo "FAIL: 泄漏 [$OUT]"
```
**期望**：会话 B 读不到会话 A 的文件

---

### T38.12 session 模式与 app 模式隔离

```bash
TS=$(date +%s | md5 | head -c 8)
SID_S=$(curl -s -u "$AUTH" -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
  -d '{"pvcMode":"session"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])")
SID_A=$(curl -s -u "$AUTH" -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
  -d "{\"pvcMode\":\"app\",\"appId\":\"cross-$TS\"}" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])")
sleep 3
SID=$SID_S; v2exec 'echo session-data > /workspace/repo/session-only.txt'
sleep 2
SID=$SID_A; OUT=$(v2exec 'cat /workspace/repo/session-only.txt 2>&1')
echo "$OUT" | grep -q "No such file" && echo "PASS: session/app 隔离" || echo "FAIL: 泄漏 [$OUT]"
```
**期望**：app 模式会话读不到 session 模式会话的文件

---

## 三、持久化与继承

### T38.18 pvcMode 持久化到 PG

**三重验证**：API 查询 + PG 直查 + directory 不暴露 worktree

```bash
APP_ID="pg-$(date +%s | md5 | head -c 8)"
SID=$(curl -s -u "$AUTH" -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
  -d "{\"pvcMode\":\"app\",\"appId\":\"$APP_ID\"}" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])")

curl -s -u "$AUTH" "$BASE/api/session/$SID" | python3 -c "
import json,sys
d=json.load(sys.stdin)['data']
assert d['pvcMode']=='app' and d['appId']=='$APP_ID' and d['location']['directory']=='/workspace'
print('PASS: API + PG 持久化')"
```

> **PG 验证**：`SELECT pvc_mode, app_id, directory FROM session_v2 WHERE id='$SID';`
> 期望：pvc_mode=app, app_id=<APP_ID>, directory=/workspace

---

### T38.19 fork 子会话继承 pvcMode 和 appId

**验证目标**：fork 子会话继承父会话的 pvcMode、appId，且共享 PVC 数据。

```bash
APP_ID="child-$(date +%s | md5 | head -c 8)"
SID=$(curl -s -u "$AUTH" -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
  -d "{\"pvcMode\":\"app\",\"appId\":\"$APP_ID\"}" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])")
sleep 3
v2exec 'mkdir -p /workspace/repo && echo parent-data > /workspace/repo/parent.txt'

# V2 fork 前置：需要至少一条已投影消息（上面的 shell 已满足）
FORK_ID=$(curl -s -u "$AUTH" -X POST "$BASE/api/session/$SID/fork" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])")
curl -s -u "$AUTH" "$BASE/api/session/$FORK_ID" | python3 -c "
import json,sys
d=json.load(sys.stdin)['data']
assert d['pvcMode']=='app' and d['appId']=='$APP_ID'
print('PASS: fork 元数据继承')"

sleep 3
SID=$FORK_ID; OUT=$(v2exec 'cat /workspace/repo/parent.txt')
echo "$OUT" | grep -q parent-data && echo "PASS: fork 数据共享" || echo "FAIL: [$OUT]"
```
**期望**：子会话 `pvcMode=app`，`appId` 一致，且能读到父会话写入的文件

> **PG 验证**：`SELECT pvc_mode, app_id, fork_session_id FROM session_v2 WHERE id='$FORK_ID';`
> 期望：pvc_mode=app, app_id=<APP_ID>, fork_session_id=<PARENT_ID>

---

### T38.20 子任务会话共享父会话 PVC（创建时继承）

**验证目标**：通过 `parentID` 创建的子任务会话（不传 pvcMode/appId），创建时直接继承父会话的 `pvcMode=app` + `appId` 落库，共享同一 PVC。

```bash
APP_ID="task-$(date +%s | md5 | head -c 8)"
PARENT_ID=$(curl -s -u "$AUTH" -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
  -d "{\"pvcMode\":\"app\",\"appId\":\"$APP_ID\"}" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])")
sleep 3
SID=$PARENT_ID; v2exec 'mkdir -p /workspace/repo && echo parent-data > /workspace/repo/parent.txt'

# 子任务会话：只传 parentID，不传 pvcMode/appId（模拟 task tool 创建）
CHILD_ID=$(curl -s -u "$AUTH" -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
  -d "{\"parentID\":\"$PARENT_ID\"}" | python3 -c "
import json,sys
d=json.load(sys.stdin)['data']
assert d.get('pvcMode')=='app' and d.get('appId')=='$APP_ID', d
print(d['id'])")

sleep 3
SID=$CHILD_ID; OUT=$(v2exec 'cat /workspace/repo/parent.txt')
echo "$OUT" | grep -q parent-data && echo "PASS: 子任务会话继承并共享 PVC" || echo "FAIL: [$OUT]"
```
**期望**：子任务会话创建即继承 `pvcMode=app` + `appId`（API 与 PG 均落库），且能读到父会话写入的文件

> **PG 验证**：`SELECT parent_id, pvc_mode, app_id FROM session_v2 WHERE id='$CHILD_ID';`
> 期望：parent_id=父ID, pvc_mode=app, app_id=<APP_ID>

---

### T38.21 session 模式不受 app 模式逻辑影响（回归保护）

**验证目标**：session 模式的子会话和 fork 不被 app 模式逻辑污染，pvc_mode 保持 NULL。

```bash
python3 - <<'EOF'
import urllib.request, base64, json
BASE = "http://localhost:14096"
auth = base64.b64encode(b"opencode:<password>").decode()
H = {"Content-Type": "application/json", "Authorization": "Basic " + auth}

def api(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None, headers=H)
    return json.load(urllib.request.urlopen(req))

# 场景1: session 模式父会话 -> 创建子会话（parentID）-> pvc_mode 应为 null
parent_s = api("POST", "/api/session", {"pvcMode": "session"})["data"]
child_s = api("POST", "/api/session", {"parentID": parent_s["id"]})["data"]
pass1 = child_s.get("pvcMode") is None and child_s.get("appId") is None

# 场景2: session 模式父会话 -> fork -> pvcMode 应为 null
fork_s = api("POST", f"/api/session/{parent_s['id']}/shell", {"command": "true"})
import time; time.sleep(3)
fork_s = api("POST", f"/api/session/{parent_s['id']}/fork", {})["data"]
pass2 = fork_s.get("pvcMode") is None and fork_s.get("appId") is None

# 场景3: 未指定 pvcMode 的父会话 -> 创建子会话 -> pvc_mode 应为 null
parent_u = api("POST", "/api/session", {})["data"]
child_u = api("POST", "/api/session", {"parentID": parent_u["id"]})["data"]
pass3 = child_u.get("pvcMode") is None and child_u.get("appId") is None

assert pass1 and pass2 and pass3
print("PASS: session 模式不受污染")
EOF
```
**期望**：三个场景的 pvcMode/appId 全部为 null

> **PG 验证**：`SELECT pvc_mode, app_id FROM session_v2 WHERE id IN ('$CHILD_S', '$FORK_S', '$CHILD_U');`
> 期望：全部 pvc_mode=NULL, app_id=NULL

---

## 四、真实流程 E2E — worktree 代码写入位置验证

> **code-agent 工作目录语义（重要）**：在 opencode SaaS 中，code-agent 的工作目录**只由会话的 `session.directory` 决定**。`/api/session/:id/vcs/diff` 以 PG 中该 session 的 `directory` 为准。
>
> **V2 shell cwd 固定 `/workspace`**：worktree 场景的命令需自行 `cd`（见下方用例）。
>
> 步骤 4 的 `UPDATE session_v2 SET directory=...` 必须实际执行（不是注释），否则 `/api/session/:id`、`pwd`、diff 断言必失败——外部编排系统正是通过该字段切换工作目录。

### T38.22 app 模式：worktree 代码写入位置验证

**验证目标**：app 模式会话创建 worktree 后，把 PG `session.directory` 指向 worktree，shell（cd 后）写文件、`GET /api/session/:id`、`/vcs/diff` 全部指向 worktree 目录，主仓库不被污染。

```bash
APP_ID="e2e-app-$(date +%s | md5 | head -c 8)"
SID=$(curl -s -u "$AUTH" -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
  -d "{\"pvcMode\":\"app\",\"appId\":\"$APP_ID\"}" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])")
sleep 3

WT_PATH="/workspace/worktrees/$SID"
v2exec "git clone --depth=1 https://github.com/vercel-labs/agent-browser.git /workspace/repo 2>&1"
v2exec "cd /workspace/repo && git worktree add -b feature/test-$SID $WT_PATH HEAD 2>&1"

# 4. 更新 PG session.directory 指向 worktree（模拟外部编排系统，必须执行）
psql "$PG_URL" -c "UPDATE session_v2 SET directory='$WT_PATH' WHERE id='$SID'"

# 5. 验证 GET /api/session/:id 返回 worktree 目录
curl -s -u "$AUTH" "$BASE/api/session/$SID" | python3 -c "
import json,sys
d=json.load(sys.stdin)['data']
assert d['location']['directory']=='$WT_PATH', d['location']['directory']
print('PASS: directory 指向 worktree')"

# 6. shell 内 cd worktree 后写文件（V2 cwd 固定 /workspace，需显式 cd）
v2exec "cd $WT_PATH && pwd && echo 'test content from e2e' > README.md"

# 7. 验证文件在 worktree 中、主仓库 clean
OUT=$(v2exec "cd $WT_PATH && head -1 README.md && git status --short")
echo "$OUT" | head -1 | grep -q "test content from e2e" && echo "PASS: 文件写入 worktree"
MAIN=$(v2exec "cd /workspace/repo && git status --short")
[ -z "$MAIN" ] && echo "PASS: 主仓库 clean"

# 8. 验证 /api/session/:id/vcs/diff 只显示 worktree 变更
curl -s -u "$AUTH" "$BASE/api/session/$SID/vcs/diff?mode=working" | python3 -c "
import json,sys
diffs=json.load(sys.stdin)['data']
files=[d['file'] for d in diffs]
assert files==['README.md'], files
print('PASS: diff 只含 README.md')"
```

**期望**：
- `GET /api/session/:id` 的 `data.location.directory` = `/workspace/worktrees/{sessionID}`
- worktree 中 `git status` 出现 `README.md`，主仓库 `/workspace/repo` clean
- `/api/session/:id/vcs/diff` 只返回 `README.md`

---

### T38.23 session 模式：worktree 代码写入位置验证

**验证目标**：session 模式（非 app 模式）创建 worktree 后，行为与 app 模式一致。

```bash
SID=$(curl -s -u "$AUTH" -X POST "$BASE/api/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])")
sleep 3

WT_PATH="/workspace/worktrees/$SID"
v2exec "git clone --depth=1 https://github.com/vercel-labs/agent-browser.git /workspace/repo 2>&1"
v2exec "cd /workspace/repo && git worktree add -b feature/session-$SID $WT_PATH HEAD 2>&1"

# 4. 更新 PG session.directory 指向 worktree（必须执行）
psql "$PG_URL" -c "UPDATE session_v2 SET directory='$WT_PATH' WHERE id='$SID'"

# 5-8. 同 T38.22 验证步骤
curl -s -u "$AUTH" "$BASE/api/session/$SID" | python3 -c "
import json,sys
d=json.load(sys.stdin)['data']
assert d['location']['directory']=='$WT_PATH'
print('PASS: directory 指向 worktree')"
v2exec "cd $WT_PATH && echo 'session-mode test' > README.md"
OUT=$(v2exec "cd $WT_PATH && head -1 README.md && git status --short")
echo "$OUT" | head -1 | grep -q "session-mode test" && echo "PASS: 文件写入 worktree"
MAIN=$(v2exec "cd /workspace/repo && git status --short")
[ -z "$MAIN" ] && echo "PASS: 主仓库 clean"
curl -s -u "$AUTH" "$BASE/api/session/$SID/vcs/diff?mode=working" | python3 -c "
import json,sys
diffs=json.load(sys.stdin)['data']
assert [d['file'] for d in diffs]==['README.md']
print('PASS: diff 只含 README.md')"
```

**期望**：与 T38.22 完全一致（session 模式行为不受 pvcMode 影响）

---

### T38.24 session 模式：`/api/session/:id/vcs/diff` 使用会话 `/workspace`

**验证目标**：`GET /api/session/:id/vcs/diff?mode=working` 在 session PVC 中读取该会话的 `/workspace`，返回已跟踪和未跟踪文件的 diff。

```bash
SID=$(curl -s -u "$AUTH" -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
  -d '{"pvcMode":"session"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])")
sleep 3
v2exec "cd /workspace && git init -q && git config user.email test@test.com && git config user.name Test && printf baseline > tracked.txt && git add -A && git commit -qm baseline && printf session-changed > tracked.txt && printf session-new > untracked.txt"

curl -s -u "$AUTH" "$BASE/api/session/$SID/vcs/diff?mode=working" | python3 -c "
import json,sys
diffs=json.load(sys.stdin)['data']
files=sorted(d['file'] for d in diffs)
tracked=next((d for d in diffs if d['file']=='tracked.txt'), None)
untracked=next((d for d in diffs if d['file']=='untracked.txt'), None)
assert files==['tracked.txt','untracked.txt'], files
assert tracked['status']=='modified' and '+session-changed' in tracked['patch']
assert untracked['status']=='added' and '+session-new' in untracked['patch']
print('PASS: session diff 来自 /workspace')"
```

**期望**：HTTP 200；只返回 `tracked.txt`（modified，含 `+session-changed`）和 `untracked.txt`（added，含 `+session-new`）。

---

### T38.25 app 模式：`/api/session/:id/vcs/diff` 使用会话 worktree

**验证目标**：app PVC 共享 `/workspace` 时，接口仍以 PG 中该 session 的 `directory` 为准，只读取 worktree，不读取共享主仓库 `/workspace/repo`。

```bash
APP_ID="vcs-diff-$(date +%s | md5 | head -c 8)"
SID=$(curl -s -u "$AUTH" -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
  -d "{\"pvcMode\":\"app\",\"appId\":\"$APP_ID\"}" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])")
WORKTREE="/workspace/worktrees/$SID"
sleep 3
v2exec "git init -q /workspace/repo && cd /workspace/repo && git config user.email test@test.com && git config user.name Test && printf baseline > tracked.txt && git add tracked.txt && git commit -qm baseline && git worktree add -q -b test-$SID $WORKTREE HEAD"

psql "$PG_URL" -v ON_ERROR_STOP=1 -c "UPDATE session_v2 SET directory='$WORKTREE' WHERE id='$SID';"

v2exec "cd $WORKTREE && printf app-changed > tracked.txt && printf app-new > worktree-only.txt && printf main-pollution > /workspace/repo/main-only.txt"
curl -s -u "$AUTH" "$BASE/api/session/$SID/vcs/diff?mode=working" | python3 -c "
import json,sys
diffs=json.load(sys.stdin)['data']
files=sorted(d['file'] for d in diffs)
tracked=next((d for d in diffs if d['file']=='tracked.txt'), None)
added=next((d for d in diffs if d['file']=='worktree-only.txt'), None)
assert files==['tracked.txt','worktree-only.txt'], files
assert tracked['status']=='modified' and '+app-changed' in tracked['patch']
assert added['status']=='added' and '+app-new' in added['patch']
print('PASS: app diff 来自 session worktree')"
```

**期望**：HTTP 200；只返回 `tracked.txt` 和 `worktree-only.txt`；不得返回主仓库的 `main-only.txt`。

---

### T38.26 孤儿 appId（只传 appId 不传 pvcMode）→ 仍按会话 ID 隔离

**验证目标**：`appId` 是 `pvcMode="app"` 的伴随参数。单独传 `appId`（不传 `pvcMode`）时创建成功，但卷前缀仍按会话 ID（`sessions/{sessionID}`），不进入任何 app 空间；app_id 字段落库但无隔离效果。

```bash
TS=$(date +%s | md5 | head -c 8)
ORPHAN_ID=$(curl -s -u "$AUTH" -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
  -d "{\"appId\":\"orphan-$TS\"}" | python3 -c "
import json,sys
d=json.load(sys.stdin)['data']
assert d.get('pvcMode') is None and d.get('appId')=='orphan-$TS', d
print(d['id'])")
APP_SID=$(curl -s -u "$AUTH" -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
  -d "{\"pvcMode\":\"app\",\"appId\":\"orphan-$TS\"}" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])")
sleep 3

# 孤儿会话写入的文件，同 appId 的 app 会话必须不可见（前缀不同）
SID=$ORPHAN_ID; v2exec 'mkdir -p /workspace/repo && echo orphan-data > /workspace/repo/orphan.txt'
sleep 2
SID=$APP_SID; OUT=$(v2exec 'cat /workspace/repo/orphan.txt 2>&1')
echo "$OUT" | grep -q "No such file" && echo "PASS: 孤儿 appId 按会话 ID 隔离" || echo "FAIL: 泄漏 [$OUT]"
```

**期望**：孤儿会话创建成功（200，`pvcMode=null`、`appId` 回显）；同 `appId` 的 app 会话读不到孤儿会话的文件。

> **PG 验证**：`SELECT pvc_mode, app_id FROM session_v2 WHERE id='$ORPHAN_ID';`
> 期望：pvc_mode=NULL, app_id=orphan-<TS>（数据不自洽但无隔离效果；已知边界，见"已知限制"）

---

### T38.27 `/api/session/:id/vcs/diff` 默认上下文为 3 行

**验证目标**：V2 沙箱 diff 脚本 `context` 缺省为 3（V1 为全上下文）。修改大文件中间一行，patch 只带前后各 3 行上下文。

```bash
SID=$(curl -s -u "$AUTH" -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
  -d '{"pvcMode":"session"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])")
sleep 3
v2exec "cd /workspace && git init -q && git config user.email test@test.com && git config user.name Test && seq 1 10 > big.txt && git add -A && git commit -qm baseline && sed -i 's/^5$/changed/' big.txt"

curl -s -u "$AUTH" "$BASE/api/session/$SID/vcs/diff?mode=working" | python3 -c "
import json,sys
d=next(x for x in json.load(sys.stdin)['data'] if x['file']=='big.txt')
lines=d['patch'].split('\n')
assert '+changed' in lines, d['patch']
assert ' 2' in lines and ' 8' in lines, '上下文应含第 2、8 行'
assert ' 1' not in lines and ' 10' not in lines, '上下文不应含第 1、10 行（默认 3 行）'
print('PASS: diff 默认上下文 3 行')"
```

**期望**：patch 含第 2–8 行上下文与 `+changed`；不含第 1、10 行。显式传 `context` 参数可覆盖（`?mode=working&context=10` 后 patch 含第 1、10 行）。

---

## 结果汇总

> **编号说明**：T38.13–T38.17 为历史断档（原 worktree 自动创建等用例在文档演进中移除）。

| 用例 | 验证维度 | 状态 |
|------|---------|------|
| T38.1 | 默认行为不变（pvcMode=null, dir=/workspace） | ✅ V2 PASS (2026-09-24) |
| T38.2 | 显式 pvcMode=session | ✅ V2 PASS (2026-09-24) |
| T38.3 | app 模式创建 + dir 不暴露 worktree | ✅ V2 PASS (2026-09-24) |
| T38.4 | app 缺 appId → 400 | ✅ V2 PASS (2026-09-24) |
| T38.5 | app 空白 appId → 400 | ✅ V2 PASS (2026-09-24) |
| T38.6 | 非法 pvcMode → 400 | ✅ V2 PASS (2026-09-24) |
| T38.7 | appId 路径穿越 → 拒绝 | ✅ V2 PASS (2026-09-24) |
| T38.8 | appId 超长(>128) → 拒绝 | ✅ V2 PASS (2026-09-24) |
| T38.9 | appId 合法边界字符 → 通过 | ✅ V2 PASS (2026-09-24) |
| T38.10 | 同 appId 共享 PVC | ✅ V2 PASS (2026-09-24) |
| T38.11 | 不同 appId 隔离 | ✅ V2 PASS (2026-09-24) |
| T38.12 | session/app 隔离 | ✅ V2 PASS (2026-09-24) |
| T38.18 | PG 持久化 | ✅ V2 PASS (2026-09-24) |
| T38.19 | fork 继承 pvcMode/appId + 数据共享 | ✅ V2 PASS (2026-09-24) |
| T38.20 | 子任务会话创建时继承 + 共享 PVC | ✅ V2 PASS (2026-09-24) |
| T38.21 | session 模式不受 app 逻辑影响（回归保护） | ✅ V2 PASS (2026-09-24) |
| T38.22 | app 模式 worktree 代码写入位置验证 | ✅ V2 PASS (2026-09-24) |
| T38.23 | session 模式 worktree 代码写入位置验证 | ✅ V2 PASS (2026-09-24) |
| T38.24 | session 模式 diff 读取 `/workspace` | ✅ V2 PASS (2026-09-24) |
| T38.25 | app 模式 diff 读取 session worktree | ✅ V2 PASS (2026-09-24) |
| T38.26 | 孤儿 appId 按会话 ID 隔离 | ⬜ 待测（2026-10-02 新增） |
| T38.27 | diff 默认上下文 3 行 | ⬜ 待测（2026-10-02 新增） |

> **2026-09-24（V2 复测）**：T38.1–T38.25 由 [`scripts/session-pvc-mode-v2.mjs`](../../scripts/session-pvc-mode-v2.mjs) 执行，20/20 PASS。环境：本地 OpenSandbox（Docker runtime，`host.docker.internal:8080`）+ `OPENCODE_SANDBOX_VOLUME_TYPE=pvc` + `OPENCODE_SANDBOX_PVC_CLAIM=sandbox-test` + 本地 PG `opencode-v2-up`。远端 K8s Sandbox（30040）的 PVC claim 创建失败（state: Failed），未采用。

> **2026-10-02（文档改版）**：正文由 V1 API 改写为 V2 API（语义映射表见文首）；PG 表名统一为 `session_v2`；新增 T38.26（孤儿 appId 边界）、T38.27（diff 默认上下文）。新用例待复测。

## 已知限制

### session 删除不清理 PVC 数据

`session.remove()` 不调用 PVC volume 清理（V1 的 `cleanupSessionVolume` 是空实现，V2 无对应函数）。

**影响**：
- session 模式：删除 session 后 `sessions/{sessionID}/` 数据残留
- app 模式：删除 session 后 `apps/{appId}/` 数据残留（合理，因为 app 生命周期 ≠ session 生命周期）

**修复方向**：session 模式删除时清理 `sessions/{sessionID}/`；app 模式不自动清理（由编排系统管理 app 生命周期）。

### 孤儿 appId 数据不自洽

单独传 `appId`（不传 `pvcMode`）时 `app_id` 落库但 `pvc_mode=NULL`，且 V2 fork 会无条件复制 `app_id`（V1 仅在 `pvcMode=app` 时继承）。该数据无隔离效果（T38.26），但会造成读库困惑。

**修复方向**：在 server `validPvcConfig` 增加"`appId` 出现时 `pvcMode` 必须为 `app`"校验（400），或 fork 继承时对齐 V1 条件。

### 子会话共享父会话沙箱实例

子会话经 `resolveSandboxKey` 映射到 root 会话的沙箱实例（V1 `resolveSandboxOpts` 同语义），命令在 root 沙箱内执行（V2 为隔离 command context，受 `maxConcurrentCommandsPerSession` 约束）。

**影响**：文件系统天然共享（同一 PVC 前缀）；命令上下文按会话隔离。
