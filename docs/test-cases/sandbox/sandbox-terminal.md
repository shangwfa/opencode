# 沙箱 Terminal（PTY）

> 公共测试环境和配置请参考 [`../00-preamble.md`](../00-preamble.md)。
> 技术方案请参考 [`../../../specs/sandbox-terminal.md`](../../../specs/sandbox-terminal.md)。

## 验收目标

验证 SaaS Terminal 在 Session 沙箱内运行真实 PTY，Server 仅负责鉴权、路由和 HTTP/WebSocket/SSE 代理，并满足以下约束：

| 维度 | 验收标准 |
|---|---|
| 执行位置 | shell 进程位于 Session 沙箱，不在 OpenCode Server 容器 |
| 隔离 | PTY 只能由所属 Session 查询、更新、连接和删除 |
| 协议 | `/pty` API 与 WebSocket 数据帧兼容，支持 cursor 重连 |
| 生命周期 | 首个 PTY 创建前启用 lease；最后一个 PTY 退出或删除后释放 lease |
| 多副本 | ticket 可跨 Pod 验证；同一 Session 不重复创建沙箱或互相重启 Agent |
| 恢复 | Agent SSE 断线重连后不丢失退出/删除事件 |
| 安全 | Agent endpoint 仅在 Server 与沙箱之间可达；ticket 绑定 PTY、Session、Location 且短时有效 |
| 兼容 | 非沙箱模式允许旧客户端省略 `sessionID`；SaaS 不回退本地 PTY |

## 前置条件

```bash
cd docs/test-cases
source test-env.sh 3
source test-lib.sh

# SaaS 必需配置
test -n "$OPENCODE_PTY_TICKET_SECRET" || echo "运行服务时必须配置 OPENCODE_PTY_TICKET_SECRET"

# 每个用例必须创建独立 Session，不得复用其他用例留下的 PTY/lease。
new_pty_sid() { new_sid; }

cleanup_pty_sid() {
  local sid=$1
  pty_list "$sid" 2>/dev/null | jexec "[x.get('id') for x in d]" | tr -d "[],'" | tr ' ' '\n' |
    while read -r id; do [ -n "$id" ] && curl -sS -X DELETE "$BASE/pty/$id?sessionID=$sid" >/dev/null; done
  curl -sS -X POST "$BASE/session/$sid/kill-sandbox" >/dev/null 2>&1 || true
  curl -sS -X DELETE "$BASE/session/$sid" >/dev/null 2>&1 || true
}
```

以下示例使用 legacy `/pty` API。current API 对应 `/api/pty`，Location 参数使用 `location[directory]` / `location[workspace]`。

辅助函数：

```bash
pty_create() {
  local sid=$1 title=${2:-Terminal}
  curl -sS -X POST "$BASE/pty?sessionID=$sid" \
    -H 'Content-Type: application/json' \
    -d "{\"title\":\"$title\"}"
}

pty_list() {
  curl -sS "$BASE/pty?sessionID=$1"
}
```

---

## P0 核心功能

### PTY-1 创建、查询、更新和删除

```bash
SID_A=$(new_pty_sid)
PTY_JSON=$(pty_create "$SID_A" "sandbox-terminal")
PTY_ID=$(printf '%s' "$PTY_JSON" | jexec "d.get('id')")
echo "$PTY_JSON" | jexec "d"

curl -sS "$BASE/pty/$PTY_ID?sessionID=$SID_A" | jexec "d"

curl -sS -X PUT "$BASE/pty/$PTY_ID?sessionID=$SID_A" \
  -H 'Content-Type: application/json' \
  -d '{"title":"renamed-terminal","size":{"rows":30,"cols":100}}' | jexec "d"

curl -sS -X DELETE "$BASE/pty/$PTY_ID?sessionID=$SID_A" -o /dev/null -w '%{http_code}\n'
cleanup_pty_sid "$SID_A"
```

**期望**：

- 创建返回 `pty_*` ID、`status=running`、有效 `pid`，`cwd=/workspace`
- 查询返回同一 PTY；更新后标题与尺寸生效
- 删除成功；再次查询返回 404

### PTY-2 PTY 运行在沙箱而非 Server

