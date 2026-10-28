# 灰度：策略矩阵 / 优先级 / ap 管理面

> 用例段：G30。四路策略 + 请求头覆盖 + 优先级排序 + backend-gray 管理双模式与运维路由。
> percentage 分桶用例内置与后端一致的 Java String.hashCode 计算器，构造确定性命中/不命中输入。

## 用例

### G30.1：版本选择入口

| 用例 | 验证点 |
|---|---|
| G30.1.1 | 请求头 version 存在 → 直接采用（最高优先，跳过全部策略） |
| G30.1.2 | 无任何灰度配置 → 兜底 app.version |

### G30.2：backend-gray 策略（priority 50）

| 用例 | 验证点 |
|---|---|
| G30.2.1 | `app.backendGray` 未启用/缺 featureKey/version → 不命中 |
| G30.2.2 | `globalEnabled=true` → 全局放行灰度版本 |
| G30.2.3 | 白名单 userId（cookie uuid）命中 |
| G30.2.4 | 黑名单命中 → 返回 blackListVersion；未配置 blackListVersion → 不命中 |
| G30.2.5 | percentageKey=userId：`Math.abs(javaHash(uuid)%100) < percentage` 命中；等于边界不命中 |
| G30.2.6 | 时间窗：startTime 未来 / endTime 过去 → 不命中 |
| G30.2.7 | 灰度规则不存在（featureKey 无记录）→ 不命中 |

### G30.3：user-enterprise 策略（priority 100）

| 用例 | 验证点 |
|---|---|
| G30.3.1 | cookie uuid+enterpriseUuid 匹配企业 canary → 企业版本 |
| G30.3.2 | 企业内用户级 users[].uuid 覆盖企业版本 |
| G30.3.3 | 缺任一 cookie / 企业不匹配 → 不命中 |

### G30.4：network 策略（priority 150）

| 用例 | 验证点 |
|---|---|
| G30.4.1 | `app.internalCanary.enabled` + x-forwarded-for 精确命中 |
| G30.4.2 | `::ffff:` IPv6 映射前缀剥离后命中 |
| G30.4.3 | CIDR 网段命中/未命中 |
| G30.4.4 | internalCanary 未启用 → 不命中 |

### G30.5：percent 策略（priority 175）

| 用例 | 验证点 |
|---|---|
| G30.5.1 | `app.percentCanary` 缺失 → 不命中（忽略 cookie） |
| G30.5.2 | cookie `gray_hash_{appId}={version}:{hash}` 版本匹配且 hash<percentage → 命中 |
| G30.5.3 | hash≥percentage → 不命中（同 cookie 稳定不命中） |
| G30.5.4 | cookie 版本不匹配 → 重算（md5(traceId)%100）并回写 Set-Cookie |
| G30.5.5 | 无 cookie → 回写 Set-Cookie `gray_hash_{appId}=...`（path=/、30 天） |

### G30.6：策略优先级

| 用例 | 验证点 |
|---|---|
| G30.6.1 | backend-gray(50) 命中时优先于 user-enterprise(100) |
| G30.6.2 | user-enterprise(100) 命中时优先于 percent(175) |

### G30.7：ap 管理面

| 用例 | 验证点 |
|---|---|
| G30.7.1 | `POST /gw-api/ap/backend-gray` 空对象 → 查询模式返回当前 backendGray |
| G30.7.2 | 传参 → 合并写入 app.backendGray（version number → string） |
| G30.7.3 | `PUT /gw-api/ap/backend-gray/feature/:featureKey` 写规则；`GET /:featureKey` 读回 |
| G30.7.4 | `GET /gw-api/backend-gray/polling/status`：缓存状态 + featureKeys |
| G30.7.5 | `POST /gw-api/backend-gray/polling/start-all`：遍历 apps（enabled+featureKey 者进 started） |
| G30.7.6 | `GET /gw-api/backend-gray/diagnose`：逐 app 诊断（规则存在性/缺字段） |

## 测试脚本

> 版本选择经 `/app-api/info`（baseurl 头解析应用 + 策略选版本）观察，响应 `version` 即选中版本。

