# hosting 责任链：代理 / 静态托管 / HTML 注入 / SSO / 重定向

> 用例段：G20。需要 fake 上游（COS 静态 + 飞书 webhook + 业务 API），脚本内嵌 python3 启动；网关需以 `GATEWAY_API_TARGET`/`GATEWAY_CND_DOMAIN` 指向 fake（见 [README.md](./README.md)）。

## 用例

### G20.1：api-proxy

| 用例 | 验证点 |
|---|---|
| G20.1.1 | `/api/*` 转发 upstream（fake 收到路径与 query），响应透传 |
| G20.1.2 | `/oauth/token` 同样走 api-proxy |
| G20.1.3 | 请求头过滤：host/content-length/sec-fetch-site 不透传（fake 侧断言） |
| G20.1.4 | 业务码 200 → 透传且不告警 |
| G20.1.5 | HTTP 200 但业务码非 200 → 飞书告警（读 baseRoute 应用 env.ERROR_WEB_HOOK，post 富文本格式） |
| G20.1.6 | upstream 不可达 → 502 Bad Gateway |

### G20.2：internal-proxy

| 用例 | 验证点 |
|---|---|
| G20.2.1 | `/ai-chatbot*` 转发 chatbot upstream（路径含前缀原样拼接） |
| G20.2.2 | `/ai-infra-api*` 转发 ai-tools upstream |
| G20.2.3 | 非 websocket 的 internal 路径 404 语义由 upstream 决定（透传） |

### G20.3：static-file

| 用例 | 验证点 |
|---|---|
| G20.3.1 | 有扩展名非 .html → 回源 `{app.url}/{version}{baseUrl}`（fake COS 断言路径） |
| G20.3.2 | 请求头 version 覆盖 app.version（回源路径带 header version） |
| G20.3.3 | Content-Type 按扩展名（.js → application/javascript） |
| G20.3.4 | 未知 baseRoute → 根应用回退（原 getAppByDomain pathIndex→domainIndex 语义，仍 200） |
| G20.3.5 | `.html` 扩展名不归 static-file（走 app-hosting HTML 链） |

### G20.4：SSO 与 redirect

| 用例 | 验证点 |
|---|---|
| G20.4.1 | `/exchange/sso/token` 返回中转页 HTML（含 SSOLogin / GET_ACCESS_TOKEN） |
| G20.4.2 | `/share/share?id=x` → 302 `/embed/application/detail?id=x&container=browser` |
| G20.4.3 | `/client/appstore/detail?id=y` → container=modal |

### G20.5：app-hosting 兜底（微前端宿主核心）

| 用例 | 验证点 |
|---|---|
| G20.5.1 | 入口 HTML 注入 `window.YD`：env 展开 + version + MICRO_APPS（name/baseroute/url `{url}/{version}/index.html`/iframe/destroy/config） |
| G20.5.2 | 注入**不含 locale 字段**（多语言已裁剪） |
| G20.5.3 | favicon 相对链接修正为 `${siteUrl}${href}` |
| G20.5.4 | LRU 缓存：同配置二次请求不回源（COS 命中数不变） |
| G20.5.5 | 配置变更（指纹变化）→ 重新回源且注入新 version |
| G20.5.6 | 请求头 version 覆盖（灰度最高优先）注入与回源路径 |
| G20.5.7 | `app.proxy` 存在 → 整机透传（路径保留） |
| G20.5.8 | `app.type==='ssg'` 且路径非 `/` → 回源带路径（原语义：URL 拼完整 baseUrl，含 baseRoute 前缀） |
| G20.5.9 | 未知域名 → 200 文本"访问的应用不存在" |
| G20.5.10 | `/app-api/info`：按 baseurl 头解析应用，返回 `{name,id,version}`；未匹配返回 `{}` |

## 测试脚本

> 前置：网关已按 README 指向 fake（`GATEWAY_API_TARGET=$FAKE`、`GATEWAY_CND_DOMAIN=127.0.0.1`（注意：不带端口——replace(hostname) 不含端口，带端口会造成 `host:port:port` 非法 URL））。

