# 数据集生命周期与 schema 迁移（DT01~DT10）

> data-table 业务域的数据集（dataset）管理链路：创建（元数据 + 动态物理表 + 向量索引）→ 列表/详情 →
> PATCH 元数据与列迁移（加列 / 删列 / NOT NULL）→ 删除（三件套一致性清理）。
> 全部断言基于源码 `src/data-table/{routes,services,db}` 与 2026-10 实测行为；执行不符记 `FAIL`。
> 行为要点：
>
> - 元数据表 `$SCH.databases` 一行 ↔ 动态表 `$SCH.rd_tbl_*` ↔ 向量表 `$SCH.kb_*`，三者同生同灭；
> - 创建任一步失败整体回滚（无残留）；列名保留字 `id`/`created_at`/`updated_at` 拒绝；
> - 列类型恒为 TEXT（`mapSqlType`）；物理表名 = `rd_tbl_` + normalize(id 去 `rd_` 前缀)；
> - PATCH 删列会同步 ALTER TABLE 并**全量重向量化**；仅加列不改名不触发重向量化。

## 用例（DT01~DT10）

| 用例 | 前置 | 验证点 |
|---|---|---|
| DT01 | — | 最小创建（columns 3 列，无 dataSource）：200；PG 元表行 + 动态表 + 向量表三件套存在；`index_created=1`、`index_name=kb_<id>` |
| DT02 | — | 列定义负例：保留字（id / created_at）→ 400；非法列名 → 400；空 columns → 400；重名列 → 400 且**失败无残留**（元表行/向量表均不落） |
| DT03 | DT01 | 列表：分页（total/totalPages）、search 子串命中与无匹配、includeStats rowCount、page/pageSize 边界（0 与 101 拒绝） |
| DT04 | DT01 | 详情：字段一致；`includeStats=true` 返回 rowCount；不存在 → 404 |
| DT05 | DT01 | PATCH 元数据（name/description，columns 原样）：PG 更新且 `column_definitions` 不变；columns 重名 → 400；数据集不存在 → 404 |
| DT06 | EMB | PATCH 加列：动态表新增列（旧行该列为 NULL）；**未删列不触发重向量化**（PG 向量数不变） |
| DT07 | EMB | PATCH 删列：动态表列删除；**全量重向量化**（向量 metadata 不再含被删列名；distinct rowId 覆盖全部行） |
| DT08 | EMB | NOT NULL 迁移：新列 notNull（旧行补 `''`）；已有列含 NULL 时设 notNull → 400 且**事务回滚**（column_definitions 与动态表列均不变） |
| DT09 | DT03 | 删除：三件套（元表行 / 动态表 / 向量表）全部清理，`to_regclass` 为空 |
| DT10 | DT09 | 删除负例：不存在 → 404；重复删除 → 404 |

> 前置 `EMB` = embedding 通道可用（探针数据集带 1 行 dataSource 建库成功）；不可用时 DT06~DT08 记 SKIP，不伪造。

## 内嵌测试脚本

