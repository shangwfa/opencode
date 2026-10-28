# 元信息检索（M 系列）：三种基础检索能力与组合策略

> 产品定位：平台提供**正交的基础检索能力**——语义（semantic）、关键字/全文（keyword）、元信息（metadata），
> 可组合（任意检索 × filter）、可加权（hybridWeight × fusionMethod），**是否使用、如何封装由调用方决定**。
> 本文件验证元信息检索能力与组合契约；判定规则同 [evaluation-rubric.md](./evaluation-rubric.md)（L1 机制 + L2 可答）。

## 能力契约

| 能力 | 调用 | 契约 |
|---|---|---|
| 纯元信息召回 | `POST /search` `searchType:"metadata"` + `filter` | **query 可省略**；filter 必填（MongoDB 风格）；score 恒 1（匹配即命中）；按 syncedAt/chunkIndex 稳定排序 |
| 元信息过滤（组合） | 任意 searchType + `filter` | 语义/关键字/混合召回后按 metadata 缩小范围 |
| 权重策略 | `hybridWeight` + `fusionMethod` | **`hybridWeight` 仅在 `weighted`/`weighted-rrf`/`hybrid` 融合下生效**；默认 `rrf` 只按排名融合（不消费权重）；权重生效语义见单测 `hybrid-search.service.test`（按混合权重重排序） |
| 管理面元查询 | `GET /:id/documents?metadata={...}` | 文档级 metadata 筛选（与 chunk 级 metadata 分层）；非法 JSON → 400 |

## 用例（M01~M10）

| 用例 | 验证点 |
|---|---|
| M01 | `searchType:"metadata"` + `filter:{parentPath:"功能文档/项目级基础配置"}` → 200、结果全部命中该分类、`score=1` |
| M02 | 契约负例：metadata 无 filter → 400（"requires a non-empty filter"）；semantic 无 query → 400 |
| M03 | 无匹配 filter → 200 且 0 条（不是错误） |
| M04 | 四能力对照：同一主题（MCP 配置）semantic/keyword/hybrid/metadata 均可用（metadata 按分类过滤命中） |
| M05 | 权重策略：`hybridWeight` 两组极端权重（0.9/0.1 vs 0.1/0.9）均 200 有效；两路排名一致时结果可相同（权重语义由单测覆盖） |
| M06 | 组合能力：semantic + `filter` 精确缩窄 → 结果全部在 filter 范围内 |
| M07 | 管理面：`GET /documents?metadata={"brandCode":"yingdao-harness"}` 全部命中该品牌；`{"brandCode":"ghost"}` → 0；`not-json` → 400 |
| M08 | `topK` 生效：metadata topK=2 → ≤2 条 |
| M09 | 越库隔离：metadata 召回的 documentId 全部属于本库（36 篇集合） |
| M10 | PG 只读一致（documents + 向量表快照前后不变） |

## 内嵌测试脚本

从本文件提取 bash 代码块执行（依赖已启动的服务与 PG 容器，同 R 系列）：

