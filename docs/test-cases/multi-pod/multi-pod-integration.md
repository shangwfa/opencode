# 多 Pod 部署集成用例

验证多实例（共享同一 PG）下的 session 锁互斥、auth/config 热加载广播、SSE 事件跨实例分发。

前置：按 `docs/multi-pod-issues.md` 部署两个实例（同 PG 同 sandbox 配置），`$BASE1`（如 http://localhost:14096）、`$BASE2`（如 http://localhost:14098）。curl 一律 `--noproxy '*'`。

---

## T31.1 跨实例 session 锁互斥

**场景**：同一 session 的消息请求路由到不同实例时，必须串行处理（后到者等前者的 PG advisory lock 释放后才入库处理）。

**步骤**：

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE1/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 实例 1 发起慢请求（后台），3 秒后实例 2 对同一 session 发消息
T0=$(date +%s)
curl -s --noproxy '*' --max-time 120 -X POST "$BASE1/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"count from 1 to 30 slowly"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}' \
  -o /tmp/a.json &

sleep 3; T1=$(date +%s)
curl -s --noproxy '*' --max-time 120 -X POST "$BASE2/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"just say hi"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}' \
  -o /tmp/b.json
wait

# 查消息入库时间（PG）
psql "$PG_URL" -tAc "SELECT substring(data::text,1,25), to_timestamp(min(time_created)/1000)::time \
  FROM part WHERE session_id='$SID' AND (data::text LIKE '%count from%' OR data::text LIKE '%just say hi%') \
  GROUP BY 1 ORDER BY 2"
```

**期望**：
- 两条消息都成功（HTTP 200）
- 实例 2 的 user 消息入库时间 ≥ 实例 1 请求完成时间（等待锁），而非请求发起时间（T1）

**实测记录（2026-08-19，宿主机双进程 14097/14099 + 本地 PG）**：

| 检查项 | 结果 |
|---|---|
| 实例 1 消息（05:46:02 入库），完成于 05:46:13 | ✅ |
| 实例 2（05:46:05 发起）user 消息 05:46:13 才入库（等锁 8s） | ✅ 跨实例互斥生效 |

---

## T31.2 auth 热加载跨实例广播

**场景**：实例 1 `PUT /auth` 后，实例 2 必须同步丢弃 provider 缓存（收到 `dispose.all` NOTIFY 并 dispose），否则删除 key 后其他实例仍用旧凭证。

**步骤**：

```bash
# 监听实例 2 SSE
(curl -s --noproxy '*' -N --max-time 12 "$BASE2/event" > /tmp/sse2.txt &); sleep 2

# 实例 1 写 + 删 auth
curl -s --noproxy '*' -X PUT "$BASE1/auth/test-provider" \
  -H 'Content-Type: application/json' -d '{"type":"api","key":"sk-test-123"}'
sleep 3
curl -s --noproxy '*' -X DELETE "$BASE1/auth/test-provider"
sleep 8

grep -o '"type":"[a-z._0-9]*"' /tmp/sse2.txt | sort | uniq -c
psql "$PG_URL" -tAc "SELECT provider_id FROM auth WHERE provider_id='test-provider'"
```

**期望**：
- PUT 后实例 2 SSE 出现 `server.instance.disposed`（实例 2 收到广播并 dispose）
- auth 表写入后又被删除

**实测记录（2026-08-19，宿主机双进程）**：

| 检查项 | 结果 |
|---|---|
| 实例 2 SSE 收到 `server.instance.disposed` | ✅ |
| auth 写入/删除共享 PG | ✅ |

---

## T31.3 SSE 事件跨实例分发

**场景**：客户端 SSE 连在实例 2，事件发生在实例 1 时必须实时到达（经 PG NOTIFY 桥）。

**步骤**：

```bash
(curl -s --noproxy '*' -N --max-time 20 "$BASE2/event" > /tmp/sse3.txt &); sleep 2

# 在实例 1 创建 + 改名 session
SID=$(curl -s --noproxy '*' -X POST "$BASE1/session" -H 'Content-Type: application/json' -d '{"title":"cross-pod"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --noproxy '*' -X PATCH "$BASE1/session/$SID" -H 'Content-Type: application/json' -d '{"title":"renamed"}'
sleep 16

grep -o '"type":"[a-z._0-9]*"' /tmp/sse3.txt | sort | uniq -c
```

**期望**：实例 2 的 SSE 出现 `session.created` / `session.updated`，而非只有 `server.connected`/`server.heartbeat`。内部 durable `sync` envelope 不应暴露给 instance SSE。

**实测记录（2026-08-19，宿主机双进程）**：

| 检查项 | 结果 |
|---|---|
| 实例 2 SSE 收到实例 1 的 `session.created` | ✅ |
| 本地事件（实例 2 自建 session）不重复投递 | ✅ |
| 回环抑制（事件不被 echo 来回） | ✅（单测覆盖） |

---

## T31.4 锁超时与崩溃释放（单测级）

- 外部持锁时 `withSessionLock` 按 `OPENCODE_SESSION_LOCK_TIMEOUT_SEC` 超时 die：`test/server/session-lock.test.ts` "times out when another pod holds the lock" ✅
- 事件 > 8000 字节通过 PG reference 转发，UTF-8 字节边界正确：`test/bus/bus-bridge.test.ts` ✅

## T31.5 PG 配置同步与跨 Pod abort

```bash
# Pod 1 修改全局配置；Pod 2 必须读取到真实值（不能只观察 disposed SSE）
curl -s --noproxy '*' -X PATCH "$BASE1/global/config" \
  -H 'Content-Type: application/json' -d '{"username":"multi-pod-config-test"}'
sleep 7
curl -s --noproxy '*' "$BASE2/global/config" | jq -r '.username'

# Pod 1 启动长 shell；Pod 2 abort，应在数秒内结束而不是跑满 30s
SID=$(curl -s --noproxy '*' -X POST "$BASE1/session" -H 'Content-Type: application/json' -d '{}' | jq -r '.id')
curl -s --noproxy '*' --max-time 40 -X POST "$BASE1/session/$SID/shell" \
  -H 'Content-Type: application/json' -d '{"agent":"build","command":"sleep 30"}' &
sleep 3
curl -s --noproxy '*' -X POST "$BASE2/session/$SID/abort" -H 'Content-Type: application/json' -d '{}'
wait
```

**2026-08-19 实测**：Pod 2 读取到 `multi-pod-config-test`；跨 Pod abort 后 shell 约 3 秒结束（未跑满 30 秒）✅。

补充边界实测：parent session 在 Pod 1 执行 `sleep 8`，child session 在 Pod 2 发起 shell；child 等待约 8 秒后执行，证明 parent/child 共用 root sandbox lock key ✅。

## 结果汇总

| 用例 | 结果 | 日期 |
|---|---|---|
| T31.1 跨实例锁互斥 | ✅ | 2026-08-19 |
| T31.2 auth 广播 | ✅ | 2026-08-19 |
| T31.3 SSE 互通 | ✅ | 2026-08-19 |
| T31.4 中断/池满/漏通知/大事件/exec kill（单测） | ✅ 25 pass | 2026-08-19 |
| T31.5 PG config + 跨 Pod abort | ✅ | 2026-08-19 |

> 排查提示：跨实例事件不通时先看实例日志 `[pg-notify] PG LISTEN ready` / `[bus-bridge] cross-pod event bridge active` 是否都在；LISTEN 静默失联的历史 bug（共享池连接回收）已修复为专用连接，若复现优先检查该处。