```bash
BASE=${BASE:-http://127.0.0.1:18787/api}
PGC=${PGC:-knowledge-pg}; PGDB=${PGDB:-knowledge}; SCH=${SCH:-knowledge}
TS=$(date +%s)
DS_A="rd_dt_lc_a_$TS"; DS_B="rd_dt_lc_b_$TS"; DS_MIG="rd_dt_lc_mig_$TS"; DS_NN="rd_dt_lc_nn_$TS"
RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/dt-lifecycle.XXXXXX"); RES="$RUN_DIR/response.json"
pass=0; fail=0; skip=0
req()  { curl -sS -m 90 --noproxy '*' -o "$RES" -w '%{http_code}' "$@"; }
post() { curl -sS -m 90 --noproxy '*' -o "$RES" -w '%{http_code}' -X POST "$1" -H 'Content-Type: application/json' -d "$2"; }
patch(){ curl -sS -m 90 --noproxy '*' -o "$RES" -w '%{http_code}' -X PATCH "$1" -H 'Content-Type: application/json' -d "$2"; }
py()   { python3 -c "${1//\/tmp\/uc-res.json/$RES}"; }
pgq()  { docker exec "$PGC" psql -U postgres -d "$PGDB" -Atc "$1"; }
check(){ if [ -n "$3" ] && [ "$3" = "$4" ]; then echo "PASS $1 $2"; pass=$((pass+1)); else echo "FAIL $1 $2 expect=[$3] got=[$4]"; fail=$((fail+1)); fi }
reg()  { pgq "SELECT (to_regclass('$SCH.$1') IS NOT NULL)::text"; }
cleanup(){ for id in "$@"; do curl -sS -m 30 --noproxy '*' -o /dev/null -X DELETE "$BASE/database/$id" || true; done; }
trap 'cleanup "$DS_A" "$DS_B" "$DS_MIG" "$DS_NN" "rd_dt_probe_$TS" "rd_dt_lc_dup_$TS"' EXIT

SVC=$(req "$BASE/database?page=1&pageSize=1")
if [ "$SVC" != "200" ]; then echo "SKIP 服务未就绪(http=$SVC): $BASE"; exit 0; fi
if [ "$(pgq 'SELECT 1')" != "1" ]; then echo "SKIP PG 不可达"; exit 0; fi

# ── DT01 最小创建（三件套） ────────────────────────────────
check DT01a "创建200" 200 "$(post "$BASE/database" "{\"id\":\"$DS_A\",\"name\":\"数据表用例A$TS\",\"columns\":[{\"name\":\"title\"},{\"name\":\"owner\"},{\"name\":\"desc\"}]}")"
DTBL=$(pgq "SELECT data_table_name FROM $SCH.databases WHERE id='$DS_A'")
check DT01b "元表行存在" 1 "$(pgq "SELECT count(*) FROM $SCH.databases WHERE id='$DS_A'")"
check DT01c "动态表存在" true "$(reg "$DTBL")"
check DT01d "索引就绪" "1|kb_$DS_A" "$(pgq "SELECT index_created||'|'||index_name FROM $SCH.databases WHERE id='$DS_A'")"
check DT01e "向量表存在" true "$(reg "kb_$DS_A")"

# ── DT02 列定义负例（失败不残留） ──────────────────────────
check DT02a "保留字id拒绝" 400 "$(post "$BASE/database" "{\"id\":\"rd_dt_lc_x1_$TS\",\"name\":\"x\",\"columns\":[{\"name\":\"id\"}]}")"
check DT02b "保留字created_at拒绝" 400 "$(post "$BASE/database" "{\"id\":\"rd_dt_lc_x1_$TS\",\"name\":\"x\",\"columns\":[{\"name\":\"created_at\"}]}")"
check DT02c "非法列名拒绝" 400 "$(post "$BASE/database" "{\"id\":\"rd_dt_lc_x1_$TS\",\"name\":\"x\",\"columns\":[{\"name\":\"1abc\"}]}")"
check DT02d "空columns拒绝" 400 "$(post "$BASE/database" "{\"id\":\"rd_dt_lc_x1_$TS\",\"name\":\"x\",\"columns\":[]}")"
check DT02e "重名列拒绝" 400 "$(post "$BASE/database" "{\"id\":\"rd_dt_lc_dup_$TS\",\"name\":\"x\",\"columns\":[{\"name\":\"a\"},{\"name\":\"a\"}]}")"
check DT02f "失败无元表残留" 0 "$(pgq "SELECT count(*) FROM $SCH.databases WHERE id='rd_dt_lc_dup_$TS'")"
check DT02g "失败无向量表残留" false "$(reg "kb_rd_dt_lc_dup_$TS")"

# ── DT03 列表 ─────────────────────────────────────────────
post "$BASE/database" "{\"id\":\"$DS_B\",\"name\":\"数据表用例B$TS\",\"columns\":[{\"name\":\"title\"}]}" >/dev/null
check DT03a "列表200且total≥2" yes "$(req "$BASE/database" >/dev/null; py "import json;d=json.load(open('/tmp/uc-res.json'));print('yes' if d['data']['total']>=2 else 'no')")"
check DT03b "search子串命中" yes "$(req "$BASE/database?search=$TS" >/dev/null; py "import json;d=json.load(open('/tmp/uc-res.json'));print('yes' if d['data']['total']>=2 else 'no')")"
check DT03c "search无匹配0" 0 "$(req "$BASE/database?search=绝对不存在词xyz" >/dev/null; py "import json;print(json.load(open('/tmp/uc-res.json'))['data']['total'])")"
check DT03d "pageSize=1分页" yes "$(req "$BASE/database?pageSize=1" >/dev/null; py "import json;d=json.load(open('/tmp/uc-res.json'));print('yes' if len(d['data']['items'])==1 and d['data']['totalPages']>=2 else 'no')")"
check DT03e "includeStats行数" 0 "$(req "$BASE/database/$DS_A?includeStats=true" >/dev/null; py "import json;print(json.load(open('/tmp/uc-res.json'))['data'].get('rowCount'))")"
check DT03f1 "page=0拒绝" 400 "$(req "$BASE/database?page=0")"
check DT03f2 "pageSize=101拒绝" 400 "$(req "$BASE/database?pageSize=101")"

# ── DT04 详情 ─────────────────────────────────────────────
check DT04a "详情字段一致" yes "$(req "$BASE/database/$DS_A" >/dev/null; py "import json;d=json.load(open('/tmp/uc-res.json'))['data'];print('yes' if d['id']=='$DS_A' and len(d['columnDefinitions'])==3 else 'no')")"
check DT04b "includeStats=0行" 0 "$(req "$BASE/database/$DS_A?includeStats=true" >/dev/null; py "import json;print(json.load(open('/tmp/uc-res.json'))['data'].get('rowCount'))")"
check DT04c "不存在404" 404 "$(req "$BASE/database/rd_dt_lc_ghost_$TS")"

# ── DT05 PATCH 元数据 ─────────────────────────────────────
COLS_BEFORE=$(pgq "SELECT column_definitions::text FROM $SCH.databases WHERE id='$DS_A'")
check DT05a "PATCH元数据200" 200 "$(patch "$BASE/database/$DS_A" '{"name":"数据表用例A改","description":"改后描述","columns":[{"name":"title"},{"name":"owner"},{"name":"desc"}]}')"
check DT05b "PG名称描述已更新" "数据表用例A改|改后描述" "$(pgq "SELECT name||'|'||coalesce(description,'') FROM $SCH.databases WHERE id='$DS_A'")"
check DT05c "列定义不变" "$COLS_BEFORE" "$(pgq "SELECT column_definitions::text FROM $SCH.databases WHERE id='$DS_A'")"
check DT05d "重名列拒绝" 400 "$(patch "$BASE/database/$DS_A" '{"columns":[{"name":"x"},{"name":"x"}]}')"
check DT05e "不存在404" 404 "$(patch "$BASE/database/rd_dt_lc_ghost_$TS" '{"columns":[{"name":"x"}]}')"

# ── embedding 探针 ────────────────────────────────────────
EMB_OK=0
if [ "$(post "$BASE/database" "{\"id\":\"rd_dt_probe_$TS\",\"name\":\"emb-probe\",\"columns\":[{\"name\":\"a\"}],\"dataSource\":[{\"a\":\"探针行\"}]}")" = "200" ]; then EMB_OK=1; fi
if [ "$EMB_OK" != "1" ] && [ "${DT_ALLOW_EMBEDDING_SKIP:-0}" != "1" ]; then echo "FAIL EMB 探针失败，不自动视为环境阻塞"; exit 1; fi

# ── DT06~DT08（需 embedding） ─────────────────────────────
if [ "$EMB_OK" = "1" ]; then
  post "$BASE/database" "{\"id\":\"$DS_MIG\",\"name\":\"迁移数据集\",\"columns\":[{\"name\":\"nameCol\"},{\"name\":\"descCol\"}],\"dataSource\":[{\"nameCol\":\"行一\",\"descCol\":\"描述一\"},{\"nameCol\":\"行二\",\"descCol\":\"描述二\"},{\"nameCol\":\"行三\",\"descCol\":\"描述三\"}]}" >/dev/null
  MTBL=$(pgq "SELECT data_table_name FROM $SCH.databases WHERE id='$DS_MIG'")
  V0=$(pgq "SELECT count(*) FROM $SCH.kb_$DS_MIG")

  patch "$BASE/database/$DS_MIG" '{"columns":[{"name":"nameCol"},{"name":"descCol"},{"name":"status"}]}' >/dev/null
  check DT06a "加列后旧行NULL" "3" "$(pgq "SELECT count(*) FROM $SCH.$MTBL WHERE status IS NULL")"
  check DT06b "加列后向量数量不变（不单独证明未重算）" "$V0" "$(pgq "SELECT count(*) FROM $SCH.kb_$DS_MIG")"

  check DT07a "删列200" 200 "$(patch "$BASE/database/$DS_MIG" '{"columns":[{"name":"nameCol"},{"name":"status"}]}')"
  check DT07b "动态表列已删" 0 "$(pgq "SELECT count(*) FROM information_schema.columns WHERE table_schema='$SCH' AND table_name='$MTBL' AND column_name='descCol'")"
  check DT07c "向量metadata无被删列" 0 "$(pgq "SELECT count(*) FROM $SCH.kb_$DS_MIG WHERE metadata::text LIKE '%\"descCol\"%'")"
  check DT07d "重向量化覆盖全行" 3 "$(pgq "SELECT count(DISTINCT metadata->>'rowId') FROM $SCH.kb_$DS_MIG")"

  post "$BASE/database" "{\"id\":\"$DS_NN\",\"name\":\"NN数据集\",\"columns\":[{\"name\":\"nameCol\",\"notNull\":true},{\"name\":\"descCol\"}],\"dataSource\":[{\"nameCol\":\"有描述\",\"descCol\":\"d1\"},{\"nameCol\":\"空描述\"}]}" >/dev/null
  NN_TBL=$(pgq "SELECT data_table_name FROM $SCH.databases WHERE id='$DS_NN'")
  patch "$BASE/database/$DS_NN" '{"columns":[{"name":"nameCol","notNull":true},{"name":"descCol"},{"name":"status","notNull":true}]}' >/dev/null
  check DT08a "新列notNull旧行补空串" 2 "$(pgq "SELECT count(*) FROM $SCH.$NN_TBL WHERE status=''")"
  NN_BEFORE=$(pgq "SELECT column_definitions::text FROM $SCH.databases WHERE id='$DS_NN'")
  check DT08b "NULL列设notNull拒绝" 400 "$(patch "$BASE/database/$DS_NN" '{"columns":[{"name":"nameCol","notNull":true},{"name":"descCol","notNull":true}]}')"
  check DT08c "失败后列定义回滚" "$NN_BEFORE" "$(pgq "SELECT column_definitions::text FROM $SCH.databases WHERE id='$DS_NN'")"
  check DT08d "失败后动态表列仍在" 1 "$(pgq "SELECT count(*) FROM information_schema.columns WHERE table_schema='$SCH' AND table_name='$NN_TBL' AND column_name='descCol'")"
else
  for c in DT06 DT07 DT08; do echo "SKIP $c（embedding 通道不可用）"; skip=$((skip+1)); done
fi

# ── DT09 删除（三件套清理） ────────────────────────────────
BTBL=$(pgq "SELECT data_table_name FROM $SCH.databases WHERE id='$DS_B'")
check DT09a "删除200" 200 "$(req -X DELETE "$BASE/database/$DS_B")"
check DT09b "元表行清理" 0 "$(pgq "SELECT count(*) FROM $SCH.databases WHERE id='$DS_B'")"
check DT09c "动态表清理" false "$(reg "$BTBL")"
check DT09d "向量表清理" false "$(reg "kb_$DS_B")"

# ── DT10 删除负例 ─────────────────────────────────────────
check DT10a "不存在404" 404 "$(req -X DELETE "$BASE/database/rd_dt_lc_ghost_$TS")"
check DT10b "重复删除404" 404 "$(req -X DELETE "$BASE/database/$DS_B")"

echo "━━━ lifecycle.md 汇总: PASS=$pass FAIL=$fail SKIP=$skip ━━"
exit $fail
```