```bash
SID_A=$(new_pty_sid)
MARKER="pty-placement-$(date +%s)-$$"
PTY_JSON=$(curl -sS -X POST "$BASE/pty?sessionID=$SID_A" -H 'Content-Type: application/json' \
  -d "{\"title\":\"placement-check\",\"command\":\"/bin/sh\",\"args\":[\"-lc\",\"exec -a $MARKER sleep 300\"]}")
PTY_ID=$(printf '%s' "$PTY_JSON" | jexec "d.get('id')")

# 唯一命令标记只应出现在 Session 沙箱
docker exec opencode-saas-test sh -lc "pgrep -af '$MARKER' || true"
curl -sS -X POST "$BASE/session/$SID_A/exec" -H 'Content-Type: application/json' \
  -d "{\"command\":\"pgrep -af '$MARKER'\"}" | jexec "d.get('stdout','')"

# PG 应有 SID_A 对应的 running sandbox
psql "$PG_URL" -x -c "SELECT id,session_id,state,keep_alive FROM sandbox WHERE session_id='$SID_A'"
cleanup_pty_sid "$SID_A"
```

**期望**：唯一 marker 在沙箱内可见、Server 容器内不可见；PG 中对应沙箱为 `running` 且 `keep_alive=true`。不以 PID 数字判断放置位置，避免 PID namespace 重号。

### PTY-3 Session 隔离

```bash
SID_A=$(new_pty_sid)
SID_B=$(new_pty_sid)
PTY_JSON=$(pty_create "$SID_A" "owner-a")
PTY_ID=$(printf '%s' "$PTY_JSON" | jexec "d.get('id')")

echo "A list: $(pty_list "$SID_A" | jexec "len(d)")"
echo "B list: $(pty_list "$SID_B" | jexec "len(d)")"

curl -sS -o /dev/null -w 'B get: %{http_code}\n' "$BASE/pty/$PTY_ID?sessionID=$SID_B"
curl -sS -o /dev/null -w 'B update: %{http_code}\n' -X PUT \
  "$BASE/pty/$PTY_ID?sessionID=$SID_B" -H 'Content-Type: application/json' -d '{"title":"stolen"}'
curl -sS -o /dev/null -w 'B delete: %{http_code}\n' -X DELETE \
  "$BASE/pty/$PTY_ID?sessionID=$SID_B"
cleanup_pty_sid "$SID_A"
cleanup_pty_sid "$SID_B"
```

**期望**：B 的列表不包含 A 的 PTY；B 对 A 的查询、更新和删除均返回 404；A 的 PTY 仍为 `running`。

### PTY-4 WebSocket 输入输出和 meta cursor

先创建 PTY 并签发短期 ticket：

```bash
SID_A=$(new_pty_sid)
PTY_JSON=$(pty_create "$SID_A" "ws-io")
export PTY_ID=$(printf '%s' "$PTY_JSON" | jexec "d.get('id')")
export SID_A BASE

TOKEN_JSON=$(curl -sS -X POST "$BASE/pty/$PTY_ID/connect-token?sessionID=$SID_A" \
  -H 'x-opencode-ticket: 1' -H "Origin: $BASE")
export PTY_TICKET=$(printf '%s' "$TOKEN_JSON" | jexec "d.get('ticket')")
echo "$TOKEN_JSON" | jexec "d"
```

使用 Bun 建立 WebSocket：

```bash
bun - <<'JS'
const url = new URL(`${process.env.BASE.replace(/^http/, "ws")}/pty/${process.env.PTY_ID}/connect`)
url.searchParams.set("sessionID", process.env.SID_A)
url.searchParams.set("ticket", process.env.PTY_TICKET)
const ws = new WebSocket(url, { headers: { Origin: process.env.BASE } })
ws.binaryType = "arraybuffer"
const timer = setTimeout(() => { console.error("timeout"); process.exit(1) }, 10_000)
let output = ""
let sawMeta = false
ws.onopen = () => ws.send("printf 'PTY_WS_OK\\n'\n")
ws.onmessage = (event) => {
  const bytes = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : undefined
  if (bytes?.[0] === 0) {
    console.log("meta", new TextDecoder().decode(bytes.slice(1)))
    sawMeta = true
    return
  }
  output += typeof event.data === "string" ? event.data : new TextDecoder().decode(bytes)
  if (!output.includes("PTY_WS_OK") || !sawMeta) return
  console.log(output)
  clearTimeout(timer)
  ws.close()
  process.exit(0)
}
JS
cleanup_pty_sid "$SID_A"
```

**期望**：收到 `PTY_WS_OK`；连接初始阶段收到 `0x00 + {"cursor":N}` meta frame；普通终端输出保持原始 UTF-8 数据帧。

### PTY-5 cursor 重连只补发缺失输出

1. 建立 WebSocket，记录 meta frame 中的 `cursor=N` 后断开。
2. 在另一个连接中执行 `printf 'AFTER_CURSOR\n'`。
3. 重新连接，并在 URL 增加 `cursor=N`。

