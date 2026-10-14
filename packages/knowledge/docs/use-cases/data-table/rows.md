# 行 CRUD 与事务一致性（DT11~DT20）

> data-table 行级链路：批量写入（动态表事务 + 分块向量化）→ 列表/过滤/详情 → 批量更新（事务 +
> 增量重向量化）→ 批量删行（先删向量再删行）→ 数据集不存在时的接口语义。
> 行为要点（断言依据）：
>
> - 行 id 服务端生成（`r_<ts>_<i>_<rand>`），chunk 向量 id = `<rowId>__c<chunkIndex>`，metadata 携带 `rowId/chunkIndex/text` + 业务列；
> - `POST /rows` 对**未知列键静默忽略**（按 columns 白名单取值，不报错）；
> - embedding 文本 = 列定义顺序拼接全部列值；全空白 → 400 且事务回滚（行不落库）；
> - 批量更新单条失败**整体回滚**（包括已执行成功的行）；有字段变更的行提交后按批重向量化；
> - 批量删行要求**每个 id 均存在**：单条 SQL 批量删行后校验，不存在的 id 报 404（同批真实行已被删，观察点）；
> - filter 字符串值 = trim + ILIKE 子串（大小写不敏感）；数字/布尔 = trim(col::text) 精确等值；`id` 精确；`null` → IS NULL。

## 用例（DT11~DT20）

| 用例 | 前置 | 验证点 |
|---|---|---|
| DT11 | EMB | 批量写入 6 行：count=6；行 id `r_` 前缀；PG 动态表 6 行；向量表 metadata 含 rowId/chunkIndex/text；向量 id 全部匹配 `__c<idx>` 模式 |
| DT12 | EMB | 未知列键静默忽略：200 不报错；PG 动态表列集合不变（无 ghost_col） |
| DT13 | — | 全空白行文本 → 400；PG 行数不变（回滚） |
| DT14 | — | notNull 列缺失 → 400；`rows:[]` → 400（均不触发向量化，无 EMB 可跑） |
| DT15 | EMB | 行列表分页：items/total/totalPages 正确；page=2 与 page=1 不重叠；pageSize=201 / 0 拒绝 |
| DT16 | EMB | 行列表 filter：URL 平铺参数与 `filter` JSON 等价；子串（浙江省杭州市 ⊂ 浙江）；大小写不敏感；未知键 / 非法 JSON → 500 |
| DT17 | EMB | 行详情：业务字段 + created_at/updated_at 完整；不存在行 → 404 |
| DT18 | EMB | 批量更新：值变更 + updated_at 前移 + 重向量化（向量 text 含新值）；空 patch noop；未知列 400；ghost 行 404；**混合批次整体回滚**；items id 重复 400 |
| DT19 | EMB | 批量删行：deleted=2；PG 行与向量同步清理；含不存在 id → 404（同批真实行已删，部分成功观察点）；`ids:[]` → 400 |
| DT20 | — | 数据集不存在：GET rows / GET row / PATCH batch / DELETE batch / POST search → 404；**POST rows → 400**（路由错误映射与其它行接口不一致，观察点） |

## 内嵌测试脚本

