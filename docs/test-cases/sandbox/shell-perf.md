# Shell 执行性能与 SSE 早退优化测试（ST.Sx / ST.Ex）—— V2 版

> **2026-09-24 重写为 V2 API 版本**。原 V1 用例基于 `/session`、`/session/:id/exec`、`/file/content`，V2 已不提供这些接口；本文全部映射到 V2：
> - 创建会话：`POST /api/session`
> - 执行命令：`POST /api/session/:sessionID/shell`（成功 HTTP 204，结果经消息读取）
> - 读取结果：`GET /api/session/:sessionID/message?order=asc`（`type=shell` 的消息含 `status/exit/output`）
> - 文件 API：`GET /api/session/:sessionID/fs/list|read|find`
> - keep-alive/boot：`POST /api/experimental/session/:sessionID/keep-alive`
>
> 公共环境见 [`docs/local-test-env.md`](../../local-test-env.md)：服务 `http://localhost:14096`（容器 `opencode-saas-test`）、本地 PG `opencode-v2-up`、本地 OpenSandbox `:8080`。服务需设置 `OPENCODE_PASSWORD`，全部请求带 Basic Auth。
>
> 历史背景（两代优化）：
> - **ST.S1-S5**：Shell 执行性能（并发去重、超时保护、缓存复用、read vs shell 对比）
> - **ST.E1-E6**：SSE 早退（命令延迟、exitCode 推断、输出完整性、并发、SDK A/B、远端 K8s）

## 0. V2 机制对照（与 V1 `sandbox-provider.ts` 的映射）

| V1 机制 | V2 实现（`packages/core/src/sandbox/provider.ts`） | 说明 |
|---|---|---|
| `commandSemaphores` Semaphore(1) 按 session | `commandLocks` Semaphore(1) 按 **commandSessionID** | 同 session shell 命令**串行**（bash session 状态非并发安全，V1 同样串行） |
| `getOrCreateUnlocked` + 外层 90s 超时 | `getOrCreate` + `run` 内 `withOperationTimeout(..., GET_OR_CREATE_TIMEOUT_SECONDS=90)` | 2026-09-24 补齐；建箱另有 `OPENCODE_SANDBOX_CREATE_TIMEOUT_SECONDS`（默认 300s） |
| 建箱后台 fiber + `ensuring` 回收 token | `Effect.forkDetach` + `Effect.ensuring` | 2026-09-24 补齐：等待方超时/中断不取消建箱、不泄漏 Deferred |
| `sbCache` TTL 30s | **无 TTL**：进程内 `entries` map + 每次进入 `isHealthy()` 复检 | ST.S4 语义变为「进程内持续复用，不健康才重建」 |
| `runCommandEarlyExit`（SSE 早退） | `run` 内直接消费 `commands.runInSessionStream`，收到 `execution_complete`/`error` 立即返回 | 同 V1 语义 |
| 失败自愈（`isSandboxGone` + 重建重试、超时回收 command session、空流检测、OOM 日志） | 已按 V1 语义补齐（2026-09-24） | 见 `withRecreateRetry` / `recycle` / 空流检测 / exit 137 告警 |

> **2026-09-24 修复的 ST.S3 根因**：V2 曾把建箱失败经 `Effect.orDie` 转成 defect，`SessionShell.start` 的 `Effect.catch`（仅捕获 typed error）接不到 → `settled` Deferred 永不完成 → HTTP 请求**永久挂死**。现 `getOrCreate`/`commandSession` 遵守 Interface 的 `Error` 通道，失败秒级返回并写入 session log。

## 1. 公共变量

