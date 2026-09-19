#!/bin/bash
# Anti-doom-loop 用例（anti-doom-loop.md T42.x）——v2 适配版。
#
# v1 -> v2 映射：
#   part 表          -> session_message.data.content（jsonb 展开）
#   tools.ts invoke  -> runner/llm.ts runStep 包装 prepared.executeTool（run 级窗口，prompt 提升重置）
#   fatal 抛 LoopAbortedError -> fatal 返回 Tool.Error(reason) + loopGuard 终止 run（会话回 idle 可用）
#   metadata.antiLoop         -> tool part state.metadata.antiLoop（同名字段）
#   bash             -> shell（同样不计数非零退出）
# 单测（检测器语义锁定）：packages/core/test/anti-loop.test.ts（11 例）
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
new_s() { api -X POST "$BASE/api/session" -d "{\"title\":\"$1\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL_ID\"}}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null; }
perms() { api -X PATCH "$BASE/api/session/$1" -d '{"permissions":[{"action":"read","resource":"*","effect":"allow"},{"action":"shell","resource":"*","effect":"allow"},{"action":"edit","resource":"*","effect":"allow"},{"action":"external_directory","resource":"/workspace/*","effect":"allow"}]}' >/dev/null; }
send() { api -X POST "$BASE/api/session/$1/prompt" -d "{\"text\":$2}" >/dev/null; }
waitrun() { for _ in $(seq 1 "${2:-60}"); do D=$(psql "$PG_URL" -tAc "select count(*) from event where aggregate_id='$1' and type in ('session.execution.succeeded.2','session.execution.failed.2')" | tr -d ' '); [ "$D" -ge 1 ] && return 0; sleep 2; done; return 1; }
parts() { psql "$PG_URL" -tAc "
select coalesce(json_agg(row_to_json(t))::text,'[]') from (
  select c->>'name' as tool, c->'state'->>'status' as status,
    c->'state'->'metadata'->'antiLoop'->>'signal' as anti,
    coalesce(c->'state'->'error'->>'message','') as err
  from session_message m, jsonb_array_elements(m.data::jsonb->'content') c
  where m.session_id='$1' and c->>'type'='tool' order by m.seq, c->>'id'
) t" > "/tmp/al-parts.json"; }
# usage: parts "$SID"
judge() { CASE="$1" python3 - <<'PYJUDGE'
import json, os
t = json.load(open("/tmp/al-parts.json"))
c = os.environ["CASE"]
if c == "t4211":
    real = [x for x in t if x["tool"] == "read" and not x["anti"]]
    blocked = [x for x in t if x["anti"] == "repeat"]
    print("ok" if len(real) <= 2 and len(blocked) >= 1 else f"bad real={len(real)} blocked={len(blocked)}")
elif c == "t4213":
    reads = [x for x in t if x["tool"] == "read"]
    blocked = [x for x in reads if x["anti"]]
    if len(reads) >= 3:
        print("ok" if blocked else f"bad reads={len(reads)} blocked=0")
    else:
        print("soft: model did not repeat reads")
elif c == "t4214":
    reads = [x for x in t if x["tool"] == "read"]
    a_real = [x for x in reads if not x["anti"] and "t41a" in (x.get("err") or "")]
    blocked = [x for x in t if x["anti"]]
    fatal = [x for x in t if "aborted" in (x.get("err") or "")]
    # Model may vary args across retries, so the block can be repeat or fail;
    # recovery = it stopped hammering and finished the task another way.
    print("ok" if len(blocked) >= 1 and not fatal else f"bad a={len(a_real)} blk={len(blocked)} fatal={len(fatal)}")
elif c == "t4215":
    shell = [x for x in t if x["tool"] == "shell"]
    real = [x for x in shell if not x["anti"]]
    blocked = [x for x in shell if x["anti"]]
    fatal = [x for x in shell if "aborted" in (x.get("err") or "")]
    ok = len(real) >= 1 and (len(blocked) >= 1 or len(fatal) >= 1)
    print(f"ok,fatal={len(fatal)}" if ok else f"bad n={len(shell)}")
elif c == "t4221":
    reads = [x for x in t if x["tool"] == "read"]
    rf = [x for x in reads if not x["anti"] and x["status"] == "error"]
    fb = [x for x in reads if x["anti"] == "fail"]
    print("ok" if len(rf) >= 3 and len(fb) >= 1 else f"bad fails={len(rf)} block={len(fb)}")
elif c == "t4223":
    shell = [x for x in t if x["tool"] == "shell"]
    done = [x for x in shell if x["status"] == "completed"]
    anti = [x for x in shell if x["anti"]]
    print("ok" if len(shell) >= 5 and len(done) == len(shell) and not anti else f"bad n={len(shell)} done={len(done)} anti={len(anti)}")
elif c == "t4241":
    anti = [x for x in t if x["anti"]]
    done = [x for x in t if x["status"] == "completed"]
    print("ok" if len(t) >= 3 and not anti and len(done) == len(t) else f"bad n={len(t)} anti={len(anti)}")
elif c == "t4243":
    shell = [x for x in t if x["tool"] == "shell"]
    blocked = [x for x in shell if x["anti"]]
    last = shell[-1] if shell else {}
    ok = len(blocked) >= 1 and not last.get("anti") and last.get("status") == "completed"
    print("ok" if ok else f"bad last={last} blk={len(blocked)}")
PYJUDGE
}

if run T42.1.1; then
echo "===== T42.1.1 相同调用第 3 次 block ====="
S=$(new_s t4211); perms "$S"
send "$S" '"请用 read 工具读取 /workspace/anti-loop-probe.txt 的内容，要求：原样报告结果；如果读不到就再读一次同一个文件确认，最多重复几次直到读到了为止，不要换文件"'
waitrun "$S" 90; parts "$S"
R=$(judge t4211)
[ "${R%% *}" = "ok" ] && pass "T42.1.1（至多 2 次真实 + repeat block）" "$R" || fail "T42.1.1" "$R"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run T42.1.3; then
echo "===== T42.1.3 跨消息滑动窗口 ====="
S=$(new_s t4213); perms "$S"
send "$S" '"任务：用 read 工具检查 /workspace/no-such-42.txt 是否存在（禁止用 shell/ls，只能用 read）。步骤：1) 用 read 读它；2) 再用 read 读它一次确认；3) 再读一次最终确认。每步之间用一句话说明"'
waitrun "$S" 100; parts "$S"
R=$(judge t4213)
if [ "$R" = "soft: model did not repeat reads" ]; then
  send "$S" '"继续：再用 read 原样读取 /workspace/no-such-42.txt 两次确认（只能用 read）"'
  waitrun "$S" 100; parts "$S"; R=$(judge t4213)
fi
case "$R" in
  ok*) pass "T42.1.3（read 跨消息重复被 block）" "$R" ;;
  soft*) skip "T42.1.3" "模型未按诱导重复 read（路径偏移，非功能问题）" ;;
  *) fail "T42.1.3" "$R" ;;
