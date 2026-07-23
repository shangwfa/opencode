# Sandbox Proxy 与 Dev Server 生命周期

> 公共测试环境和配置见 [`00-preamble.md`](./00-preamble.md)。运行用例前先 `source test-env.sh 3 && source test-lib.sh`（以下用例直接使用 `$BASE`/`$PG_URL`/`$MODEL`）。
>
> 本文档分两部分：
> - **一、Sandbox Proxy 注入与路径重写（T11.1–T11.15）**：proxy 模式下 HTML/JS/CSS 注入、路径重写、HMR、keepAlive。
> - **二、Dev Server 生命周期（T11.16–T11.25）**：exec/async 启动 dev server、keepAlive、HMR、endpoint 直连。
>
> Endpoint 直连专项用例（endpoint API、proxy vs 直连对比、错误场景）另见 [`15-sandbox-endpoint.md`](./15-sandbox-endpoint.md)（T17.x）。

## 一、Sandbox Proxy 注入与路径重写

### T11.1 创建 Vite 项目并启动 dev server

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

# 创建项目 + 安装依赖
curl -s --max-time 300 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: npx create-vite@5 /workspace/vite-app --template react-ts --yes && cd /workspace/vite-app && npm install\"}],\"model\":$MODEL}" \
  | python3 -c "import json,sys;[print(p['text'][:100]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"

# background:true 启动 Vite（必须）
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 工具执行，background 必须设为 true: cd /workspace/vite-app && npx vite --host 0.0.0.0 --port 5173\"}],\"model\":$MODEL}" \
  | python3 -c "import json,sys;[print(p['text'][:100]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"

sleep 10
curl -s "$BASE/session/$SID/proxy/5173/" -o /dev/null -w "Vite proxy: %{http_code}\n"
```
**期望**：`Vite proxy: 200`

---

### T11.2 HTML 注入验证

```bash
curl -s "$BASE/session/$SID/proxy/5173/" | python3 -c "
import sys,re
html=sys.stdin.read()
sid='$SID'
prefix='/session/'+sid+'/proxy/5173'
print('data-oc-prefix:', 'data-oc-prefix=\"'+prefix+'\"' in html)
print('inject script:', 'function f(' in html)
print('fetch patch:', 'window.fetch=function' in html)
print('WebSocket patch:', 'window.WebSocket=function' in html)
print('XHR patch:', 'XMLHttpRequest.prototype.open' in html)
"
```
**期望**：全部为 `True`

---

### T11.3 HTML src/href 属性路径重写

```bash
curl -s "$BASE/session/$SID/proxy/5173/" | python3 -c "
import sys,re
html=sys.stdin.read()
sid='$SID'
prefix='/session/'+sid+'/proxy/5173'
# 找 src/href 属性
attrs = re.findall(r'(?:src|href)=\"(/[^\"]+)\"', html)
unprefixed = [a for a in attrs if not a.startswith(prefix) and not a.startswith('http')]
print('unprefixed src/href:', unprefixed[:5])
print('all prefixed:', len(unprefixed)==0)
"
```
**期望**：`all prefixed: True`，`unprefixed` 为空

---

### T11.4 内联 script import 路径重写（Vite @react-refresh）

```bash
curl -s "$BASE/session/$SID/proxy/5173/" | python3 -c "
import sys,re
html=sys.stdin.read()
sid='$SID'
prefix='/session/'+sid+'/proxy/5173'
# 检查 @react-refresh preamble
prefixed = 'from \"'+prefix+'/@react-refresh\"' in html
unprefixed = 'from \"/@react-refresh\"' in html
print('@react-refresh PREFIXED:', prefixed)
print('@react-refresh UNPREFIXED (bug):', unprefixed)
"
```
**期望**：`PREFIXED: True`，`UNPREFIXED: False`

---

### T11.5 JS import 路径重写

```bash
# 获取 main chunk URL
MAIN=$(curl -s "$BASE/session/$SID/proxy/5173/" | grep -o "src=\"/session/$SID/proxy/5173/src/main.tsx[^\"]*\"" | head -1 | sed 's/src="//;s/"//')
curl -s "$BASE$MAIN" | python3 -c "
import sys,re
js=sys.stdin.read()
sid='$SID'
prefix='/session/'+sid+'/proxy/5173'
# 找未加前缀的 import
bad = re.findall(r'from \"/(?!session/)[^\"]+\"', js)
print('unprefixed imports:', bad[:3])
print('all imports prefixed:', len(bad)==0)
"
```
**期望**：`all imports prefixed: True`

---

### T11.6 BrowserRouter 自动替换为 HashRouter

```bash
MAIN=$(curl -s "$BASE/session/$SID/proxy/5173/" | grep -o "src=\"/session/$SID/proxy/5173/src/main.tsx[^\"]*\"" | head -1 | sed 's/src="//;s/"//')
curl -s "$BASE$MAIN" | python3 -c "
import sys
js=sys.stdin.read()
print('HashRouter count:', js.count('HashRouter'))
print('BrowserRouter count (should be 0):', js.count('BrowserRouter'))
"
```
**期望**：`HashRouter count >= 1`，`BrowserRouter count: 0`

---

### T11.7 CSS url() 路径重写

```bash
# 获取 layout.css URL
CSS=$(curl -s "$BASE/session/$SID/proxy/5173/" | grep -o "href=\"/session/$SID/proxy/5173/[^\"]*\.css[^\"]*\"" | head -1 | sed 's/href="//;s/"//')
if [ -n "$CSS" ]; then
  curl -s "$BASE$CSS" | grep -o 'url([^)]*)' | head -5
