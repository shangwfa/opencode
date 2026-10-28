# 向量直连通道（DT35~DT40）

> `POST /database/:id/vectors`（手动 upsert）与 `POST /database/:id/vectors/query`（向量直查）：
> 绕过行/分块管道、直接操作数据集向量表的低层通道（供外部向量化管线使用）。
> 行为要点（断言依据，`vectors-upsert.ts` / `vectors-query.ts` / `vector-store.ts`）：
>
> - upsert 校验 `metadata.length === vectors.length`，数据集须存在且向量索引就绪；
> - query 返回 `{id, score, metadata}`，`score = 1 - cosine_distance`，过滤条件 `score > minScore`（严格大于）；
> - filter 为 MongoDB 风格 metadata 过滤（等值子集，见 `vector/filter.ts`）；
> - `queryVector` 维度与索引不一致 → PG 报错 → 400；
> - 手写向量与行 chunk 向量在同一张 `kb_*` 表共存，互不干扰。

## 用例（DT35~DT40）

| 用例 | 前置 | 验证点 |
|---|---|---|
| DT35 | — | upsert 2 条正交单位向量（e0/e1）+ query(e0)：200、top1 = v_a（score 降序）、topK=1 截断、PG 向量表 2 行 |
| DT36 | — | upsert 负例：metadata 与 vectors 长度不一致 → 400；数据集不存在 → 400 |
| DT37 | — | query + filter 等值：命中 tag=premium；tag 无匹配 → 0 条 |
| DT38 | — | queryVector 维度不匹配（3 维 vs 1536）→ 400 |
| DT39 | — | minScore=0.5：仅保留 score=1 的正交命中（正交项 score=0 被滤除） |
| DT40 | EMB | 手写向量与行 chunk 向量共存：写 1 行后 PG 总数 = 手写数 + 行 chunk 数；手写向量仍可查 |

## 内嵌测试脚本

