#!/bin/bash
# 沙箱命令执行 API（exec-api.md T19.x）——v2 适配版。
#
# v2 契约差异（相对 v1）：
#   exec 返回 {exitCode, stdout, stderr}（无 id；stderr 独立采集，v1 合并到 stdout）
#   超时返回 exitCode=-1 + stderr="exec timed out after Ns"（v1 为 exitCode=null + TimeoutError）
#   timeoutSeconds falsy 短路（0/不传 = 不超时，本轮修复对齐 v1）
# v2 无对应面（SKIP）：/exec/async、/stream、/exec/:execId(+kill)、/execs 历史与 exec_log
#   持久化体系、keep-alive 端点（v2 为 idle suspendForIdle 自动管理）、proxy 端点、
#   boot 初始化（pnpm store）、signal/oom 解码
set -u
BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-v2-test-pass}"
ONLY="${ONLY:-}"
run() { [ -z "$ONLY" ] && return 0; printf " %s " "$ONLY" | grep -q " $1 " ; }

PASS=0; FAIL=0; SKIP=0
pass() { echo "PASS $1 ${2:-}"; PASS=$((PASS+1)); }
fail() { echo "FAIL $1: ${2:-}"; FAIL=$((FAIL+1)); }
skip() { echo "SKIP $1 ${2:-}"; SKIP=$((SKIP+1)); }

