# 基础链路：服务 / 全局契约 / 访问控制

> 用例段：G01。脚本面向已启动的网关（见 [README.md](./README.md) 运行环境）。

## 用例

### G01：服务与全局契约

| 用例 | 验证点 |
|---|---|
| G01.1 | `GET /health`：apps 表有数据 → 200 `{status:'healthy', initialized, configCount>0}` |
| G01.2 | `/health` 响应**不被包装**（无 code/success 外层，原 @Res 直写语义） |
| G01.3 | `/gw-api` 控制器响应统一包装：`{code:200, success:true, data, message:'Success'}` |
| G01.4 | 错误形态：`{statusCode, timestamp:'yyyy-MM-dd HH:mm:ss', url:'METHOD path', message}` |
| G01.5 | `/gw-api` 域名白名单：localhost/127.0.0.1 放行（curl 默认 Host） |
| G01.6 | 外部域名（含 'front-gw'）放行；其它域名返回文本"无权访问" |
| G01.7 | 路径含 `health` 的 /gw-api 请求放行（越过域名白名单，未匹配路由则 Nest 404） |
| G01.8 | 未匹配的 /gw-api 路径 → Nest 风格 404（不落 hosting 兜底） |
| G01.9 | 非 /gw-api 未知路径 → hosting 兜底："访问的应用不存在" |
| G01.10 | 尾斜杠归一：`POST /report-api/`（带斜杠）等价 `/report-api` |
| G01.11 | 所有响应带 `X-Trace-ID` 头 |
| G01.12 | `GET /metrics` 输出 Prometheus 文本且请求被计数 |
| G01.13 | PG 连通：health 的 configCount 与 `SELECT count(*) FROM {SCH}.apps` 一致 |

## 测试脚本

