#!/bin/bash
# 会话级权限配置用例（session-permission.md T4.1-T4.11 + T5.1-T5.10）——v2 适配版。
#
# 字段映射（v1 -> v2）：permission->action、pattern->resource、action->effect；
# bash 工具在 v2 的 action 名为 shell；其余（external_directory/read/*）同名。
# 语义对齐：PATCH permissions 为合并追加（findLast 后配覆盖）；评估默认 ask。
set -u
BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-v2-test-pass}"
PROVIDER="${PROVIDER:-Yd-DeepSeek}"
MODEL="${MODEL:-deepseek-v4-flash}"
PG_URL="${PG_URL:-postgresql://local@127.0.0.1:15432/opencode_v2}"

PASS=0; FAIL=0; SKIP=0
pass() { echo "✅ $1 PASS ${2:-}"; PASS=$((PASS+1)); }
fail() { echo "❌ $1 FAIL: ${2:-}"; FAIL=$((FAIL+1)); }
skip() { echo "➖ $1 SKIP: ${2:-}"; SKIP=$((SKIP+1)); }

api() { curl -s -m 200 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }
code() { curl -s -o /tmp/perm-body.json -w "%{http_code}" -m 60 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }
new_session() { api -X POST "$BASE/api/session" -d "{\"title\":\"perm-cfg\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL\"}}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null; }
pgperm() { psql "$PG_URL" -tAc "SELECT coalesce(permission::text,'NULL') FROM session_v2 WHERE id='$1'" | tr -d ' '; }
pgcount() { psql "$PG_URL" -tAc "SELECT json_array_length(permission::json) FROM session_v2 WHERE id='$1'" | tr -d ' '; }
# 工具行为：发 prompt，返回最后一条 shell/read 工具的 state status + 关键输出
tool_outcome() { # sid -> "status|snippet"
  api "$BASE/api/session/$1/message" | python3 -c "
import json,sys
res=''
for m in json.load(sys.stdin).get('data',[]):
    for p in (m.get('content') or []):
        if p.get('type')=='tool' and p.get('name') in ('shell','read','write'):
            st=p.get('state') or {}
            err=(st.get('error') or {}).get('message','')
            c=st.get('content')
            out=' '.join(x.get('text','') for x in c if isinstance(x,dict)) if isinstance(c,list) else str(c or '')
            res=st.get('status','')+'|'+(err or out)[:80]
print(res)" 2>/dev/null | tail -1
}
exec_cmd() { api -X POST "$BASE/api/session/$1/exec" -d "{\"command\":\"$2\"}" > /dev/null 2>&1; }
wait_run() { # 等 run 收尾（出现 idle）
  local sid="$1" waited=0
  while [ "$waited" -lt 180 ]; do
    A=$(api "$BASE/api/session/$sid/message" | python3 -c "import json,sys;d=json.load(sys.stdin).get('data',[]);print(any(m.get('type')=='idle' for m in d))" 2>/dev/null)
    [ "$A" = "True" ] && return 0
    sleep 4; waited=$((waited+4))
  done
  return 1
}
run_case() { # sid prompt
  api -X POST "$BASE/api/session/$1/prompt" -d "{\"text\":\"$2\"}" > /dev/null
  wait_run "$1"
}
has_pending() { api "$BASE/api/permission/request" | SID="$1" python3 -c "import json,sys,os;d=json.load(sys.stdin).get('data',[]);print(len([x for x in d if x['sessionID']==os.environ['SID']]))" 2>/dev/null; }
cleanup_perm() { # 清掉该会话残留 pending（避免影响后续）
  api "$BASE/api/permission/request" | SID="$1" python3 -c "
import json,sys,os
for x in json.load(sys.stdin).get('data',[]):
    if x['sessionID']==os.environ['SID']: print(x['id'])" 2>/dev/null | while read -r PID; do
    api -X POST "$BASE/api/session/$1/permission/$PID/reply" -d '{"decision":"reject"}' > /dev/null
  done
}

echo "################ 一、T4 CRUD ################"

echo "--- T4.1 创建空 session ---"
S1=$(new_session)
V1=$(pgperm "$S1")
[ "$V1" = "NULL" ] && pass "T4.1（默认空）" || fail "T4.1" "perm=$V1"

echo "--- T4.2 POST 创建时传 permission ---"
S2=$(api -X POST "$BASE/api/session" -d '{"title":"perm-create","permissions":[{"action":"external_directory","resource":"/data/*","effect":"allow"}],"model":{"providerID":"'$PROVIDER'","id":"'$MODEL'"}}' | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null)
V2=$(pgperm "$S2")
printf '%s' "$V2" | grep -q "external_directory" && printf '%s' "$V2" | grep -q "/data/\*" && printf '%s' "$V2" | grep -q "allow" && pass "T4.2（创建即落规则）" || fail "T4.2" "perm=$V2"

echo "--- T4.3 PATCH 设置（合并后 1 条）---"
api -X PATCH "$BASE/api/session/$S1" -d '{"permissions":[{"action":"external_directory","resource":"/tmp/*","effect":"allow"},{"action":"read","resource":"/etc/*","effect":"deny"}]}' > /dev/null
C3=$(pgcount "$S1")
V3=$(pgperm "$S1")
[ "${C3:-0}" = "2" ] && printf '%s' "$V3" | grep -q "/tmp/\*" && pass "T4.3（PATCH 设置）" "count=$C3" || fail "T4.3" "count=$C3 perm=$V3"

echo "--- T4.4 PATCH 合并追加 ---"
api -X PATCH "$BASE/api/session/$S1" -d '{"permissions":[{"action":"shell","resource":"curl*","effect":"deny"}]}' > /dev/null
C4=$(pgcount "$S1")
[ "${C4:-0}" = "3" ] && pass "T4.4（合并追加 3 条）" || fail "T4.4" "count=$C4"

echo "--- T4.5 GET 返回 permission ---"
N5=$(api "$BASE/api/session/$S1" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('data',{}).get('permissions') or []))" 2>/dev/null)
[ "${N5:-0}" = "3" ] && pass "T4.5（详情返回 3 条）" || fail "T4.5" "count=$N5"