```bash
BASE=${BASE:-http://127.0.0.1:18787/api}
PGC=${PGC:-knowledge-pg}; PGDB=${PGDB:-knowledge}; SCH=${SCH:-knowledge}
TS=$(date +%s)
DS="rd_dt_rows_$TS"; DS_NN="rd_dt_rows_nn_$TS"
RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/dt-rows.XXXXXX"); RES="$RUN_DIR/response.json"
pass=0; fail=0; skip=0
req()  { curl -sS -m 90 --noproxy '*' -o "$RES" -w '%{http_code}' "$@"; }
post() { curl -sS -m 90 --noproxy '*' -o "$RES" -w '%{http_code}' -X POST "$1" -H 'Content-Type: application/json' -d "$2"; }
patch(){ curl -sS -m 90 --noproxy '*' -o "$RES" -w '%{http_code}' -X PATCH "$1" -H 'Content-Type: application/json' -d "$2"; }
del()  { curl -sS -m 90 --noproxy '*' -o "$RES" -w '%{http_code}' -X DELETE "$1" -H 'Content-Type: application/json' -d "$2"; }
py()   { python3 -c "${1//\/tmp\/uc-res.json/$RES}"; }
pgq()  { docker exec "$PGC" psql -U postgres -d "$PGDB" -Atc "$1"; }
check(){ if [ -n "$3" ] && [ "$3" = "$4" ]; then echo "PASS $1 $2"; pass=$((pass+1)); else echo "FAIL $1 $2 expect=[$3] got=[$4]"; fail=$((fail+1)); fi }
cleanup(){ for id in "$@"; do curl -sS -m 30 --noproxy '*' -o /dev/null -X DELETE "$BASE/database/$id" || true; done; }
trap 'cleanup "$DS" "$DS_NN" "rd_dt_probe_$TS"' EXIT

SVC=$(req "$BASE/database?page=1&pageSize=1")
if [ "$SVC" != "200" ]; then echo "SKIP 服务未就绪(http=$SVC): $BASE"; exit 0; fi
if [ "$(pgq 'SELECT 1')" != "1" ]; then echo "SKIP PG 不可达"; exit 0; fi

# ── DT13 / DT14（无 embedding 依赖的负例） ─────────────────
post "$BASE/database" "{\"id\":\"$DS_NN\",\"name\":\"rows负例\",\"columns\":[{\"name\":\"nameCol\",\"notNull\":true},{\"name\":\"descCol\"}]}" >/dev/null
NN_TBL=$(pgq "SELECT data_table_name FROM $SCH.databases WHERE id='$DS_NN'")
check DT13a "空白文本拒绝" 400 "$(post "$BASE/database/$DS_NN/rows" '{"rows":[{"nameCol":"   "}]}')"
check DT13b "空白行不落库" 0 "$(pgq "SELECT count(*) FROM $SCH.$NN_TBL")"
check DT14a "notNull缺失400" 400 "$(post "$BASE/database/$DS_NN/rows" '{"rows":[{"descCol":"只有描述"}]}')"
check DT14b "空rows拒绝" 400 "$(post "$BASE/database/$DS_NN/rows" '{"rows":[]}')"
check DT14c "失败行不落库" 0 "$(pgq "SELECT count(*) FROM $SCH.$NN_TBL")"

# ── DT20 数据集不存在（负例） ──────────────────────────────
check DT20a "列表404" 404 "$(req "$BASE/database/rd_dt_ghost_$TS/rows")"
check DT20b "行详情404" 404 "$(req "$BASE/database/rd_dt_ghost_$TS/rows/r1")"
check DT20c "批更新404" 404 "$(patch "$BASE/database/rd_dt_ghost_$TS/rows/batch" '{"items":[{"id":"r1","patch":{"a":"b"}}]}')"
check DT20d "批删除404" 404 "$(del "$BASE/database/rd_dt_ghost_$TS/rows/batch" '{"ids":["r1"]}')"
check DT20e "search404" 404 "$(post "$BASE/database/rd_dt_ghost_$TS/rows/search" '{"query":"x"}')"
check DT20f "POST rows为400" 400 "$(post "$BASE/database/rd_dt_ghost_$TS/rows" '{"rows":[{"a":"b"}]}')"

# ── embedding 探针 ────────────────────────────────────────
EMB_OK=0
if [ "$(post "$BASE/database" "{\"id\":\"rd_dt_probe_$TS\",\"name\":\"emb-probe\",\"columns\":[{\"name\":\"a\"}],\"dataSource\":[{\"a\":\"探针行\"}]}")" = "200" ]; then EMB_OK=1; fi
if [ "$EMB_OK" != "1" ] && [ "${DT_ALLOW_EMBEDDING_SKIP:-0}" != "1" ]; then echo "FAIL EMB 探针失败，不自动视为环境阻塞"; exit 1; fi

if [ "$EMB_OK" = "1" ]; then
  post "$BASE/database" "{\"id\":\"$DS\",\"name\":\"行CRUD数据集\",\"columns\":[{\"name\":\"name\"},{\"name\":\"owner\"},{\"name\":\"region\"},{\"name\":\"desc\"}],\"dataSource\":[{\"name\":\"订单管理服务\",\"owner\":\"张三\",\"region\":\"华东\",\"desc\":\"处理订单创建与订单查询\"},{\"name\":\"库存管理服务\",\"owner\":\"李四\",\"region\":\"华东\",\"desc\":\"管理库存数量与出入库\"},{\"name\":\"用户认证服务\",\"owner\":\"zhangSan\",\"region\":\"华北\",\"desc\":\"负责登录鉴权与会话管理\"},{\"name\":\"支付网关服务\",\"owner\":\"王五\",\"region\":\"华南\",\"desc\":\"对接支付渠道与退款处理\"},{\"name\":\"物流跟踪服务\",\"owner\":\"赵六\",\"region\":\"华南\",\"desc\":\"提供物流轨迹查询与运单推送\"},{\"name\":\"报表中心服务\",\"owner\":\"钱七\",\"region\":\"浙江省杭州市\",\"desc\":\"经营数据统计与报表导出\"}]}" >/dev/null
  RTBL=$(pgq "SELECT data_table_name FROM $SCH.databases WHERE id='$DS'")
  R1=$(pgq "SELECT id FROM $SCH.$RTBL WHERE name='订单管理服务'")
  R2=$(pgq "SELECT id FROM $SCH.$RTBL WHERE name='库存管理服务'")
  R4=$(pgq "SELECT id FROM $SCH.$RTBL WHERE name='支付网关服务'")
  R5=$(pgq "SELECT id FROM $SCH.$RTBL WHERE name='物流跟踪服务'")
  R6=$(pgq "SELECT id FROM $SCH.$RTBL WHERE name='报表中心服务'")

  # ── DT11 批量追加写入 ───────────────────────────────────
  check DT11a "追加1行count" 1 "$(post "$BASE/database/$DS/rows" '{"rows":[{"name":"消息通知服务","owner":"孙八","region":"华北","desc":"短信邮件与站内消息推送"}]}' >/dev/null; py "import json;print(json.load(open('/tmp/uc-res.json'))['data']['count'])")"
  check DT11b "行id为r_前缀" yes "$(py "print('yes' if '${R1:0:2}'=='r_' else 'no')")"
  check DT11c "动态表7行" 7 "$(pgq "SELECT count(*) FROM $SCH.$RTBL")"
  check DT11d "向量metadata契约" 7 "$(pgq "SELECT count(*) FROM $SCH.kb_$DS WHERE metadata ? 'rowId' AND metadata ? 'chunkIndex' AND metadata ? 'text'")"
  check DT11e "向量id为chunk模式" "$(pgq "SELECT count(*) FROM $SCH.kb_$DS")" "$(pgq "SELECT count(*) FROM $SCH.kb_$DS WHERE vector_id ~ '^r_.*__c[0-9]+$'")"

  # ── DT12 未知列键静默忽略 ───────────────────────────────
  check DT12a "未知列不报错" 200 "$(post "$BASE/database/$DS/rows" '{"rows":[{"name":"未知列测试行","ghost_col":"v","region":"华东","desc":"带未知列的行"}]}')"
  check DT12b "动态表列集合不变" 7 "$(pgq "SELECT count(*) FROM information_schema.columns WHERE table_schema='$SCH' AND table_name='$RTBL'")"
  check DT12c "行已落库8行" 8 "$(pgq "SELECT count(*) FROM $SCH.$RTBL")"

  # ── DT15 行列表分页 ─────────────────────────────────────
  check DT15a "分页元数据" "2|8|4" "$(req "$BASE/database/$DS/rows?page=1&pageSize=2" >/dev/null; py "import json;d=json.load(open('/tmp/uc-res.json'))['data'];print('%s|%s|%s'%(len(d['items']),d['total'],d['totalPages']))")"
  P1=$(req "$BASE/database/$DS/rows?page=1&pageSize=4" >/dev/null; py "import json;print(','.join(sorted(x['id'] for x in json.load(open('/tmp/uc-res.json'))['data']['items'])))")
  P2=$(req "$BASE/database/$DS/rows?page=2&pageSize=4" >/dev/null; py "import json;print(','.join(sorted(x['id'] for x in json.load(open('/tmp/uc-res.json'))['data']['items'])))")
  check DT15b "页间不重叠" yes "$(py "a='$P1'.split(',');b='$P2'.split(',');print('yes' if not set(a)&set(b) and len(a)==4 and len(b)==4 else 'no')")"
  check DT15c "pageSize=201拒绝" 400 "$(req "$BASE/database/$DS/rows?pageSize=201")"
  check DT15d "pageSize=0拒绝" 400 "$(req "$BASE/database/$DS/rows?pageSize=0")"

  # ── DT16 行列表 filter ──────────────────────────────────
  check DT16a "URL平铺过滤" 3 "$(req "$BASE/database/$DS/rows?region=华东" >/dev/null; py "import json;print(json.load(open('/tmp/uc-res.json'))['data']['total'])")"
  check DT16b "filterJSON等价" 3 "$(req "$BASE/database/$DS/rows?filter=%7B%22region%22%3A%22%E5%8D%8E%E4%B8%9C%22%7D" >/dev/null; py "import json;print(json.load(open('/tmp/uc-res.json'))['data']['total'])")"
  check DT16c "子串匹配" 1 "$(req "$BASE/database/$DS/rows?region=%E6%B5%99%E6%B1%9F" >/dev/null; py "import json;print(json.load(open('/tmp/uc-res.json'))['data']['total'])")"
  check DT16d "大小写不敏感" 1 "$(req "$BASE/database/$DS/rows?owner=zhangsan" >/dev/null; py "import json;print(json.load(open('/tmp/uc-res.json'))['data']['total'])")"
  check DT16e "未知filter键500" 500 "$(req "$BASE/database/$DS/rows?ghost_col=v")"
  check DT16f "非法filter JSON 500" 500 "$(req "$BASE/database/$DS/rows?filter=not-json")"

  # ── DT17 行详情 ─────────────────────────────────────────
  check DT17a "详情字段完整" yes "$(req "$BASE/database/$DS/rows/$R1" >/dev/null; py "import json;d=json.load(open('/tmp/uc-res.json'))['data'];print('yes' if d.get('name')=='订单管理服务' and d.get('created_at') and d.get('updated_at') else 'no')")"
  check DT17b "行不存在404" 404 "$(req "$BASE/database/$DS/rows/rd_dt_ghost_row")"

  # ── DT18 批量更新 ───────────────────────────────────────
  UPD_BEFORE=$(pgq "SELECT updated_at FROM $SCH.$RTBL WHERE id='$R1'")
  check DT18a "更新200且返回新值" yes "$(patch "$BASE/database/$DS/rows/batch" "{\"items\":[{\"id\":\"$R1\",\"patch\":{\"owner\":\"王大明\"}}]}" >/dev/null; py "import json;d=json.load(open('/tmp/uc-res.json'));print('yes' if d['code']==200 and '王大明' in d['data']['rows'][0]['owner'] else 'no')")"
  check DT18b "updated_at前移" yes "$(pgq "SELECT CASE WHEN updated_at > '$UPD_BEFORE' THEN 'yes' ELSE 'no' END FROM $SCH.$RTBL WHERE id='$R1'")"
  check DT18c "重向量化生效" 1 "$(pgq "SELECT (count(*)>0)::int FROM $SCH.kb_$DS WHERE metadata->>'rowId'='$R1' AND metadata->>'text' LIKE '%王大明%'")"
  check DT18d "空patch noop" 200 "$(patch "$BASE/database/$DS/rows/batch" "{\"items\":[{\"id\":\"$R1\",\"patch\":{}}]}")"
  check DT18e "未知列400" 400 "$(patch "$BASE/database/$DS/rows/batch" "{\"items\":[{\"id\":\"$R1\",\"patch\":{\"ghost_col\":\"v\"}}]}")"
  check DT18f "ghost行404" 404 "$(patch "$BASE/database/$DS/rows/batch" '{"items":[{"id":"rd_dt_ghost_row","patch":{"owner":"x"}}]}')"
  check DT18g "混合批次404" 404 "$(patch "$BASE/database/$DS/rows/batch" "{\"items\":[{\"id\":\"$R2\",\"patch\":{\"owner\":\"不应生效\"}},{\"id\":\"rd_dt_ghost_row\",\"patch\":{\"owner\":\"x\"}}]}")"
  check DT18h "失败整体回滚" 0 "$(pgq "SELECT count(*) FROM $SCH.$RTBL WHERE id='$R2' AND owner='不应生效'")"
  check DT18i "items重复id 400" 400 "$(patch "$BASE/database/$DS/rows/batch" "{\"items\":[{\"id\":\"$R1\",\"patch\":{\"owner\":\"a\"}},{\"id\":\"$R1\",\"patch\":{\"owner\":\"b\"}}]}")"
  check DT18j "保留字列desc更新200" 200 "$(patch "$BASE/database/$DS/rows/batch" "{\"items\":[{\"id\":\"$R1\",\"patch\":{\"desc\":\"保留字列更新\"}}]}")"

  # ── DT19 批量删行 ───────────────────────────────────────
  check DT19a "删2行" 2 "$(del "$BASE/database/$DS/rows/batch" "{\"ids\":[\"$R4\",\"$R5\"]}" >/dev/null; py "import json;print(json.load(open('/tmp/uc-res.json'))['data']['deleted'])")"
  check DT19b "行已删6行" 6 "$(pgq "SELECT count(*) FROM $SCH.$RTBL")"
  check DT19c "向量同步清理" 0 "$(pgq "SELECT count(*) FROM $SCH.kb_$DS WHERE metadata->>'rowId' IN ('$R4','$R5')")"
  check DT19d "含不存在id 404" 404 "$(del "$BASE/database/$DS/rows/batch" "{\"ids\":[\"$R6\",\"rd_dt_ghost_row\"]}")"
  check DT19e "同批真实行已删" 0 "$(pgq "SELECT count(*) FROM $SCH.$RTBL WHERE id='$R6'")"
  check DT19f "空ids拒绝" 400 "$(del "$BASE/database/$DS/rows/batch" '{"ids":[]}')"
else
  for c in DT11 DT12 DT15 DT16 DT17 DT18 DT19; do echo "SKIP $c（embedding 通道不可用）"; skip=$((skip+1)); done
fi

echo "━━━ rows.md 汇总: PASS=$pass FAIL=$fail SKIP=$skip ━━"
exit $fail
```

