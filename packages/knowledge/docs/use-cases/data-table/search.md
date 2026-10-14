# 行检索矩阵（DT21~DT34）

> `POST /database/:id/rows/search`（主通道）与 `GET /database/:id/query`（GET 版）全行为矩阵：
> filter-only / query（semantic·keyword·hybrid）/ 组合（先 SQL 过滤再检索）、selectFields 投影、
> 旧请求兼容（query 对象视为 filter、fields/returnFields 别名）、校验负例、跨数据集隔离。
> 行为要点（断言依据，`runDatabaseRowsSearch` + `RowsSearchRequestSchema`）：
>
> - **filter-only**：`mode=filter`、`sqlFilter=true`、`vectorSearch=false`、每项 `score=1`、`text=""`、row 全量回填，`limit` 截断；
> - **query**：向量侧为行文本分块 chunk，返回 `vectorId=<rowId>__c<idx>`、`text` 为命中块文本，`documentId` 回填行 id；
> - **组合**：先按 filter 预取行 id 集（idOnly），向量召回后取交集；候选集为空 → 200 空结果 + warning；
> - keyword 检索主路径为 `ILIKE %query%` 文本包含（score 1.0），pg_trgm 相似度兜底；
> - `keyword` × `recallConfig.enableMultiStage=true` → 400（多阶段仅语义）；
> - filter 匹配语义与行列表一致：字符串 trim+ILIKE 子串、数字/布尔文本精确、id 精确、null → IS NULL；校验类错误 route 统一 400。

## 用例（DT21~DT34）

| 用例 | 前置 | 验证点 |
|---|---|---|
| DT21 | EMB | filter-only 契约：mode/sqlFilter/vectorSearch/reranked 标志、score=1、text=""、row 回填、limit 截断 |
| DT22 | EMB | filter 匹配语义：子串（西北）、大小写（path ORDERS）、数字精确（level=1 不含 level=10）、level=10、null（desc IS NULL）、id 精确、空串值 400、未知键 400 |
| DT23 | EMB | semantic：query 命中目标行；mode=query、vectorSearch=true；vectorId 匹配 `__c` 模式 |
| DT24 | EMB | keyword：ILIKE 包含路径命中（库存盘点 → 库存行） |
| DT25 | EMB | hybrid：融合检索命中（支付回调 → 支付行） |
| DT26 | EMB | 组合：query+filter 结果全部在 filter 子集内、mode=combined；filter 无匹配 → 200 空结果 + warning |
| DT27 | EMB | keyword × enableMultiStage → 400 |
| DT28 | — | 校验负例（zod 层，不触达数据集）：空 body / 空 filter 对象 / topK=201 / limit=201 / selectFields 非法字段名 → 400 |
| DT29 | EMB | selectFields：row 仅含白名单字段（系统字段 id/created_at 亦被剔除）；不存在字段忽略；fields / returnFields 别名等价 |
| DT30 | EMB | 旧请求兼容：body.query 为对象 → 视为 filter（mode=filter） |
| DT31 | EMB | GET /query：query 参数检索；simple=1 → 仅 {name,path}；无 query → 400；与 POST 结果一致 |
| DT32 | — | 数据集不存在：POST search / GET query → 404 |
| DT33 | EMB | topK 截断：多命中 query topK=2 → ≤2 条 |
| DT34 | EMB | 跨数据集隔离：A 检索 documentId ⊆ A 行集；B 中含相同关键词的行不被 A 召回（反之 B 命中自己的行） |

## 测试数据

数据集列：`name, path, category, region, level, desc`（行 8 故意缺 desc 构造 NULL；desc 以顿号分隔短词，
配合确定性向量（bag-of-tokens）使语义命中可精确断言）：