echo "--- T4.6 追加 deny 覆盖旧 allow（findLast）---"
api -X PATCH "$BASE/api/session/$S1" -d '{"permissions":[{"action":"external_directory","resource":"/tmp/*","effect":"deny"}]}' > /dev/null
C6=$(pgcount "$S1")
[ "${C6:-0}" = "4" ] && pass "T4.6（追加至 4 条，findLast 生效）" || fail "T4.6" "count=$C6"

echo "--- T4.7 跨 session 隔离 ---"
SA=$(new_session); SB=$(new_session)
api -X PATCH "$BASE/api/session/$SA" -d '{"permissions":[{"action":"read","resource":"/secret/*","effect":"deny"}]}' > /dev/null
VA=$(pgperm "$SA"); VB=$(pgperm "$SB")
printf '%s' "$VA" | grep -q "secret" && [ "$VB" = "NULL" ] && pass "T4.7（A 有 B 无）" || fail "T4.7" "A=$VA B=$VB"

echo "--- T4.8 非法格式 400 ---"
C8=$(code -X PATCH "$BASE/api/session/$S1" -d '{"permissions":[{"action":"read","resource":"/tmp/*","effect":"invalid_action"}]}')
[ "$C8" = "400" ] && pass "T4.8（非法 effect → 400）" || fail "T4.8" "http=$C8"

echo "--- T4.9 PATCH 不存在 session 404 ---"
C9=$(code -X PATCH "$BASE/api/session/ses_nonexistent123" -d '{"permissions":[{"action":"read","resource":"*","effect":"allow"}]}')
[ "$C9" = "404" ] && pass "T4.9（404）" || fail "T4.9" "http=$C9"

echo "--- T4.10 规则顺序存储（findLast 优先）---"
SP=$(new_session)
api -X PATCH "$BASE/api/session/$SP" -d '{"permissions":[{"action":"external_directory","resource":"/tmp/*","effect":"deny"},{"action":"external_directory","resource":"/tmp/allow-this/*","effect":"allow"}]}' > /dev/null
C10=$(pgcount "$SP")
[ "${C10:-0}" = "2" ] && pass "T4.10（两条均存储）" || fail "T4.10" "count=$C10"

