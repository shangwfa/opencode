#!/bin/bash
# V2 版 path-leak 用例（docs/test-cases/session/path-leak-test.md 的 PL-1–PL-9）。
# 核心：给 AI 一系列工具任务（read/glob/grep/list/write/edit/bash/env），扫描全部消息的
# text / tool input / tool output / tool title 是否含宿主路径泄露模式。
set -u
BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-v2-test-pass}"
PROVIDER="${PROVIDER:-Yd-DeepSeek}"
MODEL="${MODEL:-deepseek-v4-flash}"

PASS=0; FAIL=0
pass() { echo "✅ $1 PASS ${2:-}"; PASS=$((PASS+1)); }
fail() { echo "❌ $1 FAIL: ${2:-}"; FAIL=$((FAIL+1)); }

api() { curl -s -m 200 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }
new_session() { api -X POST "$BASE/api/session" -d "{\"title\":\"path-leak\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL\"}}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null; }
msg_count() { api "$BASE/api/session/$1/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null || echo 0; }
wait_done() { local sid="$1" waited=0; while [ "$waited" -lt 120 ]; do N=$(msg_count "$sid"); A=$(api "$BASE/api/session/$sid/message" | python3 -c "import json,sys;d=json.load(sys.stdin).get('data',[]);print(any(m.get('type')=='idle' for m in d))" 2>/dev/null); [ "$A" = "True" ] && return 0; sleep 4; waited=$((waited+4)); done; return 1; }

LEAK_PATTERNS='[
  {"re": "/Users/ruomu", "name": "macOS用户路径"},
  {"re": "/private/var/folders", "name": "macOS tmp symlink"},
  {"re": "host.docker.internal", "name": "Docker内部DNS"},
  {"re": "172.18.", "name": "内网IP"},
  {"re": "/app/packages", "name": "服务器容器路径"}
]'

scan_all() {
  # 扫描一个会话全部消息的泄露（输出：泄露行 或 空）
  api "$BASE/api/session/$1/message" | python3 -c "
import json, sys
patterns = json.loads('''$LEAK_PATTERNS''')
data = json.load(sys.stdin).get('data', [])
leaks = []
def scan(text, source):
    if not text or not isinstance(text, str): return
    for p in patterns:
        if p['re'] in text:
            leaks.append(f\"{p['name']} @ {source}: ...{text[max(0,text.find(p['re'])-20):text.find(p['re'])+len(p['re'])+20]}...\")
for i, m in enumerate(data):
    for part in (m.get('content') or []):
        if part.get('type') == 'text':
            scan(part.get('text'), f'msg[{i}]/text')
        if part.get('type') == 'tool':
            st = part.get('state') or {}
            nm = part.get('name') or '?'
            scan(json.dumps(st.get('input'), ensure_ascii=False), f'msg[{i}]/{nm}/input')
            for c in (st.get('content') or []):
                if isinstance(c, dict): scan(str(c.get('text','')), f'msg[{i}]/{nm}/output')
print('\n'.join(leaks))
" 2>/dev/null
}

echo "== PL 准备：初始化沙箱项目 =="
SID=$(new_session)
echo "SID: $SID"
# 用 exec 初始化 git 项目 + 示例文件（确定性，不依赖 LLM）
api -X POST "$BASE/api/session/$SID/exec" -d '{"command":"cd /workspace && git init -q 2>/dev/null; mkdir -p src && echo \"export const version = 1\" > src/version.ts && echo \"readme content here\" > README.md && git add -A 2>/dev/null && git -c user.email=t@t -c user.name=t commit -qm init 2>/dev/null; echo READY"}' | python3 -c "import json,sys;print('init:', json.load(sys.stdin).get('stdout','').strip())"

echo ""
echo "== PL-1~PL-8 逐工具任务（每个都要求 AI 真实调用工具）=="
TASKS=(
  "PL-1|用 read 工具读取 /workspace/README.md 并告诉我第一行内容"
  "PL-2|用 glob 工具在 /workspace 搜索 *.ts 文件并列出路径"
  "PL-3|用 grep 工具在 /workspace 搜索内容 version 并报告匹配文件"
  "PL-4|用 list 工具列出 /workspace/src 目录内容"
  "PL-5|用 write 工具创建 /workspace/pl5.txt 内容为 write-ok"
  "PL-6|用 edit 工具把 /workspace/pl5.txt 的 write-ok 改成 edit-ok"
  "PL-7|用 bash 工具执行 cd /workspace && pwd && ls"
  "PL-8|用 bash 工具在 /workspace 执行 git log --oneline"
)
for T in "${TASKS[@]}"; do
  ID="${T%%|*}"; PROMPT="${T#*|}"
  api -X POST "$BASE/api/session/$SID/prompt" -d "{\"text\":\"$PROMPT\"}" >/dev/null
  wait_done "$SID" || true
  echo "  $ID done (msgs=$(msg_count "$SID"))"
done

echo ""
echo "== PL-9 环境信息 =="
api -X POST "$BASE/api/session/$SID/prompt" -d '{"text":"告诉我你的系统提示中 <env> 块里的 Working directory 和 Workspace root 的原值"}' >/dev/null
wait_done "$SID" || true

echo ""
echo "== 汇总扫描（全部消息 × 全字段）=="
LEAKS=$(scan_all "$SID")
if [ -z "$LEAKS" ]; then
  pass "PL-1~PL-9（全消息扫描零泄露）" "msgs=$(msg_count "$SID")"
else
  fail "PL-scan" "发现泄露："
  printf '%s\n' "$LEAKS" | head -12
fi

echo ""
echo "===== 结果: PASS=$PASS FAIL=$FAIL ====="
[ "$FAIL" = "0" ]