| name | path | category | region | level | desc |
|---|---|---|---|---|---|
| 订单管理服务 | /api/orders | 交易 | 华东 | 1 | 处理订单创建、订单查询、订单状态流转 |
| 库存管理服务 | /api/inventory | 供应链 | 华东 | 1 | 管理库存数量、库存盘点、出入库 |
| 用户认证服务 | /api/auth | 平台 | 华北 | 2 | 负责登录鉴权、权限校验、会话管理 |
| 支付网关服务 | /api/payment | 交易 | 华南 | 2 | 对接支付渠道、处理支付回调、退款 |
| 物流跟踪服务 | /api/logistics | 供应链 | 华南 | 1 | 提供物流轨迹查询、运单状态推送 |
| 消息通知服务 | /api/notify | 平台 | 华北 | 2 | 短信、邮件与站内消息推送 |
| 数据报表服务 | /api/report | 数据 | 华东 | 10 | 经营数据统计、报表生成与导出 |
| 智能问答服务 | /api/qa | 数据 | 西北 | 1 | （NULL） |

## 内嵌测试脚本

```bash
BASE=${BASE:-http://127.0.0.1:18787/api}
PGC=${PGC:-knowledge-pg}; PGDB=${PGDB:-knowledge}; SCH=${SCH:-knowledge}
TS=$(date +%s)
DS="rd_dt_sea_$TS"; DS_B="rd_dt_sea_b_$TS"
RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/dt-search.XXXXXX"); RES="$RUN_DIR/response.json"
pass=0; fail=0; skip=0
req()  { curl -sS -m 90 --noproxy '*' -o "$RES" -w '%{http_code}' "$@"; }
post() { curl -sS -m 90 --noproxy '*' -o "$RES" -w '%{http_code}' -X POST "$1" -H 'Content-Type: application/json' -d "$2"; }
py()   { python3 -c "${1//\/tmp\/uc-res.json/$RES}"; }
pgq()  { docker exec "$PGC" psql -U postgres -d "$PGDB" -Atc "$1"; }
check(){ if [ -n "$3" ] && [ "$3" = "$4" ]; then echo "PASS $1 $2"; pass=$((pass+1)); else echo "FAIL $1 $2 expect=[$3] got=[$4]"; fail=$((fail+1)); fi }
cleanup(){ for id in "$@"; do curl -sS -m 30 --noproxy '*' -o /dev/null -X DELETE "$BASE/database/$id" || true; done; }
trap 'cleanup "$DS" "$DS_B" "rd_dt_probe_$TS"' EXIT

SVC=$(req "$BASE/database?page=1&pageSize=1")
if [ "$SVC" != "200" ]; then echo "SKIP 服务未就绪(http=$SVC): $BASE"; exit 0; fi
if [ "$(pgq 'SELECT 1')" != "1" ]; then echo "SKIP PG 不可达"; exit 0; fi

# ── DT32 数据集不存在（无数据依赖） ────────────────────────
check DT32a "POST search 404" 404 "$(post "$BASE/database/rd_dt_ghost_$TS/rows/search" '{"query":"x"}')"
check DT32b "GET query 404" 404 "$(req "$BASE/database/rd_dt_ghost_$TS/query?query=x")"

# ── DT28 校验负例（zod 层，ghost 数据集即可） ──────────────
GH="rd_dt_ghost_$TS"
check DT28a "空body 400" 400 "$(post "$BASE/database/$GH/rows/search" '{}')"
check DT28b "空filter对象400" 400 "$(post "$BASE/database/$GH/rows/search" '{"filter":{}}')"
check DT28c "topK=201 400" 400 "$(post "$BASE/database/$GH/rows/search" '{"query":"订单","topK":201}')"
check DT28d "limit=201 400" 400 "$(post "$BASE/database/$GH/rows/search" '{"query":"订单","limit":201}')"
check DT28e "selectFields非法400" 400 "$(post "$BASE/database/$GH/rows/search" '{"query":"订单","selectFields":["1abc"]}')"

# ── embedding 探针 + 建数据 ───────────────────────────────
EMB_OK=0
if [ "$(post "$BASE/database" "{\"id\":\"rd_dt_probe_$TS\",\"name\":\"emb-probe\",\"columns\":[{\"name\":\"a\"}],\"dataSource\":[{\"a\":\"探针行\"}]}")" = "200" ]; then EMB_OK=1; fi
if [ "$EMB_OK" != "1" ] && [ "${DT_ALLOW_EMBEDDING_SKIP:-0}" != "1" ]; then echo "FAIL EMB 探针失败，不自动视为环境阻塞"; exit 1; fi

if [ "$EMB_OK" = "1" ]; then
  post "$BASE/database" "{\"id\":\"$DS\",\"name\":\"检索矩阵\",\"columns\":[{\"name\":\"name\"},{\"name\":\"path\"},{\"name\":\"category\"},{\"name\":\"region\"},{\"name\":\"level\"},{\"name\":\"desc\"}],\"dataSource\":[{\"name\":\"订单管理服务\",\"path\":\"/api/orders\",\"category\":\"交易\",\"region\":\"华东\",\"level\":\"1\",\"desc\":\"处理订单创建、订单查询、订单状态流转\"},{\"name\":\"库存管理服务\",\"path\":\"/api/inventory\",\"category\":\"供应链\",\"region\":\"华东\",\"level\":\"1\",\"desc\":\"管理库存数量、库存盘点、出入库\"},{\"name\":\"用户认证服务\",\"path\":\"/api/auth\",\"category\":\"平台\",\"region\":\"华北\",\"level\":\"2\",\"desc\":\"负责登录鉴权、权限校验、会话管理\"},{\"name\":\"支付网关服务\",\"path\":\"/api/payment\",\"category\":\"交易\",\"region\":\"华南\",\"level\":\"2\",\"desc\":\"对接支付渠道、处理支付回调、退款\"},{\"name\":\"物流跟踪服务\",\"path\":\"/api/logistics\",\"category\":\"供应链\",\"region\":\"华南\",\"level\":\"1\",\"desc\":\"提供物流轨迹查询、运单状态推送\"},{\"name\":\"消息通知服务\",\"path\":\"/api/notify\",\"category\":\"平台\",\"region\":\"华北\",\"level\":\"2\",\"desc\":\"短信、邮件与站内消息推送\"},{\"name\":\"数据报表服务\",\"path\":\"/api/report\",\"category\":\"数据\",\"region\":\"华东\",\"level\":\"10\",\"desc\":\"经营数据统计、报表生成与导出\"},{\"name\":\"智能问答服务\",\"path\":\"/api/qa\",\"category\":\"数据\",\"region\":\"西北\",\"level\":\"1\"}]}" >/dev/null
  SEA() { post "$BASE/database/$DS/rows/search" "$1"; }
  R1=$(pgq "SELECT t.id FROM $SCH.$(pgq "SELECT data_table_name FROM $SCH.databases WHERE id='$DS'") t WHERE t.name='订单管理服务'")

  # ── DT21 filter-only 契约 ───────────────────────────────
  check DT21a "filter-only 200" 200 "$(SEA '{"filter":{"category":"交易"}}')"
  check DT21b "模式标志" "filter|true|false|false" "$(py "import json;d=json.load(open('/tmp/uc-res.json'))['data'];print('%s|%s|%s|%s'%(d['mode'],str(d['sqlFilter']).lower(),str(d['vectorSearch']).lower(),str(d['reranked']).lower()))")"
  check DT21c "score=1且text空且row回填" yes "$(py "import json;d=json.load(open('/tmp/uc-res.json'))['data'];print('yes' if d['total']==2 and all(x['score']==1 and x['text']=='' and x['row']['category']=='交易' for x in d['items']) else 'no')")"
  check DT21d "limit截断" 1 "$(SEA '{"filter":{"category":"交易"},"limit":1}' >/dev/null; py "import json;print(json.load(open('/tmp/uc-res.json'))['data']['total'])")"

  # ── DT22 filter 匹配语义 ────────────────────────────────
  check DT22a "子串匹配" 1 "$(SEA '{"filter":{"region":"西北"}}' >/dev/null; py "import json;print(json.load(open('/tmp/uc-res.json'))['data']['total'])")"
  check DT22b "大小写不敏感" 1 "$(SEA '{"filter":{"path":"ORDERS"}}' >/dev/null; py "import json;print(json.load(open('/tmp/uc-res.json'))['data']['total'])")"
  check DT22c "数字精确不含10" 4 "$(SEA '{"filter":{"level":1}}' >/dev/null; py "import json;print(json.load(open('/tmp/uc-res.json'))['data']['total'])")"
  check DT22d "数字10命中" 1 "$(SEA '{"filter":{"level":10}}' >/dev/null; py "import json;print(json.load(open('/tmp/uc-res.json'))['data']['total'])")"
  check DT22e "null为IS NULL" 1 "$(SEA '{"filter":{"desc":null}}' >/dev/null; py "import json;print(json.load(open('/tmp/uc-res.json'))['data']['total'])")"
  check DT22f "id精确" 1 "$(SEA "{\"filter\":{\"id\":\"$R1\"}}" >/dev/null; py "import json;print(json.load(open('/tmp/uc-res.json'))['data']['total'])")"
  check DT22g "空白值400" 400 "$(SEA '{"filter":{"region":"  "}}')"
  check DT22h "未知键400" 400 "$(SEA '{"filter":{"ghost_col":"v"}}')"

  # ── DT23 semantic ───────────────────────────────────────
  check DT23a "semantic 200" 200 "$(SEA '{"query":"订单查询","searchType":"semantic","topK":3}')"
  check DT23b "命中目标行" yes "$(py "import json;d=json.load(open('/tmp/uc-res.json'))['data'];print('yes' if any(x.get('row',{}).get('name')=='订单管理服务' for x in d['items']) else 'no')")"
  check DT23c "mode=query标志" "query|true|semantic" "$(py "import json;d=json.load(open('/tmp/uc-res.json'))['data'];print('%s|%s|%s'%(d['mode'],str(d['vectorSearch']).lower(),d['searchType']))")"
  check DT23d "vectorId为chunk模式" yes "$(py "import json,re;d=json.load(open('/tmp/uc-res.json'))['data'];print('yes' if d['items'] and all(re.match(r'^.+__c[0-9]+$',x.get('vectorId','')) for x in d['items']) else 'no')")"

  # ── DT24 keyword ────────────────────────────────────────
  check DT24a "keyword(显式关多阶段)200" 200 "$(SEA '{"query":"库存盘点","searchType":"keyword","topK":3,"recallConfig":{"enableMultiStage":false}}')"
  check DT24b "keyword包含命中" yes "$(py "import json;d=json.load(open('/tmp/uc-res.json'))['data'];print('yes' if any(x.get('row',{}).get('name')=='库存管理服务' for x in d['items']) else 'no')")"
  check DT24c "keyword默认参数200" 200 "$(SEA '{"query":"库存盘点","searchType":"keyword","topK":3}')"

  # ── DT25 hybrid ─────────────────────────────────────────
  check DT25a "hybrid 200" 200 "$(SEA '{"query":"处理支付回调","searchType":"hybrid","topK":3}')"
  check DT25b "hybrid命中" yes "$(py "import json;d=json.load(open('/tmp/uc-res.json'))['data'];print('yes' if any(x.get('row',{}).get('name')=='支付网关服务' for x in d['items']) else 'no')")"
  check DT25c "hybrid两路实际执行并融合" yes "$(py "import json;d=json.load(open('/tmp/uc-res.json'))['data']['execution'];print('yes' if d['strategy']=='hybrid' and d['branchResults']['semantic']>0 and d['branchResults']['keyword']>0 and d['fusionApplied'] else 'no')")"

  # ── DT26 组合 query+filter ──────────────────────────────
  check DT26a "组合200" 200 "$(SEA '{"query":"订单查询","filter":{"region":"华东"},"topK":5}')"
  check DT26b "结果在filter子集" yes "$(py "import json;d=json.load(open('/tmp/uc-res.json'))['data'];print('yes' if d['items'] and all(x['row']['region']=='华东' for x in d['items']) else 'no')")"
  check DT26c "mode=combined" "combined|true" "$(py "import json;d=json.load(open('/tmp/uc-res.json'))['data'];print('%s|%s'%(d['mode'],str(d['sqlFilter']).lower()))")"
  check DT26d "filter无匹配空结果" "0|yes" "$(SEA '{"query":"订单查询","filter":{"region":"不存在区域"}}' >/dev/null; py "import json;d=json.load(open('/tmp/uc-res.json'))['data'];print('%s|%s'%(len(d['items']),'yes' if d.get('warning') else 'no'))")"

  # ── DT27 keyword×multiStage ─────────────────────────────
  check DT27 "keyword多阶段400" 400 "$(SEA '{"query":"库存","searchType":"keyword","recallConfig":{"enableMultiStage":true}}')"

  # ── DT29 selectFields 投影 ──────────────────────────────
  check DT29a "白名单投影" yes "$(SEA '{"query":"订单查询","selectFields":["name","category"],"topK":3}' >/dev/null; py "import json;d=json.load(open('/tmp/uc-res.json'))['data'];rs=[x['row'] for x in d['items'] if x.get('row')];print('yes' if rs and all(set(r.keys())=={'name','category'} for r in rs) else 'no')")"
  check DT29b "不存在字段忽略" yes "$(SEA '{"query":"订单查询","selectFields":["name","ghost_field"],"topK":3}' >/dev/null; py "import json;d=json.load(open('/tmp/uc-res.json'))['data'];rs=[x['row'] for x in d['items'] if x.get('row')];print('yes' if rs and all(set(r.keys())=={'name'} for r in rs) else 'no')")"
  check DT29c "fields别名" yes "$(SEA '{"query":"订单查询","fields":["name"],"topK":3}' >/dev/null; py "import json;d=json.load(open('/tmp/uc-res.json'))['data'];rs=[x['row'] for x in d['items'] if x.get('row')];print('yes' if rs and all(set(r.keys())=={'name'} for r in rs) else 'no')")"
  check DT29d "returnFields别名" yes "$(SEA '{"query":"订单查询","returnFields":["name"],"topK":3}' >/dev/null; py "import json;d=json.load(open('/tmp/uc-res.json'))['data'];rs=[x['row'] for x in d['items'] if x.get('row')];print('yes' if rs and all(set(r.keys())=={'name'} for r in rs) else 'no')")"

  # ── DT30 旧请求兼容 ─────────────────────────────────────
  check DT30 "query对象视为filter" "filter|2" "$(SEA '{"query":{"category":"交易"}}' >/dev/null; py "import json;d=json.load(open('/tmp/uc-res.json'))['data'];print('%s|%s'%(d['mode'],d['total']))")"

  # ── DT31 GET /query ─────────────────────────────────────
  check DT31a "GET query 200" 200 "$(req "$BASE/database/$DS/query?query=%E8%AE%A2%E5%8D%95%E6%9F%A5%E8%AF%A2")"
  check DT31b "GET命中目标行" yes "$(py "import json;d=json.load(open('/tmp/uc-res.json'))['data'];print('yes' if isinstance(d,list) and any(x.get('row',{}).get('name')=='订单管理服务' for x in d) else 'no')")"
  check DT31c "simple仅name/path" yes "$(req "$BASE/database/$DS/query?query=%E8%AE%A2%E5%8D%95%E6%9F%A5%E8%AF%A2&simple=1" >/dev/null; py "import json;d=json.load(open('/tmp/uc-res.json'))['data'];print('yes' if d and all(set(x.keys())<={'name','path'} and x.get('name') for x in d) else 'no')")"
  check DT31d "无query 400" 400 "$(req "$BASE/database/$DS/query")"

  # ── DT33 topK 截断 ──────────────────────────────────────
  check DT33 "topK=2严格截断" yes "$(SEA '{"query":"华东","topK":2}' >/dev/null; py "import json;d=json.load(open('/tmp/uc-res.json'))['data'];print('yes' if 0<len(d['items'])<=2 else 'no')")"

  # ── DT34 跨数据集隔离 ───────────────────────────────────
  post "$BASE/database" "{\"id\":\"$DS_B\",\"name\":\"隔离对照\",\"columns\":[{\"name\":\"name\"},{\"name\":\"desc\"}],\"dataSource\":[{\"name\":\"发票管理服务\",\"desc\":\"订单查询、发票开具\"}]}" >/dev/null
  A_IDS=$(pgq "SELECT string_agg(t.id,',') FROM $SCH.$(pgq "SELECT data_table_name FROM $SCH.databases WHERE id='$DS'") t")
  check DT34a "A检索命中" 200 "$(SEA '{"query":"订单查询","topK":5}')"
  check DT34b "documentId⊆A行集" yes "$(py "import json;d=json.load(open('/tmp/uc-res.json'))['data'];a=set('$A_IDS'.split(','));print('yes' if {x['documentId'] for x in d['items']}<=a else 'no')")"
  check DT34c "B检索命中自己的行" yes "$(post "$BASE/database/$DS_B/rows/search" '{"query":"订单查询","topK":5}' >/dev/null; py "import json;d=json.load(open('/tmp/uc-res.json'))['data'];print('yes' if any(x.get('row',{}).get('name')=='发票管理服务' for x in d['items']) else 'no')")"
else
  for c in DT21 DT22 DT23 DT24 DT25 DT26 DT27 DT28 DT29 DT30 DT31 DT33 DT34; do echo "SKIP $c（embedding 通道不可用）"; skip=$((skip+1)); done
fi

echo "━━━ search.md 汇总: PASS=$pass FAIL=$fail SKIP=$skip ━━"
exit $fail
```