echo "--- T4.11 通配 pattern ---"
SW=$(new_session)
api -X PATCH "$BASE/api/session/$SW" -d '{"permissions":[{"action":"external_directory","resource":"*","effect":"allow"}]}' > /dev/null
V11=$(pgperm "$SW")
printf '%s' "$V11" | grep -q '"\*"' && pass "T4.11（pattern=* 存储）" || fail "T4.11" "perm=$V11"

echo ""
echo "################ 二、T5 工具行为 ################"

echo "--- T5.1 allow /tmp（cat 放行）---"
S51=$(new_session)
api -X PATCH "$BASE/api/session/$S51" -d '{"permissions":[{"action":"external_directory","resource":"/tmp/*","effect":"allow"},{"action":"read","resource":"/tmp/*","effect":"allow"}]}' > /dev/null
exec_cmd "$S51" "echo t51-ok > /tmp/perm-t51.txt"
run_case "$S51" "必须使用 read 工具读取文件 /tmp/perm-t51.txt 的内容，禁止直接回答"
O51=$(tool_outcome "$S51")
if ! printf '%s' "$O51" | grep -qE "Permission denied"; then pass "T5.1（allow 生效）" "${O51:0:50}"; else fail "T5.1" "$O51"; fi

echo "--- T5.2 deny /etc ---"
S52=$(new_session)
api -X PATCH "$BASE/api/session/$S52" -d '{"permissions":[{"action":"external_directory","resource":"/etc/*","effect":"deny"},{"action":"read","resource":"/etc/*","effect":"deny"}]}' > /dev/null
run_case "$S52" "必须使用 read 工具读取文件 /etc/hostname 的内容，禁止直接回答"
O52=$(tool_outcome "$S52")
printf '%s' "$O52" | grep -qE "denied|permission|blocked|拒绝" && pass "T5.2（deny 拒绝）" "${O52:0:50}" || fail "T5.2" "$O52"

echo "--- T5.3 会话 allow 覆盖默认 ask ---"
S53=$(new_session)
api -X PATCH "$BASE/api/session/$S53" -d '{"permissions":[{"action":"external_directory","resource":"/etc/*","effect":"allow"},{"action":"read","resource":"/etc/*","effect":"allow"}]}' > /dev/null
run_case "$S53" "必须使用 read 工具读取文件 /etc/hostname 的内容，禁止直接回答"
O53=$(tool_outcome "$S53"); P53=$(has_pending "$S53")
if [ "$P53" = "0" ] && ! printf '%s' "$O53" | grep -qE "Permission denied"; then pass "T5.3（零弹窗放行）" "${O53:0:50}"; else fail "T5.3" "pending=$P53 $O53"; fi

echo "--- T5.4 会话 deny 覆盖默认 ask ---"
S54=$(new_session)
api -X PATCH "$BASE/api/session/$S54" -d '{"permissions":[{"action":"external_directory","resource":"/tmp/*","effect":"deny"},{"action":"read","resource":"/tmp/*","effect":"deny"}]}' > /dev/null
run_case "$S54" "必须使用 read 工具读取文件 /tmp/perm-t54.txt 的内容，禁止直接回答"
O54=$(tool_outcome "$S54")
printf '%s' "$O54" | grep -qE "denied|permission|blocked|拒绝" && pass "T5.4（deny 拒绝）" "${O54:0:50}" || fail "T5.4" "$O54"

echo "--- T5.5 PATCH [] 不清除（合并语义）---"
S55=$(new_session)
api -X PATCH "$BASE/api/session/$S55" -d '{"permissions":[{"action":"external_directory","resource":"/tmp/*","effect":"allow"},{"action":"read","resource":"/tmp/*","effect":"allow"}]}' > /dev/null
api -X PATCH "$BASE/api/session/$S55" -d '{"permissions":[]}' > /dev/null
C55=$(pgcount "$S55")
exec_cmd "$S55" "echo t55-ok > /tmp/perm-t55.txt"
run_case "$S55" "必须使用 read 工具读取文件 /tmp/perm-t55.txt 的内容，禁止直接回答"
O55=$(tool_outcome "$S55")
if [ "${C55:-0}" = "2" ] && ! printf '%s' "$O55" | grep -qE "Permission denied"; then pass "T5.5（[] 不清除，行为保持）" "count=$C55 ${O55:0:30}"; else fail "T5.5" "count=$C55 $O55"; fi