**期望**：重连只收到 cursor 之后的输出，包含一次 `AFTER_CURSOR`；不会重放 cursor 之前的完整终端历史；新 meta cursor 大于 `N`。

### PTY-6 退出态保留与显式删除

```bash
SID_A=$(new_pty_sid)
EXITED=$(curl -sS -X POST "$BASE/pty?sessionID=$SID_A" \
  -H 'Content-Type: application/json' \
  -d '{"title":"exit-test","command":"/bin/sh","args":["-lc","exit 23"]}')
EXITED_ID=$(printf '%s' "$EXITED" | jexec "d.get('id')")
sleep 1

curl -sS "$BASE/pty/$EXITED_ID?sessionID=$SID_A" | jexec "d"
curl -sS -X DELETE "$BASE/pty/$EXITED_ID?sessionID=$SID_A" -o /dev/null -w '%{http_code}\n'
cleanup_pty_sid "$SID_A"
```

**期望**：退出后查询返回 `status=exited`、`exitCode=23`；显式删除后返回 404。Agent 最多保留最近 25 个 exited PTY，超过后淘汰最旧记录。

### PTY-7 最后一个 PTY 删除后释放 lease

```bash
SID_A=$(new_pty_sid)
PTY_JSON=$(pty_create "$SID_A" "lease-release")
PTY_ID=$(printf '%s' "$PTY_JSON" | jexec "d.get('id')")

psql "$PG_URL" -tAc "SELECT keep_alive FROM sandbox WHERE session_id='$SID_A'"
curl -sS -X DELETE "$BASE/pty/$PTY_ID?sessionID=$SID_A" >/dev/null
sleep 2
psql "$PG_URL" -tAc "SELECT keep_alive FROM sandbox WHERE session_id='$SID_A'"
cleanup_pty_sid "$SID_A"
```

**期望**：创建后 `keep_alive=true`；删除最后一个 running PTY 后变为 `false`。如果并发创建了新 PTY，二次确认会恢复为 `true`，不得误释放。

---

## P0 多副本与安全

以下用例需要两个连接同一 PG、同一 OpenSandbox、配置相同 `OPENCODE_PTY_TICKET_SECRET` 的 Server Pod：

```bash
export BASE_A=http://127.0.0.1:14096
export BASE_B=http://127.0.0.1:14097
```

### PTY-8 ticket 跨 Pod 验证

1. 通过 `BASE_A` 创建 PTY 并调用 `connect-token`。
2. 将 WebSocket URL 的 host 改为 `BASE_B`，保留相同 `sessionID`、`ptyID` 和 `ticket`。
3. 建立连接并执行 `echo CROSS_POD_OK`。

**期望**：Pod B 接受 Pod A 签发的 ticket，并收到 `CROSS_POD_OK`。

### PTY-9 ticket scope、篡改与过期

对同一 ticket 分别执行：

| 变体 | 期望 |
|---|---|
| 原始 PTY、Session、Location | WebSocket 成功升级 |
| 修改任意一个 ticket 字符 | 403 |
| 替换 `ptyID` | 403 |
| 替换 `sessionID` | 403 |
| 替换 directory/workspace | 403 |
| 等待超过返回的 `expires_in` | 403 |

ticket 在有效期内允许同 scope 重试；它是短期、scope-bound capability，不是一次性凭证。

### PTY-10 同 Session 并发创建只产生一个沙箱

```bash
SID_MULTI=$(new_sid)

for base in "$BASE_A" "$BASE_B" "$BASE_A" "$BASE_B"; do
  curl -sS -X POST "$base/pty?sessionID=$SID_MULTI" \
    -H 'Content-Type: application/json' -d '{"title":"concurrent"}' &
done
wait

psql "$PG_URL" -x -c "SELECT id,session_id,state FROM sandbox WHERE session_id='$SID_MULTI'"
```

**期望**：四次 PTY 创建均成功；PG 只有一个 running sandbox；两 Pod 日志中没有遗留第二个 orphan sandbox。

### PTY-11 多 Pod 不互相重启 Agent

1. 通过 Pod A 创建 PTY，记录沙箱内 `/tmp/opencode-pty-agent.pid`。
2. 通过 Pod B 对同 Session 连续执行 list、create、connect。
3. 再次读取 Agent PID 与 `/tmp/opencode-pty-agent.log`。

**期望**：Agent PID 不变；没有重复 bind 4097、相互 kill 或启动风暴；所有请求成功。

### PTY-13 缺少生产 secret 时 fail closed

