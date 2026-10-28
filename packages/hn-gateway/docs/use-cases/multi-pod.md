# 多 pod 实时同步：配置变更跨实例传播（K8s 部署形态）

> 用例段：G60。网关以 K8s 多 pod 部署，任一 pod 的写操作（或带 NOTIFY 的 PG 直写）须**实时**（秒级，不等 TTL）同步到其它 pod。
> 机制：写事务内 `pg_notify('gateway_config_changed')` → 各 pod 独 LISTEN 连接 → 缓存失效 → 回源 PG；LISTEN 断线重连后全量失效补偿；TTL 兜底最终一致。

## 用例

| 用例 | 验证点 |
|---|---|
| G60.1 | 应用配置跨 pod：pod-A 更新 version → pod-B 立即读到（不等 60s TTL） |
| G60.2 | HTML 指纹缓存跨 pod：pod-B 已缓存 v1 入口 HTML → pod-A 改配置 → pod-B 注入新 version 并重新回源 |
| G60.3 | 灰度规则跨 pod：pod-B 预热时规则不存在（策略不命中）→ pod-A 写入规则 → pod-B 立即命中灰度版本 |
| G60.4 | 微前端注册表跨 pod：pod-A 发布子应用 → pod-B 列表立即可见 |
| G60.5 | 直写 PG + NOTIFY（运维通道）：pgq 直改 + 手工 NOTIFY → pod-B 立即可见 |
| G60.6 | LISTEN 断线重连补偿（重连后全量失效）——需故障注入，由 `test/notify.test.ts` 覆盖，脚本记 SKIP |
| G60.7 | TTL 兜底：NOTIFY 全丢场景下 60s/30s 内最终一致——机制说明，不脚本化 |
| G60.8 | **PG 不可达兜底（stale 降级）**：`docker stop` 专用 PG 容器（hn-gw-pg，第三实例 hn-gw-c 独享）→ gw-c 缓存过期后回源失败 → 降级返回旧配置（不 500）+ `/health` degraded healthy（不摘流）；`docker start` 恢复后自愈。要求预置 hn-gw-pg/hn-gw-c 容器（README 命令），否则 SKIP |

## 测试脚本

> 前置：pod-A（`BASE`，默认 3101）已在跑；脚本自起 pod-B（`BASE2_PORT`，默认 3102，须与 pod-A 同 schema）。

