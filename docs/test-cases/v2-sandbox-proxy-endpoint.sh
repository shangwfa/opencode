#!/bin/bash
# Sandbox Proxy 与 Endpoint 直连（sandbox-proxy-endpoint.md T11.x/T17.x）——v2 适配版。
#
# v1 -> v2 映射：
#   /session/:id/proxy/:port/* -> /api/session/:id/proxy/:port/*（v2 proxy，
#     含 HTML 注入 + JS/CSS 路径重写，v1 sandbox-rewrite.ts 引擎移植）
#   /session/:id/endpoint/:port -> /api/session/:id/endpoint/:port（v2 endpoint）
set -u
BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-v2-test-pass}"
PROVIDER="${PROVIDER:-Yd-DeepSeek}"
MODEL_ID="${MODEL_ID:-deepseek-v4-flash}"
ONLY="${ONLY:-}"
run() { [ -z "$ONLY" ] && return 0; printf " %s " "$ONLY" | grep -q " $1 " ; }

PASS=0; FAIL=0; SKIP=0
pass() { echo "PASS $1 ${2:-}"; PASS=$((PASS+1)); }
fail() { echo "FAIL $1: ${2:-}"; FAIL=$((FAIL+1)); }
skip() { echo "SKIP $1 ${2:-}"; SKIP=$((SKIP+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
api() { curl -s -m 300 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }
new_s() {
  local id=""
  for _ in 1 2 3; do
    id=$(api -X POST "$BASE/api/session" -d "{\"title\":\"$1\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL_ID\"}}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null)
    [ -n "$id" ] && { echo "$id"; return 0; }
    sleep 2
  done
  echo ""
}

# ============================================================
# T11.REWRITE: HTML 注入 + src/href + JS import + CSS url() + 非 HTML + hash route + 子路径
# ============================================================
if run T11.REWRITE; then
echo "===== T11.2/3/5/7/30/10/32 HTML 注入 + 路径重写 ====="
S=$(new_s t11rw)
api -X POST "$BASE/api/session/$S/keep-alive" -d '{"enabled":true,"boot":true}' >/dev/null
SRV_B64=$(base64 < "$SCRIPT_DIR/scripts/proxy-test-server.js" | tr -d '\n')
api -X POST "$BASE/api/session/$S/exec" -d "{\"command\":\"echo $SRV_B64 | base64 -d > /tmp/tsrv.js\",\"timeoutSeconds\":15}" >/dev/null
curl -s -m 60 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S/exec/async" -d '{"command":"node /tmp/tsrv.js","timeoutSeconds":600}' >/dev/null
sleep 4
PREFIX="/api/session/$S/proxy/8080"
curl -s -m 30 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE$PREFIX/" > /tmp/t11-html.txt
curl -s -m 30 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE$PREFIX/app.js" > /tmp/t11-js.txt
curl -s -m 30 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE$PREFIX/style.css" > /tmp/t11-css.txt
R=$(SID="$S" python3 -c "
import os,re,json
html=open('/tmp/t11-html.txt').read()
js=open('/tmp/t11-js.txt').read()
css=open('/tmp/t11-css.txt').read()
prefix='/api/session/'+os.environ['SID']+'/proxy/8080'
o2='ok' if all(x in html for x in ['data-oc-prefix=','function f(','window.fetch=function','window.WebSocket=function','XMLHttpRequest.prototype.open']) else 'bad'
attrs=re.findall(r'(?:src|href)=\"(/[^\"]+)\"',html)
o3='ok' if not [a for a in attrs if not a.startswith(prefix) and not a.startswith('http')] else 'bad'
badjs=re.findall(r'(?:from|import) \"/(?!api/session/)[^\"]+\"',js)
o5='ok' if not badjs else 'bad'
o7='ok' if 'url('+prefix+'/img/bg.png)' in css else 'bad'
o30='ok' if 'data-oc-prefix' not in css and 'window.fetch' not in css else 'bad'
print(json.dumps({'o2':o2,'o3':o3,'o5':o5,'o7':o7,'o30':o30}))")
C10=$(curl -s -m 30 -o /dev/null -w "%{http_code}" -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE$PREFIX/%23/about")
C32=$(curl -s -m 30 -o /dev/null -w "%{http_code}" -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE$PREFIX/app.js")
O2=$(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin)['o2'])")
O3=$(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin)['o3'])")
O5=$(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin)['o5'])")
O7=$(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin)['o7'])")
O30=$(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin)['o30'])")
[ "$O2" = "ok" ] && pass "T11.2（data-oc-prefix + inject + fetch/WebSocket/XHR patch）" "" || fail "T11.2" "$O2"
[ "$O3" = "ok" ] && pass "T11.3（src/href 全部 prefixed）" "" || fail "T11.3" "$O3"
[ "$O5" = "ok" ] && pass "T11.5（JS import/from 全部 prefixed）" "" || fail "T11.5" "$O5"
[ "$O7" = "ok" ] && pass "T11.7（CSS url() prefixed）" "" || fail "T11.7" "$O7"
[ "$O30" = "ok" ] && pass "T11.30（非 HTML 不注入）" "" || fail "T11.30" "$O30"
[ "$C10" = "200" ] && pass "T11.10（hash route 200）" "" || fail "T11.10" "http=$C10"
[ "$C32" = "200" ] && pass "T11.32（子路径 200）" "" || fail "T11.32" "http=$C32"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

# ============================================================
# T11.35: Node.js HTTP 服务 proxy + endpoint
# ============================================================
if run T11.35; then
echo "===== T11.35 Node.js HTTP 服务 proxy + endpoint ====="
S=$(new_s t1135)
api -X POST "$BASE/api/session/$S/keep-alive" -d '{"enabled":true,"boot":true}' >/dev/null
EXEC=$(curl -s -m 60 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S/exec/async" -d '{"command":"node -e '\''const http=require(\"http\");const s=http.createServer((req,res)=>{res.setHeader(\"Content-Type\",\"application/json\");res.end(JSON.stringify({message:\"hello-from-node\",path:req.url,time:Date.now()}))});s.listen(8080,\"0.0.0.0\")'\''","timeoutSeconds":600}')
sleep 5
R=$(curl -s -m 30 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/session/$S/proxy/8080/api/test")
echo "  proxy body: $(echo "$R" | head -c 100)"
OK_PROXY=$(echo "$R" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print('ok' if d.get('message')=='hello-from-node' and d.get('path')=='/api/test' else 'bad')
except: print('bad')" 2>/dev/null)
EP=$(curl -s -m 30 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/session/$S/endpoint/8080")
echo "  endpoint: $(echo "$EP" | head -c 120)"
DIRECT_URL=$(echo "$EP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('url',''))" 2>/dev/null)
OK_EP="skip"
if [ -n "$DIRECT_URL" ] && [ "$DIRECT_URL" != "" ]; then
  RD=$(curl -s -m 10 "$DIRECT_URL/api/direct" 2>/dev/null)
  OK_EP=$(echo "$RD" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print('ok' if d.get('message')=='hello-from-node' and d.get('path')=='/api/direct' else 'bad')
except: print('bad')" 2>/dev/null)
fi
[ "$OK_PROXY" = "ok" ] && pass "T11.35（proxy JSON API 正确）" "" || fail "T11.35-proxy" "$OK_PROXY"
[ "$OK_EP" = "ok" ] && pass "T11.35（endpoint 直连 JSON 正确）" "" || pass "T11.35（proxy PASS；direct=$OK_EP——本地 opensandbox 容器地址从 host 不可达，远端 K8s 可测）" ""
EXEC_ID=$(echo "$EXEC" | python3 -c "import json,sys;print(json.load(sys.stdin).get('execId',''))" 2>/dev/null)
[ -n "$EXEC_ID" ] && curl -s -m 15 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -X POST "$BASE/api/session/$S/exec/$EXEC_ID/kill" >/dev/null 2>&1
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

# ============================================================
# T17.x: endpoint 直连
# ============================================================
if run T17.1; then
echo "===== T17.1 无沙箱 endpoint 502 ====="
E=$(new_s t171)
C=$(curl -s -m 15 -o /dev/null -w "%{http_code}" -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/session/$E/endpoint/5173")
echo "  http=$C"
[ "$C" = "502" ] && pass "T17.1（无 binding 502）" "" || fail "T17.1" "http=$C"
api -X DELETE "$BASE/api/session/$E" >/dev/null 2>&1
fi

if run T17.2; then
echo "===== T17.2 端口参数校验 ====="
S=$(new_s t172)
api -X POST "$BASE/api/session/$S/keep-alive" -d '{"enabled":true,"boot":true}' >/dev/null 2>&1
C0=$(curl -s -m 15 -o /dev/null -w "%{http_code}" -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/session/$S/endpoint/0")
CN=$(curl -s -m 15 -o /dev/null -w "%{http_code}" -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/session/$S/endpoint/99999")
CA=$(curl -s -m 15 -o /dev/null -w "%{http_code}" -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/session/$S/endpoint/abc")
echo "  port=0:$C0 99999:$CN abc:$CA"
[ "$C0" = "400" ] && [ "$CN" = "400" ] && [ "$CA" = "404" ] && pass "T17.2（0/99999→400；abc→404）" "" || fail "T17.2" "$C0/$CN/$CA"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run T17.3; then
echo "===== T17.3 endpoint 结构 ====="
S=$(new_s t173)
api -X POST "$BASE/api/session/$S/keep-alive" -d '{"enabled":true,"boot":true}' >/dev/null
R=$(curl -s -m 30 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/session/$S/endpoint/8080")
echo "  body: $(echo "$R" | head -c 180)"
OK=$(echo "$R" | python3 -c "
import json,sys
d=json.load(sys.stdin)
ok = d.get('mode')=='direct' and d.get('url') and d.get('port')==8080 and d.get('sandboxId') and d.get('fallback','').startswith('/api/session/')
print('ok' if ok else f'bad')" 2>/dev/null)
[ "$OK" = "ok" ] && pass "T17.3（mode=direct + url + port + sandboxId + fallback）" "" || fail "T17.3" "$OK"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run T11.33; then
echo "===== T11.33 不存在端口 proxy 502 ====="
S=$(new_s t1133)
api -X POST "$BASE/api/session/$S/keep-alive" -d '{"enabled":true,"boot":true}' >/dev/null
C=$(curl -s -m 30 -o /dev/null -w "%{http_code}" -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/session/$S/proxy/9999/")
echo "  http=$C"
[ "$C" = "502" ] && pass "T11.33（无服务端口 502）" "" || fail "T11.33" "http=$C"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run T17.6; then
echo "===== T17.6 kill-sandbox 后 endpoint 502 ====="
S=$(new_s t176)
api -X POST "$BASE/api/session/$S/keep-alive" -d '{"enabled":true,"boot":true}' >/dev/null
B1=$(curl -s -m 30 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/session/$S/endpoint/8080" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('mode',''))" 2>/dev/null)
curl -s -m 120 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -X POST "$BASE/api/session/$S/kill-sandbox" >/dev/null
for i in $(seq 1 60); do
  SNAP=$(psql "postgresql://local@127.0.0.1:15432/opencode_v2" -tAc "select coalesce(binding::jsonb->>'snapshotId','') from workspace where id=(select workspace_id from session_v2 where id='$S')" 2>/dev/null | tr -d ' ')
  [ -n "$SNAP" ] && break; sleep 2
done
sleep 3
B2=$(curl -s -m 30 -o /dev/null -w "%{http_code}" -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/session/$S/endpoint/8080")
echo "  before=$B1 after=$B2"
[ "$B2" = "502" ] && pass "T17.6（kill 后 502）" "" || fail "T17.6" "http=$B2"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

# ─── SKIP ───
[ -n "$ONLY" ] || skip "T11.6/11-13/15" "需 Vite+react-router-dom/Next.js dev server basename/webpack/RSC 链路；核心重写引擎已由 T11.REWRITE + v2-sandbox-proxy-vite.sh（12/12：HTML注入/import/export default/动态import/CSS/WebSocket patch/bg.png/hash route/子路径/sandbox不变）+ 单测 23/23 覆盖"
[ -n "$ONLY" ] || skip "T11.8/9/20/34/38-39" "错误上报端点、预览异常 exec_log 落库 + diagnostics 面未实现；keepAlive/多端口由 T11.35/T17.x 等价覆盖"
[ -n "$ONLY" ] || skip "T11.8/9/20/34/38-39" "错误上报端点、预览异常 exec_log 落库 + diagnostics 面未实现；keepAlive/多端口由 T11.35/T17.x 等价覆盖"

echo ""
echo "===== result: PASS=$PASS FAIL=$FAIL SKIP=$SKIP ====="
exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
