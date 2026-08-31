# Sandbox Proxy 与 Endpoint 直连

> 本文档合并自 `sandbox-proxy.md`（T11.x）与 `sandbox-endpoint.md`（T17.x）。公共测试环境和配置见 [`00-preamble.md`](./00-preamble.md)。
>
> 运行前先 `source test-env.sh [1|2|3]`。以下用例直接使用 `$BASE`/`$PG_URL`/`$MODEL`。

## 概述

沙箱内运行的服务（dev server）可通过两种方式被外部访问：

| 模式 | API | 特点 |
|------|-----|------|
| **Proxy** | `/session/:id/proxy/:port/*` | SaaS server 中转，注入 HTML prefix + fetch/WebSocket/XHR patch（路径重写） |
| **Direct** | `GET /session/:id/endpoint/:port` | 返回沙箱 Pod 直连 IP，浏览器直连，无注入，延迟低 |

---

## 一、Sandbox Proxy 注入与路径重写（T11.1–T11.15）

### 前置：创建 Vite 项目并启动 dev server

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

# boot sandbox + keepAlive
curl -s -X POST "$BASE/session/$SID/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":true,"boot":true}' > /dev/null
sleep 5

# 创建 Vite 项目
curl -s --max-time 120 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"rm -rf /workspace/vite-app && cd /workspace && npx --yes create-vite@5 vite-app --template react-ts 2>&1 | tail -2","timeoutSeconds":90}' > /dev/null

# npm install
curl -s --max-time 180 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace/vite-app && npm install 2>&1 | tail -1","timeoutSeconds":120}' > /dev/null

