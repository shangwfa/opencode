# 配置面：应用注册 / platform 聚合 / nacos 运维语义（Nacos→PG）

> 用例段：G10。对应原 NacosConfigService/AppController 的全部能力面（两轮审计确认的逐条映射，见 DESIGN.md §3.1）。

## 用例

### G10.1：apps CRUD 与匹配

| 用例 | 验证点 |
|---|---|
| G10.1.1 | `POST /gw-api/apps/:appId` 建应用（domain 小写化）→ 200 |
| G10.1.2 | 同 appId 重复 POST 为 upsert（version+1，非 400） |
| G10.1.3 | `GET /gw-api/apps/:appId` 返回配置 |
| G10.1.4 | `GET /gw-api/apps/domain/:domain` 按 domain 前缀过滤 |
| G10.1.5 | `GET /gw-api/platform` 聚合：key 为 `domain/baseRoute` 与 `domain` 两种 |
| G10.1.6 | domain+baseRoute 唯一约束：不同 appId 同 (domain,base_route) 被拒（PG 层） |
| G10.1.7 | getAppByDomain 语义：精确 `domain/baseRoute` 优先，未命中回退根应用（hosting 链上验证） |

### G10.2：nacos 运维语义

| 用例 | 验证点 |
|---|---|
| G10.2.1 | `GET /gw-api/nacos/status`：`{success, data:{store:'postgres', db:'up', cache}}`（双层包装） |
| G10.2.2 | `POST /gw-api/nacos/refresh`：清缓存并重读，返回 configCount |
| G10.2.3 | `POST /gw-api/nacos/resubscribe`：type=all/config/locale（locale 已裁剪按 config 处理） |
| G10.2.4 | `GET /gw-api/nacos/subscribedConfigs`：返回订阅列表 |
| G10.2.5 | `POST /gw-api/nacos/cache/fix`：整份 IPlatform 批量写穿；缺 appId 条目跳过 |
| G10.2.6 | `POST /gw-api/nacos/app/:appId/update` **默认 incremental**（JSONB 合并） |
| G10.2.7 | `?mode=full` 整体替换；非法 mode → 400 |
| G10.2.8 | `x-expected-version` 乐观锁：不匹配 → 409；匹配 → 成功且 version+1 |
| G10.2.9 | 更新不存在应用 → 404 |
| G10.2.10 | private-info：configs KV 读（`GET /gw-api/private-info`） |

### G10.3：缓存与一致性

| 用例 | 验证点 |
|---|---|
| G10.3.1 | 写后读一致：upsert 后立即 GET platform 可见（写后本地失效） |
| G10.3.2 | incremental 合并保留未覆盖字段（PG 断言 config JSONB） |
| G10.3.3 | version 乐观锁列随每次写 +1（PG 断言） |

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

[ "$(req "$BASE/health" >/dev/null; echo ok)" = "ok" ] || { echo "网关未启动，退出"; exit 9; }

# 幂等清理
pgq "DELETE FROM $SCH.apps WHERE app_id IN ('uc_g10_app','uc_g10_root','uc_g10_sub','uc_g10_conflict','uc_g10_fix1','uc_g10_fix2','uc_g10_bad')" >/dev/null
pgq "DELETE FROM $SCH.configs WHERE key='private-info'" >/dev/null
pgq "SELECT pg_notify('gateway_config_changed', '{\"table\":\"apps\",\"key\":\"*\"}')" >/dev/null; sleep 0.2

# ── G10.1 apps CRUD ──
BODY='{"domain":"UC-G10.TEST","baseRoute":"web","config":{"url":"http://fake/static/app","version":"1.0.0","name":"用例应用"}}'
check G10.1.1a "创建应用" 200 "$(req -X POST "$BASE/gw-api/apps/uc_g10_app" -H 'content-type: application/json' -d "$BODY")"
check G10.1.1b "domain小写化" uc-g10.test "$(pgq "SELECT domain FROM $SCH.apps WHERE app_id='uc_g10_app'")"
BODY='{"domain":"uc-g10.test","baseRoute":"web","config":{"url":"http://fake/static/app","version":"2.0.0","name":"用例应用v2"}}'
c=$(req -X POST "$BASE/gw-api/apps/uc_g10_app" -H 'content-type: application/json' -d "$BODY")
check G10.1.2a "重复POST=upsert" 200 "$c"
check G10.1.2b "version+1" 2 "$(jget "['data']['data']['version']")"
c=$(req "$BASE/gw-api/apps/uc_g10_app")
check G10.1.3 "按appId查询" 2.0.0 "$(jget "['data']['data']['version']")"
c=$(req "$BASE/gw-api/apps/domain/uc-g10.test")
check G10.1.4 "按domain过滤" yes "$(jget "['data']['data']" | grep -q 'uc-g10.test/web' && echo yes || echo no)"

