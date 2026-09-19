#!/bin/bash
# SSE 事件流用例（sse.md T9.1-T9.37）——v2 适配版。
#
# v1→v2 映射：
#   /global/event、实例 /event  → 单一 /api/event（全 location，无需 directory 头）
#   GET /session/:id/event      → GET /api/experimental/session/:id/log（durable，after/follow）
#   prompt_async / POST /message→ POST /api/session/:id/prompt（admission 回显）
#   message.part.*              → session.text.* / session.reasoning.* / session.tool.*
#   session.status / session.idle→ 保留同名事件
#   properties                  → data
# 无 v2 对应（SKIP）：prompt_stream 系列、/global/dispose、消息删除、command.executed。
set -u
BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-v2-test-pass}"
PROVIDER="${PROVIDER:-Yd-DeepSeek}"
MODEL_ID="${MODEL_ID:-deepseek-v4-flash}"
MODEL="{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL_ID\"}"
PG_URL="${PG_URL:-postgresql://local@127.0.0.1:15432/opencode_v2}"

PASS=0; FAIL=0; SKIP=0
pass() { echo "✅ $1 PASS ${2:-}"; PASS=$((PASS+1)); }
fail() { echo "❌ $1 FAIL: ${2:-}"; FAIL=$((FAIL+1)); }
skip() { echo "➖ $1 SKIP: ${2:-}"; SKIP=$((SKIP+1)); }
ONLY="${ONLY:-}"
# ONLY=T9.5 只跑指定用例（空格分隔可多个）；为空时跑全部
run() { [ -z "$ONLY" ] && return 0; printf " %s " "$ONLY" | grep -q " $1 " ; }