# async exec 启动 Vite
EXEC_ID=$(curl -s -m 10 -X POST "$BASE/session/$SID/exec/async" -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace/vite-app && ./node_modules/.bin/vite --host 0.0.0.0 --port 5173","timeoutSeconds":600}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin).get('execId',''))")
echo "execId: $EXEC_ID"
sleep 8
```

### T11.1 Proxy 基本连通

```bash
curl -s "$BASE/session/$SID/proxy/5173/" -o /dev/null -w "Vite proxy: %{http_code}\n"
```
**期望**：HTTP 200

### T11.2 HTML 注入验证

```bash
curl -s "$BASE/session/$SID/proxy/5173/" | python3 -c "
import sys
html=sys.stdin.read()
sid='$SID'; prefix='/session/'+sid+'/proxy/5173'
print('data-oc-prefix:', 'data-oc-prefix=\"'+prefix+'\"' in html)
print('inject script:', 'function f(' in html)
print('fetch patch:', 'window.fetch=function' in html)
print('WebSocket patch:', 'window.WebSocket=function' in html)
print('XHR patch:', 'XMLHttpRequest.prototype.open' in html)
"
```
**期望**：全部 True

### T11.3 HTML src/href 路径重写

```bash
curl -s "$BASE/session/$SID/proxy/5173/" | python3 -c "
import sys,re
html=sys.stdin.read()
sid='$SID'; prefix='/session/'+sid+'/proxy/5173'
attrs = re.findall(r'(?:src|href)=\"(/[^\"]+)\"', html)
unprefixed = [a for a in attrs if not a.startswith(prefix) and not a.startswith('http')]
print('unprefixed:', unprefixed[:5])
print('all prefixed:', len(unprefixed)==0)
"
```
**期望**：`all prefixed: True`

### T11.4 内联 script import 路径重写（@react-refresh）

```bash
curl -s "$BASE/session/$SID/proxy/5173/" | python3 -c "
import sys
html=sys.stdin.read()
sid='$SID'; prefix='/session/'+sid+'/proxy/5173'
print('PREFIXED:', (prefix+'/@react-refresh') in html)
print('UNPREFIXED(bug):', 'from \"/@react-refresh\"' in html)
"
```
**期望**：`PREFIXED: True`，`UNPREFIXED: False`

### T11.5 JS import 路径重写

```bash
MAIN=$(curl -s "$BASE/session/$SID/proxy/5173/" | grep -o "src=\"/session/$SID/proxy/5173/src/main.tsx[^\"]*\"" | head -1 | sed 's/src="//;s/"//')
curl -s "$BASE$MAIN" | python3 -c "
import sys,re
js=sys.stdin.read()
sid='$SID'
bad = re.findall(r'from \"/(?!session/)[^\"]+\"', js)
print('unprefixed imports:', bad[:3])
print('all prefixed:', len(bad)==0)
"
```
**期望**：`all prefixed: True`

### T11.8 错误上报端点

```bash
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/session/$SID/proxy/5173/__errors"
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/session/$SID/proxy-errors"
```
**期望**：均 200

### T11.9 keepAlive 阻止 idle 回收验证

> 前置步骤已通过 keep-alive API 设置保活（`bash background:true` 不再自动保活）。

```bash
curl -s "$BASE/session/$SID/proxy/5173/" -o /dev/null
sleep 10
curl -s "$BASE/session/$SID/proxy/5173/" -o /dev/null -w "After idle: %{http_code}\n"
```
**期望**：200（keepAlive 阻止 idle 回收）

### T11.20 keepAlive 下 sandbox 不变

```bash
SB1=$(curl -s "$BASE/session/$SID/endpoint/5173" | python3 -c "import json,sys;print(json.load(sys.stdin).get('sandboxId',''))")
sleep 10
SB2=$(curl -s "$BASE/session/$SID/endpoint/5173" | python3 -c "import json,sys;print(json.load(sys.stdin).get('sandboxId',''))")
echo "unchanged: $([ "$SB1" = "$SB2" ] && echo YES || echo NO)"
```
**期望**：`unchanged: YES`

### T11.6 BrowserRouter basename 代理适配

> 验证应用可用原生 `BrowserRouter` 在 proxy prefix 下正常路由：proxy 注入脚本暴露 `window.__OC_PROXY_PREFIX__`（见 `sandbox-proxy.ts` INJECT_SCRIPT），应用将其作为 `basename` 传入。
>
> **前提**：项目需安装 `react-router-dom`，main.tsx 使用 `<BrowserRouter basename={window.__OC_PROXY_PREFIX__ ?? "/"}>`。

```bash
# 检查 main.tsx 的 basename 写法（应引用 __OC_PROXY_PREFIX__）
curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"grep -c \"__OC_PROXY_PREFIX__\" /workspace/vite-app/src/main.tsx"}' \
  | python3 -c "import json,sys;print('basename refs:', json.load(sys.stdin).get('stdout','').strip())"

# 浏览器验证：刷新 /session/:id/proxy/5173/about，应渲染 About Page（Vite SPA fallback + basename 剥离前缀）
```
**期望**：basename 引用存在；直接刷新 `/session/:id/proxy/5173/about` 渲染 About Page，无 "No routes matched" 告警

### T11.7 CSS url() 路径重写

> 验证 CSS 文件中 `url()` 引用的路径被注入 proxy prefix。

```bash
# 查找 CSS link
CSS=$(curl -s "$BASE/session/$SID/proxy/5173/" | grep -o "href=\"/session/$SID/proxy/5173/[^\"]*\.css[^\"]*\"" | head -1 | sed 's/href="//;s/"//')
if [ -n "$CSS" ]; then
  curl -s "$BASE$CSS" | python3 -c "
import sys,re
css=sys.stdin.read()
urls = re.findall(r'url\(([^)]+)\)', css)
unprefixed = [u for u in urls if u.startswith('/') and '/session/' not in u]
print('css url() count:', len(urls))
print('unprefixed:', unprefixed[:3])
print('all prefixed:', len(unprefixed)==0)
"
else
  echo "No CSS link found (Vite 默认模板可能无外部 CSS 引用)"