else
  echo "No CSS link found (may not exist in this project)"
fi
```
**期望**：CSS 中 `url()` 内的路径含 proxy prefix，或项目无自定义字体（Next.js 项目才有）

---

### T11.8 错误上报端点

```bash
# 查询错误列表（初始为空）
curl -s "$BASE/session/$SID/proxy/5173/__errors"
echo ""
# 查询聚合错误
curl -s "$BASE/session/$SID/proxy-errors"
```
**期望**：返回 JSON（`[]` 或 `{}`），HTTP 200

---

### T11.9 background:true keepAlive 验证（核心）

```bash
# 访问 proxy 不触发 keepAlive；keepAlive 由 bash background:true 决定
curl -s "$BASE/session/$SID/proxy/5173/" -o /dev/null

# 等待 session idle（AI 无操作约 5 秒）
sleep 10

# Sandbox 应仍然存活（有 keepAlive 不回收）
curl -s "$BASE/session/$SID/proxy/5173/" -o /dev/null -w "After idle: %{http_code}\n"
```
**期望**：`After idle: 200`（sandbox 未被回收）

**注意**：这里能保持 200 的前提是 T11.1 使用了 `background:true` 启动 dev server。单纯访问 proxy 不会保活 sandbox。

---

### T11.10 sandbox proxy 刷新页面（不丢失路由）

```bash
# 访问子路由（Vite 项目 SPA 路由用 HashRouter，刷新不受影响）
curl -s "$BASE/session/$SID/proxy/5173/#/about" -o /dev/null -w "Hash route: %{http_code}\n"
```
**期望**：`Hash route: 200`（proxy 服务端只看 pathname，`#` 后的内容不影响路由）

---

### T11.11 Next.js dev server 代理

```bash
# 启动 Next.js（background:true）
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 工具执行，background 必须设为 true: cd /workspace/next-app && npx next dev -H 0.0.0.0 -p 3000\"}],\"model\":$MODEL}" \
  | python3 -c "import json,sys;[print(p['text'][:100]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"

sleep 20

# 验证首页、about、contact 三个页面
for path in "/" "/about" "/contact"; do
  CODE=$(curl -s --max-time 30 -o /dev/null -w "%{http_code}" "$BASE/session/$SID/proxy/3000$path")
  echo "Next.js $path: $CODE"
done
```
**期望**：三个路径均返回 `200`

---

### T11.12 Next.js webpack publicPath 重写

