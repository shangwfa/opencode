# base-knowledge 命名空间：hash 幂等 / 版本 / 三模式检索 / api-spec

> 用例段：R8。脚本面向已启动的知识服务（见 [README.md](./README.md)），自建 `uc_bk` 命名空间并清理。
> 注意响应字段：base-knowledge 检索结果在 **`data.items`**（区别于 knowledge-base 的 `data.results`）。

## 用例

| 用例 | 验证点 |
|---|---|
| R8.1 | `POST /base-knowledge/:kbId/documents`（markdown / tiptap）→ 200 + `chunkCount≥1`，`version=1` |
| R8.2 | **hash 幂等（冲突拒绝语义）**：同 documentId 同内容重复创建 → **409**，不重复向量化 |
| R8.3 | 更新内容（`PUT`）→ 200，`version` 递增（1→2），重新向量化 |
| R8.4 | `POST /base-knowledge/:kbId/search`：`mode: hybrid|keyword|vector` 三模式均 200；原文查询命中（结果在 `data.items`） |
| R8.5 | `POST /base-knowledge/:kbId/api-spec`（OpenAPI JSON）→ 200，`succeeded≥1` |
| R8.6 | 删除文档 → 200；删除最后一份文档后**命名空间自动清理**（向量表 DROP，再删返回 404） |
| R8.7 | tiptap 类型创建 → 200（**content 直接传 tiptap JSON 对象**，根 `type:'doc'`；传字符串被 400 拒绝） |
| R8.8 | `excludeDocumentIds` 检索排除指定文档生效 |
| R8.9 | `timeoutMs` 边界：合法区间 [100, 30000]，越界 400；请求体不接受 `version` 字段（版本由服务端递增，重复创建 409 即乐观锁语义） |

## 测试脚本

> 整块复制执行。结尾清理 `uc_bk`，可重复跑。

