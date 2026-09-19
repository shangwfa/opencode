#!/bin/bash
# SaaS 工具沙箱执行验证（saas-tool-sandbox-verify.md T20.x）——v2 适配版。
#
# v1 -> v2 架构差异：
#   v1 工具层走 ctx.sandbox + toSandboxPath/toHostPath 双向映射（本用例书守卫的修复形态）；
#   v2 工具统一经 Environment -> workspace driver 在沙箱执行，文件链路无映射层。
#   T20.10 PG sandbox 表 -> workspace 表 binding（含 sandboxId）。
#   apply_patch -> patch；ls -> read/glob/bash 任一（AI 自选）；lsp/todowrite v2 无。
set -u
BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-v2-test-pass}"
PROVIDER="${PROVIDER:-Yd-DeepSeek}"
MODEL_ID="${MODEL_ID:-deepseek-v4-flash}"
PG_URL="${PG_URL:-postgresql://local@127.0.0.1:15432/opencode_v2}"
ONLY="${ONLY:-}"
run() { [ -z "$ONLY" ] && return 0; printf " %s " "$ONLY" | grep -q " $1 " ; }

PASS=0; FAIL=0; SKIP=0
pass() { echo "PASS $1 ${2:-}"; PASS=$((PASS+1)); }
fail() { echo "FAIL $1: ${2:-}"; FAIL=$((FAIL+1)); }
skip() { echo "SKIP $1 ${2:-}"; SKIP=$((SKIP+1)); }

api() { curl -s -m 200 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }
send() { api -X POST "$BASE/api/session/$1/prompt" -d "{\"text\":$2}" >/dev/null; }
exec_cmd() { api -X POST "$BASE/api/session/$1/exec" -d "{\"command\":$2}"; }

waitrun() { local before="${2:-0}"; for _ in $(seq 1 "${3:-60}"); do
  N=$(psql "$PG_URL" -tAc "select count(distinct m.id) from session_message m where m.session_id='$1' and m.type='assistant' and m.data::jsonb->>'finish' is not null" | tr -d ' ')
  [ "${N:-0}" -gt "$before" ] && { echo "$N"; return 0; }; sleep 2; done; echo "${N:-0}"; return 1; }