```bash
BASE=${BASE:-http://127.0.0.1:3101}
PGURL=${PGURL:-postgresql://postgres:ab123456@127.0.0.1:5432/opencode-v2-up}
SCH=${SCH:-hn_gateway_dev}
pass=0; fail=0; skip=0
req()  { curl -sS -m 30 --noproxy '*' -o /tmp/gw-uc-res.json -w '%{http_code}' "$@"; }
jget() { python3 -c "import json,sys;d=json.load(open('/tmp/gw-uc-res.json'));print(eval('d'+sys.argv[1]))" "$1" 2>/dev/null; }
raw()  { cat /tmp/gw-uc-res.json; }
pgq()  { psql "$PGURL" -Atc "$1" 2>/dev/null; }
check(){ if [ -n "$3" ] && [ "$3" = "$4" ]; then echo "PASS $1 $2"; pass=$((pass+1)); else echo "FAIL $1 $2 expect=[$3] got=[$4]"; fail=$((fail+1)); fi }
skipcase(){ echo "SKIP $1 $2"; skip=$((skip+1)); }

[ "$(req "$BASE/health" >/dev/null; echo ok)" = "ok" ] || { echo "网关未启动，退出"; exit 9; }

APP=uc_g30_host
SEED='{"appId":"uc_g30_host","name":"灰度用例","url":"http://fake/static","version":"1.0.0"}'
setcfg(){ pgq "UPDATE $SCH.apps SET config='$1'::jsonb, updated_at=now() WHERE app_id='$APP'; SELECT pg_notify('gateway_config_changed', '{\"table\":\"apps\",\"key\":\"$APP\"}');" >/dev/null; }
ver(){ eval "req \"\$BASE/app-api/info\" -H 'Host: uc-g30.test' -H 'baseurl: /' $1 >/dev/null"; python3 -c "import json;print(json.load(open('/tmp/gw-uc-res.json')).get('version',''))" 2>/dev/null; }

pgq "DELETE FROM $SCH.apps WHERE app_id='$APP'" >/dev/null
pgq "DELETE FROM $SCH.apps WHERE app_id='xybot-aipower-web'" >/dev/null
pgq "DELETE FROM $SCH.gray_features WHERE feature_key LIKE 'uc_g30_%'" >/dev/null
pgq "INSERT INTO $SCH.apps (app_id,domain,base_route,config) VALUES ('$APP','uc-g30.test','', '$SEED'::jsonb) ON CONFLICT (app_id) DO NOTHING" >/dev/null
pgq "INSERT INTO $SCH.apps (app_id,domain,base_route,config) VALUES ('xybot-aipower-web','uc-g30-aipower.test','', '{\"appId\":\"xybot-aipower-web\",\"version\":\"2\",\"publishList\":[{\"id\":\"p2\",\"version\":\"2\"},{\"id\":\"p1\",\"version\":\"1\"}]}'::jsonb) ON CONFLICT (app_id) DO NOTHING" >/dev/null

# ── G30.1 入口 ──
check G30.1.1 "header version最高优先" 7.7.7 "$(ver "-H 'version: 7.7.7'")"
setcfg '{"appId":"uc_g30_host","name":"灰度用例","url":"http://fake/static","version":"1.0.0"}'
check G30.1.2 "无配置兜底app.version" 1.0.0 "$(ver x)"

# ── G30.2 backend-gray ──
# 与后端一致的 Java String.hashCode（32 位有符号溢出）计算确定性分桶
BUCKET=$(python3 - <<'PY'
# Java String.hashCode：32 位有符号回绕（JS |0 在每次乘加后截断，需逐步回绕）
h=0
for ch in 'uc-bucket-user':
    h=((h*31+ord(ch)) + 2**31) % 2**32 - 2**31
import math
print(abs(int(math.fmod(h,100))))
PY
)
setcfg '{"appId":"uc_g30_host","version":"1.0.0","backendGray":{"enabled":false,"featureKey":"uc_g30_f1","version":"2.0.0-gray"}}'
check G30.2.1a "backendGray未启用不命中" 1.0.0 "$(ver "-H 'cookie: uuid=any; enterpriseUuid=any'")"
setcfg '{"appId":"uc_g30_host","version":"1.0.0","backendGray":{"enabled":true,"version":"2.0.0-gray"}}'
check G30.2.1b "缺featureKey不命中" 1.0.0 "$(ver x)"
putrule(){ req -X PUT "$BASE/gw-api/ap/backend-gray/feature/uc_g30_f1" -H 'content-type: application/json' -d "$1" >/dev/null; }
putrule '{"featureKey":"uc_g30_f1","globalEnabled":true,"percentage":0,"percentageKey":"","startTime":null,"endTime":null,"whiteList":{},"blackList":{}}'
setcfg '{"appId":"uc_g30_host","version":"1.0.0","backendGray":{"enabled":true,"featureKey":"uc_g30_f1","version":"2.0.0-gray"}}'
check G30.2.2 "globalEnabled放行" 2.0.0-gray "$(ver x)"
putrule '{"featureKey":"uc_g30_f1","globalEnabled":false,"percentage":0,"percentageKey":"","startTime":null,"endTime":null,"whiteList":{"userId":["white-user"]},"blackList":{}}'
check G30.2.3 "白名单命中" 2.0.0-gray "$(ver "-H 'cookie: uuid=white-user'")"
putrule '{"featureKey":"uc_g30_f1","globalEnabled":false,"percentage":0,"percentageKey":"","startTime":null,"endTime":null,"whiteList":{},"blackList":{"userId":["black-user"]}}'
setcfg '{"appId":"uc_g30_host","version":"1.0.0","backendGray":{"enabled":true,"featureKey":"uc_g30_f1","version":"2.0.0-gray","blackListVersion":"0.9.0-stable"}}'
check G30.2.4a "黑名单→blackListVersion" 0.9.0-stable "$(ver "-H 'cookie: uuid=black-user'")"
setcfg '{"appId":"uc_g30_host","version":"1.0.0","backendGray":{"enabled":true,"featureKey":"uc_g30_f1","version":"2.0.0-gray"}}'
check G30.2.4b "黑名单无blVersion不命中" 1.0.0 "$(ver "-H 'cookie: uuid=black-user'")"
putrule "{\"featureKey\":\"uc_g30_f1\",\"globalEnabled\":false,\"percentage\":$((BUCKET+1)),\"percentageKey\":\"userId\",\"startTime\":null,\"endTime\":null,\"whiteList\":{},\"blackList\":{}}"
setcfg '{"appId":"uc_g30_host","version":"1.0.0","backendGray":{"enabled":true,"featureKey":"uc_g30_f1","version":"2.0.0-gray"}}'
check G30.2.5a "分桶命中(hash<percent)" 2.0.0-gray "$(ver "-H 'cookie: uuid=uc-bucket-user'")"
putrule "{\"featureKey\":\"uc_g30_f1\",\"globalEnabled\":false,\"percentage\":$BUCKET,\"percentageKey\":\"userId\",\"startTime\":null,\"endTime\":null,\"whiteList\":{},\"blackList\":{}}"
check G30.2.5b "边界(=percent)不命中" 1.0.0 "$(ver "-H 'cookie: uuid=uc-bucket-user'")"
FUTURE=$(python3 -c "import datetime;print((datetime.datetime.now()+datetime.timedelta(hours=1)).isoformat())")
putrule "{\"featureKey\":\"uc_g30_f1\",\"globalEnabled\":true,\"percentage\":0,\"percentageKey\":\"\",\"startTime\":\"$FUTURE\",\"endTime\":null,\"whiteList\":{},\"blackList\":{}}"
check G30.2.6 "时间窗未开始不命中" 1.0.0 "$(ver "-H 'cookie: uuid=white-user'")"
setcfg '{"appId":"uc_g30_host","version":"1.0.0","backendGray":{"enabled":true,"featureKey":"uc_g30_no_rule","version":"3.0.0"}}'
check G30.2.7 "规则不存在不命中" 1.0.0 "$(ver x)"

# ── G30.3 user-enterprise ──
setcfg '{"appId":"uc_g30_host","version":"1.0.0","canary":[{"enterpriseUuid":"ent-1","version":"2.0.0-ent","users":[{"uuid":"u-1","version":"3.0.0-user"}]}]}'
check G30.3.1 "企业级命中" 2.0.0-ent "$(ver "-H 'cookie: uuid=other; enterpriseUuid=ent-1'")"
check G30.3.2 "用户级覆盖" 3.0.0-user "$(ver "-H 'cookie: uuid=u-1; enterpriseUuid=ent-1'")"
check G30.3.3a "缺cookie不命中" 1.0.0 "$(ver x)"
check G30.3.3b "企业不匹配" 1.0.0 "$(ver "-H 'cookie: uuid=x; enterpriseUuid=ent-9'")"

# ── G30.4 network（网关需以 INTERNAL_GRAY_IPS=10.1.1.5,192.168.0.0/24 启动；否则整组 SKIP）──
setcfg '{"appId":"uc_g30_host","version":"1.0.0","internalCanary":{"enabled":true,"version":"5.0.0-internal"}}'
PROBE=$(ver "-H 'x-forwarded-for: 10.1.1.5'")
if [ "$PROBE" = "5.0.0-internal" ]; then
  check G30.4.1 "精确IP命中" 5.0.0-internal "$PROBE"
  check G30.4.2 "::ffff:前缀剥离" 5.0.0-internal "$(ver "-H 'x-forwarded-for: ::ffff:10.1.1.5'")"
  check G30.4.3a "CIDR命中" 5.0.0-internal "$(ver "-H 'x-forwarded-for: 192.168.0.88'")"
  check G30.4.3b "CIDR外不命中" 1.0.0 "$(ver "-H 'x-forwarded-for: 8.8.8.8'")"
  setcfg '{"appId":"uc_g30_host","version":"1.0.0","internalCanary":{"enabled":false,"version":"5.0.0-internal"}}'
  check G30.4.4 "未启用不命中" 1.0.0 "$(ver "-H 'x-forwarded-for: 10.1.1.5'")"
else
  skipcase G30.4 "网关未以 INTERNAL_GRAY_IPS 启动（探测精确 IP 未命中）"
fi

# ── G30.5 percent ──
setcfg '{"appId":"uc_g30_host","version":"1.0.0","percentCanary":{"version":"2.0.0-pct","percentage":10}}'
check G30.5.1 "无percentCanary不命中(先种无配置)" 1.0.0 "$(setcfg '{"appId":"uc_g30_host","version":"1.0.0"}'; ver x)"
setcfg '{"appId":"uc_g30_host","version":"1.0.0","percentCanary":{"version":"2.0.0-pct","percentage":10}}'
check G30.5.2 "cookie版本匹配hash<10命中" 2.0.0-pct "$(ver "-H 'cookie: gray_hash_uc_g30_host=2.0.0-pct:5'")"
check G30.5.3 "hash≥10不命中" 1.0.0 "$(ver "-H 'cookie: gray_hash_uc_g30_host=2.0.0-pct:99'")"
HDRS=$(curl -sS -m 10 --noproxy '*' -D - -o /dev/null "$BASE/app-api/info" -H 'Host: uc-g30.test' -H 'baseurl: /' -H 'cookie: gray_hash_uc_g30_host=1.0.0-old:50')
check G30.5.4 "版本切换回写Set-Cookie" yes "$(echo "$HDRS" | grep -i 'set-cookie: gray_hash_uc_g30_host=2.0.0-pct' >/dev/null && echo yes || echo no)"
HDRS=$(curl -sS -m 10 --noproxy '*' -D - -o /dev/null "$BASE/app-api/info" -H 'Host: uc-g30.test' -H 'baseurl: /')
check G30.5.5 "无cookie回写" yes "$(echo "$HDRS" | grep -i 'set-cookie: gray_hash_uc_g30_host=2.0.0-pct' >/dev/null && echo yes || echo no)"

# ── G30.6 优先级 ──
putrule "{\"featureKey\":\"uc_g30_f1\",\"globalEnabled\":true,\"percentage\":0,\"percentageKey\":\"\",\"startTime\":null,\"endTime\":null,\"whiteList\":{},\"blackList\":{}}"
setcfg '{"appId":"uc_g30_host","version":"1.0.0","backendGray":{"enabled":true,"featureKey":"uc_g30_f1","version":"2.0.0-gray"},"canary":[{"enterpriseUuid":"ent-1","version":"6.0.0-ent"}]}'
check G30.6.1 "backend-gray优先于user-enterprise" 2.0.0-gray "$(ver "-H 'cookie: uuid=u; enterpriseUuid=ent-1'")"
setcfg '{"appId":"uc_g30_host","version":"1.0.0","canary":[{"enterpriseUuid":"ent-1","version":"6.0.0-ent"}],"percentCanary":{"version":"2.0.0-pct","percentage":100}}'
check G30.6.2 "user-enterprise优先于percent" 6.0.0-ent "$(ver "-H 'cookie: uuid=u; enterpriseUuid=ent-1; gray_hash_uc_g30_host=2.0.0-pct:1'")"

# ── G30.7 ap 管理面 ──
pgq "INSERT INTO $SCH.apps (app_id,domain,base_route,config) VALUES ('xybot-aipower-web','uc-g30-aipower.test','', '{\"appId\":\"xybot-aipower-web\",\"version\":\"2\",\"backendGray\":{\"enabled\":true,\"featureKey\":\"uc_g30_f1\",\"version\":\"3.0.0\"},\"publishList\":[{\"id\":\"p2\",\"version\":\"2\"},{\"id\":\"p1\",\"version\":\"1\"}]}'::jsonb) ON CONFLICT (app_id) DO UPDATE SET config=EXCLUDED.config" >/dev/null
c=$(req -X POST "$BASE/gw-api/ap/backend-gray" -H 'content-type: application/json' -d '{}')
check G30.7.1 "查询模式返回当前配置" yes "$(raw | grep -q 'uc_g30_f1' && echo yes || echo no)"
c=$(req -X POST "$BASE/gw-api/ap/backend-gray" -H 'content-type: application/json' -d '{"enabled":true,"featureKey":"uc_g30_new","version":9}')
check G30.7.2a "设置模式合并" 200 "$c"
check G30.7.2b "version转string" 9 "$(pgq "SELECT config->'backendGray'->>'version' FROM $SCH.apps WHERE app_id='xybot-aipower-web'")"
c=$(req -X PUT "$BASE/gw-api/ap/backend-gray/feature/uc_g30_f9" -H 'content-type: application/json' -d '{"percent":10}')
check G30.7.3a "写灰度规则" 200 "$c"
c=$(req "$BASE/gw-api/ap/backend-gray/uc_g30_f9")
check G30.7.3b "读灰度规则" 10 "$(jget "['data']['data']['percent']")"
c=$(req "$BASE/gw-api/backend-gray/polling/status")
check G30.7.4 "polling状态" yes "$(jget "['data']['data']['featureKeys']" | grep -q '.' && echo yes || echo no)"
c=$(req -X POST "$BASE/gw-api/backend-gray/polling/start-all")
check G30.7.5 "start-all遍历" yes "$(jget "['data']['data']['started']" | grep -q 'xybot-aipower-web' && echo yes || echo no)"
c=$(req "$BASE/gw-api/backend-gray/diagnose")
check G30.7.6 "diagnose诊断" yes "$(jget "['data']['data']['diagnostics']" | grep -q 'xybot-aipower-web' && echo yes || echo no)"

# 清理
pgq "DELETE FROM $SCH.apps WHERE app_id LIKE 'uc_g30_%' OR app_id='xybot-aipower-web'" >/dev/null
pgq "DELETE FROM $SCH.gray_features WHERE feature_key LIKE 'uc_g30_%'" >/dev/null

echo "━━━ gray.md 汇总: PASS=$pass FAIL=$fail SKIP=$skip ━━"; exit $(( fail > 0 ))
```

## 说明

- 版本观察口为 `/app-api/info`（不经响应包装；其 `{version}` 即策略选中版本）。
- G30.2.5 的 bucket 由脚本内联 Java hashCode（32 位有符号溢出 `|0`）计算，构造 `percentage=bucket+1` 必命中、`percentage=bucket` 边界必不命中。
- backend-gray 规则经 PG 直改后，`getGrayFeature` 的 30s TTL 缓存可能未失效——G30.2 各分段依赖的规则均通过 `pgq` 直写后**紧接着用一次 `PUT /gw-api/ap/backend-gray/feature/:key` 触发缓存失效**（该写路径自带失效）；如偶发 FAIL 属缓存时序，重跑即可。
- **G30.4 需要网关以 `INTERNAL_GRAY_IPS=10.1.1.5,192.168.0.0/24` 启动**（env 属网关进程）；脚本以精确 IP 探测，未配置整组 SKIP 不计 FAIL。
