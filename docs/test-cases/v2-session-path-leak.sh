#!/bin/bash
# 路径泄露防护用例（path-leak-test.md PL-1~PL-9）——v2 适配版。
#
# v1→v2 映射：
#   架构差异：v1 需要 toSandboxPath/toHostPath 双向映射层（52 个单测守卫）；
#   v2 的文件操作统一经 Environment 直传沙箱路径（location.directory 即沙箱视角），
#   无映射层——v1 修复的目标形态是 v2 的天然设计。单测部分架构性豁免。
#   POST /session/:id/message（同步）→ POST /api/session/:id/prompt + 轮询
#   POST /session/:id/exec          → shell 工具（经会话沙箱）
#   PATCH /global/config permission → PATCH /api/session/:id permissions
#   bash 工具                       → shell
#   ls 工具                         → read 工具读目录（v2 无独立 ls）
# 泄露模式（v2 容器形态）：/Users/<user>、/private/var/folders、/app（容器安装路径）、
#   host.docker.internal、内网 IP、postgresql:// 连接串。
set -u
BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-v2-test-pass}"
PROVIDER="${PROVIDER:-Yd-DeepSeek}"
MODEL_ID="${MODEL_ID:-deepseek-v4-flash}"
ONLY="${ONLY:-}"
run() { [ -z "$ONLY" ] && return 0; printf " %s " "$ONLY" | grep -q " $1 " ; }

PASS=0; FAIL=0; SKIP=0
pass() { echo "✅ $1 PASS ${2:-}"; PASS=$((PASS+1)); }
fail() { echo "❌ $1 FAIL: ${2:-}"; FAIL=$((FAIL+1)); }
skip() { echo "➖ $1 SKIP ${2:-}"; SKIP=$((SKIP+1)); }

api() { curl -s -m 200 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }

# ---- 泄露扫描（python） ----
scan_msgs() {  # $1=输出文件 读取 GET /message 的 json
  python3 - "$1" <<'PYEOF'
import json, sys, re
msgs = json.load(open(sys.argv[1])).get('data', [])
msgs.sort(key=lambda m: m.get('time', {}).get('created', 0))
PATTERNS = [
    (r'/Users/[a-z]+/', 'macOS用户路径'),
    (r'/private/var/folders', 'macOS tmp symlink'),
    (r'/app/packages|/app/node_modules|/app/bun', '容器安装路径 /app'),
    (r'host\.docker\.internal', 'Docker host.docker.internal'),
    (r'172\.\d+\.\d+\.\d+', '内网IP 172.x'),
    (r'postgresql://', 'PG连接串'),
]
tools = []      # (name, status, input_str, output_str)
texts = []
for m in msgs:
    for p in m.get('content', []):
        if p.get('type') == 'tool':
            st = p.get('state', {})
            tools.append((p.get('name'), st.get('status'),
                          json.dumps(st.get('input') or {}, ensure_ascii=False),
                          json.dumps(st.get('content') or [], ensure_ascii=False)))
        elif p.get('type') == 'text' and p.get('text', '').strip():
            texts.append(p['text'])
leaks = []
def scan(text, src):
    for pat, name in PATTERNS:
        for mo in re.finditer(pat, text):
            leaks.append(f'{name} @ {src}: ...{text[max(0,mo.start()-30):mo.end()+30]}...')
for (nm, st, inp, out) in tools:
    scan(inp, f'tool-input/{nm}')
    scan(out, f'tool-output/{nm}')
    meta = json.dumps([t for t in tools], ensure_ascii=False)
for t in texts:
    scan(t, 'text')
print(json.dumps({
    'leaks': leaks,
    'tools': [{'name': n, 'status': s, 'input': i, 'output': o} for (n, s, i, o) in tools],
    'texts': texts,
}, ensure_ascii=False))
PYEOF
}

