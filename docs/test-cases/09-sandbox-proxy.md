# Sandbox Endpoint & Dev Server

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-INDEX.md`](./00-INDEX.md)。

## 十一、Sandbox Endpoint & Dev Server

> 前置条件：本地测试环境已启动（见 `docs/local-test-env.md`），基础 URL 为 `http://localhost:14096`。

### 核心概念

- **Sandbox 跟 session 走**：每个 session 拥有独立的 sandbox 容器
- **KeepAlive**：`POST /session/:id/keep-alive` 防止 sandbox 空闲回收（TTL 从 10min → 10h）
- **Endpoint API**：`GET /session/:id/endpoint/:port` 返回 sandbox 直接访问地址
- **exec 是同步的**：`POST /session/:id/exec` 阻塞等待命令完成，且 Semaphore(1) 保证同一 session 串行执行
- **exec/async 是异步的**：`POST /session/:id/exec/async` 立即返回 execId，后台执行
- **Dev server 必须用 async exec 启动**：长期运行的进程（Vite/Next.js）不能用同步 exec

### API 一览

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/session/:id/exec` | 同步执行（短命令） |
| POST | `/session/:id/exec/async` | 异步执行（长命令/dev server） |
| GET | `/session/:id/exec/:execId` | 查询 async exec 状态 |
| GET | `/session/:id/exec/:execId/stream` | SSE 实时输出 |
| POST | `/session/:id/exec/:execId/kill` | 中断 async exec |
| GET | `/session/:id/execs` | 列出 session 所有 exec |
| POST | `/session/:id/keep-alive` | 启用/禁用 keepAlive |
| GET | `/session/:id/keep-alive` | 查询 keepAlive |
| POST | `/session/:id/kill-sandbox` | 销毁 sandbox |
| GET | `/session/:id/endpoint/:port` | 获取端口直连地址 |

```bash
BASE="http://localhost:14096"
```

### 最佳实践：Dev Server 完整生命周期

在 sandbox 中启动 dev server（Vite/Next.js）的推荐流程：

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. POST /session                         创建 session           │
│ 2. POST /session/:id/exec               触发 sandbox 创建       │
│ 3. POST /session/:id/keep-alive          设置保活（防止回收）    │
│    {enabled: true}                                              │
│ 4. POST /session/:id/exec               创建项目（同步，分步）   │
│    {command: "npx create-vite@5 ..."}                           │
│ 5. POST /session/:id/exec               安装依赖（同步）        │
│    {command: "npm install ..."}                                 │
│ 6. POST /session/:id/exec/async          启动 dev server（异步）│
│    {command: "npx vite --host 0.0.0.0"}  → 返回 execId          │
│ 7. GET  /session/:id/endpoint/:port      获取直连 IP 地址       │
│    → { mode: "direct", url: "http://<ip>:5173" }               │
│                                                                 │
│ ── 使用期间 ──                                                  │
│ 8. 通过 endpoint URL 直接访问 dev server                        │
│                                                                 │
│ ── 使用完毕 ──                                                  │
│ 9. POST /session/:id/exec/:execId/kill   停止 dev server        │
│10. POST /session/:id/keep-alive          释放保活               │
│    {enabled: false}                                             │
│11. POST /session/:id/kill-sandbox        销毁 sandbox           │
└─────────────────────────────────────────────────────────────────┘
```

**关键约束：**

- **同步 exec 用于短命令**：项目创建、npm install、文件操作等。每条命令阻塞等待完成。
- **异步 exec 用于长期进程**：dev server、watch 模式等。立即返回 execId，后台运行。
- **Semaphore(1) 串行限制**：同一 session 的所有 exec（sync + async）共用一个信号量，同时只能执行一个。async exec 运行期间，sync exec 会被阻塞。如需在 dev server 运行时执行其他命令，需先 kill async exec 或使用另一个 session。
- **必须先 keepAlive 再启动 dev server**：否则 session idle 后 sandbox 被回收，dev server 丢失。
- **fd 重定向**：如果非要用同步 exec 后台启动进程，必须 `( cmd </dev/null > log 2>&1 & )` 断开所有 fd，否则 execd 不会发送 `execution_complete`。

---

### T11.1 创建 session + keepAlive + 确认 sandbox

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