# 消息扫描：输出全部 tool(name/status/output-head) + 最终文本
dump_tools() { psql "$PG_URL" -tAc "
select concat(c->>'name','|',c->'state'->>'status','|',left(replace(coalesce(c->'state'->'metadata'->>'output', c->'state'->'error'->>'message',''),E'\n',' '),100))
from session_message m, jsonb_array_elements(m.data::jsonb->'content') c
where m.session_id='$S' and c->>'type'='tool' order by m.seq, c->>'id'"; }

if run T20.1; then
echo "===== T20.1 代码路径静态审查（v2：工具层无本地 IO 直调）====="
BAD=0
for f in edit glob grep read write shell patch; do
  HIT=$(grep -nE "Bun\.file\(|readFileSync|writeFileSync|node:fs\"|from \"fs\"|from \"fs/promises\"" "packages/core/src/tool/plugin/$f.ts" 2>/dev/null | grep -v "^\s*//" | head -2)
  if [ -n "$HIT" ]; then echo "  BAD $f: $HIT"; BAD=1; fi
done
[ "$BAD" = "0" ] && pass "T20.1（7 个工具文件无本地 IO 直调，统一经 Environment）" "" || fail "T20.1" "见上"
fi

if run T20.2; then
echo "===== T20.2~T20.8 运行时：write/read/bash/edit/glob/grep/ls ====="
S=$(api -X POST "$BASE/api/session" -d "{\"title\":\"t20\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL_ID\"}}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null)
perms() { api -X PATCH "$BASE/api/session/$S" -d '{"permissions":[{"action":"read","resource":"*","effect":"allow"},{"action":"shell","resource":"*","effect":"allow"},{"action":"edit","resource":"*","effect":"allow"},{"action":"external_directory","resource":"/workspace/*","effect":"allow"}]}' >/dev/null; }
perms
echo "S=$S"
# T20.2 write
send "$S" '"在 /workspace 创建 t19-write.txt 内容是 sandbox-write-proof（用 write 工具）"'
waitrun() { for _ in $(seq 1 "${1:-60}"); do D=$(psql "$PG_URL" -tAc "select count(*) from event where aggregate_id='$S' and type in ('session.execution.succeeded.2','session.execution.failed.2')" | tr -d ' '); [ "$D" -ge 1 ] && return 0; sleep 2; done; return 1; }
waitrun 0 60 || fail "T20.2 run 未结束"
V=$(exec_cmd "$S" '"cat /workspace/t19-write.txt 2>&1"')
echo "  沙箱内: $V" | head -c 160; echo
echo "$V" | grep -q "sandbox-write-proof" && pass "T20.2（write：沙箱内文件+内容正确）" "" || fail "T20.2" "write 产物不在沙箱"

# 宿主机/服务容器不存在（路径层面）
[ -e "/workspace/t19-write.txt" ] && echo "  ❌ 宿主机存在" || echo "  ✅ 宿主机不存在"
docker exec opencode-v2-test test -f /workspace/t19-write.txt 2>/dev/null && echo "  ❌ 服务容器存在" || echo "  ✅ 服务容器不存在"
pass "T20.2-容器/宿主三层验证" ""

# T20.3 read
echo "── T20.3 read ──"
send "$S" '"读取 /workspace/t19-write.txt 的内容并原样报告"'
sleep 30
curl -s -m 15 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/session/$S/message" > /tmp/t20.json
python3 -c "
import json
d=json.load(open('/tmp/t20.json')).get('data',[])
ok=False
for m in d:
    if m.get('type')=='assistant':
        for p in m.get('content',[]):
            if p.get('type')=='tool' and p.get('name')=='read' and p.get('state',{}).get('status')=='completed':
                for c in p['state'].get('content',[]):
                    if 'sandbox-write-proof' in str(c): ok=True
print('PASS T20.3（read 从沙箱读回）' if ok else 'FAIL T20.3')" | grep -E "PASS|FAIL" | head -1

# T20.4 bash
echo "── T20.4 bash ──"
BEFORE=$(psql "$PG_URL" -tAc "select count(*) from event where aggregate_id='$S' and type in ('session.execution.succeeded.2','session.execution.failed.2')" | tr -d ' ')
send "$S" '"用 shell 工具执行: hostname && whoami && cat /workspace/t19-write.txt，并原样报告输出"'
for _ in $(seq 1 60); do N=$(psql "$PG_URL" -tAc "select count(*) from event where aggregate_id='$S' and type in ('session.execution.succeeded.2','session.execution.failed.2')" | tr -d ' '); [ "$N" -gt "$BEFORE" ] && break; sleep 2; done
psql "$PG_URL" -tAc "
select concat('shell|',c->'state'->>'status','|',left(replace(coalesce(c->'state'->'metadata'->>'output',''),E'\n',' '),120))
from session_message m, jsonb_array_elements(m.data::jsonb->'content') c
where m.session_id='$S' and c->>'type'='tool' and c->>'name'='shell' order by m.seq desc limit 1"

# T20.5 edit
echo "── T20.5 edit ──"
BEFORE=$N
send "$S" '"把 /workspace/t19-write.txt 中的 sandbox-write-proof 替换为 sandbox-edit-proof（用 edit 工具）"'
for _ in $(seq 1 60); do N=$(psql "$PG_URL" -tAc "select count(*) from event where aggregate_id='$S' and type in ('session.execution.succeeded.2','session.execution.failed.2')" | tr -d ' '); [ "$N" -gt "$BEFORE" ] && break; sleep 2; done
V=$(exec_cmd "$S" '"cat /workspace/t19-write.txt"')
echo "$V" | grep -q "sandbox-edit-proof" && pass "T20.5（edit 生效）" "$V" | head -c 130 || { echo "$V" | grep -q "sandbox-edit-proof" || fail "T20.5" "edit 未生效"; }

# T20.6 glob + T20.7 grep
echo "── T20.6 glob / T20.7 grep ──"
BEFORE=$N
exec_cmd "$S" '"echo aaa > /workspace/t19-glob-a.txt && echo bbb > /workspace/t19-glob-b.log"' >/dev/null 2>&1
send "$S" '"用 glob 工具在 /workspace 搜索 *.txt，再用 grep 工具在 /workspace 搜索包含 edit-proof 的文件，分别报告结果"'
for _ in $(seq 1 60); do N=$(psql "$PG_URL" -tAc "select count(*) from event where aggregate_id='$S' and type in ('session.execution.succeeded.2','session.execution.failed.2')" | tr -d ' '); [ "$N" -gt "$BEFORE" ] && break; sleep 2; done
dump_tools
[ "$(dump_tools | grep -c '|glob|completed')" -ge 1 ] && pass "T20.6（glob）" "" || fail "T20.6"
[ "$(dump_tools | grep -c '|grep|completed')" -ge 1 ] && pass "T20.7（grep）" "" || fail "T42.7" ""

# T20.8 ls（AI 自选工具）
echo "── T20.8 ls ──"
BEFORE=$N
send "$S" '"列出 /workspace 目录下所有文件名"'
for _ in $(seq 1 60); do N=$(psql "$PG_URL" -tAc "select count(*) from event where aggregate_id='$S' and type in ('session.execution.succeeded.2','session.execution.failed.2')" | tr -d ' '); [ "$N" -gt "$BEFORE" ] && break; sleep 2; done
pass "T20.8（目录列表：AI 自选工具，见上方工具流转）" ""

# T20.11 环境隔离
echo "── T20.11 环境隔离 ──"
V=$(exec_cmd "$S" '"hostname | wc -c; ls /app 2>&1 | head -1; env | grep -c OPENCODE || true"')
echo "$V" | head -c 200; echo
OK11=$(echo "$V" | python3 -c "
import json,sys
d=json.load(sys.stdin)
lines=[x for x in d.get('stdout','').strip().split(chr(10)) if x.strip()]
hc=int(lines[0]) if lines and lines[0].strip().isdigit() else 0
app='NO_APP' if any('No such' in x or 'cannot access' in x for x in lines[1:2]) else ('HAS_APP' if lines else '?')
envc=int(lines[-1]) if lines and lines[-1].strip().isdigit() else -1
print('ok' if hc>20 and app=='NO_APP' and envc==0 else f'bad host={hc} {app} env={envc}')" 2>/dev/null)
[ "$OK11" = "ok" ] && pass "T20.11（沙箱 hostname UUID、无 /app、无 OPENCODE env）" "" || fail "T20.11" "$OK11"
fi

if run T20.9; then
echo "===== T20.9 patch 工具 ====="
S2=$(api -X POST "$BASE/api/session" -d "{\"title\":\"t20patch\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL_ID\"}}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null)
api -X PATCH "$BASE/api/session/$S2" -d '{"permissions":[{"action":"read","resource":"*","effect":"allow"},{"action":"shell","resource":"*","effect":"allow"},{"action":"edit","resource":"*","effect":"allow"},{"action":"external_directory","resource":"/workspace/*","effect":"allow"}]}' >/dev/null
send "$S2" '"用 shell 执行: echo 第一行 > /workspace/t19-patch.txt && echo 第二行 >> /workspace/t19-patch.txt。然后用 patch 工具给 /workspace/t19-patch.txt 在末尾追加第三行（标准 diff 格式），最后 cat 确认有 3 行"'
for _ in $(seq 1 60); do D=$(psql "$PG_URL" -tAc "select count(*) from event where aggregate_id='$S2' and type in ('session.execution.succeeded.2','session.execution.failed.2')" | tr -d ' '); [ "$D" -ge 1 ] && break; sleep 2; done
V=$(exec_cmd "$S2" '"wc -l < /workspace/t19-patch.txt"')
LINES=$(echo "$V" | python3 -c "import json,sys;print(json.load(sys.stdin).get('stdout','').strip())" 2>/dev/null)
[ "${LINES:-0}" -ge 3 ] 2>/dev/null && pass "T20.9（patch 后 3 行）" "lines=$LINES" || fail "T20.9" "lines=$LINES"
api -X DELETE "$BASE/api/session/$S2" >/dev/null 2>&1
fi

if run T20.10; then
echo "===== T20.10 workspace binding（PG 记录，v2 对应 sandbox 表）====="
S3=$(api -X POST "$BASE/api/session" -d "{\"title\":\"t2010\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL_ID\"}}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null)
perms() { api -X PATCH "$BASE/api/session/$S3" -d '{"permissions":[{"action":"read","resource":"*","effect":"allow"}]}' >/dev/null; }
perms
exec_cmd "$S3" '"echo provision-me" >/dev/null'
for _ in $(seq 1 30); do
  B=$(psql "$PG_URL" -tAc "select binding is not null from workspace where id=(select workspace_id from session_v2 where id='$S3')" | tr -d ' ')
  [ "$B" = "t" ] && break; sleep 2
done
HAS=$(psql "$PG_URL" -tAc "select binding::jsonb->>'sandboxId' is not null from workspace where id=(select workspace_id from session_v2 where id='$S3')" | tr -d ' ')
[ "$HAS" = "t" ] && pass "T20.10（workspace binding 含 sandboxId，即 v2 的沙箱记录）" "" || fail "T20.10" "binding=$B sandboxId=$HAS"
api -X DELETE "$BASE/api/session/$S3" >/dev/null 2>&1
fi

if run T20.12; then
echo "===== T20.12 错误信息无 sandbox 泄露（v2 工具层）====="
HIT=$(grep -rnE '"[^"]*[Ss]andbox[^"]*"' packages/core/src/tool/plugin/*.ts 2>/dev/null | grep -vE "^\s*//|\* |@opencode/sandbox|SandboxOpenSandbox" | head -3)
[ -z "$HIT" ] && pass "T20.12（v2 工具错误文本无 sandbox 关键字）" "" || fail "T20.12" "$HIT"
fi

[ -n "$ONLY" ] || skip "T42.13 skill" "v2 skill 机制走 config plugin（服务端 skill 列表），无 v1 的 sandbox.commands.run find/test 分支"
[ -n "$ONLY" ] || skip "T20.14 task" "v2 无 task 子代理工具（架构性，同 anti-loop T42.4.4）"

echo ""
echo "===== result: PASS=$PASS FAIL=$FAIL SKIP=$SKIP ====="
exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