## 实测结果（2026-10-14，Docker HTTP/PG + mock 确定性向量）

> 执行环境：`KNOWLEDGE_PORT=18787` + `KNOWLEDGE_DATABASE_URL=postgresql://postgres:***@127.0.0.1:55432/knowledge`（容器 `knowledge-pg`），
> embedding 指向确定性 mock `/embeddings`（与 `test/database-e2e.test.ts` 同 bag-of-tokens 算法）。

**修复后：43 PASS / 0 FAIL / 0 SKIP**（embedding 通道经 mock 可用，DT06~DT08 全部执行）

首轮失败记录（已修复，见 [README](./README.md#已修复缺陷)）：

| 失败（首轮） | 实测 | 根因（源码） |
|---|---|---|
| DT03f1 | `page=0` 返回 200，未报 400 | `routes/list.ts`：`if (validated.page && validated.page < 1)`，0 为 falsy 被短路，校验形同虚设（`page=0` 被静默当作第 1 页） |
| DT07b | 删除列 `descCol` 后，元数据已移除，但 PG 动态表**物理列仍存在** | `services/database.service.ts` `migratePhysicalTableColumns`：`DROP COLUMN IF EXISTS ${name}` 未加双引号，驼峰列名被 PG 折叠为 `desccol`，IF EXISTS 静默跳过；元数据与物理表不一致（已用最小用例 `repro` 复现） |

其余 DT01~DT10 通过：三件套创建/回滚无残留、列表分页与搜索、详情 includeStats、元数据 PATCH 不改列定义、加列不触发重向量化、删列后向量 metadata 不再含被删列、NOT NULL 旧行补空串、NULL 列设 NOT NULL 失败时事务回滚、删除三件套清理与 404 负例。