```bash
PREFIX="/session/$SID/proxy/3000"

# 找 webpack.js
WP_URL=$(curl -s "$BASE$PREFIX/" | grep -o "src=\"$PREFIX/_next/static/chunks/webpack[^\"]*\"" | head -1 | sed 's/src="//;s/"//')
echo "webpack URL: $WP_URL"
curl -s "$BASE$WP_URL" | grep -o '__webpack_require__\.p\s*=\s*"[^"]*"'
```
**期望**：`__webpack_require__.p="/session/{sid}/proxy/3000/_next/"`

---

### T11.13 Next.js RSC 路径重写

```bash
PREFIX="/session/$SID/proxy/3000"

curl -s "$BASE$PREFIX/" | python3 -c "
import sys,re
html=sys.stdin.read()
sid='$SID'
prefix='/session/'+sid+'/proxy/3000'

# 检查 RSC flight data 中路径
unprefixed = re.findall(r'(?<=[\"\\\\])/(?!session/|/)(?:_next|about|contact|favicon)[^\"\\\\]*', html)
print('unprefixed paths in RSC:', unprefixed[:5])
print('all RSC paths prefixed:', len(unprefixed)==0)

# about 链接
has_about = (prefix+'/about') in html or '\\\\\"'+prefix+'/about' in html
print('about link prefixed:', has_about)
"
```
**期望**：`all RSC paths prefixed: True`，`about link prefixed: True`

---

### T11.14 SPA 路由（Next.js 客户端导航）

人工测试步骤：
1. 浏览器打开 `$BASE/session/$SID/proxy/3000/`
2. 点击 About 链接 → 地址栏变为 `.../proxy/3000/about`，页面内容变为 About
3. 点击 Contact 链接 → 地址栏变为 `.../proxy/3000/contact`，页面正常
4. 刷新当前页面 → 仍然正常（302/200 均可）
5. 浏览器后退 → 回到上一页

**期望**：全部正常，无白屏，无 chunk 加载错误

---

### T11.15 Server Proxy 模式连通性

```bash
# 验证 sandbox server proxy API key 正确传递（期望非 401）
CODE=$(curl -s --max-time 30 -o /dev/null -w "%{http_code}" "$BASE/session/$SID/proxy/3000/")
echo "Server proxy mode: $CODE (expect 200, NOT 401/502)"
```
**期望**：`200`（401 = API key 未传；502 = sandbox 未启动）

---

## 二、Dev Server 生命周期（exec / keepAlive / HMR / endpoint）

### 核心概念

- **Sandbox 跟 session 走**：每个 session 拥有独立的 sandbox 容器
- **KeepAlive**：`POST /session/:id/keep-alive` 防止 sandbox 空闲回收（TTL 从 1h → 10h，baseTtl ×10）
- **Endpoint API**：`GET /session/:id/endpoint/:port` 返回 sandbox 直接访问地址
- **exec 是同步的**：`POST /session/:id/exec` 阻塞等待命令完成
- **exec/async 是异步的**：`POST /session/:id/exec/async` 立即返回 execId，后台执行
- **Dev server 首选 async exec 启动**：长期运行的进程（Vite/Next.js）优先用 `exec/async`；如果必须走同步 `exec`，需要用 `nohup ... </dev/null > /tmp/app.log 2>&1 & echo $!` 显式后台化并断开 fd

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
│    {command: "./node_modules/.bin/vite --host 0.0.0.0"}        │
│    → 返回 execId                                                 │
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
- **并发 exec**：同 session 的 **sync exec 受 Semaphore(1) 串行**（`runInSession` 的命令执行在 `sem.withPermit` 内）；**`exec/async` 之间可并发**（走 `runDetached`，无 sem）。详见 [`43-shell-perf-sse.md`](./43-shell-perf-sse.md) ST.S1。
- **必须先 keepAlive 再启动 dev server**：否则 session idle 后 sandbox 被回收，dev server 丢失。
- **fd 重定向**：如果非要用同步 exec 后台启动进程，必须 `nohup cmd </dev/null > /tmp/app.log 2>&1 & echo $!` 断开所有 fd，否则 execd 可能不会发送 `execution_complete`。
- **本地二进制优先**：启动 dev server 时优先使用 `./node_modules/.bin/vite` / `./node_modules/.bin/next`，避免 `npx` 拉取 latest 版本引入 Node 版本不兼容。

