#!/bin/bash
# Back-end Java（back-end-java.md T42.x）—— v2 适配版。
#
# v1 -> v2 映射：
#   POST /session {sandbox:{image,cpu,memory}} -> v2 沙箱为 workspace 级资源：
#       镜像由 WorkspaceDriver 配置（OPENCODE_SANDBOX_IMAGE），无 per-session 镜像面
#   POST /session/:id/keep-alive {boot} -> POST /api/session/:id/keep-alive（本轮新增，
#       boot=true 立即 provision；keepAlive=true 阻止 idle suspend）
#   POST /session/:id/exec -> POST /api/session/:sessionID/exec（v1 parity，沙箱内执行）
#   POST /session/:id/proxy/:port -> v2 无 proxy 端点
#   PG sandbox 表 -> workspace 表 binding（沙箱引用）
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

api() { curl -s -m 200 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }
exec_cmd() { api -X POST "$BASE/api/session/$1/exec" -d "{\"command\":$2}"; }

if run T42.1; then
skip "T42.1" "per-session sandbox image 无协议面：v2 沙箱为 workspace 级资源，镜像由驱动配置（OPENCODE_SANDBOX_IMAGE），非 session 级"
fi

if run T42.2; then
echo "===== T42.2 keep-alive boot：立即 provision ====="
S=$(api -X POST "$BASE/api/session" -d "{\"title\":\"ka-boot\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL_ID\"}}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null)
R=$(api -X POST "$BASE/api/session/$S/keep-alive" -d '{"enabled":true,"boot":true}')
W=$(echo "$R" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('keepAlive'), bool(d.get('workspaceID')))" 2>/dev/null)
echo "  keep-alive boot: $R"
if [ "$W" = "True True" ]; then pass "T42.2（boot=true 返回 keepAlive=true + workspaceID，沙箱已 provision）" "$R"; else fail "T42.2" "$R"; fi
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run T42.EXEC; then
echo "===== T42.EXEC exec 端点：provision / 复用 / kill-sandbox / 再 provision ====="
S=$(api -X POST "$BASE/api/session" -d "{\"title\":\"java-exec\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL_ID\"}}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null)
R1=$(exec_cmd "$S" '"echo exec-ok && pwd"')
OK1=$(echo "$R1" | python3 -c "import json,sys;d=json.load(sys.stdin);print('ok' if d['exitCode']==0 and 'exec-ok' in d['stdout'] and '/workspace' in d['stdout'] else 'bad '+json.dumps(d))" 2>/dev/null)
R2=$(exec_cmd "$S" '"whoami"')
OK2=$(echo "$R2" | python3 -c "import json,sys;d=json.load(sys.stdin);print('ok' if d['exitCode']==0 and d['stdout'].strip() else 'bad')" 2>/dev/null)
K=$(api -X POST "$BASE/api/session/$S/kill-sandbox" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('destroyed'), d.get('workspaceID','')[:4])" 2>/dev/null)
R3=$(exec_cmd "$S" '"echo re-provisioned"')
OK3=$(echo "$R3" | python3 -c "import json,sys;d=json.load(sys.stdin);print('ok' if d['exitCode']==0 and 're-provisioned' in d['stdout'] else 'bad')" 2>/dev/null)
if [ "$OK1$OK2$OK3" = "okokok" ]; then
  pass "T42.EXEC（exec 首次 provision + 复用 + kill-sandbox=$K + 再 provision）" ""
else
  fail "T42.EXEC" "first=$OK1 reuse=$OK2 kill=$K reprovision=$OK3"
fi
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run T42.3; then
skip "T42.3" "Java 镜像 session-terminal 在本地环境不可用（本地无镜像，阿里云私有仓库无凭据）；opensandbox 默认镜像无 JDK"
fi

if run T42.4; then
skip "T42.4" "依赖 Java 沙箱（T42.3 前置）"
fi

if run T42.5; then
skip "T42.5" "依赖 Java 沙箱（T42.3 前置）"
fi

if run T42.6; then
skip "T42.6" "v2 无 /session/:id/proxy/:port 端点（沙箱 HTTP 服务的对外转发通道未实现）"
fi

if run T42.7; then
skip "T42.7" "proxy body 转发回归依赖 proxy 端点（见 T42.6）；v1 修复（arrayBuffer 缓冲）不适用于 v2"
fi

echo ""
echo "===== result: PASS=$PASS FAIL=$FAIL SKIP=$SKIP ====="
exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