## 实测结果（2026-10-14，Docker HTTP/PG + mock 确定性向量）

**修复后：47 PASS / 0 FAIL / 0 SKIP**（embedding 经 mock 可用）

首轮失败记录（已修复，见 [README](./README.md#已修复缺陷)）：

| 失败（首轮） | 实测 | 根因（源码） |
|---|---|---|
| DT15d | `GET /rows?pageSize=0` 返回 200 | `routes/rows-list.ts`：`if (validated.pageSize && (...))` 同样 falsy 短路，0 被放行 |
| DT18j | `PATCH /rows/batch` 更新保留字列 `desc` 返回 400（`syntax error at or near "desc"`） | `services/database.service.ts` `executeRowUpdate`：`SET ${key} = $n` 未加双引号；建表时列名加了引号，更新路径却没有，同一列名在创建与更新中行为不一致 |

通过的关键断言：批量写入行 id 前缀与 chunk 向量 id 模式、未知列静默忽略（列集合不变）、全空白文本与缺 notNull 列均不落库、列表分页不重叠、filter 平铺/JSON 等价与子串/大小写语义、批量更新 updated_at 前移与重向量化、**混合批次整体回滚**、批量删行向量同步清理。

观察（非失败，已如实断言）：
- DT19e：批量删行中含不存在 id 时报 404，但同批真实行**已被删除**（单语句删行后校验，非整体事务）。
- DT20f：`POST /rows` 对不存在的数据集返回 400，而其它行接口为 404（`rows-create.ts` 恒定 400）。