---

### T11.16 创建 session + keepAlive + 确认 sandbox

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

### T11.17 创建 Vite 项目（同步 exec，分步执行）

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

### T11.18 async exec 启动 dev server

```bash
# 异步启动（立即返回）
EXEC=$(curl -s -m 10 -X POST "$BASE/session/$SID/exec/async" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace/vite-app && ./node_modules/.bin/vite --host 0.0.0.0 --port 5173","timeoutSeconds":300}')
echo "$EXEC"
EXEC_ID=$(echo "$EXEC" | python3 -c "import json,sys;print(json.load(sys.stdin).get('execId',''))")
echo "execId: $EXEC_ID"

# 等待 dev server 启动
sleep 5

# 查询状态（也可 GET /session/:id/exec/:execId 查询单个）
curl -s "$BASE/session/$SID/execs" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for e in d.get('execs',[]):
    if e.get('execId') == '$EXEC_ID':
        print('status:', e.get('status'))
        break
"
```
**期望**：status 为 `running`

---

### T11.19 SSE stream 实时查看 async exec 输出

> **交叉引用**：exec/async 全生命周期（启动→订阅→done→清理）见 T19.12（17 文档）；本条聚焦 SSE 逐行实时性。

```bash
# 启动一个异步命令，逐步产生输出
SSE_EXEC=$(curl -s -m 10 -X POST "$BASE/session/$SID/exec/async" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo line1; sleep 1; echo line2; sleep 1; echo line3; sleep 1; echo done","timeoutSeconds":30}')
SSE_EXEC_ID=$(echo "$SSE_EXEC" | python3 -c "import json,sys;print(json.load(sys.stdin).get('execId',''))")
echo "execId: $SSE_EXEC_ID"

# 通过 SSE stream 实时读取输出
curl -s -N --max-time 15 "$BASE/session/$SID/exec/$SSE_EXEC_ID/stream" 2>&1 | python3 -c "
import sys
events = []
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    if line.startswith('event: '):
        events.append({'event': line[7:], 'data': ''})
    elif line.startswith('data: ') and events:
        events[-1]['data'] = line[6:]
    elif line.startswith(':'):
        pass  # event: ping（heartbeat）
print('total events:', len(events))
for e in events:
    print(f\"  event={e['event']} data={e['data']}\")
"

# 查询最终状态确认
curl -s "$BASE/session/$SID/exec/$SSE_EXEC_ID" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('final status:', d.get('status'))
print('final stdout:', d.get('stdout','').strip())
"
```
**期望**：
- SSE 流中收到 `line1`、`line2`、`line3`、`done` 的 stdout 事件，之间有时间间隔（非一次性返回）
- 最终收到 `event: done`，status 为 `completed`
- 查询接口确认 stdout 包含完整输出

---

### T11.20 keepAlive 下多次操作 sandbox 不变

```bash
SB1=$(curl -s "$BASE/session/$SID/endpoint/5173" | python3 -c "import json,sys;print(json.load(sys.stdin).get('sandboxId',''))")

sleep 10

SB2=$(curl -s "$BASE/session/$SID/endpoint/5173" | python3 -c "import json,sys;print(json.load(sys.stdin).get('sandboxId',''))")
echo "Before: $SB1"
echo "After:  $SB2"
echo "unchanged: $([ "$SB1" = "$SB2" ] && echo YES || echo NO)"
```
**期望**：`unchanged: YES`

---

### T11.21 持续访问 dev server

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

### T11.22 热更新验证（HMR）

> **方案**：dev server 经 async exec 启动后，通过另一次 exec 后台运行一个定时修改脚本（async 之间可并发），模拟文件变更触发 HMR。