fi
```
**期望**：CSS 中 `url()` 路径含 prefix，或项目无外部 CSS 引用（Vite 默认模板）

### T11.10 Hash route 刷新不丢失路由

```bash
curl -s "$BASE/session/$SID/proxy/5173/#/about" -o /dev/null -w "Hash route: %{http_code}\n"
```
**期望**：200（proxy 服务端只看 pathname，`#` 后内容不影响路由）

### T11.11 Next.js dev server 代理

> **前提**：需在沙箱内创建 Next.js 项目。耗时较长（create-next-app + npm install）。

```bash
# 创建 Next.js 项目（如果不存在）
curl -s --max-time 300 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"if [ ! -d /workspace/next-app ]; then cd /workspace && npx --yes create-next-app@14 next-app --js --app --no-eslint --no-tailwind --no-src-dir --no-import-alias --yes && cd next-app && npm install; fi && echo next-ready","timeoutSeconds":240}' \
  | python3 -c "import json,sys;print('next:', json.load(sys.stdin).get('exitCode'))"

# async exec 启动 Next.js
NEXT_EXEC=$(curl -s -m 10 -X POST "$BASE/session/$SID/exec/async" -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace/next-app && ./node_modules/.bin/next dev -H 0.0.0.0 -p 3000","timeoutSeconds":600}')
echo "next execId: $(echo "$NEXT_EXEC" | python3 -c "import json,sys;print(json.load(sys.stdin).get('execId',''))")"

sleep 20

# 验证首页
for path in "/" "/about" "/contact"; do
  CODE=$(curl -s --max-time 30 -o /dev/null -w "%{http_code}" "$BASE/session/$SID/proxy/3000$path")
  echo "Next.js $path: $CODE"
done
```
**期望**：三路径均 200

### T11.12 Next.js webpack publicPath 重写

```bash
PREFIX="/session/$SID/proxy/3000"
WP_URL=$(curl -s "$BASE$PREFIX/" | grep -o "src=\"$PREFIX/_next/static/chunks/webpack[^\"]*\"" | head -1 | sed 's/src="//;s/"//')
echo "webpack URL: $WP_URL"
curl -s "$BASE$WP_URL" | grep -o '__webpack_require__\.p\s*=\s*"[^"]*"'
```
**期望**：`__webpack_require__.p="/session/{sid}/proxy/3000/_next/"`

### T11.13 Next.js RSC 路径重写

```bash
PREFIX="/session/$SID/proxy/3000"
curl -s "$BASE$PREFIX/" | python3 -c "
import sys,re
html=sys.stdin.read()
sid='$SID'
prefix='/session/'+sid+'/proxy/3000'
unprefixed = re.findall(r'(?<=[\"\\\\])/(?!session/|/)(?:_next|about|contact|favicon)[^\"\\\\]*', html)
print('unprefixed RSC paths:', unprefixed[:5])
print('all prefixed:', len(unprefixed)==0)
"
```
**期望**：`all prefixed: True`

### T11.15 Server Proxy 模式连通性

> 验证 sandbox server proxy API key 正确传递（期望非 401）。

```bash
CODE=$(curl -s --max-time 30 -o /dev/null -w "%{http_code}" "$BASE/session/$SID/proxy/5173/")
echo "Server proxy mode: $CODE (expect 200, NOT 401/502)"
```
**期望**：200（401 = API key 未传；502 = sandbox 未启动）

### T11.30 非 HTML 资源代理

> 验证 JS/CSS/JSON/图片等非 HTML 资源经 proxy 代理时**不注入** HTML patch，原样透传。