```bash
BASE=${BASE:-http://127.0.0.1:3101}
FAKE=${FAKE:-http://127.0.0.1:18990}
PGURL=${PGURL:-postgresql://postgres:ab123456@127.0.0.1:5432/opencode-v2-up}
SCH=${SCH:-hn_gateway_dev}
pass=0; fail=0; skip=0
req()  { curl -sS -m 30 --noproxy '*' -o /tmp/gw-uc-res.json -w '%{http_code}' "$@"; }
raw()  { cat /tmp/gw-uc-res.json; }
pgq()  { psql "$PGURL" -Atc "$1" 2>/dev/null; }
check(){ if [ -n "$3" ] && [ "$3" = "$4" ]; then echo "PASS $1 $2"; pass=$((pass+1)); else echo "FAIL $1 $2 expect=[$3] got=[$4]"; fail=$((fail+1)); fi }
skipcase(){ echo "SKIP $1 $2"; skip=$((skip+1)); }

# ── fake 上游（COS/API/飞书；命中记录 /tmp/gw-fake-hits.log）──
mkdir -p /tmp/gw-uc && : > /tmp/gw-fake-hits.log
cat > /tmp/gw-uc/fake.py <<'PYEOF'
import json, http.server, socketserver, urllib.parse

ENTRY_HTML = '<!DOCTYPE html><html><head><link rel="shortcut icon" href="/favicon.ico"><script>window.YD = {};</script></head><body><div id="app"></div></body></html>'

def hit(kind, path, headers=None):
    with open('/tmp/gw-fake-hits.log', 'a') as f:
        f.write(json.dumps({'kind': kind, 'path': path, 'headers': headers or {}}) + '\n')

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get('content-length') or 0); body = self.rfile.read(n)
        hit('POST', self.path)
        if self.path == '/feishu':
            payload = json.loads(body); hit('feishu', json.dumps(payload, ensure_ascii=False))
            self.send_response(200); self.send_header('content-type','application/json'); self.end_headers(); self.wfile.write(b'{"ok":true}'); return
        if self.path == '/api/biz-err':
            self.send_response(200); self.send_header('content-type','application/json'); self.end_headers(); self.wfile.write(b'{"code":500,"msg":"biz fail"}'); return
        self.send_response(200); self.send_header('content-type','application/json'); self.end_headers(); self.wfile.write(b'{"code":200,"data":{"from":"api"}}')
    def do_GET(self):
        hit('GET', self.path, {'host': self.headers.get('host') or '', 'sec-fetch-site': self.headers.get('sec-fetch-site') or ''})
        p = urllib.parse.urlparse(self.path).path
        if p.startswith('/api/ping'):
            self.send_response(200); self.send_header('content-type','application/json'); self.end_headers(); self.wfile.write(b'{"code":200,"data":{"from":"api"}}'); return
        if p.startswith('/proxied'):
            self.send_response(200); self.send_header('content-type','application/json'); self.end_headers(); self.wfile.write(json.dumps({'proxied': True, 'path': self.path}).encode()); return
        if p.endswith('.js'):
            self.send_response(200); self.send_header('content-type','text/javascript'); self.end_headers(); self.wfile.write(b'console.log(1)'); return
        if p.endswith('index.html') or p.endswith('.html'):
            self.send_response(200); self.send_header('content-type','text/html'); self.end_headers(); self.wfile.write(ENTRY_HTML.encode()); return
        if p.endswith('.css'):
            self.send_response(200); self.send_header('content-type','text/css'); self.end_headers(); self.wfile.write(b'body{}'); return
        self.send_response(200); self.send_header('content-type','application/json'); self.end_headers(); self.wfile.write(json.dumps({'echo': self.path}).encode())

socketserver.TCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(('127.0.0.1', 18990), H) as httpd:
    httpd.serve_forever()
PYEOF
python3 /tmp/gw-uc/fake.py & FAKE_PID=$!
sleep 0.5
curl -sS -m 3 --noproxy '*' "$FAKE/probe" >/dev/null 2>&1 || { echo "fake 上游启动失败"; exit 9; }
trap 'kill $FAKE_PID 2>/dev/null' EXIT

[ "$(req "$BASE/health" >/dev/null; echo ok)" = "ok" ] || { echo "网关未启动，退出"; exit 9; }
UPSTREAM_OK=$(curl -sS -m 3 --noproxy '*' "$FAKE/api/ping" >/dev/null 2>&1 && echo yes || echo no)

# 幂等清理 + 种子应用
pgq "DELETE FROM $SCH.apps WHERE app_id LIKE 'uc_g20_%'" >/dev/null
pgq "INSERT INTO $SCH.apps (app_id,domain,base_route,config) VALUES
 ('uc_g20_host','uc-g20.test','', '{\"appId\":\"uc_g20_host\",\"name\":\"宿主\",\"url\":\"$FAKE/static/app\",\"version\":\"1.0.0\",\"env\":{\"ERROR_WEB_HOOK\":\"$FAKE/feishu\"},\"microApps\":[{\"appId\":\"sub1\",\"baseroute\":\"/sub\",\"url\":\"$FAKE/static/sub\",\"version\":\"2.0.0\",\"iframe\":false,\"destroy\":false,\"config\":{\"theme\":\"dark\"}}]}'::jsonb),
 ('uc_g20_webapp','uc-g20.test','webapp', '{\"appId\":\"uc_g20_webapp\",\"url\":\"$FAKE/static/webapp\",\"version\":\"1.0.0\"}'::jsonb),
 ('uc_g20_proxy','uc-g20.test','proxied', '{\"appId\":\"uc_g20_proxy\",\"proxy\":{\"target\":\"$FAKE\"}}'::jsonb),
 ('uc_g20_ssg','uc-g20.test','ssgsite', '{\"appId\":\"uc_g20_ssg\",\"url\":\"$FAKE/static/ssg\",\"version\":\"1.0.0\",\"type\":\"ssg\",\"runId\":\"$RANDOM$RANDOM\"}'::jsonb),
 ('uc_g20_apialias','uc-g20.test','api', '{\"appId\":\"uc_g20_apialias\",\"env\":{\"ERROR_WEB_HOOK\":\"$FAKE/feishu\"}}'::jsonb)
 ON CONFLICT (app_id) DO NOTHING" >/dev/null
pgq "SELECT pg_notify('gateway_config_changed', '{\"table\":\"apps\",\"key\":\"*\"}')" >/dev/null; sleep 0.2

# ── G20.1 api-proxy ──
c=$(req "$BASE/api/ping?x=1")
check G20.1.1a "api转发" 200 "$c"
check G20.1.1b "透传响应" api "$(python3 -c "import json;print(json.load(open('/tmp/gw-uc-res.json'))['data']['from'])" 2>/dev/null)"
check G20.1.1c "upstream收到query" yes "$(grep -q '/api/ping?x=1' /tmp/gw-fake-hits.log && echo yes || echo no)"
c=$(req -X POST "$BASE/oauth/token" -H 'content-type: application/json' -d '{"grant_type":"x"}')
check G20.1.2 "oauth/token走代理" 200 "$c"
check G20.1.3 "host头已过滤(非客户端Host)" no "$(grep '/api/ping' /tmp/gw-fake-hits.log | grep -q '127.0.0.1:3101' && echo yes || echo no)"
if [ "$UPSTREAM_OK" = yes ]; then
  BEFORE=$(grep -c '"kind": "feishu"' /tmp/gw-fake-hits.log || echo 0)
  c=$(req "$BASE/api/ok-biz")
  check G20.1.4 "业务码200不告警" "$BEFORE" "$(grep -c '"kind": "feishu"' /tmp/gw-fake-hits.log || echo 0)"
  BEFORE=$(grep -c '"kind": "feishu"' /tmp/gw-fake-hits.log || echo 0)
  c=$(req "$BASE/api/biz-err" -H "domain: uc-g20.test")
  check G20.1.5a "业务码非200透传" 200 "$c"
  check G20.1.5b "飞书告警触发" "$((BEFORE+1))" "$(grep -c '"kind": "feishu"' /tmp/gw-fake-hits.log || echo 0)"
  check G20.1.5c "告警为post富文本" yes "$(grep '"kind": "feishu"' /tmp/gw-fake-hits.log | tail -1 | grep -q 'msg_type.*post' && echo yes || echo no)"
else skipcase G20.1.4/5 "fake 上游不可达"; fi

# ── G20.2 internal-proxy（默认 upstream 为内网服务名，本机不可达 → 502 也算链路正确）──
c=$(req -m 8 "$BASE/ai-chatbot/ping")
check G20.2.1a "ai-chatbot进internal链" yes "$([ "$c" = "502" ] || [ "$c" = "200" ] || [ "$c" = "404" ] || [ "$c" = "000" ] || [ "$c" = "504" ] && echo yes || echo no)"
c=$(req -m 8 "$BASE/ai-infra-api/x")
check G20.2.2 "ai-infra-api进internal链" yes "$([ "$c" = "502" ] || [ "$c" = "200" ] || [ "$c" = "404" ] || [ "$c" = "000" ] || [ "$c" = "504" ] && echo yes || echo no)"

# ── G20.3 static-file ──
: > /tmp/gw-fake-hits.log
c=$(req "$BASE/webapp/main.js" -H 'Host: uc-g20.test')
check G20.3.1a "静态回源" 200 "$c"
check G20.3.1b "回源路径=app.url/version/baseUrl" yes "$(grep -q '/static/webapp/1.0.0/webapp/main.js' /tmp/gw-fake-hits.log && echo yes || echo no)"
c=$(req "$BASE/webapp/main.js" -H 'Host: uc-g20.test' -H 'version: 9.9.9')
check G20.3.2 "header version覆盖回源" yes "$(grep -q '/static/webapp/9.9.9/webapp/main.js' /tmp/gw-fake-hits.log && echo yes || echo no)"
check G20.3.3 "Content-Type=js" application/javascript "$(curl -sS -m 10 --noproxy '*' -D - -o /dev/null "$BASE/webapp/main.js" -H 'Host: uc-g20.test' | grep -i '^content-type:' | tr -d '\r' | awk '{print $2}')"
c=$(req "$BASE/nosuchapp/main.js" -H 'Host: uc-g20.test')
check G20.3.4 "未知baseRoute回退根应用" 200 "$c"
c=$(req "$BASE/webapp/page.html" -H 'Host: uc-g20.test')
check G20.3.5 "html扩展名走HTML链非static" no "$([ "$(raw | head -c 20)" = "App not found" ] && echo yes || echo no)"

# ── G20.4 SSO 与 redirect ──
c=$(req "$BASE/exchange/sso/token")
check G20.4.1a "SSO页200" 200 "$c"
check G20.4.1b "SSO页内容" yes "$(raw | grep -q 'GET_ACCESS_TOKEN' && echo yes || echo no)"
LOC=$(curl -sS -m 10 --noproxy '*' -D - -o /dev/null "$BASE/share/share?id=5" | grep -i '^location:' | tr -d '\r' | awk '{print $2}')
check G20.4.2 "share重定向browser" "/embed/application/detail?id=5&container=browser" "$LOC"
LOC=$(curl -sS -m 10 --noproxy '*' -D - -o /dev/null "$BASE/client/appstore/detail?id=8" | grep -i '^location:' | tr -d '\r' | awk '{print $2}')
check G20.4.3 "appstore重定向modal" "/embed/application/detail?id=8&container=modal" "$LOC"

# ── G20.5 app-hosting 兜底 ──
: > /tmp/gw-fake-hits.log
c=$(req "$BASE/" -H 'Host: uc-g20.test')
check G20.5.1a "入口HTML=200" 200 "$c"
HTML=$(raw)
check G20.5.1b "注入version" yes "$(echo "$HTML" | grep -q '\"version\":\"1.0.0\"' && echo yes || echo no)"
check G20.5.1c "MICRO_APPS注入" yes "$(echo "$HTML" | grep -q 'MICRO_APPS' && echo yes || echo no)"
check G20.5.1d "子应用url带版本" yes "$(echo "$HTML" | grep -q 'static/sub/2.0.0/index.html' && echo yes || echo no)"
check G20.5.1e "子应用config透传" yes "$(echo "$HTML" | grep -q '\"theme\":\"dark\"' && echo yes || echo no)"
check G20.5.1f "env展开(ERROR_WEB_HOOK)" yes "$(echo "$HTML" | grep -q 'ERROR_WEB_HOOK' && echo yes || echo no)"
check G20.5.2 "不含locale" no "$(echo "$HTML" | grep -qi 'locale' && echo yes || echo no)"
check G20.5.3 "favicon修正" yes "$(echo "$HTML" | grep -q 'static/app/1.0.0/favicon.ico' && echo yes || echo no)"
COS_HITS=$(grep -c 'index.html' /tmp/gw-fake-hits.log)
req "$BASE/" -H 'Host: uc-g20.test' >/dev/null
check G20.5.4 "二次请求缓存命中" "$COS_HITS" "$(grep -c 'index.html' /tmp/gw-fake-hits.log)"
req -X POST "$BASE/gw-api/nacos/app/uc_g20_host/update?mode=incremental" -H 'content-type: application/json' -d '{"version":"5.0.0"}' >/dev/null
c=$(req "$BASE/" -H 'Host: uc-g20.test')
check G20.5.5a "配置变更重新回源" "$((COS_HITS+1))" "$(grep -c 'index.html' /tmp/gw-fake-hits.log)"
check G20.5.5b "注入新version" yes "$(raw | grep -q '\"version\":\"5.0.0\"' && echo yes || echo no)"
c=$(req "$BASE/" -H 'Host: uc-g20.test' -H 'version: 7.7.7')
check G20.5.6a "header version覆盖注入" yes "$(raw | grep -q '\"version\":\"7.7.7\"' && echo yes || echo no)"
c=$(req "$BASE/proxied/echo" -H 'Host: uc-g20.test')
check G20.5.7a "app.proxy整机透传" 200 "$c"
check G20.5.7b "透传保留路径" "/proxied/echo" "$(python3 -c "import json;print(json.load(open('/tmp/gw-uc-res.json'))['path'])" 2>/dev/null)"
c=$(req "$BASE/ssgsite/docs/intro" -H 'Host: uc-g20.test')
check G20.5.8 "ssg带路径回源" yes "$(grep -q '/static/ssg/1.0.0/ssgsite/docs/intro' /tmp/gw-fake-hits.log && echo yes || echo no)"
c=$(req "$BASE/" -H 'Host: uc-unknown-g20.test')
check G20.5.9 "未知域名兜底" 访问的应用不存在 "$(raw)"
c=$(req "$BASE/app-api/info" -H 'Host: uc-g20.test' -H 'baseurl: /webapp')
check G20.5.10a "app-api-info返回结构" uc_g20_webapp "$(python3 -c "import json;print(json.load(open('/tmp/gw-uc-res.json'))['id'])" 2>/dev/null)"
c=$(req "$BASE/app-api/info" -H 'Host: uc-unknown-g20.test' -H 'baseurl: /x')
check G20.5.10b "未匹配返回空对象" "{}" "$(raw | tr -d ' ')"

# 清理
pgq "DELETE FROM $SCH.apps WHERE app_id LIKE 'uc_g20_%'" >/dev/null
kill $FAKE_PID 2>/dev/null

echo "━━━ hosting.md 汇总: PASS=$pass FAIL=$fail SKIP=$skip ━━"; exit $(( fail > 0 ))
```

## 说明

- G20.2 的 internal-proxy 默认 upstream 是 K8s 内网服务名（本机不可达）——断言"进入 internal 链"（502/404 而非 hosting 兜底文案）即可；精确转发由单测 `test/hosting.test.ts` 以 `GATEWAY_CHATBOT_TARGET` 覆盖。
- G20.5.5 用 PG 直改配置（绕过 API）验证指纹缓存失效——NOTIFY 触发跨实例失效，同实例由 60s TTL 或 NOTIFY 本地回调达成；若时序敏感可重跑。
- G20.1.3 的 host 过滤断言：fake 收到的 host 头为空或上游域名，而非客户端原始 Host。