```bash
# 预埋定时修改脚本（10 秒后修改 App.tsx）
printf '#!/bin/sh\nsleep 10\nprintf "import '"'"'./App.css'"'"'\nfunction App() { return <h1>HMR-TEST-MARKER-12345</h1> }\nexport default App\n" > /workspace/vite-app/src/App.tsx\n' > /tmp/hmr-modify.sh
chmod +x /tmp/hmr-modify.sh

# ← 上面通过 sync exec 执行

# async exec：后台跑修改脚本 + 前台启动 vite
EXEC_ID=$(curl -s -m 10 -X POST "$BASE/session/$SID/exec/async" \
  -H 'Content-Type: application/json' \
  -d '{"command":"/tmp/hmr-modify.sh & cd /workspace/vite-app && ./node_modules/.bin/vite --host 0.0.0.0 --port 5173","timeoutSeconds":600}' \
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

### T11.23 kill async exec（停止 dev server）

> 以下用例中 `$EXEC_ID` 来自 T11.18 或 T11.22 的 async exec。

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

### T11.24 取消 keepAlive + kill sandbox

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

### T11.25 完整流程：pnpm 创建 Vite 项目 + SSE stream 实时日志 + endpoint 访问

> 自包含用例，独立创建 session，演示从零到访问前端的全流程。

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）
PNPM="pnpm"  # sandbox 中通过 mise shims 提供，直接用 pnpm 即可

# 1. 创建独立 session
SID2=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID2: $SID2"

# 2. 设置 keepAlive（防止项目创建期间沙箱被回收）
curl -s -X POST "$BASE/session/$SID2/keep-alive" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}' > /dev/null && echo "keepAlive: OK"

# 3. 触发 sandbox 创建 + 创建 Vite 项目（sandbox 已通过 mise 预装 pnpm，无需 npm install -g）
curl -s --max-time 80 -X POST "$BASE/session/$SID2/exec" \
  -H 'Content-Type: application/json' \
  -d "{\"command\":\"echo init && rm -rf /workspace/pnpm-app && cd /workspace && $PNPM create vite@5 pnpm-app --template react-ts 2>&1 | tail -1\",\"timeoutSeconds\":60}" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('create-vite exit:', d.get('exitCode'))"

# 4. pnpm install 安装依赖
curl -s --max-time 90 -X POST "$BASE/session/$SID2/exec" \
  -H 'Content-Type: application/json' \
  -d "{\"command\":\"cd /workspace/pnpm-app && $PNPM install 2>&1 | tail -2\",\"timeoutSeconds\":60}" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('pnpm install exit:', d.get('exitCode'));print(d.get('stdout','').strip()[-100:])"

# 5. async exec 启动 dev server
ASEXEC=$(curl -s -m 10 -X POST "$BASE/session/$SID2/exec/async" \
  -H 'Content-Type: application/json' \
  -d "{\"command\":\"cd /workspace/pnpm-app && $PNPM dev --host 0.0.0.0 --port 5173\",\"timeoutSeconds\":300}")
ASEID=$(echo "$ASEXEC" | python3 -c "import json,sys;print(json.load(sys.stdin).get('execId',''))")
echo "async execId: $ASEID"

# 6. SSE stream 实时查看 dev server 启动日志
curl -s -N --max-time 30 "$BASE/session/$SID2/exec/$ASEID/stream" 2>&1 | python3 -c "
import sys
lines = [l.strip() for l in sys.stdin if l.strip()]
print(f'SSE events: {len(lines)}')
for l in lines:
    print(' ', l[:80])

# 验证关键输出
text = ' '.join(lines)
checks = [
    ('VITE ready', 'VITE' in text and 'ready' in text),
    ('Local URL', 'Local' in text and 'localhost' in text),
    ('Network URL', 'Network' in text),
]
for name, ok in checks:
    print(f'  {\"✅\" if ok else \"❌\"} {name}')
"

# 7. 获取 endpoint 直连地址 + 访问前端
sleep 3
ENDPOINT=$(curl -s -m 10 "$BASE/session/$SID2/endpoint/5173")
echo "$ENDPOINT" | python3 -m json.tool

EP_URL=$(echo "$ENDPOINT" | python3 -c "import json,sys;print(json.load(sys.stdin).get('url',''))")
HTTP_CODE=$(curl -s --max-time 10 "$EP_URL" -o /dev/null -w "%{http_code}")
echo "HTTP: $HTTP_CODE"

curl -s --max-time 10 "$EP_URL" | python3 -c "
import sys
html = sys.stdin.read()
print(f'DOCTYPE: {\"<!doctype\" in html.lower()}')
print(f'has root: {\"id=\\\\\"root\\\\\"\" in html or \"id=\\\\\"app\\\\\"\" in html}')
print(f'has script: {\"<script\" in html}')
print(f'length: {len(html)}')
"
```
**期望**：
- create-vite/pnpm install 均 `exit: 0`
- SSE stream 实时输出 Vite 启动过程（VITE ready、Local URL、Network URL）
- endpoint 返回 `mode: direct`，HTTP 200，HTML 含 DOCTYPE/root/script