```bash
BASE=http://localhost:14096
PW="${OPENCODE_PASSWORD:-pg-e2e-test-password}"
AUTH="$(printf 'opencode:%s' "$PW" | base64)"
H=(-H "Authorization: Basic $AUTH" -H 'Content-Type: application/json')
PG_URL='postgresql://local@127.0.0.1:5432/opencode-v2-up'

# 通用函数
new_sid(){ curl -s "${H[@]}" -X POST "$BASE/api/session" -d "{\"title\":\"$1\",\"location\":{\"directory\":\"/workspace\"}}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["id"])'; }
shell(){ curl -s -o /dev/null -w '%{http_code} %{time_total}' "${H[@]}" -X POST "$BASE/api/session/$1/shell" -d "$(CMD="$2" python3 -c 'import json,os;print(json.dumps({"command":os.environ["CMD"]}))')"; }
# 最后一条 shell 消息: "exit\tstatus\toutput"
shellmsg(){ curl -s "$BASE/api/session/$1/message?order=asc" -H "Authorization: Basic $AUTH" | python3 -c '
import json,sys
d=json.load(sys.stdin); ms=d.get("data",d)
sh=[m for m in ms if m.get("type")=="shell"]
print("NONE" if not sh else "%s\t%s\t%s"%(sh[-1].get("exit"),sh[-1].get("status"),(sh[-1].get("output") or {}).get("output","")))'; }
```

启动容器（本地 PG + 本地 OpenSandbox）：

```bash
docker run -d --name opencode-saas-test -p 14096:4096 \
  -e OPENCODE_DATABASE_URL="postgresql://local@host.docker.internal:5432/opencode-v2-up" \
  -e OPENCODE_SANDBOX_ENABLED=1 -e OPENCODE_SANDBOX_DOMAIN=host.docker.internal:8080 \
  -e OPENCODE_SANDBOX_USE_SERVER_PROXY=true -e OPENCODE_SANDBOX_PROTOCOL=http \
  -e OPENCODE_SANDBOX_IMAGE=opencode-opensandbox:local -e OPENCODE_DEFAULT_DIRECTORY=/workspace \
  -e OPENCODE_EVENTS_PERSIST=1 -e OPENCODE_DISABLE_AUTOUPDATE=1 -e OPENCODE_PASSWORD=pg-e2e-test-password \
  opencode-saas-sandbox-test:slim serve --hostname 0.0.0.0 --port 4096 --print-logs --log-level info
```

---

## 一、Shell 执行性能（ST.Sx）

### ST.S1 同 session shell 命令串行化（commandLocks Semaphore(1)）

> **V2 语义**：同一 session 的 shell 命令按 commandSessionID 加 `Semaphore(1)` **串行**（共享 bash session，状态非并发安全；V1 同样串行）。串行本身是设计而非缺陷。

```bash
SID=$(new_sid "ST.S1")
shell "$SID" "echo warmup" >/dev/null          # 预热（建沙箱 + command session）
START=$(date +%s%N)
for i in 1 2 3; do shell "$SID" "sleep 2 && echo cmd-$i" >/dev/null & done
wait; END=$(date +%s%N); TOTAL=$(( (END-START)/1000000 ))
echo "3 并发（各 sleep 2s）总耗时: ${TOTAL}ms（期望 ~6000ms）"
[ "$TOTAL" -ge 5000 ] && [ "$TOTAL" -lt 9000 ] && echo "✅ PASS" || echo "❌ FAIL"
```

**2026-09-24 实测**：7145ms ✅（串行生效；若显著 <5000ms 才是锁失效 regression）

### ST.S2 command session 双重检查（并发首命令只建 1 个）

```bash
SID=$(new_sid "ST.S2")
# 只 boot 沙箱、不建 command session
curl -s -o /dev/null "${H[@]}" -X POST "$BASE/api/experimental/session/$SID/keep-alive" -d '{"enabled":true,"boot":true}'
sleep 3
for i in 1 2 3; do shell "$SID" "echo concurrent-$i" >/dev/null & done   # 竞争创建 command session
wait; sleep 1
psql "$PG_URL" -t -A -c "SELECT count(*), count(DISTINCT command_session_id) FROM sandbox WHERE session_id='$SID' AND command_session_id IS NOT NULL"
# 期望 1|1
```

**2026-09-24 实测**：`1|1` ✅（`sessionCreates` Deferred claim 去重）

### ST.S3 建箱失败/超时保护（getOrCreate 有界等待）

> V1 为 90s 超时；V2 双层：`OPENCODE_SANDBOX_CREATE_TIMEOUT_SECONDS`（建箱自身，默认 300）+ `GET_OR_CREATE_TIMEOUT_SECONDS=90`（等待 getOrCreate）。**判定标准改为「有界失败、不挂死、后续请求不受污染」**（V2 shell API 失败返回 204，失败原因写入 session log，符合 exec-api.md 契约）。