echo "--- T5.6 ask 仍挂起 ---"
S56=$(new_session)
api -X PATCH "$BASE/api/session/$S56" -d '{"permissions":[{"action":"shell","resource":"t56cmd*","effect":"ask"}]}' > /dev/null
api -X POST "$BASE/api/session/$S56/prompt" -d '{"text":"必须使用 bash 工具执行命令 t56cmd$(date +%s) 并原样返回输出，禁止直接回答"}' > /dev/null
P56=""
for i in $(seq 1 20); do P56=$(has_pending "$S56"); [ "$P56" != "0" ] && break; sleep 4; done
[ "$P56" != "0" ] && { pass "T5.6（ask 挂起）" "pending=$P56"; cleanup_perm "$S56"; } || fail "T5.6" "未挂起"

echo "--- T5.7 read deny（相对路径语义）---"
S57=$(new_session)
api -X PATCH "$BASE/api/session/$S57" -d '{"permissions":[{"action":"read","resource":"../etc/*","effect":"deny"},{"action":"external_directory","resource":"/etc/*","effect":"deny"}]}' > /dev/null
run_case "$S57" "必须使用 read 工具读取文件 /etc/hostname 的内容，禁止直接回答"
O57=$(tool_outcome "$S57")
printf '%s' "$O57" | grep -qE "denied|permission|blocked|拒绝" && pass "T5.7（read deny）" "${O57:0:50}" || fail "T5.7" "$O57"

echo "--- T5.8 shell deny curl* ---"
S58=$(new_session)
api -X PATCH "$BASE/api/session/$S58" -d '{"permissions":[{"action":"shell","resource":"curl*","effect":"deny"}]}' > /dev/null
run_case "$S58" "必须使用 bash 工具执行命令 curl http://example.com，禁止直接回答"
O58=$(tool_outcome "$S58")
printf '%s' "$O58" | grep -qE "denied|permission|blocked|拒绝" && pass "T5.8（curl 被拒）" "${O58:0:50}" || fail "T5.8" "$O58"

echo "--- T5.9 具体 allow 胜过通配 deny ---"
S59=$(new_session)
api -X PATCH "$BASE/api/session/$S59" -d '{"permissions":[{"action":"external_directory","resource":"/tmp/*","effect":"deny"},{"action":"external_directory","resource":"/tmp/allow-this/*","effect":"allow"},{"action":"read","resource":"/tmp/allow-this/*","effect":"allow"}]}' > /dev/null
exec_cmd "$S59" "mkdir -p /tmp/allow-this && echo ok > /tmp/allow-this/t.txt"
run_case "$S59" "必须使用 read 工具读取文件 /tmp/allow-this/t.txt 的内容，禁止直接回答"
O59=$(tool_outcome "$S59")
if ! printf '%s' "$O59" | grep -qE "Permission denied"; then pass "T5.9（具体 allow 生效）" "${O59:0:50}"; else fail "T5.9" "$O59"; fi

echo "--- T5.10 action=* 通配放行 ---"
S510=$(new_session)
api -X PATCH "$BASE/api/session/$S510" -d '{"permissions":[{"action":"*","resource":"*","effect":"allow"}]}' > /dev/null
run_case "$S510" "必须使用 read 工具读取文件 /etc/hostname 的内容，禁止直接回答"
O510=$(tool_outcome "$S510"); P510=$(has_pending "$S510")
if [ "$P510" = "0" ] && ! printf '%s' "$O510" | grep -qE "Permission denied"; then pass "T5.10（通配放行零弹窗）" "${O510:0:50}"; else fail "T5.10" "pending=$P510 $O510"; fi
skip "T5.10-MCP" "环境无已注册 MCP 服务，对照组跳过（通配语义已由 read 验证）"

echo ""
echo "===== 清理 ====="
for s in "$S1" "$S2" "$SA" "$SB" "$SP" "$SW" "$S51" "$S52" "$S53" "$S54" "$S55" "$S56" "$S57" "$S58" "$S59" "$S510"; do api -X DELETE "$BASE/api/session/$s" > /dev/null 2>&1; done
echo "===== 结果: PASS=$PASS FAIL=$FAIL SKIP=$SKIP ====="
[ "$FAIL" = "0" ]