```bash
BASE=${BASE:-http://127.0.0.1:18787/api}
PGC=${PGC:-knowledge-pg}; PGDB=${PGDB:-knowledge}; SCH=${SCH:-knowledge}
TS=$(date +%s)
DS="rd_dt_vec_$TS"
RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/dt-vectors.XXXXXX"); RES="$RUN_DIR/response.json"
pass=0; fail=0; skip=0
req()  { curl -sS -m 90 --noproxy '*' -o "$RES" -w '%{http_code}' "$@"; }
post() { curl -sS -m 90 --noproxy '*' -o "$RES" -w '%{http_code}' -X POST "$1" -H 'Content-Type: application/json' -d "$2"; }
py()   { python3 -c "${1//\/tmp\/uc-res.json/$RES}"; }
pgq()  { docker exec "$PGC" psql -U postgres -d "$PGDB" -Atc "$1"; }
check(){ if [ -n "$3" ] && [ "$3" = "$4" ]; then echo "PASS $1 $2"; pass=$((pass+1)); else echo "FAIL $1 $2 expect=[$3] got=[$4]"; fail=$((fail+1)); fi }
cleanup(){ for id in "$@"; do curl -sS -m 30 --noproxy '*' -o /dev/null -X DELETE "$BASE/database/$id" || true; done; }
trap 'cleanup "$DS" "rd_dt_probe_$TS"' EXIT

SVC=$(req "$BASE/database?page=1&pageSize=1")
if [ "$SVC" != "200" ]; then echo "SKIP 服务未就绪(http=$SVC): $BASE"; exit 0; fi
if [ "$(pgq 'SELECT 1')" != "1" ]; then echo "SKIP PG 不可达"; exit 0; fi

# 1536 维单位向量 e_i（JSON 数组）
evec() { python3 -c "
import json,sys
v=[0.0]*1536; v[int(sys.argv[1])]=1.0
print(json.dumps(v))" "$1"; }
E0=$(evec 0); E1=$(evec 1); E2=$(evec 2)

post "$BASE/database" "{\"id\":\"$DS\",\"name\":\"向量直连数据集\",\"columns\":[{\"name\":\"name\"},{\"name\":\"tag\"}]}" >/dev/null

# ── DT35 upsert + query ───────────────────────────────────
VEC_BODY="{\"vectors\":[$E0,$E1],\"metadata\":[{\"name\":\"alphaVec\",\"text\":\"alpha content\"},{\"name\":\"betaVec\",\"text\":\"beta content\"}],\"ids\":[\"v_a\",\"v_b\"]}"
check DT35a "upsert 200" 200 "$(post "$BASE/database/$DS/vectors" "$VEC_BODY")"
check DT35b "PG向量2行" 2 "$(pgq "SELECT count(*) FROM $SCH.kb_$DS")"
check DT35c "query(e0) top1命中" alphaVec "$(post "$BASE/database/$DS/vectors/query" "{\"queryVector\":$E0,\"topK\":2}" >/dev/null; py "import json;print(json.load(open('/tmp/uc-res.json'))['data'][0]['metadata']['name'])")"
check DT35d "topK=1截断" 1 "$(post "$BASE/database/$DS/vectors/query" "{\"queryVector\":$E0,\"topK\":1}" >/dev/null; py "import json;print(len(json.load(open('/tmp/uc-res.json'))['data']))")"

# ── DT36 upsert 负例 ──────────────────────────────────────
check DT36a "长度不一致400" 400 "$(post "$BASE/database/$DS/vectors" "{\"vectors\":[$E0,$E1],\"metadata\":[{\"name\":\"only\"}]}")"
check DT36b "数据集不存在400" 400 "$(post "$BASE/database/rd_dt_ghost_$TS/vectors" "{\"vectors\":[$E0],\"metadata\":[{\"name\":\"x\"}]}")"

# ── DT37 query + filter ───────────────────────────────────
check DT37a "upsert带tag 200" 200 "$(post "$BASE/database/$DS/vectors" "{\"vectors\":[$E2],\"metadata\":[{\"name\":\"gammaVec\",\"tag\":\"premium\"}],\"ids\":[\"v_c\"]}")"
check DT37b "filter等值命中" gammaVec "$(post "$BASE/database/$DS/vectors/query" "{\"queryVector\":$E2,\"topK\":5,\"filter\":{\"tag\":\"premium\"}}" >/dev/null; py "import json;d=json.load(open('/tmp/uc-res.json'))['data'];print(d[0]['metadata']['name'] if d else 'empty')")"
check DT37c "filter无匹配0条" 0 "$(post "$BASE/database/$DS/vectors/query" "{\"queryVector\":$E2,\"topK\":5,\"filter\":{\"tag\":\"ghost\"}}" >/dev/null; py "import json;print(len(json.load(open('/tmp/uc-res.json'))['data']))")"

# ── DT38 维度不匹配 ───────────────────────────────────────
check DT38 "3维向量拒绝" 400 "$(post "$BASE/database/$DS/vectors/query" '{"queryVector":[0.1,0.2,0.3],"topK":1}')"

# ── DT39 minScore ─────────────────────────────────────────
check DT39 "minScore滤除正交项" 1 "$(post "$BASE/database/$DS/vectors/query" "{\"queryVector\":$E0,\"topK\":5,\"minScore\":0.5}" >/dev/null; py "import json;print(len(json.load(open('/tmp/uc-res.json'))['data']))")"

# ── DT40 与行数据共存（需 embedding） ──────────────────────
EMB_OK=0
if [ "$(post "$BASE/database" "{\"id\":\"rd_dt_probe_$TS\",\"name\":\"emb-probe\",\"columns\":[{\"name\":\"a\"}],\"dataSource\":[{\"a\":\"探针行\"}]}")" = "200" ]; then EMB_OK=1; fi
if [ "$EMB_OK" != "1" ] && [ "${DT_ALLOW_EMBEDDING_SKIP:-0}" != "1" ]; then echo "FAIL EMB 探针失败，不自动视为环境阻塞"; exit 1; fi
if [ "$EMB_OK" = "1" ]; then
  post "$BASE/database/$DS/rows" '{"rows":[{"name":"行数据一","tag":"row"}]}' >/dev/null
  CHN=$(pgq "SELECT count(*) FROM $SCH.kb_$DS WHERE vector_id ~ '^r_.*__c[0-9]+$'")
  TOTAL=$(pgq "SELECT count(*) FROM $SCH.kb_$DS")
  check DT40a "总数=手写3+行chunk" yes "$(if [ "$TOTAL" -eq $((3 + CHN)) ] && [ "$CHN" -ge 1 ]; then echo yes; else echo "no(total=$TOTAL,chunk=$CHN)"; fi)"
  check DT40b "手写向量仍可查" alphaVec "$(post "$BASE/database/$DS/vectors/query" "{\"queryVector\":$E0,\"topK\":1}" >/dev/null; py "import json;print(json.load(open('/tmp/uc-res.json'))['data'][0]['metadata']['name'])")"
else
  echo "SKIP DT40（embedding 通道不可用）"; skip=$((skip+1))
fi

echo "━━━ vectors.md 汇总: PASS=$pass FAIL=$fail SKIP=$skip ━━"
exit $fail
```

## 实测结果（2026-10-14，Docker HTTP/PG + mock 确定性向量）

**13 PASS / 0 FAIL / 0 SKIP**（embedding 经 mock 可用）

通过：upsert 与 query 排序（top1 = 正交单位向量命中）、topK 截断、upsert 长度不一致与数据集不存在 400、filter 等值命中与无匹配 0 条、3 维查询维度不匹配 400、minScore 滤除 score=0 的正交项（`score > minScore` 严格大于）、手写向量与行 chunk 共存（PG 总数 = 手写 3 + chunk 1，且手写向量仍可查）。
