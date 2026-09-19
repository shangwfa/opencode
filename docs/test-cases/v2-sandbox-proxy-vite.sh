#!/bin/bash
# Vite dev server 全链路 proxy 验证（T11.1-13/30-32/36-37 的完整项目形态）
# 在沙箱内创建真实 Vite + React 项目，启动 dev server，经 proxy 验证重写链路
set -u
BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-v2-test-pass}"

api() { curl -s -m 300 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }
PASS=0; FAIL=0
pass() { echo "PASS $1 ${2:-}"; PASS=$((PASS+1)); }
fail() { echo "FAIL $1: ${2:-}"; FAIL=$((FAIL+1)); }

echo "===== 创建会话 + boot ====="
S=$(api -X POST "$BASE/api/session" -d '{"title":"vite-e2e","model":{"providerID":"Yd-DeepSeek","id":"deepseek-v4-flash"}}' | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))")
echo "S=$S"
api -X POST "$BASE/api/session/$S/keep-alive" -d '{"enabled":true,"boot":true}' >/dev/null

echo "===== 创建 Vite 项目 ====="
R=$(api -X POST "$BASE/api/session/$S/exec" -d '{"command":"rm -rf /workspace/vite-app && cd /workspace && npx --yes create-vite@5 vite-app --template react-ts 2>&1 | tail -2","timeoutSeconds":120}')
echo "  create: $(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin).get('exitCode'))" 2>/dev/null)"

echo "===== npm install ====="
R=$(api -X POST "$BASE/api/session/$S/exec" -d '{"command":"cd /workspace/vite-app && npm install 2>&1 | tail -1","timeoutSeconds":240}')
echo "  install: $(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin).get('exitCode'))" 2>/dev/null)"

echo "===== 注入测试资源（bg.png + lazy.ts + 动态 import）====="
# 1x1 红色 PNG
api -X POST "$BASE/api/session/$S/exec" -d '{"command":"cd /workspace/vite-app/src && mkdir -p assets && printf '"'"'\\x89PNG\\x0d\\x0a\\x1a\\x0a\\x00\\x00\\x00\\x0dIHDR\\x00\\x00\\x00\\x01\\x00\\x00\\x00\\x01\\x08\\x02\\x00\\x00\\x00\\x90wS\\xde\\x00\\x00\\x00\\x0cIDAT\\x08\\xd7c\\xf8\\xcf\\xc0\\x00\\x00\\x00\\x03\\x00\\x01\\x5c\\xcd\\xff\\x69\\x00\\x00\\x00\\x00IEND\\xaeB`\\x82'"'"' > assets/bg.png && echo bg-ok","timeoutSeconds":10}' >/dev/null

# lazy.ts
api -X POST "$BASE/api/session/$S/exec" -d '{"command":"cd /workspace/vite-app/src && echo \"export function lazyHello(){return '"'"'lazy-module-ok'"'"'}\" > lazy.ts && echo lazy-ok","timeoutSeconds":10}' >/dev/null

# App.tsx 带 import + 动态 import + bg 引用
APP_TSX='import { useState } from "react"
import BgPic from "./assets/bg.png"
import reactLogo from "/vite.svg"
export default function App() {
  const [lazyMsg, setLazyMsg] = useState("")
  const loadLazy = async () => {
    const m = await import("./lazy")
    setLazyMsg(m.lazyHello())
  }
  return (
    <>
      <div style={{ backgroundImage: `url(${BgPic})` }} data-testid="bg-div" />
      <img src={reactLogo} alt="logo" />
      <button onClick={loadLazy}>Load Lazy</button>
      <span data-testid="lazy-msg">{lazyMsg}</span>
    </>
  )
}'
echo "$APP_TSX" | base64 | tr -d '\n' > /tmp/app64
APP64=$(cat /tmp/app64)
api -X POST "$BASE/api/session/$S/exec" -d "{\"command\":\"echo $APP64 | base64 -d > /workspace/vite-app/src/App.tsx && echo app-ok\",\"timeoutSeconds\":10}" >/dev/null