```bash
docker run -d --name opencode-saas-test-timeout -p 14097:4096 \
  -e OPENCODE_DATABASE_URL="postgresql://local@host.docker.internal:5432/opencode-v2-up" \
  -e OPENCODE_SANDBOX_ENABLED=1 -e OPENCODE_SANDBOX_DOMAIN=host.docker.internal:39999 \
  -e OPENCODE_SANDBOX_USE_SERVER_PROXY=true -e OPENCODE_SANDBOX_PROTOCOL=http \
  -e OPENCODE_SANDBOX_IMAGE=opencode-opensandbox:local -e OPENCODE_SANDBOX_CREATE_TIMEOUT_SECONDS=20 \
  -e OPENCODE_DISABLE_AUTOUPDATE=1 -e OPENCODE_PASSWORD=pg-e2e-test-password \
  opencode-saas-sandbox-test:slim serve --hostname 0.0.0.0 --port 4096 --print-logs --log-level info
sleep 12
B2=http://localhost:14097
SID=$(curl -s "${H[@]}" -X POST "$B2/api/session" -d '{"title":"ST.S3","location":{"directory":"/workspace"}}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["id"])')
sleep 3
curl -s -o /dev/null -w "shell#1: %{http_code} %{time_total}s\n" --max-time 60 "${H[@]}" -X POST "$B2/api/session/$SID/shell" -d '{"command":"echo t"}'
curl -s -o /dev/null -w "shell#2: %{http_code} %{time_total}s\n" --max-time 60 "${H[@]}" -X POST "$B2/api/session/$SID/shell" -d '{"command":"echo t2"}'
curl -s "$B2/api/session/$SID/message?order=asc" -H "Authorization: Basic $AUTH" | python3 -c '
import json,sys
for m in json.load(sys.stdin).get("data",[]):
  if m.get("type")=="shell": print("shell msg:",m.get("status"),"exit=",m.get("exit"),repr((m.get("output") or {}).get("output","")[:80]))'
```

**2026-09-24 实测**：shell#1 **0.36s**、shell#2 **0.11s** 返回；消息记录 `Sandbox execution failed: Sandbox.create failed: Unable to connect...` ✅（修复前 >120s 挂死）

### ST.S4 进程内沙箱复用（无 TTL，65s 不重建）

> V2 无 V1 的 30s sbCache TTL：`entries` 常驻 + 每次进入 `isHealthy()` 复检。判定改为「窗口内 `sandbox created` 日志仅 1 次」。

```bash
SID=$(new_sid "ST.S4")
shell "$SID" "echo initial" >/dev/null
for i in 1 2 3; do sleep 10; shell "$SID" "echo tick-$i" >/dev/null; echo "  [${i}0s]"; done
sleep 35; shell "$SID" "echo after-ttl" >/dev/null; echo "  [65s]"
docker logs opencode-saas-test 2>&1 | grep "sandbox created" | grep -c "$SID"   # 期望 1
```

**2026-09-24 实测**：1 次 ✅

### ST.S5 fs/list（无锁）vs shell（有锁）延迟

```bash
SID=$(new_sid "ST.S5"); shell "$SID" "echo warmup" >/dev/null
TR=0; for i in 1 2 3; do T=$(curl -s -o /dev/null -w '%{time_total}' "$BASE/api/session/$SID/fs/list?path=/workspace" -H "Authorization: Basic $AUTH"); TR=$(python3 -c "print($TR+$T)"); done
TB=0; for i in 1 2 3; do T=$(shell "$SID" "ls /workspace/" | awk '{print $2}'); TB=$(python3 -c "print($TB+$T)"); done
echo "fs/list 平均=$(python3 -c "print(round($TR/3,3))")s  shell 平均=$(python3 -c "print(round($TB/3,3))")s"
```

**2026-09-24 实测**：0.061s vs 0.129s ✅（shell < 2.0s，比值 ~2x）

---

## 二、SSE 早退（ST.Ex）

> 根因链（V1 遗留背景）：SDK 等 SSE 流关闭 → K8s ingress idle timeout 放大到 60-3539s。V2 `run` 直接消费 `runInSessionStream`，收到 `execution_complete`/`error` 立即返回。

### ST.E1 shell 命令延迟