```bash
# 获取 main.tsx 的 JS 资源
MAIN=$(curl -s "$BASE/session/$SID/proxy/5173/" | grep -o "src=\"/session/$SID/proxy/5173/src/main.tsx[^\"]*\"" | head -1 | sed 's/src="//;s/"//')
curl -s "$BASE$MAIN" | python3 -c "
import sys
js=sys.stdin.read()
print('JS 长度:', len(js))
print('无 HTML 注入(data-oc-prefix):', 'data-oc-prefix' not in js)
print('无 fetch patch:', 'window.fetch=function' not in js)
print('有 Vite HMR 注入:', '@vite/client' in js or 'import' in js)
"

# 验证 JSON/API 资源
curl -s -o /dev/null -w "vite client JS: %{http_code} %{content_type}\n" "$BASE/session/$SID/proxy/5173/@vite/client"
```
**期望**：JS 资源不含 HTML 注入脚本，原样透传；`@vite/client` 返回 200 + JS content-type

### T11.31 WebSocket HMR 代理

> 验证 proxy 模式下 Vite HMR WebSocket 能正确建立连接（proxy patch 了 `window.WebSocket`，实际 HMR 通信走 proxy 中转）。

```bash
# 检查 proxy HTML 中 WebSocket patch 是否将 ws 连接重定向到 proxy
curl -s "$BASE/session/$SID/proxy/5173/" | python3 -c "
import sys
html=sys.stdin.read()
sid='$SID'
# WebSocket patch 应将 ws:// 请求重写为 proxy 路径
has_ws_patch = 'window.WebSocket=function' in html
# 检查 patch 是否引用了 proxy 路径（而非原始 host）
print('WebSocket patch 存在:', has_ws_patch)
if has_ws_patch:
    # 提取 patch 中的 URL 构造逻辑
    import re
    ws_logic = re.findall(r'WebSocket[^}]+}', html)
    print('patch 片段:', ws_logic[0][:150] if ws_logic else '(未提取到)')
"
```
**期望**：WebSocket patch 存在，将 HMR 连接重定向到 proxy 路径

### T11.32 proxy 子路径访问

> 验证 proxy 对子路径（非根 `/`）的代理行为。

```bash
# Vite 特定路径
for path in "/src/main.tsx" "/@vite/client" "/src/App.tsx"; do
  CODE=$(curl -s --max-time 10 -o /dev/null -w "%{http_code}" "$BASE/session/$SID/proxy/5173$path")
  echo "proxy 5173$path: $CODE"
done
```
**期望**：均 200（proxy 正确代理子路径请求到沙箱）

### T11.33 proxy 不存在的端口

> 验证端口未启动时 proxy 的错误处理。

```bash
# 端口 9999 无服务
CODE=$(curl -s --max-time 10 -o /dev/null -w "%{http_code}" "$BASE/session/$SID/proxy/9999/")
echo "proxy 9999 (no service): $CODE"
```
**期望**：502 或 504（连接被拒绝/超时），不应 200 或挂起

### T11.34 endpoint 多端口

> 验证同时获取不同端口的直连地址。

```bash
# Vite 在 5173，Next.js 在 3000（如果已启动）
for port in 5173 3000; do
  RESULT=$(curl -s "$BASE/session/$SID/endpoint/$port")
  echo "port $port: $(echo "$RESULT" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('mode','?'), d.get('url','?') or d.get('error','?'))")"
done
```
**期望**：有服务的端口返回 `direct` + URL；无服务的端口返回 502

### T11.35 Node.js HTTP 服务代理

> 验证普通 Node.js HTTP 服务（Express/Koa/原生 http）也能通过 proxy 和 endpoint 访问。不限于前端 dev server。