# 根应用 + platform 聚合（经 API 写入以触发缓存失效；pgq 直写不 NOTIFY）
c=$(req -X POST "$BASE/gw-api/apps/uc_g10_root" -H 'content-type: application/json' -d '{"domain":"uc-g10.test","baseRoute":"","config":{"version":"9.0.0"}}')
c=$(req "$BASE/gw-api/platform")
check G10.1.5a "platform含domain/baseRoute键" yes "$(jget "['data']" | grep -q "uc-g10.test/web" && echo yes || echo no)"
check G10.1.5b "platform含domain根键" yes "$(jget "['data']" | grep -q "'uc-g10.test':" && echo yes || echo no)"
pgq "INSERT INTO $SCH.apps (app_id,domain,base_route,config) VALUES ('uc_g10_conflict','uc-g10.test','web','{\"appId\":\"uc_g10_conflict\"}'::jsonb)" >/dev/null 2>&1
check G10.1.6 "domain+base_route唯一约束" 0 "$(pgq "SELECT count(*) FROM $SCH.apps WHERE app_id='uc_g10_conflict'")"

# ── G10.2 nacos 运维 ──
c=$(req "$BASE/gw-api/nacos/status")
check G10.2.1a "status=200" 200 "$c"
check G10.2.1b "store=postgres" postgres "$(jget "['data']['data']['store']")"
check G10.2.1c "db=up" up "$(jget "['data']['data']['db']")"
c=$(req -X POST "$BASE/gw-api/nacos/refresh")
check G10.2.2 "refresh返回configCount" yes "$(jget "['data']['configCount']" | grep -qE '^[0-9]+$' && echo yes || echo no)"
c=$(req -X POST "$BASE/gw-api/nacos/resubscribe" -H 'content-type: application/json' -d '{"type":"locale"}')
check G10.2.3 "resubscribe(locale按config)" config "$(jget "['data']['type']" | grep -q 'config' && echo config || echo no)"
c=$(req "$BASE/gw-api/nacos/subscribedConfigs")
check G10.2.4 "subscribedConfigs列表" yes "$(jget "['data']" | grep -q 'apps' && echo yes || echo no)"

# cache/fix 批量写穿
BODY='{"uc-fix.test/sub":{"appId":"uc_g10_fix1","url":"u1"},"uc-fix.test":{"appId":"uc_g10_fix2","url":"u2"},"bad":{"url":"no-appid"}}'
c=$(req -X POST "$BASE/gw-api/nacos/cache/fix" -H 'content-type: application/json' -d "$BODY")
check G10.2.5a "fix计数=2(跳过无appId)" 2 "$(jget "['data']['configCount']")"
check G10.2.5b "fix1落库" uc_g10_fix1 "$(pgq "SELECT config->>'appId' FROM $SCH.apps WHERE app_id='uc_g10_fix1'")"