```bash
SID=$(new_sid "ST.E1"); shell "$SID" "echo warmup" >/dev/null
for cmd in "ls /workspace/" "echo hello" "cat /workspace/package.json | head -5" "pwd" "whoami"; do
  R=$(shell "$SID" "$cmd"); printf "  %-42s %ss (http %s)\n" "$cmd" "${R##* }" "${R%% *}"
done
```

**2026-09-24 实测**：最大 0.155s ✅（本地单层 proxy 阈值 <0.5s）

### ST.E2 exitCode 推断（成功/失败/命令不存在）

```bash
SID=$(new_sid "ST.E2"); shell "$SID" "echo warmup" >/dev/null
for pair in "ls /workspace/:0" "exit 42:42" "nonexistent-cmd-xyz:127"; do
  CMD=${pair%:*}; EXP=${pair##*:}
  shell "$SID" "$CMD" >/dev/null; sleep 0.3
  GOT=$(shellmsg "$SID" | cut -f1); echo "  $CMD → exit=$GOT (expect $EXP)"
done
```

**2026-09-24 实测**：0 / 42 / 127 全对 ✅（推断：error.value 匹配 `/^-?\d+$/` 取数字；有 complete 无 error → 0）

### ST.E3 stdout 完整性（多行重建）

> execd 逐行发事件并剥离换行，V2 用 `assembleStreamText`（`join("\n")`）重建；stderr 在 execd 侧被合并进 stdout（协议限制，见文末）。

```bash
SID=$(new_sid "ST.E3"); shell "$SID" "echo warmup" >/dev/null
shell "$SID" "echo line1 && echo line2 && echo line3" >/dev/null; sleep 0.5
curl -s "$BASE/api/session/$SID/message?order=asc" -H "Authorization: Basic $AUTH" | python3 -c '
import json,sys
sh=[m for m in json.load(sys.stdin).get("data",[]) if m.get("type")=="shell"]
o=(sh[-1].get("output") or {}).get("output","")
print("行数:",len([x for x in o.split("\n") if x]),"output:",repr(o))'   # 期望 3 行
```

**2026-09-24 实测**：`'line1\nline2\nline3'` 3 行 ✅

### ST.E4 并发 shell（串行锁下的总耗时）

> **V2 语义统一**：同 session shell **串行**（与 ST.S1 一致）。本用例判定「热态总耗时 < 1s 且无 SSE gap 排队」；「真并发」需 V1 的 `exec/async` 通道，V2 未提供。

```bash
SID=$(new_sid "ST.E4"); shell "$SID" "echo warmup" >/dev/null
START=$(date +%s%N)
for i in 1 2 3; do shell "$SID" "ls /workspace/" >/dev/null & done
wait; END=$(date +%s%N); echo "3 并发 ls 总耗时: $(( (END-START)/1000000 ))ms"
```

**2026-09-24 实测**：热态 667ms ✅（冷启动首轮流 ~2-3.8s 属建沙箱，非 regression）

### ST.E5 SDK 直接 A/B（run vs runInSessionStream 早退）

```ts
// packages/core/verify-sse-ab.ts（SDK 装在 packages/core）
import { Sandbox, ConnectionConfig } from "@alibaba-group/opensandbox"
const cfg = new ConnectionConfig({ domain: "localhost:8080", protocol: "http", useServerProxy: true })
const sb = await Sandbox.create({ connectionConfig: cfg, image: "opencode-opensandbox:local", timeoutSeconds: 120 })
const cs = await sb.commands.createSession({ workingDirectory: "/workspace" })
const CMD = "ls /workspace/"
for (let i = 1; i <= 3; i++) {           // A: 等 SSE 关闭
  let completeAt = 0; const t0 = Date.now()
  await sb.commands.run(CMD, { timeoutSeconds: 30 }, { onExecutionComplete: () => { completeAt = Date.now() - t0 } })
  console.log(`A#${i}: complete=${completeAt}ms resolved=${Date.now() - t0}ms gap=${Date.now() - t0 - completeAt}ms`)
}
for (let i = 1; i <= 3; i++) {           // B: 早退
  const t0 = Date.now()
  for await (const ev of sb.commands.runInSessionStream(cs, CMD, { timeoutSeconds: 30 }))
    if (ev.type === "execution_complete" || ev.type === "error") break
  console.log(`B#${i}: returned=${Date.now() - t0}ms`)
}
await sb.kill().catch(() => {}); await sb.close().catch(() => {})
```

```bash
cd packages/core && bun verify-sse-ab.ts
```

**2026-09-24 实测**：A gap≈1000ms；B 27–71ms ≈ A 的 complete ✅（比值 >10x）

### ST.E6 远端 K8s 沙箱（本地复现）

> 远端 Sandbox API 经本地转发可达：`30040 → 172.18.32.15:30040`。SaaS 容器用 `host.docker.internal:30040` + API Key + 远端可拉取的镜像。AI 路径需 provider 配置（从既有 e2e 容器取 `~/.config/opencode/opencode.jsonc`）。

```bash
# 0) 确认/恢复转发（重启后可能丢失）
curl -s http://172.18.32.15:30040/health   # {"status":"healthy"}
nohup node -e "const net=require('net');net.createServer(c=>{const r=net.connect(30040,'172.18.32.15');c.pipe(r);r.pipe(c);c.on('error',()=>r.destroy());r.on('error',()=>c.destroy())}).listen(30040,'0.0.0.0')" >/tmp/sandbox-forward.log 2>&1 &