wait_turn() {  # $1=sessionID：轮询直到出现新的 assistant 文本（简单以消息数稳定判断）
  local before="${1:-0}"
  for _ in $(seq 1 "${2:-45}"); do
    N=$(api "$BASE/api/session/$S/message" | python3 -c "
import json,sys
d=json.load(sys.stdin).get('data',[])
a=[m for m in d if m.get('type')=='assistant' and any(p.get('type')=='text' and p.get('text','').strip() for p in m.get('content',[]))]
print(len(a))" 2>/dev/null)
    [ "${N:-0}" -gt "$before" ] && { echo "$N"; return 0; }
    sleep 2
  done
  echo "${N:-0}"
}

echo "===== 建会话 + 权限 ====="
S=$(api -X POST "$BASE/api/session" -d "{\"title\":\"pl\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL_ID\"}}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null)
api -X PATCH "$BASE/api/session/$S" -d '{"permissions":[{"action":"shell","resource":"*","effect":"allow"},{"action":"edit","resource":"*","effect":"allow"},{"action":"read","resource":"*","effect":"allow"},{"action":"external_directory","resource":"/workspace/*","effect":"allow"}]}' >/dev/null
echo "S=$S"

echo "===== Step A: shell 初始化项目（git init + 示例文件）====="
api -X POST "$BASE/api/session/$S/prompt" -d '{"text":"用 shell 工具执行（注意给引号内的括号加双引号转义）: mkdir -p /workspace/test-project && cd /workspace/test-project && git init -q && echo \"console.log(1)\" > index.js && echo \"# Test\" > README.md && mkdir -p src && echo \"export const foo = 1\" > src/mod.ts && ls /workspace/test-project && pwd。完成后只回复OK"}' >/dev/null
NA=$(wait_turn 0 45)

echo "===== Step B: read / glob / grep / list ====="
api -X POST "$BASE/api/session/$S/prompt" -d '{"text":"依次执行并把每个工具输出里的路径值原样告诉我：1) 用 read 工具读 /workspace/test-project/README.md；2) 用 glob 工具在 /workspace/test-project 搜索 **/*.ts；3) 用 grep 工具在 /workspace/test-project 搜索关键词 console；4) 用 read 工具列出 /workspace/test-project 目录内容。"}' >/dev/null
NB=$(wait_turn "$NA" 45)

echo "===== Step C: write / edit ====="
api -X POST "$BASE/api/session/$S/prompt" -d '{"text":"依次执行：1) 用 write 工具在 /workspace/test-project/src/utils.ts 写入 export function add(a: number, b: number) { return a + b }；2) 用 edit 工具把 /workspace/test-project/README.md 里的 Test 替换为 My Project。完成后只回复OK"}' >/dev/null
NC=$(wait_turn "$NB" 45)

echo "===== Step D: shell git 操作 ====="
api -X POST "$BASE/api/session/$S/prompt" -d '{"text":"用 shell 工具在 /workspace/test-project 执行: cd /workspace/test-project && git config user.email test@opencode.dev && git config user.name Test && git add -A && git commit -q -m \"feat: add utils\" && git log --oneline -2 && git status。把输出原样告诉我。"}' >/dev/null
ND=$(wait_turn "$NC" 45)

echo "===== Step E: AI 报告 <env> ====="
api -X POST "$BASE/api/session/$S/prompt" -d '{"text":"查看你的系统提示中 <env> 块，把 Working directory 和 Workspace root folder 的值一字不差地告诉我。"}' >/dev/null
NE=$(wait_turn "$ND" 45)

echo "===== 汇总扫描 ====="
api "$BASE/api/session/$S/message" > /tmp/pl-msgs.json
scan_msgs /tmp/pl-msgs.json > /tmp/pl-scan.json

if run PL-1; then
R=$(python3 -c "
import json
d=json.load(open('/tmp/pl-scan.json'))
t=[x for x in d['tools'] if x['name']=='read' and '\"path\": \"/workspace/test-project/README.md\"' in x['input'] and x['status']=='completed']
print('ok' if t else 'missing')")
[ "$R" = "ok" ] && pass "PL-1（read 路径 /workspace/...）" || fail "PL-1" "$R"
fi
if run PL-2; then
R=$(python3 -c "
import json
d=json.load(open('/tmp/pl-scan.json'))
t=[x for x in d['tools'] if x['name']=='glob' and x['status']=='completed' and '/workspace/test-project' in x['output']]
print('ok' if t else 'missing')")
[ "$R" = "ok" ] && pass "PL-2（glob 输出 /workspace/...）" || fail "PL-2" "$R"
fi
if run PL-3; then
R=$(python3 -c "
import json
d=json.load(open('/tmp/pl-scan.json'))
t=[x for x in d['tools'] if x['name']=='grep' and x['status']=='completed' and '/workspace/test-project' in x['output']]
print('ok' if t else 'missing')")
[ "$R" = "ok" ] && pass "PL-3（grep 输出 /workspace/...）" || fail "PL-3" "$R"
fi
if run PL-4; then
R=$(python3 -c "
import json
d=json.load(open('/tmp/pl-scan.json'))
t=[x for x in d['tools'] if x['name']=='read' and '\"path\": \"/workspace/test-project\"' in x['input'] and x['status']=='completed' and ('mod.ts' in x['output'] or 'README' in x['output'])]
print('ok' if t else 'missing')")
[ "$R" = "ok" ] && pass "PL-4（read 目录列表 /workspace/...）" || fail "PL-4" "$R"
fi
if run PL-5; then
R=$(python3 -c "
import json
d=json.load(open('/tmp/pl-scan.json'))
t=[x for x in d['tools'] if x['name']=='write' and '/workspace/test-project/src/utils.ts' in x['input'] and x['status']=='completed']
print('ok' if t else 'missing')")
[ "$R" = "ok" ] && pass "PL-5（write 路径 /workspace/...）" || fail "PL-5" "$R"
fi
if run PL-6; then
R=$(python3 -c "
import json
d=json.load(open('/tmp/pl-scan.json'))
t=[x for x in d['tools'] if x['name']=='edit' and '/workspace/test-project/README.md' in x['input'] and x['status']=='completed']
print('ok' if t else 'missing')")
[ "$R" = "ok" ] && pass "PL-6（edit 路径 /workspace/...）" || fail "PL-6" "$R"
fi
if run PL-7; then
R=$(python3 -c "
import json
d=json.load(open('/tmp/pl-scan.json'))
t=[x for x in d['tools'] if x['name']=='shell' and x['status']=='completed' and 'pwd' in x['input']]
ok = t and any('/workspace' in x['output'] for x in t)
print('ok' if ok else 'missing')")
[ "$R" = "ok" ] && pass "PL-7（shell 输出 pwd=/workspace/...）" || fail "PL-7" "$R"
fi
if run PL-8; then
R=$(python3 -c "
import json
d=json.load(open('/tmp/pl-scan.json'))
t=[x for x in d['tools'] if x['name']=='shell' and 'git commit' in x['input'] and x['status']=='completed']
print('ok' if t else 'missing')")
[ "$R" = "ok" ] && pass "PL-8（git 操作输出无宿主路径）" || fail "PL-8" "$R"
fi
if run PL-9; then
R=$(python3 -c "
import json
d=json.load(open('/tmp/pl-scan.json'))
env=[t for t in d['texts'] if 'Working directory' in t]
ok = env and any('/workspace' in t for t in env)
print('ok' if ok else f'missing texts={len(env)}')")
[ "$R" = "ok" ] && pass "PL-9（<env> Working directory = /workspace）" "" || fail "PL-9" "$R"
fi
if run PL-ALL; then
R=$(python3 -c "
import json
d=json.load(open('/tmp/pl-scan.json'))
print('ok' if not d['leaks'] else json.dumps(d['leaks'], ensure_ascii=False))")
[ "$R" = "ok" ] && pass "PL-ALL（全量扫描 0 泄露：text/tool input/output）" "" || fail "PL-ALL" "$R"
fi

api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
[ -n "$ONLY" ] || skip "PL-WF" "WF 真实 GitLab 流程：token 已失效（Access denied，网络可达）；其差异点（真实仓库+AI 自主工具组合）路径面与 PL 系列一致，由 PL-1~PL-9+PL-ALL 覆盖"
[ -n "$ONLY" ] || skip "PL-U" "v1 双向映射层单测（52 个）：v2 无 toSandboxPath/toHostPath 层，文件操作直传沙箱路径，由 PL-1~PL-9 e2e 实测覆盖"

echo ""
echo "===== 结果: PASS=$PASS FAIL=$FAIL SKIP=$SKIP ====="
exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