```bash
# 在沙箱内启动一个简单的 Node.js HTTP 服务（无需 npm install，用原生模块）
EXEC_NODE=$(curl -s -m 10 -X POST "$BASE/session/$SID/exec/async" -H 'Content-Type: application/json' \
  -d '{"command":"node -e '\''const http=require(\"http\");const s=http.createServer((req,res)=>{res.setHeader(\"Content-Type\",\"application/json\");res.end(JSON.stringify({message:\"hello-from-node\",path:req.url,time:Date.now()}))});s.listen(8080,\"0.0.0.0\",()=>console.log(\"node-server-ready\"))'\''","timeoutSeconds":600}')
NODE_EXEC_ID=$(echo "$EXEC_NODE" | python3 -c "import json,sys;print(json.load(sys.stdin).get('execId',''))")
echo "node execId: $NODE_EXEC_ID"
sleep 3

# Proxy 访问 JSON API
echo "--- Proxy 访问 ---"
curl -s "$BASE/session/$SID/proxy/8080/api/test" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'  message: {d.get(\"message\")}')
print(f'  path: {d.get(\"path\")}')
print(f'  有 time: {bool(d.get(\"time\"))}')
assert d.get('message') == 'hello-from-node'
assert d.get('path') == '/api/test'
print('  ✅ Proxy JSON API 正确')
"

# Proxy 访问 — 验证非 HTML 响应不注入 patch
echo "--- 非 HTML 不注入 ---"
curl -s "$BASE/session/$SID/proxy/8080/api/test" | python3 -c "
import sys
body=sys.stdin.read()
print(f'  无 data-oc-prefix: {\"data-oc-prefix\" not in body}')
print(f'  无 fetch patch: {\"window.fetch=function\" not in body}')
print(f'  纯 JSON: {body.strip().startswith(\"{\") and body.strip().endswith(\"}\")}')
"

# Endpoint 直连访问
echo "--- Endpoint 直连 ---"
NODE_EP=$(curl -s "$BASE/session/$SID/endpoint/8080" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('url',''))")
echo "  direct URL: $NODE_EP"
curl -s --max-time 10 "$NODE_EP/api/direct" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'  message: {d.get(\"message\")}')
print(f'  path: {d.get(\"path\")}')
assert d.get('message') == 'hello-from-node'
assert d.get('path') == '/api/direct'
print('  ✅ Direct JSON API 正确')
"

# 清理
curl -s -X POST "$BASE/session/$SID/exec/$NODE_EXEC_ID/kill" > /dev/null
```
**期望**：
- Proxy 访问 JSON API 返回正确 JSON，**不注入 HTML patch**（Content-Type: application/json 时不注入）
- Endpoint 直连访问返回正确 JSON
- 证明 proxy 不限于前端 dev server，普通 Node.js API 服务同样可代理

---

## 二、Endpoint 直连 API（T17.1–T17.6）

### T17.1 无沙箱时 endpoint 返回 502

```bash
EMPTY_SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/session/$EMPTY_SID/endpoint/5173"
```
**期望**：502

### T17.2 端口参数校验

```bash
for p in 0 99999 abc; do
  curl -s -o /dev/null -w "port=$p: %{http_code}\n" "$BASE/session/$SID/endpoint/$p"
done
```
**期望**：均 400

### T17.3 endpoint 返回直连信息

```bash
curl -s "$BASE/session/$SID/endpoint/5173" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert d.get('mode') in ('direct','proxy')
assert d.get('url')
assert d.get('port') == 5173
assert d.get('sandboxId')
assert d.get('fallback','').startswith('/session/')
print(f'✅ mode={d[\"mode\"]} url={d[\"url\"]}')
"
```
**期望**：`mode=direct`，`url` 为沙箱 Pod IP（如 `http://10.12.x.x:5173`）

### T17.4 直连访问 Vite 页面

```bash
URL=$(curl -s "$BASE/session/$SID/endpoint/5173" | python3 -c "import json,sys;print(json.load(sys.stdin).get('url',''))")
curl -s --max-time 10 "$URL/" -o /dev/null -w "Direct: %{http_code}\n"
curl -s --max-time 10 "$URL/" | python3 -c "
import sys; html=sys.stdin.read()
print(f'has Vite: {\"vite\" in html.lower()}')
print(f'无 proxy 注入: {\"data-oc-prefix\" not in html}')
"
```
**期望**：HTTP 200，无 proxy 注入

### T17.5 Proxy vs 直连模式对比