## 实测结果（2026-10-14，Docker HTTP/PG + mock 确定性向量）

**最新回归：47 PASS / 0 FAIL / 0 SKIP**（Docker HTTP/PG，新增 hybrid 两路融合执行断言；embedding 经 mock 可用）

首轮失败记录（已修复，见 [README](./README.md#已修复缺陷)）：

| 失败（首轮） | 实测 | 根因（源码） |
|---|---|---|
| DT24c | `searchType:"keyword"` 不传 `recallConfig` 时返回 400（`multi-stage semantic only`） | `config/search.constants.ts`：`DEFAULT_ENABLE_MULTI_STAGE = true`，而 `services/database-rows-search.ts` 对 `keyword` 做 `if (enableMultiStage && searchType==="keyword") → 400`。即**默认参数下关键词检索不可用**，必须显式传 `enableMultiStage:false`（DT24a 显式关闭后命中正常，证明关键词通路本身可用） |

通过的关键断言：filter-only 的 mode/sqlFilter/vectorSearch/reranked 标志、score=1 与 text=""、子串/大小写/数字精确（level=1 不含 10）/null/id 精确、semantic 命中与 chunk 形态 vectorId、hybrid 命中、组合检索结果全在 filter 子集内且空候选带 warning、keyword×多阶段 400、zod 校验负例、selectFields 白名单投影（含别名 fields/returnFields、不存在字段忽略）、旧请求 query 对象视为 filter、GET query 与 simple 输出、topK 截断、跨数据集隔离（documentId 不越库）。