# app update：默认 incremental
pgq "INSERT INTO $SCH.apps (app_id,domain,base_route,config) VALUES ('uc_g10_bad','uc-inc.test','', '{\"appId\":\"uc_g10_bad\",\"keep\":\"yes\",\"version\":\"1.0.0\"}'::jsonb) ON CONFLICT (app_id) DO NOTHING" >/dev/null
c=$(req -X POST "$BASE/gw-api/nacos/app/uc_g10_bad/update" -H 'content-type: application/json' -d '{"version":"1.1.0"}')
check G10.2.6a "默认incremental=200" 200 "$c"
check G10.2.6b "返回message成功" "App config updated successfully" "$(jget "['data']['message']")"
check G10.2.6c "默认mode=incremental" incremental "$(jget "['data']['mode']")"
check G10.2.6d "合并保留keep字段" yes "$(pgq "SELECT config->>'keep' FROM $SCH.apps WHERE app_id='uc_g10_bad'" | grep -q yes && echo yes || echo no)"
check G10.2.6e "合并更新version" 1.1.0 "$(pgq "SELECT config->>'version' FROM $SCH.apps WHERE app_id='uc_g10_bad'")"
c=$(req -X POST "$BASE/gw-api/nacos/app/uc_g10_bad/update?mode=full" -H 'content-type: application/json' -d '{"appId":"uc_g10_bad","only":"this"}')
check G10.2.7a "full整体替换" 200 "$c"
KEEPV=$(pgq "SELECT config->>'keep' FROM $SCH.apps WHERE app_id='uc_g10_bad'")
check G10.2.7b "替换后keep消失" yes "$([ -z "$KEEPV" ] && echo yes || echo no)"
c=$(req -X POST "$BASE/gw-api/nacos/app/uc_g10_bad/update?mode=bad" -H 'content-type: application/json' -d '{}')
check G10.2.7c "非法mode=400" 400 "$c"
CUR_VER=$(pgq "SELECT version FROM $SCH.apps WHERE app_id='uc_g10_bad'")
c=$(req -X POST "$BASE/gw-api/nacos/app/uc_g10_bad/update" -H 'content-type: application/json' -H "x-expected-version: 99999" -d '{"x":1}')
check G10.2.8a "乐观锁冲突409" 409 "$c"
c=$(req -X POST "$BASE/gw-api/nacos/app/uc_g10_bad/update" -H 'content-type: application/json' -H "x-expected-version: $CUR_VER" -d '{"y":2}')
check G10.2.8b "正确版本成功" 200 "$c"
check G10.2.8c "version+1" "$((CUR_VER+1))" "$(pgq "SELECT version FROM $SCH.apps WHERE app_id='uc_g10_bad'")"
c=$(req -X POST "$BASE/gw-api/nacos/app/no_such_app/update" -H 'content-type: application/json' -d '{}')
check G10.2.9 "应用不存在404" 404 "$c"

# private-info
pgq "INSERT INTO $SCH.configs (key,value) VALUES ('private-info','{\"secret\":\"uc-s\"}'::jsonb) ON CONFLICT (key) DO UPDATE SET value='{\"secret\":\"uc-s\"}'::jsonb" >/dev/null
c=$(req "$BASE/gw-api/private-info")
check G10.2.10 "private-info读" uc-s "$(jget "['data']['secret']")"

# ── G10.3 缓存与一致性 ──
c=$(req -X POST "$BASE/gw-api/apps/uc_g10_app" -H 'content-type: application/json' -d '{"domain":"uc-g10.test","baseRoute":"web","config":{"url":"http://fake/static/app","version":"3.0.0","name":"用例应用v3"}}')
c=$(req "$BASE/gw-api/platform")
check G10.3.1 "写后立即可见" 3.0.0 "$(jget "['data']['uc-g10.test/web']['version']")"
check G10.3.2 "incremental合并语义(PG)" yes "$(pgq "SELECT CASE WHEN config ? 'y' THEN 'yes' ELSE 'no' END FROM $SCH.apps WHERE app_id='uc_g10_bad'")"
check G10.3.3 "乐观锁列随写递增" yes "$(python3 -c "print('yes' if $(pgq "SELECT version FROM $SCH.apps WHERE app_id='uc_g10_app'") >= 3 else 'no')" 2>/dev/null)"

# 清理
pgq "DELETE FROM $SCH.apps WHERE app_id LIKE 'uc_g10_%'" >/dev/null
pgq "DELETE FROM $SCH.configs WHERE key='private-info'" >/dev/null

echo "━━━ config.md 汇总: PASS=$pass FAIL=$fail SKIP=$skip ━━"; exit $(( fail > 0 ))
```

## 说明

- G10.1.6 的唯一约束在 PG 层验证（INSERT 直接失败）；HTTP 层 upsert by appId 不触发该约束。
- G10.2.8 的乐观锁通过 `x-expected-version` 头传入（原网关无此机制，为 PG 化增强；不传时退化为 last-write-wins，等价原语义）。
- 多实例 NOTIFY 失效不在本脚本（需双实例），由 `test/notify.test.ts` 覆盖。