```bash
BASE=${BASE:-http://127.0.0.1:3101}
BASE2_PORT=${BASE2_PORT:-3102}
BASE2=${BASE2:-http://127.0.0.1:$BASE2_PORT}
PGURL=${PGURL:-postgresql://postgres:ab123456@127.0.0.1:5432/opencode-v2-up}
SCH=${SCH:-hn_gateway_dev}
GW_DIR="$(cd "$(dirname "$0")/../.." && pwd)"   # packages/hn-gateway
COSURL=${COSURL:-http://127.0.0.1:18993}         # 种子应用的静态回源地址（容器实例传 http://host.docker.internal:18990）
pass=0; fail=0; skip=0
req()  { curl -sS -m 30 --noproxy '*' -o /tmp/gw-mp-res.json -w '%{http_code}' "$@"; }
raw()  { cat /tmp/gw-mp-res.json; }
pgq()  { psql "$PGURL" -Atc "$1" 2>/dev/null; }
check(){ if [ -n "$3" ] && [ "$3" = "$4" ]; then echo "PASS $1 $2"; pass=$((pass+1)); else echo "FAIL $1 $2 expect=[$3] got=[$4]"; fail=$((fail+1)); fi }
skipcase(){ echo "SKIP $1 $2"; skip=$((skip+1)); }
verof(){ curl -sS -m 30 --noproxy '*' -H 'Host: mp.test' "$1/" | grep -o '"version":"[^"]*"' | head -1; }

[ "$(req "$BASE/health" >/dev/null; echo ok)" = "ok" ] || { echo "pod-A($BASE) 未启动，退出"; exit 9; }

# ── pod-B：外部已提供（BASE2/health 可达，如 K8s/docker 多实例）则直接复用；否则自起 ──
mkdir -p /tmp/gw-uc; : > /tmp/gw-mp-cos.log
EXTERNAL_PODB=no
if [ "$(curl -sS -m 3 --noproxy '*' "$BASE2/health" >/dev/null 2>&1 && echo ok)" = "ok" ]; then EXTERNAL_PODB=yes; fi
FAKE_PID=""; PODB_PID=""
if [ "$EXTERNAL_PODB" = "no" ]; then
cat > /tmp/gw-uc/mp-fake.py <<'PYEOF'
import http.server, socketserver
ENTRY='<html><head><script>window.YD = {};</script></head><body>x</body></html>'
class H(http.server.BaseHTTPRequestHandler):
    def log_message(s,*a): pass
    def do_GET(s):
        open('/tmp/gw-mp-cos.log','a').write(s.path+'\n')
        s.send_response(200); s.send_header('content-type','text/html'); s.end_headers(); s.wfile.write(ENTRY.encode())
socketserver.TCPServer.allow_reuse_address=True
with socketserver.ThreadingTCPServer(('127.0.0.1',18993),H) as h: h.serve_forever()
PYEOF
python3 /tmp/gw-uc/mp-fake.py & FAKE_PID=$!
cd "$GW_DIR" && GATEWAY_PORT=$BASE2_PORT \
  GATEWAY_DATABASE_SCHEMA=$SCH GATEWAY_API_TARGET=http://127.0.0.1:18993 GATEWAY_CND_DOMAIN=127.0.0.1 \
  bun run src/server.ts > /tmp/gw-mp-podB.log 2>&1 & PODB_PID=$!
for i in $(seq 1 20); do sleep 0.5; [ "$(req "$BASE2/health" >/dev/null; echo ok)" = "ok" ] && break; done
fi
[ "$(req "$BASE2/health" >/dev/null; echo ok)" = "ok" ] || { echo "pod-B($BASE2) 不可用（自起失败见 /tmp/gw-mp-podB.log），退出"; exit 9; }
trap '[ -n "$FAKE_PID" ] && kill $FAKE_PID 2>/dev/null; [ -n "$PODB_PID" ] && kill $PODB_PID 2>/dev/null' EXIT

# 幂等清理 + 种子（经 pod-A API 写入：所有 pod 缓存失效）
pgq "DELETE FROM $SCH.apps WHERE app_id IN ('mp_app','mp_app2')" >/dev/null
pgq "DELETE FROM $SCH.micro_apps WHERE app_id='mp_sub'" >/dev/null
pgq "DELETE FROM $SCH.gray_features WHERE feature_key='mp_feat'" >/dev/null
req -X POST "$BASE/gw-api/apps/mp_app" -H 'content-type: application/json' -d "{\"domain\":\"mp.test\",\"config\":{\"url\":\"$COSURL/static/mp\",\"version\":\"1.0.0\"}}" >/dev/null
req -X POST "$BASE/gw-api/apps/mp_app2" -H 'content-type: application/json' -d '{"domain":"mp2.test","config":{"appId":"mp_app2","version":"1.0.0","backendGray":{"enabled":true,"featureKey":"mp_feat","version":"9.0.0-gray"}}}' >/dev/null

# ── G60.1 应用配置跨 pod ──
V1A=$(verof "$BASE"); V1B=$(verof "$BASE2")
check G60.1a "pod-B 预热 v1" '"version":"1.0.0"' "$V1B"
req -X POST "$BASE/gw-api/nacos/app/mp_app/update" -H 'content-type: application/json' -d '{"version":"2.0.0"}' >/dev/null
sleep 0.3
check G60.1b "pod-A 立即 v2" '"version":"2.0.0"' "$(verof "$BASE")"
check G60.1c "pod-B 立即 v2(不等TTL)" '"version":"2.0.0"' "$(verof "$BASE2")"

# ── G60.2 HTML 指纹缓存跨 pod ──
COS_B=$(grep -c 'static/mp' /tmp/gw-mp-cos.log)
req -X POST "$BASE/gw-api/nacos/app/mp_app/update" -H 'content-type: application/json' -d '{"version":"3.0.0"}' >/dev/null
sleep 0.3
V3B=$(verof "$BASE2")
check G60.2a "pod-B 注入 v3" '"version":"3.0.0"' "$V3B"
check G60.2b "pod-B 重新回源(指纹变)" "$((COS_B+1))" "$(grep -c 'static/mp' /tmp/gw-mp-cos.log)"

# ── G60.3 灰度规则跨 pod ──
PRE=$(curl -sS -m 10 --noproxy '*' "$BASE2/app-api/info" -H 'Host: mp2.test' -H 'baseurl: /' | grep -o '"version":"[^"]*"')
check G60.3a "pod-B 预热(规则缺失不命中)" '"version":"1.0.0"' "$PRE"
req -X PUT "$BASE/gw-api/ap/backend-gray/feature/mp_feat" -H 'content-type: application/json' -d '{"featureKey":"mp_feat","globalEnabled":true,"percentage":0,"percentageKey":"","startTime":null,"endTime":null,"whiteList":{},"blackList":{}}' >/dev/null
sleep 0.3
POST=$(curl -sS -m 10 --noproxy '*' "$BASE2/app-api/info" -H 'Host: mp2.test' -H 'baseurl: /' | grep -o '"version":"[^"]*"')
check G60.3b "pod-B 立即命中灰度" '"version":"9.0.0-gray"' "$POST"

# ── G60.4 微前端注册表跨 pod ──
req -X POST "$BASE/gw-api/microapps" -H 'content-type: application/json' -d '{"appId":"mp_sub","name":"跨pod子应用","version":"1.0.0"}' >/dev/null
sleep 0.3
LB=$(req "$BASE2/gw-api/microapps")
check G60.4 "pod-B 列表立即可见" yes "$(raw | grep -q 'mp_sub' && echo yes || echo no)"

# ── G60.5 直写 PG + NOTIFY（运维通道）──
pgq "UPDATE $SCH.apps SET config = config || '{\"version\":\"4.0.0\"}'::jsonb, updated_at=now() WHERE app_id='mp_app'; SELECT pg_notify('gateway_config_changed', '{\"table\":\"apps\",\"key\":\"mp_app\"}');" >/dev/null
sleep 0.3
check G60.5 "直写+NOTIFY 同步 pod-B" '"version":"4.0.0"' "$(verof "$BASE2")"

# ── G60.6/G60.7 机制项 ──
skipcase G60.6 "LISTEN 断线重连补偿（由 test/notify.test.ts 的重连全量失效覆盖）"
skipcase G60.7 "TTL 兜底最终一致（需 NOTIFY 全丢故障注入，机制见 DESIGN §3.1）"

# ── G60.8 PG 不可达兜底（stale 降级）：停第三实例的专用 PG 容器注入 ──
# 前置（README 有完整命令）：hn-gw-c（端口 3103，连专用 PG hn-gw-pg，GATEWAY_CACHE_TTL_MS=2000）
if docker inspect hn-gw-c >/dev/null 2>&1 && curl -sS -m 3 --noproxy '*' http://127.0.0.1:3103/health >/dev/null 2>&1; then
  CBASE=http://127.0.0.1:3103
  # 种子 + 预热（经 gw-c 写入其专用 PG）
  curl -sS -m 10 --noproxy '*' -X POST "$CBASE/gw-api/apps/mp_c" -H 'content-type: application/json' \
    -d '{"domain":"mp-c.test","config":{"url":"http://host.docker.internal:18990/static/mpc","version":"7.0.0"}}' >/dev/null
  sleep 0.3
  PRE_C=$(curl -sS -m 15 --noproxy '*' -H 'Host: mp-c.test' "$CBASE/" | grep -o '"version":"[^"]*"' | head -1)
  check G60.8a "预热正常" '"version":"7.0.0"' "$PRE_C"
  sleep 3   # 等 TTL（2s）过期，确保下一次请求走回源
  docker stop hn-gw-pg >/dev/null 2>&1
  sleep 1
  STALE_V=$(curl -sS -m 15 --noproxy '*' -H 'Host: mp-c.test' "$CBASE/" | grep -o '"version":"[^"]*"' | head -1)
  check G60.8b "PG断后降级返回旧配置(不500)" '"version":"7.0.0"' "$STALE_V"
  HB=$(curl -sS -m 15 --noproxy '*' "$CBASE/health")
  check G60.8c "health降级healthy不摘流" yes "$(echo "$HB" | grep -q '"degraded":true' && echo yes || echo no)"
  docker start hn-gw-pg >/dev/null 2>&1
  sleep 8   # 等 PG 起活 + LISTEN 5s 重连 + 全量失效回源
  RECOVER=$(curl -sS -m 15 --noproxy '*' "$CBASE/health")
  check G60.8d "恢复后自愈" '"status":"healthy"' "$(echo "$RECOVER" | grep -o '"status":"[^"]*"' | head -1)"
  check G60.8e "自愈后数据正常" '"version":"7.0.0"' "$(curl -sS -m 15 --noproxy '*' -H 'Host: mp-c.test' "$CBASE/" | grep -o '"version":"[^"]*"' | head -1)"
else
  skipcase G60.8 "需预置 hn-gw-pg + hn-gw-c 容器（README「PG 故障演练」命令）"
fi

# 清理
pgq "DELETE FROM $SCH.apps WHERE app_id IN ('mp_app','mp_app2')" >/dev/null
pgq "DELETE FROM $SCH.micro_apps WHERE app_id='mp_sub'" >/dev/null
pgq "DELETE FROM $SCH.gray_features WHERE feature_key='mp_feat'" >/dev/null

echo "━━━ multi-pod.md 汇总: PASS=$pass FAIL=$fail SKIP=$skip ━━"; exit $(( fail > 0 ))
```

## 说明

- pod-B 由脚本自起（与 pod-A 同 schema、同 PG；API/COS 指向 mini fake），测后连同 fake 一并回收。
- 「立即」断言前留 0.3s：NOTIFY 投递与 LISTEN 回调为毫秒级，留裕量消除抖动；TTL 兜底为 60s（apps/platform）/30s（gray/microapps），断言远小于 TTL 即证明走的是推送而非过期。
- K8s 语义等价性：多 pod = 多进程，各自持有独立 LISTEN 连接；本用例的双实例行为与多 pod 一致（差异仅在副本数）。