api() { curl -s -m 200 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }
S=$(api -X POST "$BASE/api/session" -d '{"title":"execapi","model":{"providerID":"Yd-DeepSeek","id":"deepseek-v4-flash"}}' | python3 -c "import json,sys;print(json.load(sys.stdin).get('data','{}').get('id',''))" 2>/dev/null)
EX() { curl -s -m "${3:-90}" -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S/exec" -d "$2"; }

# 首次 exec 触发 provision（可能较慢），失败重试一次
R=$(EX "" '{"command":"echo warmup"}' 150)
echo "$R" | grep -q '"exitCode":0' || R=$(EX "" '{"command":"echo warmup"}' 150)

if run T19.1; then
echo "===== T19.1 简单命令 ====="
R=$(EX "" '{"command":"echo hello-from-exec"}')
OK=$(echo "$R" | python3 -c "import json,sys;d=json.load(sys.stdin);print('ok' if d['exitCode']==0 and 'hello-from-exec' in d['stdout'] else 'bad '+json.dumps(d))" 2>/dev/null)
[ "$OK" = "ok" ] && pass "T19.1" "$R" || fail "T19.1" "$R"
fi

if run T19.2; then
echo "===== T19.2 多行输出与 stderr（v2 stderr 独立）====="
R=$(EX "" '{"command":"echo line1 && echo line2 && echo err-line >&2"}')
OK=$(echo "$R" | python3 -c "
import json,sys
d=json.load(sys.stdin)
ok = d['exitCode']==0 and 'line1' in d['stdout'] and 'line2' in d['stdout'] and 'err-line' in d['stderr']
print('ok' if ok else 'bad '+json.dumps(d))" 2>/dev/null)
[ "$OK" = "ok" ] && pass "T42.2/v2（stdout/stderr 独立采集，优于 v1 合并行为）" "$R" || fail "T19.2" "$R"
fi

if run T19.3; then
echo "===== T19.3 workingDirectory ====="
R=$(EX "" '{"command":"pwd","workingDirectory":"/tmp"}')
OK=$(echo "$R" | python3 -c "import json,sys;d=json.load(sys.stdin);print('ok' if d['stdout'].strip()=='/tmp' else 'bad '+json.dumps(d))" 2>/dev/null)
[ "$OK" = "ok" ] && pass "T19.3" "$R" || fail "T19.3" "$R"
fi

if run T19.4; then
echo "===== T19.4 非零退出码 ====="
R=$(EX "" '{"command":"exit 42"}')
OK=$(echo "$R" | python3 -c "import json,sys;d=json.load(sys.stdin);print('ok' if d['exitCode']==42 else 'bad '+json.dumps(d))" 2>/dev/null)
[ "$OK" = "ok" ] && pass "T19.4（exitCode=42）" "$R" || fail "T19.4" "$R"
fi

if run T19.5; then
echo "===== T19.5 缺 command -> 400 ====="
C=$(curl -s -o /dev/null -w "%{http_code}" -m 15 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S/exec" -d '{}')
[ "$C" = "400" ] && pass "T19.5" "" || fail "T19.5" "http=$C"
fi

if run T19.6; then
echo "===== T19.6 不存在 session -> 404 ====="
C=$(curl -s -o /dev/null -w "%{http_code}" -m 15 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/ses_NOTEXIST/exec" -d '{"command":"echo test"}')
[ "$C" = "404" ] && pass "T19.6" "" || fail "T19.6" "http=$C"
fi

if run T19.10; then
echo "===== T19.10 超时控制（v2 契约：-1/stderr 文案）====="
A=$(EX "" '{"command":"echo no-timeout && sleep 1 && echo done"}')
OKA=$(echo "$A" | python3 -c "import json,sys;d=json.load(sys.stdin);print('ok' if d['exitCode']==0 and 'done' in d['stdout'] else 'bad')" 2>/dev/null)
B_=$(EX "" '{"command":"sleep 30","timeoutSeconds":1}' 30)
OKB=$(echo "$B_" | python3 -c "import json,sys;d=json.load(sys.stdin);print('ok' if d['exitCode']==-1 and 'timed out after 1s' in d['stderr'] else 'bad '+json.dumps(d))" 2>/dev/null)
C_=$(EX "" '{"command":"echo zero-ok","timeoutSeconds":0}')
OKC=$(echo "$C_" | python3 -c "import json,sys;d=json.load(sys.stdin);print('ok' if d['exitCode']==0 and 'zero-ok' in d['stdout'] else 'bad '+json.dumps(d))" 2>/dev/null)
D_=$(EX "" '{"command":"echo fast && sleep 0.5 && echo done","timeoutSeconds":30}')
OKD=$(echo "$D_" | python3 -c "import json,sys;d=json.load(sys.stdin);print('ok' if d['exitCode']==0 and 'done' in d['stdout'] else 'bad')" 2>/dev/null)
[ "$OKA$OKB$OKC$OKD" = "okokokok" ] && pass "T42.10（a 正常 / b 1s 超时 / c 0 不超时 / d 大超时）" "a=$OKA b=$OKB c=$OKC d=$OKD" || fail "T42.10" "a=$OKA b=$OKB c=$OKC d=$OKD"
fi

if run T19.11; then
echo "===== T19.11 环境信息 ====="
R=$(EX "" '{"command":"echo \"node=$(node -v) pwd=$(pwd)\""}')
OK=$(echo "$R" | python3 -c "
import json,sys
d=json.load(sys.stdin)
s=d.get('stdout','')
print('ok' if 'node=v' in s and '/workspace' in s else 'bad '+json.dumps(d))" 2>/dev/null)
[ "$OK" = "ok" ] && pass "T19.11（node 版本 + pwd）" "$R" || fail "T19.11" "$R"
fi

api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1

[ -n "$ONLY" ] || skip "T19.7-9/12-19/22-24" "v2 无 async exec 体系（/exec/async、/stream、/exec/:execId+kill、exec_log 持久化与历史、detached 修复、signal/oom 解码）、keep-alive 端点（v2 为 idle suspendForIdle 自动管理）、proxy 端点、boot 初始化（pnpm store）"
[ -n "$ONLY" ] || skip "T19.10e" "v2 超时在 handler 内 Effect.timeoutOption 实现，无独立 withExecTimeout 单测面；行为由 T19.10 b/c/d e2e 锁定"

echo ""
echo "===== result: PASS=$PASS FAIL=$FAIL SKIP=$SKIP ====="
exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