# exec 触发 sandbox 创建
curl -s -m 15 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo sandbox-ready"}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('exit:', d.get('exitCode'), 'stdout:', d.get('stdout','').strip())"

# 设置 keepAlive
curl -s -X POST "$BASE/session/$SID/keep-alive" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}'

# 查询
curl -s "$BASE/session/$SID/keep-alive" | python3 -c "import json,sys;print(json.dumps(json.load(sys.stdin)))"
```
**期望**：exec 返回 `exit: 0 stdout: sandbox-ready`，keepAlive 返回 `true`

---

### T11.2 创建 Vite 项目（同步 exec，分步执行）

```bash
# Step 1: 创建项目
curl -s -m 60 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"rm -rf /workspace/vite-app && mkdir -p /workspace/vite-app && cd /workspace/vite-app && npx --yes create-vite@5 . --template react-ts 2>&1 | tail -2","timeoutSeconds":45}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('exit:', d.get('exitCode'));print(d.get('stdout','').strip()[-80:])"

# Step 2: npm install
curl -s -m 120 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace/vite-app && npm install 2>&1 | tail -1","timeoutSeconds":90}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('exit:', d.get('exitCode'));print(d.get('stdout','').strip()[-80:])"
```
**期望**：两步均 `exit: 0`

---

### T11.3 async exec 启动 dev server

```bash
# 异步启动（立即返回）
EXEC=$(curl -s -m 10 -X POST "$BASE/session/$SID/exec/async" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace/vite-app && npx vite --host 0.0.0.0 --port 5173","timeoutSeconds":300}')
echo "$EXEC"
EXEC_ID=$(echo "$EXEC" | python3 -c "import json,sys;print(json.load(sys.stdin).get('execId',''))")
echo "execId: $EXEC_ID"

# 等待 dev server 启动
sleep 5

# 查询状态
curl -s "$BASE/session/$SID/exec/$EXEC_ID" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('status:', d.get('status'))
print('stdout:', d.get('stdout','')[:200])
"
```
**期望**：status 为 `running`，stdout 含 `VITE v5.x.x ready`

---

### T11.4 endpoint API 获取直连地址

```bash
curl -s "$BASE/session/$SID/endpoint/5173" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('mode:', d.get('mode'))
print('url:', d.get('url'))
print('sandboxId:', d.get('sandboxId'))
"
```
**期望**：`mode: direct`，`url` 为 `http://<ip>:5173`

---

### T11.5 通过 endpoint 直接访问

```bash
EP=$(curl -s "$BASE/session/$SID/endpoint/5173" | python3 -c "import json,sys;print(json.load(sys.stdin).get('url',''))")
echo "Endpoint: $EP"

curl -s --max-time 10 "$EP" | python3 -c "
import sys
html = sys.stdin.read()
print('has DOCTYPE:', '<!doctype' in html.lower())
print('has script:', '<script' in html)
print('has main.tsx:', 'main.tsx' in html)
print('length:', len(html))
"
```
**期望**：HTML 含 DOCTYPE、script、main.tsx

---

### T11.6 keepAlive 下多次操作 sandbox 不变

```bash
SB1=$(curl -s "$BASE/session/$SID/endpoint/5173" | python3 -c "import json,sys;print(json.load(sys.stdin).get('sandboxId',''))")

# 多次 exec（在 dev server 运行期间，同步 exec 会排队等 Semaphore）
# 注意：async exec 占用 semaphore 期间，sync exec 会阻塞！
# 此处验证 sandboxId 不变即可

sleep 10

SB2=$(curl -s "$BASE/session/$SID/endpoint/5173" | python3 -c "import json,sys;print(json.load(sys.stdin).get('sandboxId',''))")
echo "Before: $SB1"
echo "After:  $SB2"
echo "unchanged: $([ "$SB1" = "$SB2" ] && echo YES || echo NO)"
```
**期望**：`unchanged: YES`

---

### T11.7 持续访问 dev server

```bash
EP=$(curl -s "$BASE/session/$SID/endpoint/5173" | python3 -c "import json,sys;print(json.load(sys.stdin).get('url',''))")

for i in 1 2 3; do
  CODE=$(curl -s --max-time 10 "$EP" -o /dev/null -w "%{http_code}")
  echo "Attempt $i: $CODE"
  sleep 2
done
```
**期望**：三次均 `200`

---

### T11.8 热更新验证（HMR）

> **注意**：async exec 运行期间持有 Semaphore，无法通过 sync exec 修改文件。方案：在 async exec 启动 vite 的同时，后台运行一个定时修改脚本。

```bash
# 预埋定时修改脚本（10 秒后修改 App.tsx）
printf '#!/bin/sh\nsleep 10\nprintf "import '"'"'./App.css'"'"'\nfunction App() { return <h1>HMR-TEST-MARKER-12345</h1> }\nexport default App\n" > /workspace/vite-app/src/App.tsx\n' > /tmp/hmr-modify.sh
chmod +x /tmp/hmr-modify.sh

# ← 上面通过 sync exec 执行

# async exec：后台跑修改脚本 + 前台启动 vite
EXEC_ID=$(curl -s -m 10 -X POST "$BASE/session/$SID/exec/async" \
  -H 'Content-Type: application/json' \
  -d '{"command":"/tmp/hmr-modify.sh & cd /workspace/vite-app && npx vite --host 0.0.0.0 --port 5173","timeoutSeconds":600}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin).get('execId',''))")

sleep 6
EP=$(curl -s "$BASE/session/$SID/endpoint/5173" | python3 -c "import json,sys;print(json.load(sys.stdin).get('url',''))")

# Before: 修改前
curl -s --max-time 10 "$EP/src/App.tsx" | python3 -c "
import sys;code=sys.stdin.read()
print('has Vite + React:', 'Vite + React' in code)
print('has HMR-MARKER:', 'HMR-TEST-MARKER-12345' in code)
"

# After: 等修改脚本执行（sleep 10）
sleep 8
curl -s --max-time 10 "$EP/src/App.tsx" | python3 -c "
import sys;code=sys.stdin.read()
print('has Vite + React:', 'Vite + React' in code)
print('has HMR-MARKER:', 'HMR-TEST-MARKER-12345' in code)
"
```
**期望**：Before — `Vite + React: True, HMR-MARKER: False`；After — `Vite + React: False, HMR-MARKER: True`

---

### T11.9 kill async exec（停止 dev server）

> 以下用例中 `$EXEC_ID` 来自 T11.3 或 T11.8 的 async exec。

```bash
# 中断 dev server
curl -s -X POST "$BASE/session/$SID/exec/$EXEC_ID/kill" | python3 -c "import json,sys;print(json.dumps(json.load(sys.stdin)))"

sleep 2

# 查询状态
curl -s "$BASE/session/$SID/exec/$EXEC_ID" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('status:', d.get('status'))
"

# endpoint 仍返回地址（sandbox 还在，只是 dev server 停了）
curl -s "$BASE/session/$SID/endpoint/5173" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('sandbox still exists:', bool(d.get('url')))
"
```
**期望**：status 变为 `killed`，sandbox 仍存在

---

### T11.10 取消 keepAlive + kill sandbox

```bash
# 取消 keepAlive
curl -s -X POST "$BASE/session/$SID/keep-alive" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":false}' | python3 -c "import json,sys;print(json.dumps(json.load(sys.stdin)))"

# 强制销毁
curl -s -X POST "$BASE/session/$SID/kill-sandbox" | python3 -c "import json,sys;print(json.dumps(json.load(sys.stdin)))"

# 验证 endpoint 不可用
curl -s "$BASE/session/$SID/endpoint/5173" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('after kill:', d.get('error') or d.get('url'))
"
```
**期望**：keepAlive=false，kill 成功，endpoint 返回 `sandbox unreachable`

---

### T11.11 endpoint API 错误场景

```bash
# 不存在的 session
curl -s "$BASE/session/ses_nonexistent/endpoint/5173" | python3 -c "
import json,sys;d=json.load(sys.stdin);print('bad session:', d.get('error') or d)"

# 无效 port
curl -s "$BASE/session/$SID/endpoint/abc" | python3 -c "
import json,sys;d=json.load(sys.stdin);print('bad port:', d.get('error') or d)"
```
**期望**：返回错误信息

---

## 注意事项

1. **async exec 占用 Semaphore**：dev server 通过 async exec 启动后，该 session 的 Semaphore(1) 被持有。在 dev server 运行期间，**同步 exec 会被阻塞**。如需执行其他命令，需先 kill 掉 async exec 或使用另一个 session。
2. **fd 重定向**：如果用同步 exec 启动后台进程，必须 `( cmd </dev/null > log 2>&1 & )` 模式，否则 execd 不会发送 `execution_complete` 事件。
3. **keepAlive TTL**：启用后 sandbox TTL 从 10min → 10h，用完务必释放。

---

## 结果汇总

| 用例 | 状态 | 说明 |
|------|------|------|
| T11.1 | ✅ | exec → keepAlive=true |
| T11.2 | ✅ | create-vite + npm install（同步 exec 分步） |
| T11.3 | ✅ | exec/async 启动 Vite，立即返回 execId |
| T11.4 | ✅ | mode:direct, url:http://<ip>:5173 |
| T11.5 | ✅ | HTML 含 DOCTYPE、script、main.tsx |
| T11.6 | ✅ | sandboxId 不变 |
| T11.7 | ✅ | 三次均 200 |
| T11.8 | ✅ | Before: Vite+React=True, After: HMR-MARKER=True |
| T11.9 | ✅ | kill → status:killed，sandbox 仍在 |
| T11.10 | ✅ | keepAlive=false, destroyed=true, endpoint→sandbox unreachable |
| T11.11 | ✅ | bad session→sandbox unreachable, bad port→invalid port |

---

## 完整测试脚本

> 将以下内容保存为 `test-sandbox.sh`，一键运行所有用例（T11.1-T11.11）。

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE="${1:-http://localhost:14096}"
PASS=0; FAIL=0; TOTAL=0

check() {
  TOTAL=$((TOTAL+1))
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "✅ $label"; PASS=$((PASS+1))
  else
    echo "❌ $label"; FAIL=$((FAIL+1))
  fi
}

jq_val() { python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('$1',''))" ; }
jq_raw() { python3 -c "import json,sys;print(json.dumps(json.load(sys.stdin)))"; }

exec_sync() {
  local sid="$1" cmd="$2" ts="${3:-30}"
  curl -s -m "$((ts+15))" -X POST "$BASE/session/$sid/exec" \
    -H 'Content-Type: application/json' \
    -d "{\"command\":$(python3 -c "import json;print(json.dumps('$cmd'))"),\"timeoutSeconds\":$ts}"
}

# ────────────────────────────────────────────
echo "=== T11.1 创建 session + keepAlive ==="
SID=$(curl -s -m 10 -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jq_val id)
echo "SID: $SID"

EXIT=$(curl -s -m 15 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo sandbox-ready"}' | jq_val exitCode)
check "T11.1a exec 触发 sandbox" [ "$EXIT" = "0" ]

KA=$(curl -s -m 10 -X POST "$BASE/session/$SID/keep-alive" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}' | jq_val keepAlive)

KA_GET=$(curl -s -m 10 "$BASE/session/$SID/keep-alive" | jq_val keepAlive)
check "T11.1b keepAlive=true" [ "$KA_GET" = "True" ]

# ────────────────────────────────────────────
echo ""
echo "=== T11.2 创建 Vite 项目 ==="
EXIT1=$(curl -s -m 60 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"rm -rf /workspace/vite-app && mkdir -p /workspace/vite-app && cd /workspace/vite-app && npx --yes create-vite@5 . --template react-ts 2>&1 | tail -2","timeoutSeconds":45}' \
  | jq_val exitCode)
check "T11.2a create-vite" [ "$EXIT1" = "0" ]

EXIT2=$(curl -s -m 120 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace/vite-app && npm install 2>&1 | tail -1","timeoutSeconds":90}' \
  | jq_val exitCode)
check "T11.2b npm install" [ "$EXIT2" = "0" ]

# ────────────────────────────────────────────
echo ""
echo "=== T11.3 async exec 启动 dev server ==="
EXEC_RESP=$(curl -s -m 10 -X POST "$BASE/session/$SID/exec/async" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace/vite-app && npx vite --host 0.0.0.0 --port 5173","timeoutSeconds":600}')
EXEC_ID=$(echo "$EXEC_RESP" | jq_val execId)
EXEC_STATUS=$(echo "$EXEC_RESP" | jq_val status)
echo "execId: $EXEC_ID"
check "T11.3 async exec 返回 running" [ "$EXEC_STATUS" = "running" ]

sleep 8

# ────────────────────────────────────────────
echo ""
echo "=== T11.4 endpoint API ==="
EP_RESP=$(curl -s -m 10 "$BASE/session/$SID/endpoint/5173")
EP_MODE=$(echo "$EP_RESP" | jq_val mode)
EP_URL=$(echo "$EP_RESP" | jq_val url)
EP_SB=$(echo "$EP_RESP" | jq_val sandboxId)
echo "mode: $EP_MODE  url: $EP_URL"
check "T11.4a mode=direct" [ "$EP_MODE" = "direct" ]
check "T11.4b url 非空" [ -n "$EP_URL" ]
check "T11.4c sandboxId 非空" [ -n "$EP_SB" ]

# ────────────────────────────────────────────
echo ""
echo "=== T11.5 通过 endpoint 直接访问 ==="
HTML=$(curl -s --max-time 10 "$EP_URL")
echo "$HTML" | python3 -c "
import sys; html=sys.stdin.read()
print('DOCTYPE:', '<!doctype' in html.lower())
print('script:', '<script' in html)
print('main.tsx:', 'main.tsx' in html)
print('length:', len(html))
"
HAS_DOCTYPE=$(echo "$HTML" | python3 -c "import sys;print('<!doctype' in sys.stdin.read().lower())")
HAS_MAIN=$(echo "$HTML" | python3 -c "import sys;print('main.tsx' in sys.stdin.read())")
check "T11.5a has DOCTYPE" [ "$HAS_DOCTYPE" = "True" ]
check "T11.5b has main.tsx" [ "$HAS_MAIN" = "True" ]

# ────────────────────────────────────────────
echo ""
echo "=== T11.6 keepAlive sandbox 稳定 ==="
SB1=$(curl -s -m 10 "$BASE/session/$SID/endpoint/5173" | jq_val sandboxId)
sleep 5
SB2=$(curl -s -m 10 "$BASE/session/$SID/endpoint/5173" | jq_val sandboxId)
echo "Before: $SB1  After: $SB2"
check "T11.6 sandboxId 不变" [ "$SB1" = "$SB2" ]

# ────────────────────────────────────────────
echo ""
echo "=== T11.7 持续访问 dev server ==="
T7_OK=true
for i in 1 2 3; do
  CODE=$(curl -s --max-time 10 "$EP_URL" -o /dev/null -w "%{http_code}")
  echo "  Attempt $i: $CODE"
  [ "$CODE" != "200" ] && T7_OK=false
  sleep 2
done
check "T11.7 三次均 200" $T7_OK

# ────────────────────────────────────────────
echo ""
echo "=== T11.8 热更新 HMR ==="
# kill 当前 dev server，释放 semaphore
curl -s -m 10 -X POST "$BASE/session/$SID/exec/$EXEC_ID/kill" > /dev/null 2>&1
sleep 2

# 预埋定时修改脚本
curl -s -m 15 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"printf \"#!/bin/sh\nsleep 10\nprintf \\\"import \\x27./App.css\\x27\\\\nfunction App() { return <h1>HMR-TEST-MARKER-12345</h1> }\\\\nexport default App\\\\n\\\" > /workspace/vite-app/src/App.tsx\\n\" > /tmp/hmr-modify.sh && chmod +x /tmp/hmr-modify.sh"}' \
  > /dev/null

# async exec: 后台跑修改脚本 + 前台启动 vite
EXEC_RESP2=$(curl -s -m 10 -X POST "$BASE/session/$SID/exec/async" \
  -H 'Content-Type: application/json' \
  -d '{"command":"/tmp/hmr-modify.sh & cd /workspace/vite-app && npx vite --host 0.0.0.0 --port 5173","timeoutSeconds":600}')
EXEC_ID=$(echo "$EXEC_RESP2" | jq_val execId)
echo "execId: $EXEC_ID"

sleep 6
EP_URL=$(curl -s -m 10 "$BASE/session/$SID/endpoint/5173" | jq_val url)

# Before: 修改前（t≈6s，脚本还没执行）
BEFORE_OLD=$(curl -s --max-time 10 "$EP_URL/src/App.tsx" | python3 -c "import sys;print('Vite + React' in sys.stdin.read())")
BEFORE_NEW=$(curl -s --max-time 10 "$EP_URL/src/App.tsx" | python3 -c "import sys;print('HMR-TEST-MARKER-12345' in sys.stdin.read())")
echo "Before: Vite+React=$BEFORE_OLD HMR-MARKER=$BEFORE_NEW"
check "T11.8a 修改前有 Vite+React" [ "$BEFORE_OLD" = "True" ]
check "T11.8b 修改前无 HMR-MARKER" [ "$BEFORE_NEW" = "False" ]

# After: 等修改脚本执行（sleep 10 + 余量）
sleep 8
AFTER_OLD=$(curl -s --max-time 10 "$EP_URL/src/App.tsx" | python3 -c "import sys;print('Vite + React' in sys.stdin.read())")
AFTER_NEW=$(curl -s --max-time 10 "$EP_URL/src/App.tsx" | python3 -c "import sys;print('HMR-TEST-MARKER-12345' in sys.stdin.read())")
echo "After:  Vite+React=$AFTER_OLD HMR-MARKER=$AFTER_NEW"
check "T11.8c 修改后无 Vite+React" [ "$AFTER_OLD" = "False" ]
check "T11.8d 修改后有 HMR-MARKER" [ "$AFTER_NEW" = "True" ]

# ────────────────────────────────────────────
echo ""
echo "=== T11.9 kill async exec ==="
KILL_STATUS=$(curl -s -m 10 -X POST "$BASE/session/$SID/exec/$EXEC_ID/kill" | jq_val status)
sleep 2
QUERY_STATUS=$(curl -s -m 10 "$BASE/session/$SID/exec/$EXEC_ID" | jq_val status)
SB_EXISTS=$(curl -s -m 10 "$BASE/session/$SID/endpoint/5173" | python3 -c "import json,sys;print(bool(json.load(sys.stdin).get('url')))")
echo "kill: $KILL_STATUS  query: $QUERY_STATUS  sandbox: $SB_EXISTS"
check "T11.9a status=killed" [ "$KILL_STATUS" = "killed" ]
check "T11.9b sandbox 仍在" [ "$SB_EXISTS" = "True" ]

# ────────────────────────────────────────────
echo ""
echo "=== T11.10 取消 keepAlive + kill sandbox ==="
curl -s -m 10 -X POST "$BASE/session/$SID/keep-alive" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":false}' > /dev/null

KA_OFF=$(curl -s -m 10 "$BASE/session/$SID/keep-alive" | jq_val keepAlive)
check "T11.10a keepAlive=false" [ "$KA_OFF" = "False" ]

DESTROYED=$(curl -s -m 10 -X POST "$BASE/session/$SID/kill-sandbox" | jq_val destroyed)
check "T11.10b destroyed=true" [ "$DESTROYED" = "True" ]

sleep 2
EP_ERR=$(curl -s -m 10 "$BASE/session/$SID/endpoint/5173" | jq_val error)
echo "endpoint after kill: $EP_ERR"
check "T11.10c endpoint→sandbox unreachable" [ "$EP_ERR" = "sandbox unreachable" ]

# ────────────────────────────────────────────
echo ""
echo "=== T11.11 endpoint 错误场景 ==="
ERR_SESSION=$(curl -s -m 10 "$BASE/session/ses_nonexistent/endpoint/5173" | jq_val error)
ERR_PORT=$(curl -s -m 10 "$BASE/session/$SID/endpoint/abc" | jq_val error)
echo "bad session: $ERR_SESSION"
echo "bad port: $ERR_PORT"
check "T11.11a bad session 返回错误" [ -n "$ERR_SESSION" ]
check "T11.11b bad port 返回错误" [ -n "$ERR_PORT" ]

# ────────────────────────────────────────────
echo ""
echo "================================"
echo "总计: $TOTAL  通过: $PASS  失败: $FAIL"
[ "$FAIL" -eq 0 ] && echo "🎉 ALL PASSED" || echo "⚠️  有失败用例"
```
