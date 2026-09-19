#!/bin/bash
# 结构化输出用例（structured-output.md TSO.1-TSO.7）——v2 适配版。
#
# v1→v2 映射：
#   POST /session/:id/message（同步）→ POST /api/session/:id/prompt（admission）+ 轮询
#   prompt_async                 → 同上（v2 prompt 本身即异步 admission）
#   prompt_stream                → POST /api/session/:id/prompt_stream（sse.md 同名端点）
#   info.structured              → assistant 消息 structured 字段（StructuredOutput 工具参数）
#   info.format                  → user 消息 format 字段
#   单条 GET /message/:id        → v2 无单条端点（列表读回覆盖同一 decode 路径）
set -u
BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-v2-test-pass}"
PROVIDER="${PROVIDER:-Yd-DeepSeek}"
MODEL_ID="${MODEL_ID:-deepseek-v4-flash}"
PG_URL="${PG_URL:-postgresql://local@127.0.0.1:15432/opencode_v2}"
ONLY="${ONLY:-}"
run() { [ -z "$ONLY" ] && return 0; printf " %s " "$ONLY" | grep -q " $1 " ; }

PASS=0; FAIL=0; SKIP=0
pass() { echo "✅ $1 PASS ${2:-}"; PASS=$((PASS+1)); }
fail() { echo "❌ $1 FAIL: ${2:-}"; FAIL=$((FAIL+1)); }
skip() { echo "➖ $1 SKIP ${2:-}"; SKIP=$((SKIP+1)); }