api() { curl -s -m 200 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }
new_session() { api -X POST "$BASE/api/session" -d "{\"title\":\"sse\",\"model\":$MODEL}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null; }

SUB_PID=""
subscribe() { curl -s -N --max-time "${2:-120}" -u "opencode:$PASSWORD" "$BASE/api/event" > "$1" 2>/dev/null & SUB_PID=$!; }
stop_sub() { kill "$SUB_PID" 2>/dev/null; wait "$SUB_PID" 2>/dev/null; }
wait_connected() { local i; for i in $(seq 1 60); do grep -q '"type":"server.connected"' "$1" 2>/dev/null && return 0; sleep 0.5; done; return 1; }
wait_type() { local i n; n=$(( ${3:-90} * 2 )); for i in $(seq 1 "$n"); do grep -q "\"type\":\"$2\"" "$1" 2>/dev/null && return 0; sleep 0.5; done; return 1; }
# 统计某 type（可按 sessionID 过滤，空串=不过滤）
evcount() { grep '^data: ' "$1" | sed 's/^data: //' | TYPE="$2" SID="$3" python3 -c "
import sys,os,json
t=os.environ['TYPE']; sid=os.environ['SID']; n=0
for l in sys.stdin:
    l=l.strip()
    if not l: continue
    try: d=json.loads(l)
    except Exception: continue
    if d.get('type')!=t: continue
    if sid and (d.get('data') or {}).get('sessionID')!=sid: continue
    n+=1
print(n)" 2>/dev/null; }
prompt() { api -X POST "$BASE/api/session/$1/prompt" -d "{\"text\":\"$2\"}" >/dev/null; }
wait_idle() { # sid: wait until session.idle or session.status idle for sid
  local i
  for i in $(seq 1 120); do
    ok=$(grep '^data: ' "$1" | sed 's/^data: //' | SID="$2" python3 -c "
import sys,os,json
sid=os.environ['SID']
for l in sys.stdin:
    try: d=json.loads(l)
    except Exception: continue
    if (d.get('data') or {}).get('sessionID')!=sid: continue
    t=d.get('type')
    if t=='session.idle': print(1); break
    if t=='session.status' and (d.get('data') or {}).get('status',{}).get('type')=='idle': print(1); break
    if t in ('session.execution.succeeded','session.execution.failed','session.execution.interrupted'): print(1); break
" 2>/dev/null)
    [ "${ok:-}" = "1" ] && return 0
    sleep 0.5
  done
  return 1
}

[ -n "$ONLY" ] || echo "################ A. 连接与帧形状 ################"

if run T9.1; then
curl -s -N --max-time 4 -u "opencode:$PASSWORD" -D /tmp/sse-h1.txt "$BASE/api/event" -o /tmp/sse-t91.txt
CT=$(grep -i "content-type" /tmp/sse-h1.txt | grep -c "text/event-stream")
CC=$(grep -i "cache-control" /tmp/sse-h1.txt | grep -c "no-cache, no-transform")
FIRST=$(head -1 /tmp/sse-t91.txt)
if [ "$CT" = "1" ] && [ "$CC" = "1" ] && printf '%s' "$FIRST" | grep -q '"type":"server.connected"'; then
  pass "T9.1（headers + server.connected）"
else
  fail "T9.1" "ct=$CT cc=$CC first=${FIRST:0:80}"
fi

fi
if run T9.3; then
curl -s -N --max-time 18 -u "opencode:$PASSWORD" "$BASE/api/event" -o /tmp/sse-t93.txt
HB=$(grep -c '^: heartbeat' /tmp/sse-t93.txt || true)
[ "${HB:-0}" -ge 1 ] && pass "T9.3（心跳注释帧 ≥1）" "hb=$HB" || fail "T9.3" "hb=$HB"

fi
if run T9.23; then
curl -s -N --max-time 4 -u "opencode:$PASSWORD" "$BASE/api/event" -o /tmp/sse-t923.txt
SHAPE=$(grep -m1 '^data: ' /tmp/sse-t923.txt | sed 's/^data: //' | python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print('ok' if d.get('id','').startswith('evt_') and 'type' in d and isinstance(d.get('data'),dict) else 'bad')" 2>/dev/null)
[ "$SHAPE" = "ok" ] && pass "T9.23（id/type/data 齐全，用 data 非 properties）" || fail "T9.23" "$SHAPE"

fi
if run T9.24; then
IDOK=$(grep '^data: ' /tmp/sse-t923.txt | sed 's/^data: //' | python3 -c "
import json,sys
ok=all(json.loads(l).get('id','').startswith('evt_') for l in sys.stdin if l.strip())
print('ok' if ok else 'bad')" 2>/dev/null)
[ "$IDOK" = "ok" ] && pass "T9.24（全为 evt_*）" || fail "T9.24" "$IDOK"

fi
if run T9.25; then
C25=$(curl -s -N --max-time 4 -D - -o /tmp/sse-t925.txt -u "opencode:$PASSWORD" "$BASE/api/event" | grep -ci "200")
[ "${C25:-0}" -ge 1 ] && grep -q '"type":"server.connected"' /tmp/sse-t925.txt && pass "T9.25（无头连接成功）" || fail "T9.25" "http200=$C25"

fi
[ -n "$ONLY" ] || echo "################ B. 会话生命周期 ################"

if run T9.2; then
subscribe /tmp/sse-t92.txt 12
wait_connected /tmp/sse-t92.txt
S92=$(new_session)
wait_type /tmp/sse-t92.txt session.created 10
stop_sub
C92=$(evcount /tmp/sse-t92.txt session.created "$S92")
[ "${C92:-0}" -ge 1 ] && pass "T9.2（session.created）" "count=$C92" || fail "T9.2" "count=$C92"

fi
if run T9.16; then
subscribe /tmp/sse-t916.txt 15
wait_connected /tmp/sse-t916.txt
S916=$(new_session)
api -X PATCH "$BASE/api/session/$S916" -d '{"title":"sse-renamed"}' >/dev/null
wait_type /tmp/sse-t916.txt session.renamed 10
R16=$(grep '^data: ' /tmp/sse-t916.txt | sed 's/^data: //' | SID="$S916" python3 -c "
import sys,os,json
sid=os.environ['SID']
for l in sys.stdin:
    try: d=json.loads(l)
    except Exception: continue
    if d.get('type')=='session.renamed' and (d.get('data') or {}).get('sessionID')==sid:
        print((d.get('data') or {}).get('title') or (d.get('data') or {}).get('name') or '')" 2>/dev/null | tail -1)
api -X DELETE "$BASE/api/session/$S916" >/dev/null
wait_type /tmp/sse-t916.txt session.deleted 10
stop_sub
C16D=$(evcount /tmp/sse-t916.txt session.deleted "$S916")
if [ -n "$R16" ] && [ "${C16D:-0}" -ge 1 ]; then
  pass "T9.16（renamed/deleted）" "title=$R16"
else
  fail "T9.16" "title=$R16 deleted=$C16D"
fi

fi
if run T9.21; then
subscribe /tmp/sse-t921.txt 15
wait_connected /tmp/sse-t921.txt
S921=$(api -X POST "$BASE/api/session" -d '{"title":"sse"}' | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null)
api -X POST "$BASE/api/session/$S921/model" -d "{\"model\":$MODEL}" >/dev/null
api -X POST "$BASE/api/session/$S921/agent" -d '{"agent":"build"}' >/dev/null
wait_type /tmp/sse-t921.txt session.model.selected 8
wait_type /tmp/sse-t921.txt session.agent.selected 8
stop_sub
CM=$(evcount /tmp/sse-t921.txt session.model.selected "$S921")
CA=$(evcount /tmp/sse-t921.txt session.agent.selected "$S921")
[ "${CM:-0}" -ge 1 ] && [ "${CA:-0}" -ge 1 ] && pass "T9.21（model/agent selected）" "m=$CM a=$CA" || fail "T9.21" "m=$CM a=$CA"

fi
if run T9.8; then
subscribe /tmp/sse-t98.txt 18
wait_connected /tmp/sse-t98.txt
SA=$(new_session); SB=$(new_session)
api -X PATCH "$BASE/api/session/$SA" -d '{"title":"iso-a"}' >/dev/null
api -X PATCH "$BASE/api/session/$SB" -d '{"title":"iso-b"}' >/dev/null
wait_type /tmp/sse-t98.txt session.renamed 10
sleep 1
stop_sub
XR=$(grep '^data: ' /tmp/sse-t98.txt | sed 's/^data: //' | A="$SA" B="$SB" python3 -c "
import sys,os,json
a=os.environ['A']; b=os.environ['B']; na=nb=cross=0
for l in sys.stdin:
    try: d=json.loads(l)
    except Exception: continue
    if d.get('type')!='session.renamed': continue
    sid=(d.get('data') or {}).get('sessionID')
    if sid==a: na+=1
    elif sid==b: nb+=1
    else: cross+=1
print(f'{na},{nb},{cross}')" 2>/dev/null)
[ "$XR" = "1,1,0" ] && pass "T9.8（A/B 各 1，无交叉）" "$XR" || fail "T9.8" "$XR"

fi
if run T9.13; then
curl -s -N --max-time 3 -u "opencode:$PASSWORD" "$BASE/api/event" -o /tmp/sse-t913a.txt
curl -s -N --max-time 3 -u "opencode:$PASSWORD" "$BASE/api/event" -o /tmp/sse-t913b.txt
if grep -q '"type":"server.connected"' /tmp/sse-t913a.txt && grep -q '"type":"server.connected"' /tmp/sse-t913b.txt; then
  pass "T9.13（两次连接均 connected）"
else fail "T9.13" "a/b 缺少 connected"; fi

fi
if run T9.14; then
subscribe /tmp/sse-t914a.txt 15; PA=$SUB_PID
subscribe /tmp/sse-t914b.txt 15; PB=$SUB_PID
subscribe /tmp/sse-t914c.txt 15; PC=$SUB_PID
for f in a b c; do wait_connected "/tmp/sse-t914$f.txt"; done
S914=$(new_session)
api -X PATCH "$BASE/api/session/$S914" -d '{"title":"multi"}' >/dev/null
wait_type /tmp/sse-t914a.txt session.renamed 8
kill "$PA" "$PB" "$PC" 2>/dev/null; wait "$PA" "$PB" "$PC" 2>/dev/null; SUB_PID=""
CNT=$(for f in a b c; do evcount "/tmp/sse-t914$f.txt" session.renamed "$S914"; done | paste -sd, -)
[ "$CNT" = "1,1,1" ] && pass "T9.14（3 客户端均收到）" "$CNT" || fail "T9.14" "$CNT"

fi
if run T9.15; then
subscribe /tmp/sse-t915a.txt 15; PA=$SUB_PID
wait_connected /tmp/sse-t915a.txt
S915=$(new_session)
sleep 1
subscribe /tmp/sse-t915b.txt 12; PB=$SUB_PID
wait_connected /tmp/sse-t915b.txt
api -X PATCH "$BASE/api/session/$S915" -d '{"title":"late-join"}' >/dev/null
wait_type /tmp/sse-t915a.txt session.renamed 8
kill "$PA" "$PB" 2>/dev/null; wait "$PA" "$PB" 2>/dev/null; SUB_PID=""
B15=$(evcount /tmp/sse-t915b.txt session.renamed "$S915")
A15=$(evcount /tmp/sse-t915a.txt session.renamed "$S915")
[ "${A15:-0}" -ge 1 ] && [ "${B15:-0}" -ge 1 ] && pass "T9.15（A/B 均收到后续）" "a=$A15 b=$B15" || fail "T9.15" "a=$A15 b=$B15"

fi
[ -n "$ONLY" ] || echo "################ C. LLM 事件流 ################"

if run T9.5; then
subscribe /tmp/sse-t95.txt 90
wait_connected /tmp/sse-t95.txt
S95=$(new_session)
prompt "$S95" "只回复两个字：收到"
wait_idle /tmp/sse-t95.txt "$S95"
stop_sub
TXT=$(evcount /tmp/sse-t95.txt session.text.delta "$S95")
TXTED=$(evcount /tmp/sse-t95.txt session.text.ended "$S95")
STARTED=$(evcount /tmp/sse-t95.txt session.execution.started "$S95")
SUCC=$(evcount /tmp/sse-t95.txt session.execution.succeeded "$S95")
if [ "${TXT:-0}" -ge 1 ] && [ "${STARTED:-0}" -ge 1 ] && [ $(( ${SUCC:-0} )) -ge 1 ]; then
  pass "T9.5/9/10（text.delta=$TXT started=$STARTED succeeded=$SUCC ended=${TXTED}）"
else fail "T9.5/9/10" "delta=$TXT started=$STARTED succeeded=$SUCC ended=$TXTED"; fi

fi
if run T9.18; then
subscribe /tmp/sse-t918.txt 90
wait_connected /tmp/sse-t918.txt
S918=$(new_session)
prompt "$S918" "说一个字"
wait_idle /tmp/sse-t918.txt "$S918"
stop_sub
C18=$(evcount /tmp/sse-t918.txt session.step.ended "$S918")
[ "${C18:-0}" -ge 1 ] && pass "T9.18（step.ended 落库边界）" "count=$C18" || fail "T9.18" "count=$C18"

fi
if run T9.6; then
subscribe /tmp/sse-t96.txt 120
wait_connected /tmp/sse-t96.txt
S96=$(new_session)
prompt "$S96" "用 bash 执行 echo hello_sse_test，然后只回复 OK"
wait_idle /tmp/sse-t96.txt "$S96"
stop_sub
TCALL=$(evcount /tmp/sse-t96.txt session.tool.called "$S96")
TDELTA=$(evcount /tmp/sse-t96.txt session.tool.input.delta "$S96")
TDONE=$(( $(evcount /tmp/sse-t96.txt session.tool.success "$S96") + $(evcount /tmp/sse-t96.txt session.tool.failed "$S96") ))
if [ "${TCALL:-0}" -ge 1 ] && [ "${TDONE:-0}" -ge 1 ]; then
  pass "T9.6/27（called=$TCALL input.delta=$TDELTA terminal=${TDONE}）"
else fail "T9.6/27" "called=$TCALL delta=$TDELTA terminal=$TDONE"; fi

fi
if run T9.19; then
subscribe /tmp/sse-t919.txt 90
wait_connected /tmp/sse-t919.txt
S919=$(new_session)
# 非法模型：先 switch 再 prompt，确保失败回合被记录
api -X POST "$BASE/api/session/$S919/model" -d '{"model":{"providerID":"Yd-DeepSeek","id":"nonexistent-model-xyz"}}' >/dev/null
prompt "$S919" "hi"
wait_idle /tmp/sse-t919.txt "$S919"
stop_sub
EF=$(evcount /tmp/sse-t919.txt session.execution.failed "$S919")
SF=$(evcount /tmp/sse-t919.txt session.step.failed "$S919")
[ $(( ${EF:-0} + ${SF:-0} )) -ge 1 ] && pass "T9.19（execution/step failed）" "ef=$EF sf=$SF" || fail "T9.19" "ef=$EF sf=$SF"

fi
if run T9.20; then
subscribe /tmp/sse-t920.txt 60
wait_connected /tmp/sse-t920.txt
S920=$(new_session)
prompt "$S920" "hi"
wait_idle /tmp/sse-t920.txt "$S920"
MID=$(api "$BASE/api/session/$S920/message" | python3 -c "
import json,sys
d=json.load(sys.stdin).get('data',[])
u=[m for m in d if m.get('type')=='user']
print(u[-1]['id'] if u else '')" 2>/dev/null)
api -X POST "$BASE/api/session/$S920/revert/stage" -d "{\"messageID\":\"$MID\",\"files\":false}" >/dev/null
wait_type /tmp/sse-t920.txt session.revert.staged 10
stop_sub
R20=$(evcount /tmp/sse-t920.txt session.revert.staged "$S920")
[ "${R20:-0}" -ge 1 ] && pass "T9.20（revert.staged）" "count=$R20" || fail "T9.20" "mid=$MID count=$R20"

fi
if run T9.7; then
CMDP="sseperm$(date +%s)"
subscribe /tmp/sse-t97.txt 120
wait_connected /tmp/sse-t97.txt
S97=$(new_session)
api -X PATCH "$BASE/api/session/$S97" -d "{\"permissions\":[{\"action\":\"shell\",\"resource\":\"${CMDP}*\",\"effect\":\"ask\"}]}" >/dev/null
api -X POST "$BASE/api/session/$S97/prompt" -d "{\"text\":\"必须使用 bash 工具执行命令 ${CMDP} 并原样返回输出，禁止直接回答\"}" >/dev/null
PID97=""
for i in $(seq 1 60); do
  PID97=$(grep '^data: ' /tmp/sse-t97.txt | sed 's/^data: //' | SID="$S97" python3 -c "
import sys,os,json
sid=os.environ['SID']
for l in sys.stdin:
    try: d=json.loads(l)
    except Exception: continue
    if d.get('type')=='permission.asked' and (d.get('data') or {}).get('sessionID')==sid:
        print((d.get('data') or {}).get('id') or ''); break" 2>/dev/null)
  [ -n "$PID97" ] && break
  sleep 1
done
if [ -n "$PID97" ]; then
  RC=$(curl -s -o /dev/null -w "%{http_code}" -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S97/permission/$PID97/reply" -d '{"decision":"reject"}')
  pass "T9.7（permission.asked + reply http=${RC}）" "id=${PID97:0:14}"
else
  fail "T9.7" "未见 permission.asked"
fi
stop_sub

fi
[ -n "$ONLY" ] || echo "################ D. durable 会话日志 ################"

if run T9.28; then
S928=$(new_session)
curl -s -N --max-time 3 -D /tmp/sse-t928h.txt -u "opencode:$PASSWORD" "$BASE/api/experimental/session/$S928/log?follow=true" -o /tmp/sse-t928.txt
CT28=$(grep -ci "text/event-stream" /tmp/sse-t928h.txt)
SYNC28=$(grep -c '"type":"log.synced"' /tmp/sse-t928.txt || true)
C28BAD=$(curl -s -o /dev/null -w "%{http_code}" -N --max-time 3 -u "opencode:$PASSWORD" "$BASE/api/experimental/session/$S928/log?after=-1")
if [ "${CT28:-0}" -ge 1 ] && [ "${SYNC28:-0}" -ge 1 ] && [ "$C28BAD" = "400" ]; then
  pass "T9.28（SSE + log.synced；after<0 → 400）" "sync=$SYNC28"
else
  fail "T9.28" "ct=$CT28 sync=$SYNC28 after-1=$C28BAD"
fi


fi

if run T9.29; then
echo "===== T9.29 会话 log 回放隔离（persist 已开启） ====="
SA=$(new_session); SB=$(new_session)
api -X POST "$BASE/api/session/$SA/prompt" -d '{"text":"只回复A"}' >/dev/null
api -X POST "$BASE/api/session/$SB/prompt" -d '{"text":"只回复B"}' >/dev/null
sleep 8
R929=$(A="$SA" B="$SB" python3 -c "
import json,os,urllib.request,base64
def log(sid):
    req=urllib.request.Request(f'http://localhost:14097/api/experimental/session/{sid}/log?after=0')
    req.add_header('Authorization','Basic '+base64.b64encode(b'opencode:v2-test-pass').decode())
    req.add_header('x-opencode-directory','/workspace')
    out=[]
    for line in urllib.request.urlopen(req, timeout=20).read().decode().split('\n'):
        if line.startswith('data: '): out.append(json.loads(line[6:]))
    return out
a=log(os.environ['A']); b=log(os.environ['B'])
oka=all(e.get('data',{}).get('sessionID')==os.environ['A'] for e in a if e['type']!='log.synced')
okb=all(e.get('data',{}).get('sessionID')==os.environ['B'] for e in b if e['type']!='log.synced')
print('ok' if oka and okb and len(a)>2 and len(b)>2 else f'leak a_frames={len(a)} b_frames={len(b)} oka={oka} okb={okb}')")
if [ "$R929" = "ok" ]; then pass "T9.29（A/B 会话 log 各自隔离，无串流）" ""; else fail "T9.29" "$R929"; fi
api -X DELETE "$BASE/api/session/$SA" >/dev/null 2>&1
api -X DELETE "$BASE/api/session/$SB" >/dev/null 2>&1
fi
if run T9.30; then
C30=$(curl -s -o /dev/null -w "%{http_code}" -N --max-time 3 -u "opencode:$PASSWORD" "$BASE/api/experimental/session/ses_httpapi_missing/log")
[ "$C30" = "404" ] && pass "T9.30（404）" || fail "T9.30" "http=$C30"


fi

if run T9.35; then
echo "===== T9.35 断连续传：after 游标回放不丢不重 ====="
S935=$(new_session)
api -X POST "$BASE/api/session/$S935/prompt" -d '{"text":"只回复两个字：收到"}' >/dev/null
sleep 8
R935=$(S="$S935" python3 -c "
import json,base64,urllib.request
def log(after):
    req=urllib.request.Request(f'http://localhost:14097/api/experimental/session/{os.environ[\"S\"]}/log?after={after}')
    req.add_header('Authorization','Basic '+base64.b64encode(b'opencode:v2-test-pass').decode())
    req.add_header('x-opencode-directory','/workspace')
    out=[]
    for line in urllib.request.urlopen(req, timeout=20).read().decode().split('\n'):
        if line.startswith('data: '): out.append(json.loads(line[6:]))
    return out
import os
full=log(0)
seqs=[e['durable']['seq'] for e in full if e.get('durable')]
mid=seqs[len(seqs)//2]
half=log(mid)
hseqs=[e['durable']['seq'] for e in half if e.get('durable')]
ok = half[-1]['type']=='log.synced' and hseqs==[q for q in seqs if q>mid] and len(set(hseqs))==len(hseqs)
print('ok' if ok else f'bad full={len(seqs)} mid={mid} half={len(hseqs)}')
" 2>&1)
if [ "$R935" = "ok" ]; then pass "T9.35（after=mid 只补发 seq>mid，衔接 synced 标记，零重复）" ""; else fail "T9.35" "$R935"; fi
api -X DELETE "$BASE/api/session/$S935" >/dev/null 2>&1
fi

if run T9.36; then
echo "===== T9.36 follow 续传：回放衔接实时不丢不重 ====="
S936=$(new_session)
api -X POST "$BASE/api/session/$S936/prompt" -d '{"text":"第一轮"}' >/dev/null
sleep 8
W936=$(api "$BASE/api/experimental/session/$S936/log?after=0" | python3 -c "
import sys,json
seqs=[json.loads(l[6:])['durable']['seq'] for l in sys.stdin if l.startswith('data: ') and json.loads(l[6:]).get('durable')]
print(seqs[-1] if seqs else 0)" 2>/dev/null)
curl -s -N -m 40 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/experimental/session/$S936/log?after=$W936&follow=true" > /tmp/sse-t936.log &
FL936=$!
sleep 3
api -X POST "$BASE/api/session/$S936/prompt" -d '{"text":"第二轮"}' >/dev/null
sleep 12; kill "$FL936" 2>/dev/null
R936=$(W="$W936" python3 -c "
import json,os
frames=[json.loads(l[6:]) for l in open('/tmp/sse-t936.log') if l.startswith('data: ')]
w=int(os.environ['W'])
synced=[f for f in frames if f['type']=='log.synced']
live=[f for f in frames if f.get('durable') and f['durable']['seq']>w]
seqs=[f['durable']['seq'] for f in live]
ok = len(synced)>=1 and len(live)>=2 and len(set(seqs))==len(seqs) and min(seqs)>w
print('ok' if ok else f'bad synced={len(synced)} live={len(live)} dup={len(seqs)-len(set(seqs))} w={w}')")
if [ "$R936" = "ok" ]; then
  pass "T9.36（synced 标记后 live 帧全为 seq>水位，零丢失零重复）" "$R936"
else
  fail "T9.36" "$R936"
fi
api -X DELETE "$BASE/api/session/$S936" >/dev/null 2>&1
fi

if run T9.31; then
echo "===== T9.31 prompt_stream 正常回合（v2 端点） ====="
S931=$(new_session)
C931=$(curl -s -o /tmp/sse-t931.txt -w "%{http_code}" -N --max-time 90 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -X POST "$BASE/api/session/$S931/prompt_stream" -H 'content-type: application/json' -d '{"text":"只回复两个字：收到"}')
R931=$(grep '^data: ' /tmp/sse-t931.txt | sed 's/^data: //' | python3 -c "
import sys,json
t=[json.loads(l).get('type') for l in sys.stdin if l.strip()]
print((t[0] if t else '')+'|'+(t[-1] if t else '')+'|'+str(sum(1 for x in t if x=='session.text.delta')))" 2>/dev/null)
if [ "$C931" = "200" ] && [ "$R931" = "server.connected|session.execution.succeeded|1" ]; then
  pass "T9.31（connected → … → succeeded，服务端关流）" "$R931"
else
  fail "T9.31" "http=$C931 r=$R931"
fi
api -X DELETE "$BASE/api/session/$S931" >/dev/null 2>&1
fi

if run T9.32; then
echo "===== T9.32 prompt_stream 错误回合（关流） ====="
S932=$(new_session)
api -X POST "$BASE/api/session/$S932/model" -d '{"model":{"providerID":"Yd-DeepSeek","id":"nonexistent-model-xyz"}}' >/dev/null
C932=$(curl -s -o /tmp/sse-t932.txt -w "%{http_code}" -N --max-time 60 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -X POST "$BASE/api/session/$S932/prompt_stream" -H 'content-type: application/json' -d '{"text":"hi"}')
R932=$(grep '^data: ' /tmp/sse-t932.txt | sed 's/^data: //' | python3 -c "
import sys,json
t=[json.loads(l).get('type') for l in sys.stdin if l.strip()]
print((t[-1] if t else '')+'|'+str(sum(1 for x in t if x in ('session.execution.failed','session.step.failed'))))" 2>/dev/null)
if [ "$C932" = "200" ] && [ "$R932" = "session.execution.failed|1" ]; then
  pass "T9.32（错误回合仍以 succeeded/failed 关流）" "$R932"
else
  fail "T9.32" "http=$C932 r=$R932"
fi
api -X DELETE "$BASE/api/session/$S932" >/dev/null 2>&1
fi

if run T9.33; then
echo "===== T9.33 prompt_stream 多会话并发隔离 ====="
SA933=$(new_session); SB933=$(new_session)
curl -s -N --max-time 60 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -X POST "$BASE/api/session/$SA933/prompt_stream" -H 'content-type: application/json' -d '{"text":"只回复A"}' > /tmp/sse-t933a.txt &
PA=$!
sleep 0.3
curl -s -N --max-time 60 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -X POST "$BASE/api/session/$SB933/prompt_stream" -H 'content-type: application/json' -d '{"text":"只回复B"}' > /tmp/sse-t933b.txt &
PB=$!
wait "$PA"; EA=$?; wait "$PB"; EB=$?
R933=$(A="$SA933" B="$SB933" python3 -c "
import re,os
sa=set(re.findall(r'\"sessionID\":\"(ses_[A-Za-z0-9]+)\"', open('/tmp/sse-t933a.txt').read()))
sb=set(re.findall(r'\"sessionID\":\"(ses_[A-Za-z0-9]+)\"', open('/tmp/sse-t933b.txt').read()))
print('ok' if sa=={os.environ['A']} and sb=={os.environ['B']} else f'leak a={sa} b={sb}')")
if [ "$EA" = "0" ] && [ "$EB" = "0" ] && [ "$R933" = "ok" ]; then
  pass "T9.33（各自隔离且独立关流）" "$R933"
else
  fail "T9.33" "ea=$EA eb=$EB $R933"
fi
api -X DELETE "$BASE/api/session/$SA933" >/dev/null 2>&1
api -X DELETE "$BASE/api/session/$SB933" >/dev/null 2>&1
fi

if run T9.34; then
echo "===== T9.34 prompt_stream 不存在 session → 404 ====="
C934=$(curl -s -o /dev/null -w "%{http_code}" -N --max-time 3 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -X POST "$BASE/api/session/ses_httpapi_missing/prompt_stream" -H 'content-type: application/json' -d '{"text":"hi"}')
[ "$C934" = "404" ] && pass "T9.34（404）" || fail "T9.34" "http=$C934"
fi

if run T9.22; then
echo "===== T9.22 自定义命令执行 → command.executed ====="
docker exec opencode-v2-test sh -c 'mkdir -p /workspace/.opencode/command && printf -- "---\ndescription: t922 sse\n---\n\n只回复两个字：收到 $ARGUMENTS\n" > /workspace/.opencode/command/t922.md' >/dev/null 2>&1
FOUND=0
for _ in $(seq 1 15); do
  N=$(api "$BASE/api/command" | python3 -c "import json,sys;d=json.load(sys.stdin);print(sum(1 for c in (d.get('data') or []) if c.get('name')=='t922'))" 2>/dev/null)
  [ "$N" = "1" ] && { FOUND=1; break; }
  sleep 1
done
if [ "$FOUND" != "1" ]; then
  fail "T9.22" "自定义命令未被 /api/command 发现"
else
  S922=$(new_session)
  curl -s -N -m 20 -u "opencode:$PASSWORD" "$BASE/api/event" > /tmp/sse-t922-ev.log &
  EV922=$!
  sleep 1
  C922=$(curl -s -o /dev/null -w "%{http_code}" -m 60 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S922/command" -d '{"name":"t922","text":"sse用例"}')
  sleep 3; kill "$EV922" 2>/dev/null
  R922=$(A="sse用例" SID="$S922" python3 -c "
import json,os
for l in open('/tmp/sse-t922-ev.log'):
    if not l.startswith('data: '): continue
    try: d=json.loads(l[6:])
    except Exception: continue
    if d.get('type')=='command.executed':
        e=d.get('data',{})
        print('ok' if e.get('name')=='t922' and e.get('sessionID')==os.environ['SID'] and e.get('arguments')==os.environ['A'] else f'mismatch {e}')
        break
else:
    print('missing')")
  if [ "$C922" = "204" ] && [ "$R922" = "ok" ]; then
    pass "T9.22（command.executed 携带 name/sessionID/arguments）" ""
  else
    fail "T9.22" "http=$C922 r=$R922"
  fi
  api -X DELETE "$BASE/api/session/$S922" >/dev/null 2>&1
fi
docker exec opencode-v2-test rm -f /workspace/.opencode/command/t922.md >/dev/null 2>&1
fi

if run T9.12; then
echo "===== T9.12 全局 dispose：POST /api/global/dispose → global.disposed ====="
curl -s -N -m 30 -u "opencode:$PASSWORD" "$BASE/api/event" > /tmp/sse-t912-ev.log &
EV912=$!
sleep 1
R912=$(curl -s -m 90 -u "opencode:$PASSWORD" -X POST "$BASE/api/global/dispose" -w "|%{http_code}")
sleep 2; kill "$EV912" 2>/dev/null
D912=$(grep -c 'global.disposed' /tmp/sse-t912-ev.log 2>/dev/null || true)
H912=$(new_session)
if [ "$R912" = '{"disposed":true}|200' ] && [ "${D912:-0}" -ge 1 ] && [ -n "$H912" ]; then
  pass "T9.12（dispose 释放重建全部 location 并广播 global.disposed，服务恢复）" ""
  api -X DELETE "$BASE/api/session/$H912" >/dev/null 2>&1
else
  fail "T9.12" "r=$R912 disposed_events=$D912 healthy=$H912"
fi
fi

if run T9.17; then
echo "===== T9.17 消息删除 → session.message.removed ====="
S917=$(new_session)
api -X POST "$BASE/api/session/$S917/prompt" -d '{"text":"只回复两个字：收到"}' >/dev/null
M917=""
for _ in $(seq 1 30); do
  M917=$(api "$BASE/api/session/$S917/message" | python3 -c "
import json,sys
d=json.load(sys.stdin)['data']
u=[m for m in d if m.get('type')=='user']
print(u[0]['id'] if u else '')" 2>/dev/null)
  [ -n "$M917" ] && break
  sleep 1
done
if [ -z "$M917" ]; then
  fail "T9.17" "user 消息未在 30s 内落库"
else
  curl -s -N -m 20 -u "opencode:$PASSWORD" "$BASE/api/event" > /tmp/sse-t917-ev.log &
  EV917=$!
  sleep 1
  D917=$(curl -s -o /dev/null -w "%{http_code}" -m 30 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -X DELETE "$BASE/api/session/$S917/message/$M917")
  sleep 2; kill "$EV917" 2>/dev/null
  R917=$(SID="$S917" MID="$M917" python3 -c "
import json,os
for l in open('/tmp/sse-t917-ev.log'):
    if not l.startswith('data: '): continue
    try: d=json.loads(l[6:])
    except Exception: continue
    if d.get('type')=='session.message.removed':
        e=d.get('data',{})
        print('ok' if e.get('sessionID')==os.environ['SID'] and e.get('messageID')==os.environ['MID'] else f'mismatch {e}')
        break
else:
    print('missing')")
  C917=$(curl -s -o /dev/null -w "%{http_code}" -m 10 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -X DELETE "$BASE/api/session/$S917/message/$M917")
  L917=$(api "$BASE/api/session/$S917/message" | python3 -c "import json,sys;print(sum(1 for m in json.load(sys.stdin)['data'] if m['id']=='$M917'))" 2>/dev/null)
  if [ "$D917" = "204" ] && [ "$R917" = "ok" ] && [ "$C917" = "404" ] && [ "${L917:-1}" = "0" ]; then
    pass "T9.17（删除 204 + session.message.removed 事件 + 重复删除 404 + 列表无残留）" "$M917"
  else
    fail "T9.17" "del=$D917 r=$R917 repeat=$C917 leftover=$L917"
  fi
fi
api -X DELETE "$BASE/api/session/$S917" >/dev/null 2>&1
fi

if run T9.11; then
echo "===== T9.11 沙箱写文件 → filesystem.changed ====="
S911=$(new_session)
api -X PATCH "$BASE/api/session/$S911" -d '{"permissions":[{"action":"edit","resource":"/workspace/*","effect":"allow"}]}' >/dev/null
curl -s -N -m 150 -u "opencode:$PASSWORD" "$BASE/api/event" > /tmp/sse-t911-ev.log &
EV911=$!
sleep 1
api -X POST "$BASE/api/session/$S911/prompt" -d '{"text":"用 write 工具把 marker-sse 写入 /workspace/t911-sse.txt，完成后只回复OK"}' >/dev/null
D911=""
for _ in $(seq 1 45); do
  D911=$(api "$BASE/api/session/$S911/message" | python3 -c "
import json,sys
for m in json.load(sys.stdin).get('data',[]):
    if m.get('type')=='assistant':
        for p in m.get('content',[]):
            if p.get('type')=='tool' and p.get('state',{}).get('status')=='completed': print('done')" 2>/dev/null)
  [ -n "$D911" ] && break
  sleep 2
done
sleep 2; kill "$EV911" 2>/dev/null
R911=$(python3 -c "
import json
for l in open('/tmp/sse-t911-ev.log'):
    if not l.startswith('data: '): continue
    d=json.loads(l[6:])
    if d.get('type')=='filesystem.changed':
        e=d.get('data',{})
        print('ok' if e.get('file')=='/workspace/t911-sse.txt' and e.get('event') in ('add','change') else f'mismatch {e}')
        break
else:
    print('missing')")
if [ "$D911" = "done" ] && [ "$R911" = "ok" ]; then
  pass "T9.11（会话沙箱内 write 触发 filesystem.changed，file/event 正确）" ""
else
  fail "T9.11" "tool=$D911 r=$R911"
fi
api -X DELETE "$BASE/api/session/$S911" >/dev/null 2>&1
fi

if [ -z "$ONLY" ]; then
echo "################ E. v1 独有 / v2 无对应 ################"
skip "T9.4" "v2 实例流与全局流合并为 /api/event，由 T9.1/T9.25 实测覆盖"

skip "T9.17-part" "v2 无独立 part 删除端点（消息内容编辑走 session.message.content.updated，整条删除已实测 T9.17）"

skip "T9.37" "v1 路径单测；v2 会话事件路由/隔离由 packages/core/test/bus-session-routing.test.ts 覆盖（9/9）"
fi

echo ""
echo "===== 结果: PASS=$PASS FAIL=$FAIL SKIP=$SKIP ====="
exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