```bash
BASE=${BASE:-http://127.0.0.1:3101}
PGURL=${PGURL:-postgresql://postgres:ab123456@127.0.0.1:5432/opencode-v2-up}
SCH=${SCH:-hn_gateway_dev}
pass=0; fail=0; skip=0
req()  { curl -sS -m 30 --noproxy '*' -o /tmp/gw-uc-res.json -w '%{http_code}' "$@"; }
jget() { python3 -c "import json,sys;d=json.load(open('/tmp/gw-uc-res.json'));print(eval('d'+sys.argv[1]))" "$1" 2>/dev/null || true; }
raw()  { cat /tmp/gw-uc-res.json; }
pgq()  { psql "$PGURL" -Atc "$1" 2>/dev/null; }
check(){ if [ -n "$3" ] && [ "$3" = "$4" ]; then echo "PASS $1 $2"; pass=$((pass+1)); else echo "FAIL $1 $2 expect=[$3] got=[$4]"; fail=$((fail+1)); fi }
skipcase(){ echo "SKIP $1 $2"; skip=$((skip+1)); }

# 环境预检
[ "$(req "$BASE/health" >/dev/null; echo ok)" = "ok" ] || { echo "网关未启动（$BASE），全部用例无法执行"; exit 9; }

# ── G01.1~G01.3 health 与响应包装 ──
# 保证 apps 表至少有一行（幂等：不存在则插入探针行）
pgq "INSERT INTO $SCH.apps (app_id, domain, base_route, config) VALUES ('uc_g01_probe','uc-g01.test','', '{\"appId\":\"uc_g01_probe\"}'::jsonb) ON CONFLICT (app_id) DO NOTHING" >/dev/null
c=$(req "$BASE/health")
check G01.1a "health=200" 200 "$c"
check G01.1b "status=healthy" healthy "$(jget "['status']")"
check G01.1c "configCount>0" yes "$(python3 -c "import json;print('yes' if json.load(open('/tmp/gw-uc-res.json'))['configCount']>0 else 'no')" 2>/dev/null)"
check G01.2 "health不被包装" no "$(jget "['code']" >/dev/null 2>&1; jget "['code']" | grep -q 200 && echo yes || echo no)"

# G01.3：/gw-api/platform 的包装契约（无需种子数据，空库也是合法 data）
c=$(req "$BASE/gw-api/platform")
check G01.3a "platform=200" 200 "$c"
check G01.3b "外层code=200" 200 "$(jget "['code']")"
check G01.3c "外层success=true" True "$(jget "['success']")"
check G01.3d "外层message=Success" Success "$(jget "['message']")"
check G01.3e "data为对象" yes "$(raw | python3 -c "import json,sys;print('yes' if isinstance(json.load(sys.stdin).get('data'),dict) else 'no')" 2>/dev/null)"

# ── G01.4 错误形态（非法 body 触发 400）──
c=$(req -X POST "$BASE/gw-api/nacos/cache/fix" -H 'content-type: application/json' -d '[1,2]')
check G01.4a "非法body=400" 400 "$c"
check G01.4b "statusCode=400" 400 "$(jget "['statusCode']")"
check G01.4c "timestamp格式" yes "$(jget "['timestamp']" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$' && echo yes || echo no)"
check G01.4d "url含方法与路径" yes "$(jget "['url']" | grep -q 'POST /gw-api' && echo yes || echo no)"
check G01.4e "message存在" yes "$(jget "['message']" | grep -q '.' && echo yes || echo no)"

# ── G01.5~G01.7 访问控制 ──
c=$(req "$BASE/gw-api/nacos/status")            # 默认 Host=127.0.0.1 → localhost 放行
check G01.5 "localhost放行" 200 "$c"
c=$(curl -sS -m 10 --noproxy '*' -o /tmp/gw-uc-res.json -w '%{http_code}' -H 'Host: uc-front-gw.example.com' "$BASE/gw-api/nacos/status")
check G01.6a "front-gw域名放行" 200 "$c"
c=$(curl -sS -m 10 --noproxy '*' -o /tmp/gw-uc-res.json -w '%{http_code}' -H 'Host: evil.example.com' "$BASE/gw-api/nacos/status")
check G01.6b "其它域名拒绝" 200 "$c"
check G01.6c "拒绝文案" 无权访问 "$(raw)"
c=$(curl -sS -m 10 --noproxy '*' -o /tmp/gw-uc-res.json -w '%{http_code}' -H 'Host: evil.example.com' "$BASE/gw-api/no-health-check-here/health")
check G01.7a "路径含health放行(非无权访问)" 404 "$c"
check G01.7b "未返回拒绝文案" no "$(raw | grep -q '无权访问' && echo yes || echo no)"

# ── G01.8~G01.9 404 与兜底 ──
c=$(req "$BASE/gw-api/no-such-route")
check G01.8a "gw-api未知路径404" 404 "$c"
check G01.8b "Nest风格404" 404 "$(jget "['statusCode']")"
c=$(req "$BASE/no-such-page/" -H 'Host: uc-unknown.test')
check G01.9 "hosting兜底文案" 访问的应用不存在 "$(raw)"

# ── G01.10 尾斜杠归一（POST /report-api/ 与 /report-api 等价）──
c=$(req -X POST "$BASE/report-api/" -H 'content-type: application/json' -d '{"level":"info","msg":"uc"}')
check G01.10a "尾斜杠POST=200" 200 "$c"
check G01.10b "响应等价(包装后data=success)" success "$(jget "['data']")"
c=$(req -X POST "$BASE/report-api" -H 'content-type: application/json' -d '{"level":"info","msg":"uc"}')
check G01.10c "无斜杠POST同样success" success "$(jget "['data']")"

# ── G01.11 X-Trace-ID ──
req "$BASE/health" >/dev/null
TID=$(curl -sS -m 10 --noproxy '*' -D - -o /dev/null "$BASE/health" | grep -i '^x-trace-id:' | tr -d '\r' | awk '{print $2}')
check G01.11 "X-Trace-ID存在" yes "$([ -n "$TID" ] && echo yes || echo no)"

# ── G01.12 /metrics ──
req "$BASE/health" >/dev/null   # 制造一次计数
MET=$(curl -sS -m 10 --noproxy '*' "$BASE/metrics")
check G01.12a "metrics文本" yes "$(echo "$MET" | grep -q 'gateway_http_request_duration_seconds' && echo yes || echo no)"
check G01.12b "默认进程指标" yes "$(echo "$MET" | grep -q 'gateway_process_' && echo yes || echo no)"

# ── G01.13 PG 一致性 ──
DB_COUNT=$(pgq "SELECT count(*) FROM $SCH.apps")
c=$(req "$BASE/health")
check G01.13 "configCount=PG行数" "$DB_COUNT" "$(jget "['configCount']")"

# 清理探针
pgq "DELETE FROM $SCH.apps WHERE app_id='uc_g01_probe'" >/dev/null

echo "━━━ base.md 汇总: PASS=$pass FAIL=$fail SKIP=$skip ━━"; exit $(( fail > 0 ))
```

## 说明

- G01.1 需要 apps 表非空（脚本自动插入探针行，测后清理）；空库场景的 503 语义见 G01.1x（可选：独立 schema 验证，不在此脚本化）。
- G01.6b 的"无权访问"HTTP 状态为 200 文本（原实现 res.send 语义，非 403）——断言文案而非状态码。
- G01.10 的 report POST 会在 report_events 表落下 2 行事件（`uc` msg），属预期数据，不在本文件清理（量小且无害）。