api() { curl -s -m 200 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }
new_session() { api -X POST "$BASE/api/session" -d "{\"title\":\"tso\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL_ID\"}}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null; }

# 轮询直到 assistant.structured 出现（或超时），输出 JSON 摘要
wait_structured() { # $1=sessionID $2=timeout_iters
  for _ in $(seq 1 "${2:-45}"); do
    R=$(api "$BASE/api/session/$1/message" | python3 -c "
import json,sys
d=json.load(sys.stdin).get('data',[])
a=[m for m in d if m.get('type')=='assistant' and m.get('structured') is not None]
u=[m for m in d if m.get('type')=='user']
print(json.dumps({'structured': a[0]['structured'] if a else None, 'user_format': (u[0].get('format') or {}).get('type') if u else None}, ensure_ascii=False))" 2>/dev/null)
    echo "$R" | grep -q '"structured": {' && { echo "$R"; return 0; }
    sleep 2
  done
  echo "${R:-{}}"
  return 1
}

if run TSO.1; then
echo "===== TSO.1 prompt 带 format：structured 结果 ====="
S=$(new_session)
C=$(curl -s -o /dev/null -w "%{http_code}" -m 30 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S/prompt" -d '{"text":"北京是中国的首都吗？","format":{"type":"json_schema","schema":{"type":"object","properties":{"answer":{"type":"boolean"},"city":{"type":"string"}},"required":["answer","city"]}}}')
R=$(wait_structured "$S" 45 || true)
OK=$(echo "$R" | python3 -c "
import json,sys
d=json.load(sys.stdin)
s=d.get('structured') or {}
ok = d.get('user_format')=='json_schema' and set(s.keys())=={'answer','city'} and isinstance(s.get('answer'),bool) and isinstance(s.get('city'),str)
print('ok' if ok else f'bad {json.dumps(d,ensure_ascii=False)}')" 2>/dev/null)
if [ "$C" = "200" ] && [ "$OK" = "ok" ]; then pass "TSO.1（structured 结构符合 schema）" "$R"; else fail "TSO.1" "http=$C r=$R"; fi
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run TSO.2; then
echo "===== TSO.2 消息回读：列表 GET format/structured ====="
S=$(new_session)
api -X POST "$BASE/api/session/$S/prompt" -d '{"text":"天空是什么颜色？单个中文词回答","format":{"type":"json_schema","schema":{"type":"object","properties":{"color":{"type":"string"}},"required":["color"]}}}' >/dev/null
R=$(wait_structured "$S" 45 || true)
C2=$(api -o /tmp/tso2.json -w "%{http_code}" "$BASE/api/session/$S/message")
OK=$(python3 -c "
import json
d=json.load(open('/tmp/tso2.json')).get('data',[])
u=[m for m in d if m.get('type')=='user']
a=[m for m in d if m.get('type')=='assistant']
ok = u and (u[0].get('format') or {}).get('type')=='json_schema' and a and a[0].get('structured') is not None
print('ok' if ok else 'bad-fields')" 2>/dev/null)
if [ "$C2" = "200" ] && [ "$OK" = "ok" ]; then pass "TSO.2（列表 200；user.format=json_schema；assistant.structured 回读）" ""; else fail "TSO.2" "http=$C2 ok=$OK"; fi
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run TSO.3; then
echo "===== TSO.3 异步 admission + 轮询 structured ====="
S=$(new_session)
C=$(curl -s -o /dev/null -w "%{http_code}" -m 30 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S/prompt" -d '{"text":"一周有几天？","format":{"type":"json_schema","schema":{"type":"object","properties":{"days":{"type":"integer"}},"required":["days"]}}}')
R=$(wait_structured "$S" 45 || true)
OK=$(echo "$R" | python3 -c "
import json,sys
d=json.load(sys.stdin)
s=d.get('structured') or {}
print('ok' if isinstance(s.get('days'),int) else 'bad')" 2>/dev/null)
if [ "$C" = "200" ] && [ "$OK" = "ok" ]; then pass "TSO.3（异步 admission 200 + structured 落库）" "$R"; else fail "TSO.3" "http=$C r=$R"; fi
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run TSO.4; then
echo "===== TSO.4 prompt_stream 带 format：流内 StructuredOutput 工具调用 ====="
S=$(new_session)
curl -s -N -m 120 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S/prompt_stream" -d '{"text":"一年有多少天？（整数）","format":{"type":"json_schema","schema":{"type":"object","properties":{"days":{"type":"integer"}},"required":["days"]}}}' > /tmp/tso4.log
E4=$?
R=$(python3 -c "
import json
last=None; tool_input=None
for l in open('/tmp/tso4.log'):
    if not l.startswith('data: '): continue
    d=json.loads(l[6:])
    last=d.get('type')
    if d.get('type')=='session.tool.called' and d.get('data',{}).get('id','').startswith(''):
        tool_input=d.get('data',{}).get('input')
print(json.dumps({'last': last, 'structured': tool_input}, ensure_ascii=False))" 2>/dev/null)
OK=$(echo "$R" | python3 -c "
import json,sys
d=json.load(sys.stdin)
s=d.get('structured') or {}
print('ok' if d.get('last')=='session.execution.succeeded' and isinstance(s.get('days'),int) else 'bad')" 2>/dev/null)
if [ "$E4" = "0" ] && [ "$OK" = "ok" ]; then pass "TSO.4（流含 StructuredOutput 调用，succeeded 关流，curl=0）" "$R"; else fail "TSO.4" "exit=$E4 r=$R"; fi
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run TSO.5; then
echo "===== TSO.5 非法 format → 400 ====="
S=$(new_session)
C1=$(curl -s -o /tmp/tso5.json -w "%{http_code}" -m 15 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S/prompt" -d '{"text":"hi","format":{"type":"xml","schema":{}}}')
C2=$(curl -s -o /dev/null -w "%{http_code}" -m 15 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S/prompt" -d '{"text":"hi","format":{"type":"json_schema","schema":42}}')
if [ "$C1" = "400" ] && [ "$C2" = "400" ]; then pass "TSO.5（type=xml → 400；schema=42 → 400）" ""; else fail "TSO.5" "xml=$C1 schema42=$C2"; fi
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run TSO.6; then
echo "===== TSO.6 显式 text format：普通文本不受影响 ====="
S=$(new_session)
api -X POST "$BASE/api/session/$S/prompt" -d '{"text":"只回复两个字：收到","format":{"type":"text"}}' >/dev/null
R=""
for _ in $(seq 1 45); do
  R=$(api "$BASE/api/session/$S/message" | python3 -c "
import json,sys
d=json.load(sys.stdin).get('data',[])
a=[m for m in d if m.get('type')=='assistant']
done=[m for m in a if any(p.get('type')=='text' and p.get('text','').strip() for p in m.get('content',[]))]
print(json.dumps({'text': next(p['text'] for p in done[-1]['content'] if p.get('type')=='text') if done else None, 'structured': done[-1].get('structured') if done else 'WAIT'}, ensure_ascii=False))" 2>/dev/null)
  echo "$R" | grep -q '"structured": null' && { echo "$R" | grep -q '"text": "' && break; }
  sleep 2
done
OK=$(echo "$R" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('ok' if d.get('structured') is None and d.get('text') else 'bad')" 2>/dev/null)
if [ "$OK" = "ok" ]; then pass "TSO.6（structured=null + 正常文本回复）" "$R"; else fail "TSO.6" "$R"; fi
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run TSO.7; then
echo "===== TSO.7 存量脏 format 容错 ====="
S=$(new_session)
api -X POST "$BASE/api/session/$S/prompt" -d '{"text":"只回复OK","format":{"type":"json_schema","schema":{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}}}' >/dev/null
R=$(wait_structured "$S" 45 || true)
echo "$R" | grep -q '"structured": {' || { fail "TSO.7" "前置 structured 未产出: $R"; api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1; exit 0; }
PGRES=$(psql "$PG_URL" -c "UPDATE session_message SET data = jsonb_set(data::jsonb, '{format}', '{\"type\":\"xml\",\"legacy\":true}'::jsonb)::text WHERE session_id='$S' AND type='user'" 2>&1 | head -1)
C7=$(api -o /tmp/tso7.json -w "%{http_code}" "$BASE/api/session/$S/message")
OK=$(python3 -c "
import json
d=json.load(open('/tmp/tso7.json')).get('data',[])
u=[m for m in d if m.get('type')=='user']
a=[m for m in d if m.get('type')=='assistant' and m.get('structured') is not None]
ok = u and u[0].get('format') is None and a
print('ok' if ok else f'bad user_format={u[0].get(\"format\") if u else None}')" 2>/dev/null)
if [ "$C7" = "200" ] && [ "$OK" = "ok" ]; then pass "TSO.7（脏 format 丢弃，GET 200，structured 仍在）" "pg=$PGRES"; else fail "TSO.7" "http=$C7 ok=$OK pg=$PGRES"; fi
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

echo ""
echo "===== 结果: PASS=$PASS FAIL=$FAIL SKIP=$SKIP ====="
exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