# 1) 远端沙箱服务容器（本地 PG + 远端 K8s 沙箱）
docker exec opencode-saas-e2e cat /home/opencode/.config/opencode/opencode.jsonc > /tmp/opencode-remote-config.jsonc
docker run -d --name opencode-saas-remote -p 14098:4096 \
  -e OPENCODE_DATABASE_URL="postgresql://local@host.docker.internal:5432/opencode-v2-up" \
  -e OPENCODE_SANDBOX_ENABLED=1 -e OPENCODE_SANDBOX_DOMAIN=host.docker.internal:30040 \
  -e OPENCODE_SANDBOX_API_KEY=H68idVYzjadx -e OPENCODE_SANDBOX_USE_SERVER_PROXY=true \
  -e OPENCODE_SANDBOX_PROTOCOL=http \
  -e OPENCODE_SANDBOX_IMAGE=crpi-hlpnu8kiweghie0r.cn-hangzhou.personal.cr.aliyuncs.com/shangwfa/opencode-sandbox:session-lsp-v3 \
  -e OPENCODE_DEFAULT_DIRECTORY=/workspace -e OPENCODE_EVENTS_PERSIST=1 -e OPENCODE_DISABLE_AUTOUPDATE=1 \
  -e OPENCODE_PASSWORD=pg-e2e-test-password \
  opencode-saas-sandbox-test:slim serve --hostname 0.0.0.0 --port 4096 --print-logs --log-level info
sleep 10
docker cp /tmp/opencode-remote-config.jsonc opencode-saas-remote:/home/opencode/.config/opencode/opencode.jsonc
docker exec -u root opencode-saas-remote chown opencode:opencode /home/opencode/.config/opencode/opencode.jsonc
docker restart opencode-saas-remote >/dev/null; sleep 10

# 2) AI 触发 shell（注意 model 字段是 id 不是 modelID）
B3=http://localhost:14098
SID=$(curl -s "${H[@]}" -X POST "$B3/api/session" -d '{"title":"ST.E6","model":{"providerID":"Yd-DeepSeek","id":"deepseek-v4-flash"},"location":{"directory":"/workspace"},"permissions":[{"action":"shell","resource":"*","effect":"allow"}]}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["id"])')
curl -s -o /dev/null "${H[@]}" -X POST "$B3/api/session/$SID/prompt" -d '{"text":"请用 shell 工具执行 ls /workspace/，并原样报告输出。","resume":true}'
curl -s -o /dev/null --max-time 300 "${H[@]}" -X POST "$B3/api/experimental/session/$SID/wait"

# 3) 确定性延迟 + PG 判定（shell part < 5s，对比修复前 92-3539s）
for cmd in "ls /workspace/" "echo hello" "seq 1 5" "pwd" "whoami"; do
  T=$(curl -s -o /dev/null -w '%{time_total}' --max-time 30 "${H[@]}" -X POST "$B3/api/session/$SID/shell" -d "{\"command\":\"$cmd\"}")
  printf "  %-18s %ss\n" "$cmd" "$T"
