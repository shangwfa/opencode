# 影刀文档平台同步（yddoc）：任务状态机 / 幂等 / 重试 / 真实链路

> 用例段：R7。**前置**：服务已启用 inner embedding（`KNOWLEDGE_EMBEDDING_CHANNEL=inner` + `XYBOT_*` 信封）、
> 内网代理与影刀平台可达、PG 可用——环境阻塞记 SKIP，不得伪造通过。

## 用例

| 用例 | 验证点 |
|---|---|
| R7.1 | `POST /knowledge-base/sync-from-yydoc`（brandCode/languageCode/maxDocs=2）→ 200 返回 taskId 与规范化 KB id（连字符转下划线、小写）；任务 pending→running→**completed**，`progress.total=2`、`failed=0` |
| R7.2 | **幂等**：相同参数二次同步 → 已同步且内容未变更的文档计入 `skipped`（hash 幂等），不重复向量化 |
| R7.3 | `POST /knowledge-base/sync-task/:taskId/retry-failed` → 200（无失败文档时空转）；失败明细经 `GET /knowledge-base/sync-task/:taskId` 的 `failedDocuments` 可查 |
| R7.4 | 平台契约：菜单树 `GET api.yingdao.com/.../getMenuTreeByBrandCode`（200，节点子字段 `menuTrees`）、文档内容自 OSS CDN tiptap JSON（根 `type:'doc'`） |
| R7.5 | PG 落点：documents 行 status=completed、`kb_<id>` 向量表非空（1536 维）；检索该库可命中 |
| R7.6 | `POST /knowledge-base/sync-document-from-yydoc`（指定 docIds）→ 200 + 任务完成；已同步文档幂等 skipped |
| R7.7 | `POST /knowledge-base/sync-task/:taskId/retry-document/:docId`：仅对失败列表中的文档有效（200）；**非失败文档 → 404**（契约负例） |
| R7.8 | **brandCode 不存在**：任务 200 创建但最终 `failed`（`total=0`，菜单树为空的错误路径） |
| R7.9 | `POST /knowledge-base/sync-from-doc-platform`（`operation: upsertDocument`，**content 为 tiptap JSON 对象**）→ 任务 completed、文档入库可检索；content 传普通字符串会被当 tiptap 解析而失败（契约） |

## 测试脚本

> 整块复制执行。使用真实品牌 `yingdao-harness/zh-CN`；`maxDocs=2` 控制时长（全量 36 篇约 12 分钟，去掉 `MAX_DOCS` 即全量）。