```bash
URL=$(curl -s "$BASE/session/$SID/endpoint/5173" | python3 -c "import json,sys;print(json.load(sys.stdin).get('url',''))")
echo "=== Proxy ==="
curl -s "$BASE/session/$SID/proxy/5173/" | python3 -c "
import sys; h=sys.stdin.read()
print(f'长度={len(h)} prefix={\"data-oc-prefix\" in h} fetch={\"window.fetch=function\" in h}')
"
echo "=== Direct ==="
curl -s --max-time 10 "$URL/" | python3 -c "
import sys; h=sys.stdin.read()
print(f'长度={len(h)} prefix={\"data-oc-prefix\" not in h} fetch={\"window.fetch=function\" not in h} vite={\"@vite/client\" in h}')
"
```
**期望**：
- Proxy：长度大（~3700），有 prefix + fetch patch
- Direct：长度小（~600），无注入，原始 Vite 输出

### T17.6 沙箱销毁后 endpoint 返回 502

```bash
# kill async exec
curl -s -X POST "$BASE/session/$SID/exec/$EXEC_ID/kill" > /dev/null
# 取消 keepAlive + 销毁
curl -s -X POST "$BASE/session/$SID/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":false}' > /dev/null
curl -s -X POST "$BASE/session/$SID/kill-sandbox" > /dev/null
sleep 2
curl -s "$BASE/session/$SID/endpoint/5173" | python3 -c "
import json,sys; d=json.load(sys.stdin)
print('after kill:', d.get('error') or d.get('url'))
"
```
**期望**：`sandbox unreachable`

---

## 三、Dev Server 生命周期最佳实践

> 详见 [`exec-api.md`](./exec-api.md) T19.x。此处仅列出 proxy/endpoint 相关的关键约束。

```
1. POST /session                              创建 session
2. POST /session/:id/keep-alive {boot:true}   保活 + 立即建沙箱
3. POST /session/:id/exec                     创建项目（同步）
4. POST /session/:id/exec                     npm install（同步）
5. POST /session/:id/exec/async               启动 dev server（异步）
6. GET  /session/:id/endpoint/:port           获取直连 IP
   ── 使用期间通过 proxy 或 direct 访问 ──
7. POST /session/:id/exec/:execId/kill        停止 dev server
8. POST /session/:id/keep-alive {enabled:false}  释放保活
9. POST /session/:id/kill-sandbox             销毁沙箱
```

---

## 结果汇总

### Proxy 注入与路径重写

| 用例 | 结果 | 说明 |
|------|------|------|
| T11.1 | ✅ | Vite proxy HTTP 200 |
| T11.2 | ✅ | data-oc-prefix + inject script + fetch/WebSocket/XHR patch 全部 True |
| T11.3 | ✅ | src/href 全部 prefixed |
| T11.4 | ✅ | @react-refresh PREFIXED: True |
| T11.5 | ✅ | JS import 全部 prefixed |
| T11.6 | ✅ | basename 引用 __OC_PROXY_PREFIX__，BrowserRouter 路由正常 |
| T11.7 | ✅ | Vite 默认模板无外部 CSS 引用（不适用） |
| T11.8 | ✅ | proxy errors / proxy-errors 均 200 |
| T11.9 | ✅ | keepAlive 阻止 idle 回收 |
| T11.10 | ✅ | Hash route 刷新 200 |
| T11.11 | ✅ | Next.js 首页 200（/about /contact 404 因项目无此路由） |
| T11.12 | ✅ | webpack publicPath 重写为 proxy prefix |
| T11.13 | ✅ | RSC 路径全部 prefixed |
| T11.15 | ✅ | Server Proxy 模式 200（非 401） |
| T11.20 | ✅ | sandboxId 不变 |
| T11.30 | ✅ | JS 原样透传（137KB 无注入），@vite/client 200 |
| T11.31 | ✅ | WebSocket patch 存在，HMR 连接重定向到 proxy |
| T11.32 | ✅ | 子路径 /src/main.tsx 等均 200 |
| T11.33 | ✅ | 不存在端口 502 |
| T11.34 | ✅ | 多端口均返回 direct URL |
| T11.35 | ✅ | Node.js HTTP 服务 proxy/direct 均正确，JSON 不注入 patch |

