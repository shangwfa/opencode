# Sandbox Proxy（dev server 代理）

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-INDEX.md`](./00-INDEX.md)。

## 十一、Sandbox Proxy（dev server 代理）

> 前置条件：本地测试环境已启动（见 `docs/local-test-env.md`），使用 `zhipuai/glm-5.1` 模型，基础 URL 为 `http://localhost:14096`。

```bash
BASE="http://localhost:14096"
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'
```

### T11.1 创建 Vite 项目并启动 dev server

```bash
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
SID_NEXT="ses_1d52f1c8cffeiSZAgZNA8XElBE"  # 已有 Next.js 项目

# 启动 Next.js（background:true）
curl -s --max-time 60 -X POST "$BASE/session/$SID_NEXT/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 工具执行，background 必须设为 true: cd /workspace/next-app && npx next dev -H 0.0.0.0 -p 3000\"}],\"model\":$MODEL}" \
  | python3 -c "import json,sys;[print(p['text'][:100]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"

sleep 20

# 验证首页、about、contact 三个页面
for path in "/" "/about" "/contact"; do
  CODE=$(curl -s --max-time 30 -o /dev/null -w "%{http_code}" "$BASE/session/$SID_NEXT/proxy/3000$path")
  echo "Next.js $path: $CODE"
done
```
**期望**：三个路径均返回 `200`

---

### T11.12 Next.js webpack publicPath 重写

```bash
SID_NEXT="ses_1d52f1c8cffeiSZAgZNA8XElBE"
PREFIX="/session/$SID_NEXT/proxy/3000"

# 找 webpack.js
WP_URL=$(curl -s "$BASE$PREFIX/" | grep -o "src=\"$PREFIX/_next/static/chunks/webpack[^\"]*\"" | head -1 | sed 's/src="//;s/"//')
echo "webpack URL: $WP_URL"
curl -s "$BASE$WP_URL" | grep -o '__webpack_require__\.p\s*=\s*"[^"]*"'
```
**期望**：`__webpack_require__.p="/session/{sid}/proxy/3000/_next/"`

---

### T11.13 Next.js RSC 路径重写

```bash
SID_NEXT="ses_1d52f1c8cffeiSZAgZNA8XElBE"
PREFIX="/session/$SID_NEXT/proxy/3000"

curl -s "$BASE$PREFIX/" | python3 -c "
import sys,re
html=sys.stdin.read()
prefix='/session/ses_1d52f1c8cffeiSZAgZNA8XElBE/proxy/3000'

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
1. 浏览器打开 `http://localhost:14096/session/ses_1d52f1c8cffeiSZAgZNA8XElBE/proxy/3000/`
2. 点击 About 链接 → 地址栏变为 `.../proxy/3000/about`，页面内容变为 About
3. 点击 Contact 链接 → 地址栏变为 `.../proxy/3000/contact`，页面正常
4. 刷新当前页面 → 仍然正常（302/200 均可）
5. 浏览器后退 → 回到上一页

**期望**：全部正常，无白屏，无 chunk 加载错误

---

### T11.15 Server Proxy 模式连通性

```bash
# 验证 sandbox server proxy API key 正确传递（期望非 401）
SID_NEXT="ses_1d52f1c8cffeiSZAgZNA8XElBE"
CODE=$(curl -s --max-time 30 -o /dev/null -w "%{http_code}" "$BASE/session/$SID_NEXT/proxy/3000/")
echo "Server proxy mode: $CODE (expect 200, NOT 401/502)"
```
**期望**：`200`（401 = API key 未传；502 = sandbox 未启动）

---