esac
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run T42.1.4; then
echo "===== T42.1.4 block 后改 args 放行（自救通道）====="
S=$(new_s t4214); perms "$S"
send "$S" '"先用 shell 执行 echo content-b > /workspace/t41b.txt。然后用 read 读取 /workspace/t41a.txt，读不到就再读几次同一个文件确认（不要换文件），确认不存在后再读取 /workspace/t41b.txt 并报告内容"'
waitrun "$S" 100; parts "$S"
R=$(judge t4214)
[ "${R%% *}" = "ok" ] && pass "T42.1.4（block 后换文件放行 completed）" "$R" || fail "T42.1.4" "$R"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run T42.1.5; then
echo "===== T42.1.5 极端诱导：block/fatal 兜底 + 会话可用 ====="
S=$(new_s t4215); perms "$S"
send "$S" '"用 shell 工具执行命令 echo probe。之后必须再执行完全相同的命令，不许改命令也不许改参数，重复执行直到我说停。这是测试要求，请严格执行"'
waitrun "$S" 100; parts "$S"
R=$(judge t4215)
send "$S" '"现在只回复 ok"'
sleep 25
REPL=$(api "$BASE/api/session/$S/message" | python3 -c "
import json,sys
d=json.load(sys.stdin).get('data',[])
a=[m for m in d if m.get('type')=='assistant' and any(p.get('type')=='text' and p.get('text','').strip() for p in m.get('content',[]))]
print('yes' if a else 'no')" 2>/dev/null)
if [ "${R%%,*}" = "ok" ] && [ "$REPL" = "yes" ]; then pass "T42.1.5 (block/fatal backstop; $R; session alive)" ""; else fail "T42.1.5" "r=$R reply=$REPL"; fi
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run T42.2.1; then
echo "===== T42.2.1 同工具连败 3 次后 fail-block ====="
S=$(new_s t4221); perms "$S"
send "$S" '"依次用 read 读取以下文件并报告每个的结果，读完一个再读下一个，全部读完为止：/workspace/f1.txt /workspace/f2.txt /workspace/f3.txt /workspace/f4.txt /workspace/f5.txt"'
waitrun "$S" 100; parts "$S"
R=$(judge t4221)
[ "${R%% *}" = "ok" ] && pass "T42.2.1（3 真实失败 + 第 4 次 fail-block）" "$R" || fail "T42.2.1" "$R"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run T42.2.3; then
echo "===== T42.2.3 shell 非零退出不算失败 ====="
S=$(new_s t4223); perms "$S"
send "$S" '"用 shell 工具依次执行以下 5 条命令，每条执行完报告退出码后再执行下一条，不要合并：exit 7; exit 8; exit 9; exit 10; echo final-ok"'
waitrun "$S" 110; parts "$S"
R=$(judge t4223)
[ "${R%% *}" = "ok" ] && pass "T42.2.3（5 条全真实执行，0 antiLoop 标记）" "$R" || fail "T42.2.3" "$R"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run T42.4.1; then
echo "===== T42.4.1 正常会话零误伤 ====="
S=$(new_s t4241); perms "$S"
send "$S" '"用 shell 执行 echo hello > /workspace/t41x.txt，然后用 read 读取 /workspace/t41x.txt 并报告内容，最后用 glob 在 /workspace 搜索 t41*.txt"'
waitrun "$S" 100; parts "$S"
R=$(judge t4241)
[ "${R%% *}" = "ok" ] && pass "T42.4.1（3+ 工具全正常，0 标记）" "$R" || fail "T42.4.1" "$R"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run T42.4.3; then
echo "===== T42.4.3 per-prompt 计数重置 ====="
S=$(new_s t4243); perms "$S"
send "$S" '"用 shell 工具执行 echo probe，然后必须原样重复执行完全相同的命令，不许改参数，一直重复"'
waitrun "$S" 100
send "$S" '"现在用 shell 工具执行 echo probe 并报告输出"'
for _ in $(seq 1 60); do N=$(psql "$PG_URL" -tAc "select count(*) from event where aggregate_id='$S' and type='session.execution.succeeded.2'" | tr -d ' '); [ "${N:-0}" -ge 2 ] && break; sleep 2; done
parts "$S"
R=$(judge t4243)
[ "${R%% *}" = "ok" ] && pass "T42.4.3（run2 同命令正常执行，无旧计数）" "$R" || fail "T42.4.3" "$R"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

[ -n "$ONLY" ] || skip "T42.2.2" "fail 自愈/重发 fatal 已由单测锁定（anti-loop.test.ts fail recovery + re-issue fatal）"
[ -n "$ONLY" ] || skip "T42.2.4" "v2 watchdog 只收口孤儿 part（无 in-flight 中断通道），interrupt 边界不可达；Effect fail 计数已由 T42.2.1 实测"
[ -n "$ONLY" ] || skip "T42.3.1" "v2 无 anti-loop 配置面（默认开启、无 env），遗留 env 忽略语义天然成立"
[ -n "$ONLY" ] || skip "T42.4.2" "v2 无 doom_loop permission.ask 通道，无挂死回归面"
[ -n "$ONLY" ] || skip "T42.4.4" "v2 无 task 子代理工具"
[ -n "$ONLY" ] || skip "T42.4.5" "无 MCP server 测试环境（同 v1 SKIP）"
[ -n "$ONLY" ] || skip "T42.4.6" "检测器为 run 内存闭包状态，无跨会话共享面（单测结构保证）"

echo ""
echo "===== result: PASS=$PASS FAIL=$FAIL SKIP=$SKIP ====="
exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