### Endpoint 直连

| 用例 | 结果 | 说明 |
|------|------|------|
| T17.1 | ✅ | 无沙箱 502 |
| T17.2 | ✅ | port=0/99999/abc 均 400 |
| T17.3 | ✅ | mode=direct, url=http://10.12.9.208:5173, 结构完整 |
| T17.4 | ✅ | 直连 200, 无 proxy 注入 |
| T17.5 | ✅ | Proxy 3699 字节 + 注入; Direct 621 字节 + 无注入 |
| T17.6 | ✅ | 销毁后 sandbox unreachable |

> **验证环境**：组合 1（远端 PG + 远端 K8s Sandbox），2026-08-07 实测全量通过。T11.6 需先 `pnpm add react-router-dom`。T11.11 的 /about /contact 404 是 create-next-app 默认无此路由，非 proxy 问题（首页 200 已验证 Next.js 代理）。T17.5 直连注入检查中 `prefix=True` 表示"无注入"为 True（逻辑正确）。

### 复测记录（2026-08-31，组合 1：远端 PG + 远端 K8s Sandbox）

> 使用优化后镜像：`/proxy` 路由显式经 Sandbox Server Proxy（`getSandboxEndpoint(..., useServerProxy)`），`/endpoint` 的 `proxyUrl` 显式传 `true`。测试会话 `ses_faa7f7a0cffeyq94I2Y5M4zb21`，沙箱 `437218f6-c22f-4f60-8ffc-54c65d539847`。

| 用例 | 结果 | 说明 |
|------|------|------|
| T11.1 | ✅ | HTTP 200 |
| T11.2 | ✅ | prefix/inject/fetch/ws/xhr 全 True |
| T11.3 | ✅ | 3 个 src/href 全 prefixed |
| T11.4 | ✅ | PREFIXED=True, UNPREFIXED=False |
| T11.5 | ✅ | main.tsx 200, imports 全 prefixed |
| T11.6 | ✅ | main.tsx basename 引用 `__OC_PROXY_PREFIX__`；刷新 `/session/:id/proxy/5173/about` 直达 About Page |
| T11.7 | — | 不适用（Vite 默认模板无外部 CSS link） |
| T11.8 | ✅ | 200/200 |
| T11.9 | ✅ | idle 12s 后仍 200（keepAlive 保活） |
| T11.10 | ✅ | 200 |
| T11.11 | ✅ | `/` 200；/about /contact 404（项目默认无此路由，非 proxy 问题） |
| T11.12 | ✅ | `__webpack_require__.p="/session/{sid}/proxy/3000/_next/"` |
| T11.13 | ✅ | RSC 路径全 prefixed |
| T11.15 | ✅ | 200（非 401/502） |
| T11.20 | ✅ | sandboxId 不变（437218f6） |
| T11.30 | ✅ | main.tsx 2098B 无注入；@vite/client 200 + text/javascript |
| T11.31 | ✅ | WebSocket patch 存在并重定向到 proxy 路径 |
| T11.32 | ✅ | /src/main.tsx、/@vite/client、/src/App.tsx 全 200 |
| T11.33 | ✅ | 502 |
| T11.34 | ✅ | 5173/3000 均返回 direct URL（同 Pod IP） |
| T11.35 | ✅ | proxy JSON 正确且无注入；endpoint direct 访问 JSON 正确 |

### 复测记录（2026-08-31 第二轮：HMR WebSocket 修复，组合 1）

> 镜像 `opencode-saas-sandbox-test:hmr-clean`（含本节全部修复）。测试会话 `ses_fa9abc16affe4DkwuY4l7grH4R`，沙箱 `a42fce55-a578-49de-a17a-d215ad141b1d`（Vite 5.4.21 + React + BrowserRouter basename 适配，默认 base）。