以 `OPENCODE_SANDBOX_ENABLED=true` 且不配置 `OPENCODE_PTY_TICKET_SECRET` 启动独立测试实例。

**期望**：服务启动或 PTY Runtime 装配明确失败；不得生成每 Pod 随机 secret 后继续提供 SaaS PTY，也不得回退本地 PTY。

---

## P1 恢复与资源回收

### PTY-14 Agent SSE 事件重放

1. 创建一个执行 `sleep 3; exit 17` 的 PTY。
2. 在 PTY 仍运行时临时中断 Server 到 Agent 的 SSE 连接。
3. 等待 PTY 在断线期间退出，然后恢复网络。
4. 订阅 `/global/event` 或 App 事件流。

**期望**：relay 使用 `Last-Event-ID` 续传；恢复后至少收到一次 `pty.exited`，包含 PTY ID 和 `exitCode=17`；UI 幂等移除对应 tab。多 Pod 事件语义为 at-least-once，不要求 exactly-once。

### PTY-15 心跳刷新与 idle reaper 竞态

1. 保持至少一个 PTY WebSocket 存活超过一个 heartbeat 周期（60 秒）。
2. 每 20 秒查询 `sandbox.time_updated`。
3. 将一条旧记录置为超过 idle threshold，同时并发触发 PTY 活跃请求。

**期望**：心跳持续推进 `time_updated`；活跃记录不会被回收；回收器只有在数据库条件更新成功将 `running` 原子抢占为 `killed` 后才销毁沙箱，多 Pod 中只有一个 winner。

### PTY-16 Server 重启后恢复已有 Terminal

1. 创建 PTY 并输出唯一文本，保持 shell 运行。
2. 重启一个 Server Pod，不重启 Session 沙箱。
3. 通过另一 Pod 或重启后的 Pod list/get，并使用最后 cursor 重连。

**期望**：PTY ID、PID 和沙箱 ID 不变；Agent 不被重启；重连可恢复 buffer 并继续交互。

---

## P2 兼容性与回归

### PTY-18 本地模式旧客户端兼容

以 `OPENCODE_SANDBOX_ENABLED=false` 启动嵌入式实例，并省略 `sessionID` 调用：

```bash
curl -sS -X POST "$BASE/pty" -H 'Content-Type: application/json' -d '{"title":"legacy-local"}'
curl -sS "$BASE/pty"
```

**期望**：本地 Runtime 正常创建和列出 PTY；WebSocket 旧连接方式仍可使用。配置 `OPENCODE_DATABASE_URL` 本身不得自动切换到沙箱 PTY。

### PTY-19 SaaS 缺少 sessionID 不回退本地

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$BASE/pty" \
  -H 'Content-Type: application/json' -d '{"title":"missing-session"}'
```

**期望**：返回非 2xx，Server 容器中不创建 PTY；SaaS 不因缺少或无效 `sessionID` 回退 `LocalPtyRuntime`。

### PTY-20 current 与 legacy API 一致性

分别通过以下接口执行 create/list/get/update/remove/connect-token：

- legacy：`/pty`
- current：`/api/pty`

**期望**：除 current API 的 Location response wrapper 与 204 remove 语义外，两套接口的 PTY ID、状态、隔离、ticket 和 WebSocket 行为一致。

### PTY-21 自动化回归

```bash
cd packages/core
bun test test/pty/ticket.test.ts test/pty/pty-output-isolation.test.ts test/pty/pty-session.test.ts \
  test/pty/protocol.test.ts test/pty/input.test.ts test/pty/info-schema.test.ts

cd ../opencode
bun test test/server/httpapi-pty.test.ts
bun test test/pty/pty-shell.test.ts
bun build docker/opt/opencode-pty-agent.ts --target bun --outfile /tmp/opencode-pty-agent.js

cd ../app
bun test src/context/terminal.test.ts \
  src/pages/session/terminal-panel.test.ts \
  src/utils/terminal-writer.test.ts