done
psql "$PG_URL" -t -A -F'|' -c "SELECT data::jsonb->>'status', data::jsonb->>'exit', (data::jsonb->'time'->>'completed')::bigint-(data::jsonb->'time'->>'created')::bigint FROM session_message WHERE session_id='$SID' AND type='shell' ORDER BY time_created"
```

**2026-09-24 实测**：AI 轮 tool shell `completed` exit=0；确定性 shell 0.12–0.26s；PG 时长 71–162ms、`seq 1 5` 多行完整 ✅

> 注：远端控制面建沙箱偶发 `Pending` 60s 超时（环境问题，重试即好）；远端集群里非本次测试的沙箱不要动。

---

## 三、排查对照表

| 现象 | 可能原因 | 用例 | 日志/判定关键字 |
|---|---|---|---|
| 同 session 命令排队等待 | `commandLocks` 串行（设计） | ST.S1 | 完成时刻错峰递增 |
| 建箱失败后请求永久挂死 | ~~`Effect.orDie` 把失败转 defect~~（已修复） | ST.S3 | 消息含 `Sandbox execution failed: ...`，秒级返回 |
| 并发首命令建多个 bash session | `sessionCreates` 去重失效 | ST.S2 | PG `command_session_id` 去重数 >1 |
| 命令挂起不返回 | getOrCreate 无界等待（已加 90s） | ST.S3 | `get or create sandbox timed out after 90s` |
| 窗口内频繁重建沙箱 | `entries` 失效/isHealthy 误判 | ST.S4 | `sandbox created` 出现多次 / `sandbox unhealthy, rebuilding` |
| shell 比 fs 慢一个量级 | SSE 等待 regression | ST.S5/E1 | 延迟 >2s |
| exitCode=null | 早退推断缺失 / 空流（现在会判定 session 失效并重建重试） | ST.E2 | 消息 `exit=null` + `empty execution stream` |
| 多行输出熔成一行 | `assembleStreamText` 回归（`join("")`） | ST.E3 | 行数 < 预期 |
| 命令被 SIGKILL（exit 137） | 沙箱内存 OOM | — | `likely sandbox memory OOM` 告警 |

> **stderr 合并说明（协议限制）**：execd 把 stderr 事件合并为 stdout 事件发出（`echo a && echo b >&2` 两个输出都以 `type:"stdout"` 到达）。`run` 按事件类型正确分离，但底层流不发 stderr 事件；空行在协议层丢失（无事件），`join("\n")` 只能恢复行序列。需在 SDK/execd 层跟进。

## 四、2026-09-24 实测汇总

| 用例 | 结果 | 关键数据 |
|---|---|---|
| ST.S1 | ✅ | 7145ms（3×2s 串行） |
| ST.S2 | ✅ | PG 1/1 |
| ST.S3 | ✅（修复后） | 0.36s / 0.11s 有界失败（修复前 >120s 挂死） |
| ST.S4 | ✅ | 65s 内 `sandbox created` ×1 |
| ST.S5 | ✅ | fs/list 0.061s vs shell 0.129s |
| ST.E1 | ✅ | 最大 0.155s |
| ST.E2 | ✅ | 0/42/127 |
| ST.E3 | ✅ | 3 行完整 |
| ST.E4 | ✅ | 热态 667ms（串行语义） |
| ST.E5 | ✅ | A gap≈1000ms，B 27–71ms |
| ST.E6 | ✅ | 远端 K8s 0.12–0.26s，PG 71–162ms |

环境：镜像由当前源码构建（`docker build -t opencode-saas-sandbox-test:slim -f Dockerfile .`，`--filter` 安装后 1.68GB）；本地 PG `opencode-v2-up`；本地 OpenSandbox `:8080`；远端 K8s 经 `:30040`。

## 清理

```bash
for B in http://localhost:14096 http://localhost:14097 http://localhost:14098; do
  curl -s "$B/api/session" -H "Authorization: Basic $AUTH" | python3 -c '
import json,sys
for s in json.load(sys.stdin).get("data",[]):
  if s.get("title","").startswith(("ST.","E3-verify")): print(s["id"])' | \
  while read id; do curl -s -o /dev/null -X DELETE "$B/api/session/$id" -H "Authorization: Basic $AUTH"; done
done
docker rm -f opencode-saas-remote opencode-saas-test-timeout
```