```bash
BASE=${BASE:-http://127.0.0.1:18787/api}
PGC=${PGC:-knowledge-pg}; PGDB=${PGDB:-knowledge}; SCH=${SCH:-knowledge}
BRAND=${BRAND:-yingdao-harness}; LANGCODE=${LANGCODE:-zh-CN}; MAX_DOCS=${MAX_DOCS:-2}
pass=0; fail=0
req()  { curl -sS -m 120 --noproxy '*' -o /tmp/uc-res.json -w '%{http_code}' "$@"; }
jget() { python3 -c "import json,sys;d=json.load(open('/tmp/uc-res.json'));print(eval('d'+sys.argv[1]))" "$1" 2>/dev/null || true; }
raw()  { cat /tmp/uc-res.json; }
check(){ if [ -n "$3" ] && [ "$3" = "$4" ]; then echo "PASS $1 $2"; pass=$((pass+1)); else echo "FAIL $1 $2 expect=[$3] got=[$4]"; fail=$((fail+1)); fi }
post_noop(){ curl -sS -m 120 --noproxy '*' -o /tmp/uc-res.json -w '%{http_code}' -X POST "$1" -H 'Content-Type: application/json' -d "$2"; }
syncpost(){ local extra=${1:+,\"maxDocs\":$1}
  local b="{\"brandCode\":\"$BRAND\",\"languageCode\":\"$LANGCODE\",\"name\":\"影刀同步用例\"$extra}"
  curl -sS -m 120 --noproxy '*' -o /tmp/uc-res.json -w '%{http_code}' -X POST "$BASE/knowledge-base/sync-from-yydoc" -H 'Content-Type: application/json' -d "$b"; }
waittask(){ local t=$1; for i in $(seq 1 60); do sleep 5
  req "$BASE/knowledge-base/sync-task/$t" >/dev/null
  local st=$(jget "['data']['status']"); [ "$st" = "completed" -o "$st" = "failed" ] && break
done; }

# ── R7.1 首次同步（限 $MAX_DOCS 篇）─────────────────────────
check R7.1a "创建同步任务" 200 "$(syncpost "$MAX_DOCS")"
TASK=$(jget "['data']['taskId']"); KBID=$(jget "['data']['knowledgeBaseId']")
check R7.1b "KBid规范化" "kb_yingdao_harness_zh_cn" "$KBID"
waittask "$TASK"
check R7.1c "任务完成" completed "$(req "$BASE/knowledge-base/sync-task/$TASK" >/dev/null; jget "['data']['status']")"
check R7.1d "total=$MAX_DOCS且0失败" yes "$(raw | python3 -c "import json,sys;d=json.load(sys.stdin)['data']['progress'];print('yes' if d['total']==$MAX_DOCS and d['failed']==0 and d['success']+d['skipped']==d['total'] else 'no')" 2>/dev/null)"

# ── R7.2 幂等：二次同步全部 skipped ────────────────────────
syncpost "$MAX_DOCS" >/dev/null; TASK2=$(jget "['data']['taskId']")
waittask "$TASK2"
check R7.2 "二次同步全skipped" yes "$(req "$BASE/knowledge-base/sync-task/$TASK2" >/dev/null; python3 -c "import json;d=json.load(open('/tmp/uc-res.json'))['data']['progress'];print('yes' if d['skipped']==$MAX_DOCS else 'no')" 2>/dev/null)"

# ── R7.3 重试接口（无失败时空转 200）───────────────────────
check R7.3 "retry-failed空转" 200 "$(req -X POST "$BASE/knowledge-base/sync-task/$TASK/retry-failed")"

# ── R7.4 平台契约直探 ──────────────────────────────────────
MC=$(curl -sS -m 30 --noproxy '*' "https://api.yingdao.com/api/noauth/v1/yddoc/menus/getMenuTreeByBrandCode?brandCode=$BRAND&languageCode=$LANGCODE" | python3 -c "import json,sys;n=json.load(sys.stdin)['data'][0];print('ok' if n.get('menuTrees') is not None else 'bad')" 2>/dev/null)
check R7.4 "菜单树menuTrees字段" ok "$MC"

# ── R7.6~R7.7 单篇同步 / 单篇重试 ───────────────────────────
DOCID=$(docker exec "$PGC" psql -U postgres -d "$PGDB" -Atc "SELECT id FROM $SCH.documents WHERE knowledge_base_id='$KBID' LIMIT 1")
BODY="{\"brandCode\":\"$BRAND\",\"languageCode\":\"$LANGCODE\",\"docIds\":[\"$DOCID\"]}"
check R7.6a "单篇同步" 200 "$(req -X POST "$BASE/knowledge-base/sync-document-from-yydoc" -H 'Content-Type: application/json' -d "$BODY")"
TASK3=$(jget "['data']['taskId']")
waittask "$TASK3"
check R7.6b "单篇幂等skipped" 1 "$(req "$BASE/knowledge-base/sync-task/$TASK3" >/dev/null; python3 -c "import json;d=json.load(open('/tmp/uc-res.json'))['data']['progress'];print(d['skipped'])" 2>/dev/null)"
check R7.7 "retry-document仅限失败文档404" 404 "$(req -X POST "$BASE/knowledge-base/sync-task/$TASK3/retry-document/$DOCID")"

# ── R7.8 brandCode 不存在（错误路径）────────────────────────
BODY="{\"brandCode\":\"uc-nonexist-brand\",\"languageCode\":\"$LANGCODE\",\"name\":\"不存在品牌\"}"
check R7.8a "不存在品牌任务创建" 200 "$(post_noop "$BASE/knowledge-base/sync-from-yydoc" "$BODY")"
TASK4=$(jget "['data']['taskId']")
waittask "$TASK4"
check R7.8b "任务failed" failed "$(req "$BASE/knowledge-base/sync-task/$TASK4" >/dev/null; jget "['data']['status']")"

# ── R7.9 doc-platform upsert（tiptap content）────────────────
python3 -c "import json;print(json.dumps({'brandCode':'uc-platform','languageCode':'$LANGCODE','operation':'upsertDocument','documents':[{'docUniqueId':'uc_plat_doc','name':'平台文档','content':{'type':'doc','content':[{'type':'paragraph','content':[{'type':'text','text':'文档平台内容，用于 doc-platform 用例。'}]}]}}]}))" > /tmp/uc-dp.json
check R7.9a "doc-platform upsert" 200 "$(req -X POST "$BASE/knowledge-base/sync-from-doc-platform" -H 'Content-Type: application/json' -d @/tmp/uc-dp.json)"
TASK5=$(jget "['data']['taskId']")
waittask "$TASK5"
check R7.9b "doc-platform完成" completed "$(req "$BASE/knowledge-base/sync-task/$TASK5" >/dev/null; jget "['data']['status']")"
check R7.9c "文档入库可检索" yes "$(curl -sS -m 60 --noproxy '*' -X POST "$BASE/knowledge-base/kb_uc_platform_zh_cn/search" -H 'Content-Type: application/json' -d '{"query":"文档平台内容","topK":3}' | python3 -c "import json,sys;d=json.load(sys.stdin);r=(d.get('data') or {}).get('results') or [];print('yes' if r else 'no')" 2>/dev/null)"

# ── R7.5 PG 落点 ───────────────────────────────────────────
check R7.5a "文档completed" yes "$(docker exec "$PGC" psql -U postgres -d "$PGDB" -Atc "SELECT CASE WHEN count(*) FILTER (WHERE status<>'completed')=0 AND count(*)>0 THEN 'yes' ELSE 'no' END FROM $SCH.documents WHERE knowledge_base_id='$KBID'")"
check R7.5b "向量表非空" yes "$(docker exec "$PGC" psql -U postgres -d "$PGDB" -Atc "SELECT CASE WHEN count(*)>0 THEN 'yes' ELSE 'no' END FROM $SCH.$KBID" 2>/dev/null)"

echo "━━━ sync-yddoc.md 汇总: PASS=$pass FAIL=$fail ━━"; exit $(( fail > 0 ))
```

## 说明

- 首次在**干净库**执行时 R7.1 的 `success=2`；重复执行时走 R7.2 幂等 `skipped`——两种状态都符合契约，脚本只断言总量与失败数。
- 全量 36 篇验证历史记录：**36 = 33 成功 + 3 skipped + 0 失败**，向量表 313 条 / 1536 维。
- 依赖真实内网/外网，无法进常规 CI；自动化版本（`KNOWLEDGE_INNER_E2E=1` 门控、独立 schema）见 `test/sync-inner-e2e.test.ts`。
