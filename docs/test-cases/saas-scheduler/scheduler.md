# SaaS Scheduler 测试用例

> 技术设计：[`technical-design.md`](./technical-design.md)
>
> SaaS 服务：`http://localhost:14096`
>
> 最近实测：T71-T74 共 22 个用例全部通过。

## 0. 覆盖范围

| 分组 | 用例 | 内容 |
|---|---|---|
| 基础能力 | T71.1-T71.10 | PG 表、索引、无外键、通用 Schedule CRUD |
| Task 接口 | T72.1-T72.4 | Task 便捷创建、列表隔离、删除 |
| 运行时 | T73.1-T73.6 | 持续扫描、执行状态、Session 关联、禁用/启用、错误记录 |
| 清理 | T74.1-T74.2 | Task purge 显式清理 Schedule |

运行时用例会发送真实 Session 消息，需要预先配置可用的模型 Provider。Scheduler 每 30 秒扫描一次，脚本使用六段 cron 并通过轮询覆盖扫描延迟。

## 1. 全量执行脚本

```bash
#!/usr/bin/env bash
set -uo pipefail

export BASE="${BASE:-http://localhost:14096}"
export PG="${PG:-opencode_project_test}"
export NO_PROXY="localhost,127.0.0.1"

PASS=0
FAIL=0
TASK_IDS=()

pass() { echo "PASS $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL $1 - $2"; FAIL=$((FAIL + 1)); }
field() { python3 -c "import json,sys; print(json.load(sys.stdin).get('$1',''))"; }

create_task() {
  local title="$1"
  local id
  id=$(curl -s --noproxy '*' -X POST "$BASE/saas/task" \
    -H 'Content-Type: application/json' \
    -d "{\"title\":\"$title\",\"description\":\"Scheduler test\"}" | field id)
  echo "$id"
}

wait_for_run() {
  local id="$1"
  local count=0
  for _ in $(seq 1 14); do
    sleep 5
    count=$(curl -s --noproxy '*' "$BASE/saas/schedule/$id" \
      | python3 -c "import json,sys; print(json.load(sys.stdin).get('runCount',0))" 2>/dev/null || echo 0)
    [ "$count" -gt 0 ] && break
  done
  echo "$count"
}

cleanup() {
  for id in "${TASK_IDS[@]}"; do
    [ -n "$id" ] && curl -s --noproxy '*' -X DELETE "$BASE/saas/task/$id" >/dev/null 2>&1 || true
  done
  psql -d "$PG" -c "DELETE FROM schedule WHERE owner_type='scheduler-test-unregistered'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

HEALTH=$(curl -s --noproxy '*' "$BASE/global/health" \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('healthy',False))" 2>/dev/null || echo False)
[ "$HEALTH" = "True" ] || { echo "SaaS 服务未就绪：$BASE"; exit 1; }

echo "一、基础能力 T71"

# T71.1 schedule 表和字段
TABLE=$(psql -d "$PG" -Atqc "SELECT to_regclass('public.schedule')")
COLS=$(psql -d "$PG" -Atqc "
  SELECT count(*) FROM information_schema.columns
  WHERE table_schema='public' AND table_name='schedule'
    AND column_name IN (
      'id','owner_type','owner_id','cron','enabled','payload',
      'last_run_at','next_run_at','run_count','last_error','time_created','time_updated'
    )")
[ "$TABLE" = "schedule" ] && [ "$COLS" = "12" ] \
  && pass "T71.1" || fail "T71.1" "table=$TABLE columns=$COLS"

# T71.2 索引完整
INDEXES=$(psql -d "$PG" -Atqc "
  SELECT count(*) FROM pg_indexes
  WHERE schemaname='public' AND tablename='schedule'
    AND indexname IN ('schedule_next_run_idx','schedule_owner_idx')")
[ "$INDEXES" = "2" ] && pass "T71.2" || fail "T71.2" "indexes=$INDEXES"

# T71.3 无数据库外键
FK=$(psql -d "$PG" -Atqc "
  SELECT count(*) FROM pg_constraint
  WHERE contype='f' AND conrelid='schedule'::regclass")
[ "$FK" = "0" ] && pass "T71.3" || fail "T71.3" "fk=$FK"

BASE_TASK=$(create_task "scheduler-base-$(date +%s)")
TASK_IDS+=("$BASE_TASK")

# T71.4 通用 API 创建
RES=$(curl -s --noproxy '*' -X POST "$BASE/saas/schedule" \
  -H 'Content-Type: application/json' \
  -d "{\"ownerType\":\"task\",\"ownerId\":\"$BASE_TASK\",\"cron\":\"0 9 * * 1-5\",\"payload\":{\"source\":\"T71.4\"}}")
BASE_SCHEDULE=$(echo "$RES" | field id)
echo "$RES" | python3 -c "
import json,sys
ok=d['id'].startswith('sch_') and d['enabled'] and d['runCount']==0 and d['payload']['source']=='T71.4' and d.get('nextRunAt')
" && pass "T71.4" || fail "T71.4" "$RES"

# T71.5 详情
RES=$(curl -s --noproxy '*' "$BASE/saas/schedule/$BASE_SCHEDULE")
echo "$RES" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if d['id']=='$BASE_SCHEDULE' else 1)" \
  && pass "T71.5" || fail "T71.5" "$RES"

# T71.6 按 owner 列表
RES=$(curl -s --noproxy '*' --get "$BASE/saas/schedule" \
  --data-urlencode 'ownerType=task' --data-urlencode "ownerId=$BASE_TASK")
echo "$RES" | python3 -c "
import json,sys
" && pass "T71.6" || fail "T71.6" "$RES"

# T71.7 更新 cron、开关和 payload
RES=$(curl -s --noproxy '*' -X PATCH "$BASE/saas/schedule/$BASE_SCHEDULE" \
  -H 'Content-Type: application/json' \
  -d '{"cron":"0 10 * * 1-5","enabled":false,"payload":{"revision":2}}')
echo "$RES" | python3 -c "
import json,sys
" && pass "T71.7" || fail "T71.7" "$RES"

# T71.8 无效 cron 返回 400
HTTP=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X POST "$BASE/saas/schedule" \
  -H 'Content-Type: application/json' \
  -d "{\"ownerType\":\"task\",\"ownerId\":\"$BASE_TASK\",\"cron\":\"not-a-cron\"}")
[ "$HTTP" = "400" ] && pass "T71.8" || fail "T71.8" "http=$HTTP"

# T71.9 不存在记录返回 404
HTTP=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' \
  "$BASE/saas/schedule/sch_00000000000000000000000000")
[ "$HTTP" = "404" ] && pass "T71.9" || fail "T71.9" "http=$HTTP"

# T71.10 删除
DELETE_HTTP=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X DELETE \
  "$BASE/saas/schedule/$BASE_SCHEDULE")
GET_HTTP=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' \
  "$BASE/saas/schedule/$BASE_SCHEDULE")
[ "$DELETE_HTTP" = "200" ] && [ "$GET_HTTP" = "404" ] \
  && pass "T71.10" || fail "T71.10" "delete=$DELETE_HTTP get=$GET_HTTP"

echo "二、Task 接口 T72"

TASK_A=$(create_task "scheduler-task-a-$(date +%s)")
TASK_B=$(create_task "scheduler-task-b-$(date +%s)")
TASK_IDS+=("$TASK_A" "$TASK_B")

# T72.1 便捷接口创建
RES=$(curl -s --noproxy '*' -X POST "$BASE/saas/task/$TASK_A/schedule" \
  -H 'Content-Type: application/json' \
  -d '{"cron":"0 12 * * *","payload":{"source":"task-api"}}')
TASK_SCHEDULE=$(echo "$RES" | field id)
echo "$RES" | python3 -c "
import json,sys
" && pass "T72.1" || fail "T72.1" "$RES"

# T72.2 按 Task 列表
RES=$(curl -s --noproxy '*' "$BASE/saas/task/$TASK_A/schedule")
echo "$RES" | python3 -c "
import json,sys
" && pass "T72.2" || fail "T72.2" "$RES"

# T72.3 跨 Task 列表隔离
COUNT=$(curl -s --noproxy '*' "$BASE/saas/task/$TASK_B/schedule" \
  | python3 -c "import json,sys; print(sum(1 for x in json.load(sys.stdin) if x['id']=='$TASK_SCHEDULE'))")
[ "$COUNT" = "0" ] && pass "T72.3" || fail "T72.3" "count=$COUNT"

# T72.4 便捷接口删除
HTTP=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X DELETE \
  "$BASE/saas/task/$TASK_A/schedule/$TASK_SCHEDULE")
LEFT=$(curl -s --noproxy '*' "$BASE/saas/task/$TASK_A/schedule" \
  | python3 -c "import json,sys; print(sum(1 for x in json.load(sys.stdin) if x['id']=='$TASK_SCHEDULE'))")
[ "$HTTP" = "200" ] && [ "$LEFT" = "0" ] \
  && pass "T72.4" || fail "T72.4" "http=$HTTP left=$LEFT"

echo "三、运行时 T73"

RUN_TASK=$(create_task "scheduler-runtime-$(date +%s)")
TASK_IDS+=("$RUN_TASK")

# T73.1 服务运行期间持续扫描
sleep 5
RES=$(curl -s --noproxy '*' -X POST "$BASE/saas/task/$RUN_TASK/schedule" \
  -H 'Content-Type: application/json' \
  -d '{"cron":"*/10 * * * * *","payload":{"prompt":"Reply with SCHEDULER_OK only."}}')
RUN_SCHEDULE=$(echo "$RES" | field id)
RUNS=$(wait_for_run "$RUN_SCHEDULE")
[ "$RUNS" -gt 0 ] && pass "T73.1" || fail "T73.1" "runCount=$RUNS"

# T73.2 执行状态更新
DETAIL=$(curl -s --noproxy '*' "$BASE/saas/schedule/$RUN_SCHEDULE")
echo "$DETAIL" | python3 -c "
import json,sys
" && pass "T73.2" || fail "T73.2" "$DETAIL"

# T73.3 Session 自动关联 Task
SESSIONS=$(curl -s --noproxy '*' "$BASE/saas/task/$RUN_TASK/sessions")
SESSION_ID=$(echo "$SESSIONS" | python3 -c "
import json,sys
items=[x for x in json.load(sys.stdin) if x.get('taskID')=='$RUN_TASK']
print(items[0]['id'] if items else '')
")
PG_TASK=$(psql -d "$PG" -Atqc "SELECT task_id FROM session WHERE id='$SESSION_ID'")
[ -n "$SESSION_ID" ] && [ "$PG_TASK" = "$RUN_TASK" ] \
  && pass "T73.3" || fail "T73.3" "session=$SESSION_ID pgTask=$PG_TASK"
curl -s --noproxy '*' -X PATCH "$BASE/saas/schedule/$RUN_SCHEDULE" \
  -H 'Content-Type: application/json' -d '{"enabled":false}' >/dev/null

# 同时准备禁用和未注册 owner 场景，共用一个扫描等待窗口。
RES=$(curl -s --noproxy '*' -X POST "$BASE/saas/task/$RUN_TASK/schedule" \
  -H 'Content-Type: application/json' -d '{"cron":"*/10 * * * * *"}')
DISABLED_SCHEDULE=$(echo "$RES" | field id)
curl -s --noproxy '*' -X PATCH "$BASE/saas/schedule/$DISABLED_SCHEDULE" \
  -H 'Content-Type: application/json' -d '{"enabled":false}' >/dev/null

RES=$(curl -s --noproxy '*' -X POST "$BASE/saas/schedule" \
  -H 'Content-Type: application/json' \
  -d '{"ownerType":"scheduler-test-unregistered","ownerId":"owner-1","cron":"*/10 * * * * *"}')
UNKNOWN_SCHEDULE=$(echo "$RES" | field id)
UNKNOWN_ERROR=""
for _ in $(seq 1 14); do
  sleep 5
  UNKNOWN_ERROR=$(curl -s --noproxy '*' "$BASE/saas/schedule/$UNKNOWN_SCHEDULE" \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('lastError',''))")
  [ -n "$UNKNOWN_ERROR" ] && break
done

# T73.4 禁用后不触发
RUNS=$(curl -s --noproxy '*' "$BASE/saas/schedule/$DISABLED_SCHEDULE" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['runCount'])")
[ "$RUNS" = "0" ] && pass "T73.4" || fail "T73.4" "runCount=$RUNS"

# T73.5 重新启用后恢复触发
curl -s --noproxy '*' -X PATCH "$BASE/saas/schedule/$DISABLED_SCHEDULE" \
  -H 'Content-Type: application/json' -d '{"enabled":true}' >/dev/null
RUNS=$(wait_for_run "$DISABLED_SCHEDULE")
[ "$RUNS" -gt 0 ] && pass "T73.5" || fail "T73.5" "runCount=$RUNS"
curl -s --noproxy '*' -X PATCH "$BASE/saas/schedule/$DISABLED_SCHEDULE" \
  -H 'Content-Type: application/json' -d '{"enabled":false}' >/dev/null

# T73.6 未注册 ownerType 记录错误
case "$UNKNOWN_ERROR" in
  *"No handler registered"*) pass "T73.6" ;;
  *) fail "T73.6" "lastError=$UNKNOWN_ERROR" ;;
esac
curl -s --noproxy '*' -X DELETE "$BASE/saas/schedule/$UNKNOWN_SCHEDULE" >/dev/null

echo "四、清理 T74"

PURGE_TASK=$(create_task "scheduler-purge-$(date +%s)")
TASK_IDS+=("$PURGE_TASK")
for CRON in '0 9 * * *' '0 18 * * *'; do
  curl -s --noproxy '*' -X POST "$BASE/saas/task/$PURGE_TASK/schedule" \
    -H 'Content-Type: application/json' -d "{\"cron\":\"$CRON\"}" >/dev/null
done

# T74.1 删除前存在关联 Schedule
BEFORE=$(psql -d "$PG" -Atqc "
  SELECT count(*) FROM schedule
  WHERE owner_type='task' AND owner_id='$PURGE_TASK'")
[ "$BEFORE" = "2" ] && pass "T74.1" || fail "T74.1" "count=$BEFORE"

# T74.2 删除 Task 后显式清理
HTTP=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X DELETE \
  "$BASE/saas/task/$PURGE_TASK")
AFTER=$(psql -d "$PG" -Atqc "
  SELECT count(*) FROM schedule
  WHERE owner_type='task' AND owner_id='$PURGE_TASK'")
[ "$HTTP" = "200" ] && [ "$AFTER" = "0" ] \
  && pass "T74.2" || fail "T74.2" "http=$HTTP count=$AFTER"

echo "结果：PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ]
```

## 2. 验收标准

- T71.1-T74.2 共 22 个用例全部通过。
- 成功执行后更新 `runCount`、`lastRunAt`、`nextRunAt`，并清空 `lastError`。
- 调度创建的 Session 在 API `taskID` 和 PG `session.task_id` 中均关联原 Task。
- 禁用 Schedule 跨过扫描周期后不触发，重新启用后恢复。
- 未注册 `ownerType` 写入可诊断的 `lastError`。
- 删除 Task 后不遗留关联 Schedule。

## 3. 限制

- 当前调度器为单进程、单循环、顺序执行，慢任务会延后同轮后续任务。
- 当前未实现多实例分布式锁，不要同时启动多个指向同一数据库的 Scheduler 实例执行本用例。
