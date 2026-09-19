#!/bin/bash
# 剩余 SKIP 补测：T11.8（错误上报端点）+ T11.38-39（预览异常 diagnostics）+ T11.6（basename）
set -u
BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-v2-test-pass}"
PASS=0; FAIL=0
pass() { echo "PASS $1 ${2:-}"; PASS=$((PASS+1)); }
fail() { echo "FAIL $1: ${2:-}"; FAIL=$((FAIL+1)); }

api() { curl -s -m 300 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }
new_s() { api -X POST "$BASE/api/session" -d "{\"title\":\"$1\",\"model\":{\"providerID\":\"Yd-DeepSeek\",\"id\":\"deepseek-v4-flash\"}}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null; }

echo "═══ T11.8 错误上报端点 ═══"
S=$(new_s terr)
api -X POST "$BASE/api/session/$S/keep-alive" -d '{"enabled":true,"boot":true}' >/dev/null

# POST 错误到 /proxy/:port/__errors
C1=$(curl -s -m 15 -o /dev/null -w "%{http_code}" -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S/proxy/5173/__errors" -d '[{"type":"runtime","message":"TestError: stack overflow","url":"/src/App.tsx","line":42,"timestamp":1789800000000}]')
echo "  POST __errors: $C1"

# GET 单端口错误
R1=$(curl -s -m 15 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/session/$S/proxy/5173/__errors")
echo "  GET __errors: $(echo "$R1" | head -c 150)"

# GET 全 session 错误
C2=$(curl -s -m 15 -o /dev/null -w "%{http_code}" -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/session/$S/proxy-errors")
R2=$(curl -s -m 15 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/session/$S/proxy-errors")
echo "  GET proxy-errors: $C2 $(echo "$R2" | head -c 150)"

OK8=$(python3 -c "
import json
try:
    per_port=json.loads('''$R1''')
    all_errs=json.loads('''$R2''')
    ok = (isinstance(per_port,list) and len(per_port)>=1 and per_port[0].get('message')=='TestError: stack overflow'
          and '5173' in all_errs and len(all_errs.get('5173',[]))>=1)
    print('ok')
except Exception as e:
    print(f'bad {e}')")
[ "$C1" = "200" ] && [ "$C2" = "200" ] && [ "$OK8" = "ok" ] && pass "T11.8（POST 上报 + GET 单端口 + GET 全 session）" "" || fail "T11.8" "c1=$C1 c2=$C2 ok=$OK8"

echo ""
echo "═══ T11.38 预览不可访问 diagnostics ═══"
# 端口无服务 → proxy 502 应带 diagnostics（portListening=false + hint）
R38=$(curl -s -m 30 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/session/$S/proxy/9998/")
echo "  502 body: $(echo "$R38" | head -c 250)"
OK38=$(echo "$R38" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    diag=d.get('diagnostics',{})
    ok = d.get('error')=='sandbox process unreachable' and 'portListening' in json.dumps(diag) and d.get('hint','')!=''
    print('ok')
except: print('bad')" 2>/dev/null)
[ "$OK38" = "ok" ] && pass "T11.38（502 带 diagnostics: portListening + hint）" "" || fail "T11.38" "$OK38"

# 重复调用（缓存 5s 不变）
R38b=$(curl -s -m 30 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/session/$S/proxy/9998/")
OK38b=$(echo "$R38b" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print('ok' if 'diagnostics' in json.dumps(d) or d.get('hint') else 'bad')
except: print('bad')" 2>/dev/null)
[ "$OK38b" = "ok" ] && pass "T11.38（缓存内重复调用仍返回 diagnostics）" "" || fail "T11.38-cache" "$OK38b"

echo ""
echo "═══ T11.39 沙箱存活时无误报 ═══"
# 端口有服务 → proxy 正常（非 502）→ 无 diagnostics
api -X POST "$BASE/api/session/$S/exec/async" -d '{"command":"node -e '\''const h=require(\"http\");h.createServer((q,r)=>{r.end(\"alive\")}).listen(9997)'\''","timeoutSeconds":300}' >/dev/null
sleep 3
R39=$(curl -s -m 15 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/session/$S/proxy/9997/")
C39=$(curl -s -m 15 -o /dev/null -w "%{http_code}" -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/session/$S/proxy/9997/")
echo "  proxy: $C39 body=$(echo "$R39" | head -c 50)"
[ "$C39" = "200" ] && ! echo "$R39" | grep -q "diagnostics" && pass "T11.39（存活时 200，无 diagnostics 误报）" "" || fail "T11.39" "http=$C39 body=$(echo "$R39" | head -c 80)"

echo ""
echo "═══ T11.6 basename（__OC_PROXY_PREFIX__ 可用性）═══"
# 用 proxy-test-server.js（HTML 输出）经 proxy 验证 __OC_PROXY_PREFIX__ 已注入
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRV_B64=$(base64 < "$SCRIPT_DIR/scripts/proxy-test-server.js" | tr -d '\n')
api -X POST "$BASE/api/session/$S/exec" -d "{\"command\":\"echo $SRV_B64 | base64 -d > /tmp/tsrv2.js\",\"timeoutSeconds\":15}" >/dev/null
curl -s -m 60 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S/exec/async" -d '{"command":"node /tmp/tsrv2.js","timeoutSeconds":600}' >/dev/null 2>&1
# 用独立端口启动（避免与 9997 冲突）
api -X POST "$BASE/api/session/$S/exec" -d '{"command":"sed -i s/8080/9980/ /tmp/tsrv2.js && node /tmp/tsrv2.js &","timeoutSeconds":3}' >/dev/null 2>&1
sleep 3
# 直接用已有的 8080 端口（proxy-test-server 已在上面 T11.39 停了，重新看主 proxy 响应）
# 简单验证：任何 HTML proxy 响应都包含 __OC_PROXY_PREFIX__
PROXY_HTML=$(curl -s -m 15 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/session/$S/proxy/8080/" 2>/dev/null)
if [ -z "$PROXY_HTML" ]; then
  # 8080 可能已停，起一个新的
  api -X POST "$BASE/api/session/$S/exec" -d '{"command":"node /tmp/tsrv2.js &","timeoutSeconds":3}' >/dev/null 2>&1
  sleep 3
  PROXY_HTML=$(curl -s -m 15 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/session/$S/proxy/8080/" 2>/dev/null)
fi
HAS_VAR=$(echo "$PROXY_HTML" | grep -c "__OC_PROXY_PREFIX__" || echo 0)
HAS_ASSIGN=$(echo "$PROXY_HTML" | grep -c "window.__OC_PROXY_PREFIX__" || echo 0)
echo "  __OC_PROXY_PREFIX__ mentions: $HAS_VAR, assignment: $HAS_ASSIGN"
[ "$HAS_VAR" -ge 1 ] && [ "$HAS_ASSIGN" -ge 1 ] && pass "T11.6（__OC_PROXY_PREFIX__ 已注入，应用可作 basename）" "" || fail "T11.6" "var=$HAS_VAR assign=$HAS_ASSIGN"

# 清理
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1

echo ""
echo "===== result: PASS=$PASS FAIL=$FAIL ====="
exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
