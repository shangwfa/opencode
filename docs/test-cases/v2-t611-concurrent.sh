#!/bin/bash
# T6.11 单用例：20 会话并发（分批提交版）
set -u
BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-v2-test-pass}"
DIRECTORY="${DIRECTORY:-/workspace}"
PROVIDER="${PROVIDER:-Yd-DeepSeek}"
MODEL="${MODEL:-deepseek-v4-flash}"
WAIT_SECONDS="${WAIT_SECONDS:-180}"

api() { curl -s -m 200 -u "opencode:$PASSWORD" -H "x-opencode-directory: $DIRECTORY" -H "content-type: application/json" "$@"; }
api_code() { curl -s -o /dev/null -w "%{http_code}" -m 30 -u "opencode:$PASSWORD" -H "x-opencode-directory: $DIRECTORY" -H "content-type: application/json" "$@"; }
new_session() { api -X POST "$BASE/api/session" -d "{\"title\":\"$1\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL\"}}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null; }
msg_count() { api "$BASE/api/session/$1/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null || echo 0; }

echo "== T6.11 20 会话并发（分 4 批 × 5）=="
SIDS=""
for i in $(seq 1 20); do SIDS="$SIDS $(new_session "t611b-$i")"; done
echo "创建 $(printf '%s' $SIDS | wc -w | tr -d ' ') 个会话"

: > /tmp/t611-codes.txt
BATCH=0
for SID in $SIDS; do
  BATCH=$((BATCH + 1))
  ( C=$(api_code -X POST "$BASE/api/session/$SID/prompt" -d '{"text":"回复一个字：好"}'); echo "$C" >> /tmp/t611-codes.txt ) &
  if [ $((BATCH % 5)) = 0 ]; then echo "   批次 $((BATCH / 5)) 已提交"; sleep 3; fi
done
wait
echo "--- HTTP 统计 ---"
sort /tmp/t611-codes.txt | uniq -c

echo "--- 等待（最多 ${WAIT_SECONDS}s）==="
TOTAL=0; ASSIST=0; PEND=0
for SID in $SIDS; do
  waited=0; ok=0
  while [ "$waited" -lt "$WAIT_SECONDS" ]; do
    n=$(msg_count "$SID")
    if [ "$n" -ge 2 ]; then ok=1; break; fi
    sleep 5; waited=$((waited+5))
  done
  if [ "$ok" = "1" ]; then
    TOTAL=$((TOTAL+n))
    A=$(api "$BASE/api/session/$SID/message" | python3 -c "import json,sys;print(sum(1 for m in json.load(sys.stdin).get('data',[]) if m.get('type')=='assistant' and m.get('finish')))" 2>/dev/null || echo 0)
    ASSIST=$((ASSIST+A))
  else
    PEND=$((PEND+1))
  fi
done
echo "完成assistant=$ASSIST 超时=$PEND"
HTTP_OK=$(grep -c "^200$" /tmp/t611-codes.txt || true)
if [ "$HTTP_OK" -ge 18 ] && [ "$ASSIST" -ge 15 ]; then
  echo "✅ T6.11 PASS（admission 200: $HTTP_OK/20，assistant 完成 $ASSIST/20）"
else
  echo "❌ T6.11 FAIL: http200=$HTTP_OK assistant=$ASSIST pending=$PEND"
fi
for SID in $SIDS; do api -X DELETE "$BASE/api/session/$SID" >/dev/null 2>&1; done