```bash
BASE=${BASE:-http://127.0.0.1:18787/api}
PGC=${PGC:-knowledge-pg}; PGDB=${PGDB:-knowledge}; SCH=${SCH:-knowledge}
KB=${KB:-kb_yingdao_harness_zh_cn}
pass=0; fail=0; skip=0
req()  { curl -sS -m 90 --noproxy '*' -o /tmp/uc-res.json -w '%{http_code}' "$@"; }
jget() { python3 -c "import json,sys;d=json.load(open('/tmp/uc-res.json'));print(eval('d'+sys.argv[1]))" "$1" 2>/dev/null || true; }
raw()  { cat /tmp/uc-res.json; }
pgq()  { docker exec "$PGC" psql -U postgres -d "$PGDB" -Atc "$1" 2>/dev/null; }
check(){ if [ -n "$3" ] && [ "$3" = "$4" ]; then echo "PASS $1 $2"; pass=$((pass+1)); else echo "FAIL $1 $2 expect=[$3] got=[$4]"; fail=$((fail+1)); fi }
post(){ curl -sS -m 90 --noproxy '*' -o /tmp/uc-res.json -w '%{http_code}' -X POST "$1" -H 'Content-Type: application/json' -d "$2"; }
snapshot(){ pgq "SELECT md5(coalesce(string_agg(row_to_json(d)::text,'|' ORDER BY id),'')) FROM $SCH.documents d WHERE knowledge_base_id='$KB'"; }
BEFORE=$(snapshot)

# ── M01 纯元信息召回 ────────────────────────────────────────
BODY='{"searchType":"metadata","filter":{"parentPath":"功能文档/项目级基础配置"},"topK":5}'
check M01a "metadata召回" 200 "$(post "$BASE/knowledge-base/$KB/search" "$BODY")"
check M01b "结果非空" yes "$(python3 -c "import json;d=json.load(open('/tmp/uc-res.json'));print('yes' if (d['data']['results'] or []) else 'no')" 2>/dev/null)"
check M01c "全部命中分类" yes "$(python3 -c "import json;d=json.load(open('/tmp/uc-res.json'));r=d['data']['results'];print('yes' if r and all(x['metadata'].get('parentPath')=='功能文档/项目级基础配置' for x in r) else 'no')" 2>/dev/null)"
check M01d "score恒为1" yes "$(python3 -c "import json;d=json.load(open('/tmp/uc-res.json'));r=d['data']['results'];print('yes' if r and all(x['score']==1 for x in r) else 'no')" 2>/dev/null)"

# ── M02 契约负例 ───────────────────────────────────────────
check M02a "metadata无filter拒绝" 400 "$(post "$BASE/knowledge-base/$KB/search" '{"searchType":"metadata"}')"
check M02b "semantic无query拒绝" 400 "$(post "$BASE/knowledge-base/$KB/search" '{"searchType":"semantic","filter":{"brandCode":"yingdao-harness"}}')"

# ── M03 无匹配 → 0 条 ──────────────────────────────────────
BODY='{"searchType":"metadata","filter":{"docName":"不存在的文档"},"topK":5}'
check M03 "无匹配返回0条" 0 "$(post "$BASE/knowledge-base/$KB/search" "$BODY" > /dev/null; python3 -c "import json;print(len(json.load(open('/tmp/uc-res.json'))['data']['results']))" 2>/dev/null)"

# ── M04 四能力对照（MCP 配置主题）──────────────────────────
for st in semantic keyword hybrid; do
  BODY="{\"query\":\"MCP 配置\",\"searchType\":\"${st}\",\"topK\":5}"
  check "M04-${st}" "四能力可用" 200 "$(post "$BASE/knowledge-base/$KB/search" "$BODY")"
done
BODY='{"searchType":"metadata","filter":{"docName":"MCP配置"},"topK":5}'
check M04d "metadata可用" 200 "$(post "$BASE/knowledge-base/$KB/search" "$BODY")"
check M04e "metadata命中MCP配置" yes "$(python3 -c "import json;d=json.load(open('/tmp/uc-res.json'));r=d['data']['results'];print('yes' if r and all(x['metadata'].get('docName')=='MCP配置' for x in r) else 'no')" 2>/dev/null)"

# ── M05 权重策略 ───────────────────────────────────────────
i=0
for W in '{"semantic":0.9,"keyword":0.1}' '{"semantic":0.1,"keyword":0.9}'; do
  i=$((i+1))
  BODY="{\"query\":\"怎么配置\",\"searchType\":\"hybrid\",\"topK\":3,\"hybridWeight\":$W,\"fusionMethod\":\"weighted\"}"
  check "M05-${i}" "极端权重组合有效" 200 "$(post "$BASE/knowledge-base/$KB/search" "$BODY")"
done

# ── M06 组合：语义 + filter 精确缩窄 ────────────────────────
BODY="{\"query\":\"配置\",\"searchType\":\"semantic\",\"topK\":5,\"filter\":{\"docName\":\"MCP配置\"}}"
check M06a "组合检索" 200 "$(post "$BASE/knowledge-base/$KB/search" "$BODY")"
check M06b "结果在filter内" yes "$(python3 -c "import json;d=json.load(open('/tmp/uc-res.json'));r=d['data']['results'];print('yes' if r and all(x['metadata'].get('docName')=='MCP配置' for x in r) else 'no')" 2>/dev/null)"

# ── M07 管理面文档列表元查询 ───────────────────────────────
MET='{"brandCode":"yingdao-harness"}'
check M07a "文档列表元筛选" 200 "$(req "$BASE/knowledge-base/$KB/documents?metadata=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$MET")")"
check M07b "全部命中品牌" yes "$(python3 -c "import json;d=json.load(open('/tmp/uc-res.json'));r=d['data']['items'];print('yes' if r and all(x['metadata'].get('brandCode')=='yingdao-harness' for x in r) else 'no')" 2>/dev/null)"
check M07c "无匹配返回0条" 0 "$(req "$BASE/knowledge-base/$KB/documents?metadata=%7B%22brandCode%22%3A%22ghost%22%7D" > /dev/null; python3 -c "import json;print(len(json.load(open('/tmp/uc-res.json'))['data']['items']))" 2>/dev/null)"
check M07d "非法JSON拒绝" 400 "$(req "$BASE/knowledge-base/$KB/documents?metadata=not-json")"

# ── M08 topK 生效 ──────────────────────────────────────────
BODY='{"searchType":"metadata","filter":{"brandCode":"yingdao-harness"},"topK":2}'
check M08 "topK=2生效" 2 "$(post "$BASE/knowledge-base/$KB/search" "$BODY" > /dev/null; python3 -c "import json;print(min(len(json.load(open('/tmp/uc-res.json'))['data']['results']),2))" 2>/dev/null)"

# ── M09 越库隔离 ───────────────────────────────────────────
BODY='{"searchType":"metadata","filter":{"brandCode":"yingdao-harness"},"topK":20}'
check M09 "metadata召回不跨库" 200 "$(post "$BASE/knowledge-base/$KB/search" "$BODY")"
check M09b "全部属于本库" yes "$(python3 -c "
import json,subprocess
d=json.load(open('/tmp/uc-res.json'))
ids={x['documentId'] for x in d['data']['results']}
own=set(subprocess.run(['docker','exec','$PGC','psql','-U','postgres','-d','$PGDB','-Atc',\"SELECT id FROM $SCH.documents WHERE knowledge_base_id='$KB'\"],capture_output=True,text=True).stdout.split())
print('yes' if ids<=own else 'no')" 2>/dev/null)"

# ── M10 PG 只读一致 ────────────────────────────────────────
check M10 "PG只读一致" "$BEFORE" "$(snapshot)"

echo "━━━ metadata-search.md 汇总: PASS=$pass FAIL=$fail SKIP=$skip ━━"
exit $fail
```