---

## 注意事项

1. **并发 exec**：同 session 的 sync exec 受 Semaphore(1) 串行；`exec/async` 之间可并发（dev server 运行期间可用 async exec 执行其他命令）。
2. **fd 重定向**：如果用同步 exec 启动后台进程，必须 `( cmd </dev/null > log 2>&1 & )` 模式，否则 execd 不会发送 `execution_complete` 事件。
3. **keepAlive TTL**：启用后 sandbox TTL 从 1h → 10h（baseTtl ×10，PVC 模式 baseTtl=maxTtlSeconds=3600s），用完务必释放。
4. **proxy vs 直连**：proxy 模式（`/session/:id/proxy/:port/*`）有 HTML/JS/CSS 注入与路径重写（第一部分用例）；endpoint 直连（`GET /session/:id/endpoint/:port`）无注入，适合 API/静态资源访问（见 T17.x）。

---

## 结果汇总

### 一、Proxy 注入与路径重写

| 用例 | 状态 | 说明 |
|------|------|------|
| T11.1 | ✅ | Vite 5 + glm-5.1 |
| T11.2 | ✅ | HTML 注入验证 |
| T11.3 | ✅ | HTML src/href 路径重写 |
| T11.4 | ✅ | @react-refresh PREFIXED |
| T11.5 | ✅ | JS import 路径重写 |
| T11.6 | ✅ | BrowserRouter → HashRouter 自动替换 |
| T11.7 | ✅ | CSS url/font 路径重写 |
| T11.8 | ✅ | proxy 错误查询端点 |
| T11.9 | ✅ | background:true keepAlive 生效；proxy 本身不保活 |
| T11.10 | ✅ | Hash route 刷新正常 |
| T11.11 | ✅ | Next.js 14，三页面 200 |
| T11.12 | ✅ | webpack publicPath 已重写 |
| T11.13 | ✅ | RSC 路径全部 prefixed |
| T11.14 | ✅ | 客户端导航 + 刷新正常 |
| T11.15 | ✅ | server proxy 模式 API key 正确 |

### 二、Dev Server 生命周期

| 用例 | 状态 | 说明 |
|------|------|------|
| T11.16 | ✅ | exec → keepAlive=true |
| T11.17 | ✅ | create-vite + npm install（同步 exec 分步） |
| T11.18 | ✅ | exec/async 启动 Vite，立即返回 execId |
| T11.19 | ✅ | SSE stream 逐步收到 line1/line2/line3/done，最终 event: done |
| T11.20 | ✅ | sandboxId 不变 |
| T11.21 | ✅ | 三次均 200 |
| T11.22 | ✅ | Before: Vite+React=True, After: HMR-MARKER=True |
| T11.23 | ✅ | kill → status:killed，sandbox 仍在 |
| T11.24 | ✅ | keepAlive=false, destroyed=true, endpoint→sandbox unreachable |
| T11.25 | —（新增） | pnpm 创建 Vite + SSE stream 实时日志 + endpoint 访问 |