echo "===== 启动 Vite dev server ====="
EXEC=$(curl -s -m 60 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S/exec/async" -d '{"command":"cd /workspace/vite-app && ./node_modules/.bin/vite --host 0.0.0.0 --port 5173","timeoutSeconds":3600}')
EXEC_ID=$(echo "$EXEC" | python3 -c "import json,sys;print(json.load(sys.stdin).get('execId',''))")
echo "  execId: $EXEC_ID"
sleep 10

PREFIX="/api/session/$S/proxy/5173"

# ══════════════════════════════════════════
echo ""
echo "===== T11.1 Proxy 基本连通 ====="
C=$(curl -s -m 30 -o /dev/null -w "%{http_code}" -u "opencode:$PASSWORD" "$BASE$PREFIX/")
echo "  http=$C"
[ "$C" = "200" ] && pass "T11.1" "" || fail "T11.1" "http=$C"

echo "===== T11.2 HTML 注入（全量检查）====="
curl -s -m 30 -u "opencode:$PASSWORD" "$BASE$PREFIX/" > /tmp/vite-html.txt
R=$(python3 -c "
import sys
html=open(sys.argv[1]).read()
checks = {
  'data-oc-prefix': 'data-oc-prefix=' in html,
  'inject_script': 'function f(' in html,
  'fetch_patch': 'window.fetch=function' in html,
  'ws_patch': 'window.WebSocket=function' in html,
  'xhr_patch': 'XMLHttpRequest.prototype.open' in html,
  'pushState_patch': 'history.pushState=function' in html,
  'oc_prefix_var': '__OC_PROXY_PREFIX__' in html,
}
ok = all(checks.values())
for k,v in checks.items():
    if not v: print(f'  MISSING: {k}')
print('ALL_OK' if ok else 'MISSING')" /tmp/vite-html.txt 2>/dev/null)
echo "  $R"
[ "$R" = "ALL_OK" ] && pass "T11.2（7 项 patch 全注入）" "" || fail "T11.2" "$R"

echo "===== T11.3 HTML src/href 全部 prefixed ====="
R=$(SID="$S" python3 -c "
import re,os
html=open('/tmp/vite-html.txt').read()
prefix=f'/api/session/{os.environ[\"SID\"]}/proxy/5173'
attrs = re.findall(r'(?:src|href)=\"(/[^\"]+)\"', html)
unprefixed = [a for a in attrs if not a.startswith(prefix) and not a.startswith('http')]
print('OK' if not unprefixed else f'LEAK {unprefixed[:3]}')")
echo "  $R"
[ "$R" = "OK" ] && pass "T11.3" "" || fail "T11.3" "$R"

echo "===== T11.4 @react-refresh 路径重写 ====="
R=$(SID="$S" python3 -c "
import os
html=open('/tmp/vite-html.txt').read()
prefix=f'/api/session/{os.environ[\"SID\"]}/proxy/5173'
ok = (prefix+'/@react-refresh') in html
bad = 'from \"/@react-refresh\"' in html
print('OK' if ok and not bad else 'BAD')")
echo "  $R"
[ "$R" = "OK" ] && pass "T11.4" "" || fail "T11.4" "$R"

echo "===== T11.5 main.tsx JS import 重写 ====="
MAIN=$(python3 -c "
import re
html=open('/tmp/vite-html.txt').read()
m = re.search(r'src=\"(/api/session/[^\"]*main.tsx[^\"]*)\"', html)
print(m.group(1) if m else '')" 2>/dev/null)
echo "  main.tsx path: $MAIN"
if [ -n "$MAIN" ]; then
  curl -s -m 30 -u "opencode:$PASSWORD" "$BASE$MAIN" > /tmp/vite-main.txt
  R=$(python3 -c "
import re
js=open('/tmp/vite-main.txt').read()
bad = re.findall(r'(?:from|import) \"/(?!api/session/)[^\"]+\"', js)
print('OK' if not bad else f'LEAK {bad[:3]}')" 2>/dev/null)
  echo "  $R"
  [ "$R" = "OK" ] && pass "T11.5" "" || fail "T11.5" "$R"
else
  fail "T11.5" "main.tsx not found in HTML"
fi

echo "===== T11.30 JS 原样透传（无 HTML 注入）====="
if [ -n "$MAIN" ]; then
  R=$(python3 -c "
js=open('/tmp/vite-main.txt').read()
ok = 'data-oc-prefix' not in js and 'window.fetch=function' not in js
print('OK' if ok else 'INJECTED')" 2>/dev/null)
  echo "  $R"
  [ "$R" = "OK" ] && pass "T11.30" "" || fail "T11.30" "$R"
fi

echo "===== T11.31 WebSocket patch（HMR 连接重定向）====="
R=$(python3 -c "
html=open('/tmp/vite-html.txt').read()
ok = 'window.WebSocket=function' in html
print('OK' if ok else 'NO_WS_PATCH')" 2>/dev/null)
echo "  $R"
[ "$R" = "OK" ] && pass "T11.31" "" || fail "T11.31" "$R"

echo "===== T11.36 bg.png?import export default 重写 ====="
R=$(curl -s -m 30 -u "opencode:$PASSWORD" "$BASE$PREFIX/src/assets/bg.png?import" | SID="$S" python3 -c "
import sys,re,os
body=sys.stdin.read()
prefix=f'/api/session/{os.environ[\"SID\"]}/proxy/5173'
m = re.search(r'\"(/[^\"]+)\"', body)
if m:
    path = m.group(1)
    ok = path.startswith(prefix)
    print(f'OK path={path[:60]}...' if ok else f'LEAK path={path}')
else:
    print('NO_MATCH body='+body[:80])" 2>/dev/null)
echo "  $R"
echo "$R" | grep -q "^OK" && pass "T11.36（export default 带 prefix）" "" || fail "T11.36" "$R"

echo "===== T11.37 动态 import() 重写 ====="
# 获取 App.tsx 编译产物中的 import() 路径
curl -s -m 30 -u "opencode:$PASSWORD" "$BASE$PREFIX/src/App.tsx" > /tmp/vite-app.txt
R=$(SID="$S" python3 -c "
import re,os
js=open('/tmp/vite-app.txt').read()
prefix=f'/api/session/{os.environ[\"SID\"]}/proxy/5173'
# 找所有 import(\"...\") 路径
imports = re.findall(r'import\(\"([^\"]+)\"\)', js)
if not imports:
    print('NO_DYNAMIC_IMPORTS')
else:
    leaks = [i for i in imports if i.startswith('/') and not i.startswith(prefix)]
    print('OK' if not leaks else f'LEAK {leaks[:3]}')" 2>/dev/null)
echo "  $R"
echo "$R" | grep -q "^OK" && pass "T11.37（动态 import 带 prefix）" "" || fail "T11.37" "$R"

echo "===== T11.32 子路径 ====="
for path in "/@vite/client" "/src/App.tsx" "/vite.svg"; do
  C=$(curl -s -m 30 -o /dev/null -w "%{http_code}" -u "opencode:$PASSWORD" "$BASE$PREFIX$path")
  echo "  $path: $C"
done

echo "===== T11.10 hash route ====="
C=$(curl -s -m 30 -o /dev/null -w "%{http_code}" -u "opencode:$PASSWORD" "$BASE$PREFIX/%23/about")
echo "  hash route: $C"
[ "$C" = "200" ] && pass "T11.10" "" || fail "T11.10" "http=$C"

echo "===== T11.33 不存在端口 ====="
C=$(curl -s -m 15 -o /dev/null -w "%{http_code}" -u "opencode:$PASSWORD" "$BASE/api/session/$S/proxy/9999/")
echo "  http=$C"
[ "$C" = "502" ] && pass "T11.33" "" || fail "T11.33" "http=$C"

echo "===== T11.20 sandbox 不变 ====="
SB1=$(curl -s -m 15 -u "opencode:$PASSWORD" "$BASE/api/session/$S/endpoint/5173" | python3 -c "import json,sys;print(json.load(sys.stdin).get('sandboxId','')[:12])" 2>/dev/null)
sleep 5
SB2=$(curl -s -m 15 -u "opencode:$PASSWORD" "$BASE/api/session/$S/endpoint/5173" | python3 -c "import json,sys;print(json.load(sys.stdin).get('sandboxId','')[:12])" 2>/dev/null)
echo "  SB1=$SB1 SB2=$SB2"
[ "$SB1" = "$SB2" ] && [ -n "$SB1" ] && pass "T11.20" "" || fail "T11.20" "$SB1/$SB2"

# ══════════════════════════════════════════
echo ""
echo "===== 清理 ====="
[ -n "$EXEC_ID" ] && curl -s -m 15 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -X POST "$BASE/api/session/$S/exec/$EXEC_ID/kill" >/dev/null 2>&1
api -X POST "$BASE/api/session/$S/keep-alive" -d '{"enabled":false}' >/dev/null 2>&1
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1

echo ""
echo "===== result: PASS=$PASS FAIL=$FAIL ====="
exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