| 验证项 | 结果 | 说明 |
|--------|------|------|
| 页面代理渲染 | ✅ | Home/About/Contact 三路由正常，`#/about` 刷新保持 |
| HMR WebSocket 握手 | ✅ | `ws://…/session/:id/proxy/:port/` + `vite-hmr` 协议 101，原生 WebSocket bridge |
| HMR 端到端 | ✅ | exec 修改 About.tsx 后页面**无需刷新**自动更新（hot-demo-v15→v16），console 无报错 |
| 修复后语义 | — | 见下方「修复说明」 |

**修复说明（本节对应的代码变更）**：

1. **`middleware/proxy.ts`**：outbound 连接从 `Socket.makeWebSocket`（在 raw route 场景下握手挂起）改为原生 `WebSocket`，双向桥接到 Effect inbound socket（文本/二进制/close/error）。
2. **`sandbox-proxy.ts` rewriteJs**：对 `@vite/client` 响应补齐 Vite 占位符替换（`__BASE__`/`__HMR_BASE__`/`__HMR_*__`/`__SERVER_HOST__`/`__WS_TOKEN__`），使 HMR client 的 ws 地址与模块请求都走 SaaS proxy 前缀。注意 `isViteClient` 判断必须用 `subPath`（`target.pathname` 是完整代理路径，永远不等于 `/@vite/client`）。
3. **cache-bust**：HTML 与 JS 模块中引用的 `@vite/client` 统一追加服务器启动时间戳 query（`?oc=<ts36>`），并对其响应设 `Cache-Control: no-cache`。否则浏览器磁盘缓存的旧版 client（base 无前缀）会处理 HMR 消息导致 `Failed to reload`。
4. **踩坑记录**：
   - 占位符残留会以 `ReferenceError: __XXX__ is not defined` 形式中断 client 执行，需全量替换（`__PURE__` 为压缩注释，无需处理）。
   - HMR 模块请求打到根路径且返回 200 HTML（SaaS catch-all），现象是 `Failed to reload` 而非 404——排查时不要被 200 迷惑。
   - 页面同时存在 script 标签与模块 import 两个 client 实例，二者 URL 必须一致（同一缓存键），否则旧实例处理 HMR 消息。

### 复测记录（2026-08-31 第三轮：真实业务项目，组合 1）

用 **xybot-front-micro-shasha-personal-dashboard**（GitLab 真实仓库，React 18 + Vite 5 + antd 6 + react-router-dom 6 + pnpm，前后端一体 `xybot dev`，页面请求数 ~280）替代 demo 项目验证代理能力：

| 步骤 | 结果 |
|---|---|
| 沙箱内 git clone + pnpm install（31s） | ✅ |
| `nohup pnpm dev`（5173 被占自动落 5174） | ✅ Vite ready |
| SaaS proxy 页面加载（278 请求） | ✅ 全部 200/304，零失败，HMR `connected` |
| **无注入对照组**（OpenSandbox server proxy 直开） | ❌ 白屏（root 空）——反证 SaaS proxy 重写必要性 |
| **SPA basename 适配** | 应用独立运行 basename 为空，`No routes matched`。应用侧一行 fallback 修复：`baseroute: window.__MICRO_APP_BASE_ROUTE__ \|\| window.__OC_PROXY_PREFIX__ \|\| ''`（`src/.xybot/index.ts`），与 §十 结论一致：**basename 需应用读取注入前缀，proxy 无法透明解决** |
| **HMR**：exec 改 `src/pages/index.tsx` 文案 | ✅ Vite `hmr update`，浏览器**未手动刷新**内容即更新；改 router 相关文件时 Vite 正确降级整页刷新（`hmr invalidate`） |
| basename 修复后整页刷新（deep-link） | ✅ Welcome 页正常渲染，零失败请求 |

结论：SaaS proxy 对真实重型业务项目（含微前端、UI 库、大量依赖预构建）端到端可用；应用侧唯一适配点是 baseroute/basename 读取 `__OC_PROXY_PREFIX__`。