```

**期望**：与当前 PTY 契约一致的 focused tests 和 Agent bundle 构建全部通过。全仓 typecheck、Docker 发布检查和其他 package 门禁属于通用 CI，不计入单个 Terminal 用例结果。

### PTY-22 只读操作不得创建沙箱

为一个从未创建过沙箱的新 Session 分别调用 list、随机 PTY ID 的 get/update/remove/connect。

**期望**：list 返回空数组，其余返回 404；PG 中该 Session 没有 `state=running` 的 sandbox。只有 create 可以触发 `getOrCreate`。

### PTY-23 Agent health 与网络边界

从 Server 所在网络直接请求 Agent `/health`，并从公网入口尝试访问 Agent 端口。

**期望**：内网请求返回 `status=ready`、`protocolVersion=1` 和非空 `instanceID`；Agent 端口不应暴露到公网入口。当前 Agent 没有 bearer 协议，不测试不存在的 Authorization 契约。

### PTY-24 resize 作用于真实 TTY

创建 PTY，PUT `size={rows:37,cols:119}`，随后通过同一 WebSocket 执行 `stty size`。

**期望**：输出为 `37 119`，不是仅响应对象中的尺寸字段变化。

### PTY-25 exited 上限

在全新沙箱 Agent 内顺序创建 26 个立即退出的 PTY。

**期望**：列表中恰有 25 个 exited PTY；第一个 ID 返回 404，后 25 个仍可查询；完成后清理整个 Session。

### PTY-26 ticket 强制鉴权

在 sandbox runtime 下分别尝试：无 ticket、有 Basic Auth 但无 ticket、合法 ticket，以及缺少 `x-opencode-ticket: 1` 的 mint 请求。

**期望**：前两种 WebSocket 请求均 403；合法 ticket 成功；缺 mint header 返回 403。本地 runtime 无 ticket 仍保持兼容。Origin 按 Server 的 CORS 配置校验；当前 `allowedOrigins=["*"]` 会接受任意合法 Origin，不断言错误 Origin 固定返回 403。

### PTY-27 cursor 与 buffer 边界

覆盖 `cursor=-1`、负数、未来 cursor、早于 2 MiB buffer 起点、恰好位于起点，以及超过 64 KiB 的 replay。

**期望**：`-1` 不重放历史；非法 cursor 被拒绝或按协议规范化；过旧 cursor 只重放仍保留的 buffer；大 replay 被拆为不超过 64 KiB 的数据帧，meta cursor 正确。

### PTY-28 UTF-8 与二进制输入

通过 WebSocket 发送合法 UTF-8 binary、非法 UTF-8 binary、emoji/CJK 文本，再发送普通命令。

**期望**：合法数据原样写入；非法 UTF-8 被丢弃且连接保持可用；emoji/CJK 不因 cursor 或 buffer 截断产生半个 surrogate；后续命令正常输出。

### PTY-29 多订阅者与慢客户端

为同一 PTY 建立两个正常订阅者和一个停止读取的慢订阅者，持续产生超过 2 MiB 输出。

**期望**：两个正常订阅者收到相同有序输出；慢订阅者因背压以 1013 或 Agent backpressure close 断开；Server/Agent 内存保持有界，正常订阅者不受影响。

### PTY-30 快速退出不泄漏 lease

在独立 Session 创建 `command=/bin/sh,args=[-lc,exit 0]`，轮询 PG 最长 5 秒。

**期望**：最终 `keep_alive=false`；即使 created/exited 发生在 relay 建立前也能通过事件重放或快照 reconcile 收敛。

### PTY-31 relay 并发去重

同一 Pod 对同一 Session 并发执行 20 次 list/create/resolve，并记录 Agent `/pty/events` 连接数。

**期望**：同一 Pod、同一 root Session 同时只有一个 relay 和一个 heartbeat；退出/删除事件不会因本地双 relay 重复发布。

### PTY-32 Agent 重启与事件 gap

覆盖 Agent PID 文件陈旧、Agent 进程重启、Server cursor 落后超过 512 个事件三种情况。

**期望**：陈旧 PID 文件不会阻止 Agent 重启；重启后旧 PTY 返回 404，已连接的 App tab 在查询确认 404 后 clone；事件 gap 返回 409，Server 通过 Agent 快照收敛 lease。快照不会还原缺失的 exited/deleted 事件，本用例不对未连接的 inactive tab 作收敛保证。

### PTY-33 父子 Session root 路由

创建父 Session 与共享同一 root sandbox 的子 Session，分别创建、查询 PTY。

**期望**：两者路由到同一 sandbox ID，但 Agent 按请求 sessionID 隔离 owner，父子 Session 的 list/get/update/remove 互不可见；独立 root Session 之间同样隔离。

### PTY-34 App 状态与恢复

自动化分别覆盖 session/server-scoped cache、`pty.deleted` 幂等删除、clone 清理旧 ID、clone 期间 tab 被删除，以及 WebSocket close 后 get=200 重连/get=404 clone。浏览器刷新与完整远端恢复另设 App E2E，不由纯状态单测代替。

**期望**：不串 Session、不遗留远端 PTY、不保留僵尸 tab，重连不重复完整 buffer。