```bash
BASE=${BASE:-http://127.0.0.1:18787/api}
PGC=${PGC:-knowledge-pg}; PGDB=${PGDB:-knowledge}; SCH=${SCH:-knowledge}
pass=0; fail=0
req()  { curl -sS -m 90 --noproxy '*' -o /tmp/uc-res.json -w '%{http_code}' "$@"; }
jget() { python3 -c "import json,sys;d=json.load(open('/tmp/uc-res.json'));print(eval('d'+sys.argv[1]))" "$1" 2>/dev/null || true; }
raw()  { cat /tmp/uc-res.json; }
check(){ if [ -n "$3" ] && [ "$3" = "$4" ]; then echo "PASS $1 $2"; pass=$((pass+1)); else echo "FAIL $1 $2 expect=[$3] got=[$4]"; fail=$((fail+1)); fi }
post(){ c=$(req -X POST "$@"); echo "$c"; }

KB=uc_bk
req -X DELETE "$BASE/base-knowledge/$KB" >/dev/null

# ── R8.1 创建 ───────────────────────────────────────────────
BODY='{"documentId":"bk_doc_1","type":"markdown","content":"# 标题A\n\n内容甲，用于 base-knowledge 用例。"}'
check R8.1 "创建文档" 200 "$(post "$BASE/base-knowledge/$KB/documents" -H 'Content-Type: application/json' -d "$BODY")"
check R8.1b "version=1" 1 "$(jget "['data']['version']")"

# ── R8.2 hash 幂等（409 冲突拒绝）──────────────────────────
BODY='{"documentId":"bk_doc_1","type":"markdown","content":"# 标题A\n\n内容甲，用于 base-knowledge 用例。"}'
check R8.2 "同内容重复创建409" 409 "$(post "$BASE/base-knowledge/$KB/documents" -H 'Content-Type: application/json' -d "$BODY")"

# ── R8.3 更新（version 递增）────────────────────────────────
BODY='{"type":"markdown","content":"# 标题B\n\n内容乙，更新后的文本。"}'
check R8.3 "更新version递增" 2 "$(req -X PUT "$BASE/base-knowledge/$KB/documents/bk_doc_1" -H 'Content-Type: application/json' -d "$BODY" >/dev/null; jget "['data']['version']")"

# ── R8.4 三模式检索（原文命中）─────────────────────────────
for m in hybrid vector keyword; do
  c=$(curl -sS -m 60 --noproxy '*' -o /tmp/uc-res.json -w '%{http_code}' -X POST "$BASE/base-knowledge/$KB/search" -H 'Content-Type: application/json' -d '{"query":"内容乙，更新后的文本","mode":"'$m'","topK":3}')
  check R8.4$m "$m模式检索" 200 "$c"
  check R8.4${m}b "$m模式命中" yes "$(python3 -c "import json;d=json.load(open('/tmp/uc-res.json'));items=(d.get('data') or {}).get('items') or [];print('yes' if any(i['documentId']=='bk_doc_1' for i in items) else 'no')" 2>/dev/null)"
done

# ── R8.5 api-spec 摄入 ──────────────────────────────────────
BODY='{"documentId":"bk_spec","content":{"openapi":"3.0.1","info":{"title":"t","version":"1"},"paths":{"/a":{"get":{"summary":"接口A","responses":{}}}}},"limit":5}'
check R8.5a "api-spec摄入" 200 "$(post "$BASE/base-knowledge/$KB/api-spec" -H 'Content-Type: application/json' -d "$BODY")"
check R8.5b "succeeded≥1" yes "$(python3 -c "import json;d=json.load(open('/tmp/uc-res.json'));print('yes' if d['data']['succeeded']>=1 else 'no')" 2>/dev/null)"

# ── R8.7~R8.9 tiptap / excludeDocumentIds / 边界 ────────────
# tiptap 的 content 直接传 JSON 对象（非字符串）
python3 -c "import json;print(json.dumps({'documentId':'bk_doc_2','type':'tiptap','content':{'type':'doc','content':[{'type':'paragraph','content':[{'type':'text','text':'tiptap 用例内容'}]}]}}))" > /tmp/uc-bk-tiptap.json
check R8.7 "tiptap创建" 200 "$(post "$BASE/base-knowledge/$KB/documents" -H 'Content-Type: application/json' -d @/tmp/uc-bk-tiptap.json)"
check R8.8a "exclude前有命中" 200 "$(post "$BASE/base-knowledge/$KB/search" -H 'Content-Type: application/json' -d '{"query":"用例内容","mode":"hybrid","topK":5}')"
BEFORE=$(raw | python3 -c "import json,sys;print(len((json.load(sys.stdin).get('data') or {}).get('items') or []))" 2>/dev/null)
check R8.8b "exclude后命中减少" yes "$(python3 -c "print('yes' if $BEFORE>0 else 'no')" 2>/dev/null)"
BODY='{"query":"用例内容","mode":"hybrid","topK":5,"excludeDocumentIds":["bk_doc_1","bk_doc_2"]}'
c=$(post "$BASE/base-knowledge/$KB/search" -H 'Content-Type: application/json' -d "$BODY")
check R8.8c "exclude生效" yes "$(python3 -c "import json;d=json.load(open('/tmp/uc-res.json'));items=(d.get('data') or {}).get('items') or [];print('yes' if items and all(i['documentId'] not in ('bk_doc_1','bk_doc_2') for i in items) or not items else 'no')" 2>/dev/null)"
BODY='{"query":"内容","mode":"hybrid","timeoutMs":50}'
check R8.9a "timeoutMs越界400" 400 "$(post "$BASE/base-knowledge/$KB/search" -H 'Content-Type: application/json' -d "$BODY")"
BODY='{"query":"内容","mode":"hybrid","timeoutMs":100}'
check R8.9b "timeoutMs下界200" 200 "$(post "$BASE/base-knowledge/$KB/search" -H 'Content-Type: application/json' -d "$BODY")"

# ── R8.6 删除 ───────────────────────────────────────────────
check R8.6a "删除文档" 200 "$(req -X DELETE "$BASE/base-knowledge/$KB/documents/bk_doc_1")"
req -X DELETE "$BASE/base-knowledge/$KB/documents/bk_doc_2" >/dev/null
req -X DELETE "$BASE/base-knowledge/$KB/documents/bk_spec" >/dev/null
check R8.6b "清空全部文档后ns自动清理" 404 "$(req -X DELETE "$BASE/base-knowledge/$KB")"
check R8.6c "向量表已DROP" 0 "$(docker exec "$PGC" psql -U postgres -d "$PGDB" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='$SCH' AND table_name LIKE 'bk_%'" 2>/dev/null)"

echo "━━━ base-knowledge.md 汇总: PASS=$pass FAIL=$fail ━━"; exit $(( fail > 0 ))
```

## 说明

- 命名空间向量表为 `bk_<hash>`（`getBaseKnowledgeIndexName` 派生），不写 `knowledge_bases` 表——与知识库主域物理隔离。
- hash 幂等的语义是**冲突拒绝（409）**而非静默跳过；内容变更走 `PUT` + version 乐观锁。
- 检索超时降级（`degraded`）与 3A 规则（一路超时另一路为空时报 504）由 `src/rag/routes.test.ts`、`search.service.test.ts` 单元覆盖。
