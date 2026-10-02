# Session 用户标识字段（V2）

> 覆盖 V2 prompt 请求中 `userName` / `userId` 的接收、可信身份覆盖、消息持久化与读取。V2 使用 `POST /api/session/{sessionID}/prompt`，响应为 `200`，user 消息的字段位于消息对象顶层。
>
> `userId` 的可信来源是 `x-user-id` 请求头：请求头存在时覆盖 body 中的 `userId`；请求头缺失时 body 中的 `userId` 不写入消息。`userName` 按请求 body 原样记录。

## 前提

```bash
export BASE="http://127.0.0.1:14101"
export PG_URL="postgresql://local@127.0.0.1:5432/opencode-v2-up"
export OPENCODE_PASSWORD="<测试服务口令>"
bun docs/test-cases/scripts/session-user-fields-e2e.mjs
```

自动化脚本通过 Docker SaaS API 覆盖普通 prompt、header/body 优先级、无标识兼容和多轮用户消息，并查询 PG 中的投影记录。每条 prompt 等待 user 消息进入消息历史后再进行下一条请求。

手工执行下方 curl 示例时，为每个请求附加服务认证参数 `-u "opencode:$OPENCODE_PASSWORD"`。

## T25.1 创建 session 并发送带用户标识的 prompt

```bash
SID=$(curl -fsS -X POST "$BASE/api/session" \
  -H 'Content-Type: application/json' -d '{}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["id"])')

curl -sS -X POST "$BASE/api/session/$SID/prompt" \
  -H 'Content-Type: application/json' \
  -H 'x-user-id: user-123' \
  -d '{"text":"hello","userName":"alice","userId":"spoofed-id","resume":false}'
```

**期望**：HTTP `200`；响应包含已接受的 user 输入 ID。

## T25.2 消息列表及数据库持久化

```bash
curl -fsS "$BASE/api/session/$SID/message?order=asc" | python3 -c '
import json,sys
body=json.load(sys.stdin)
msgs=body.get("data", body)
users=[m for m in msgs if m.get("type")=="user"]
assert users, f"没有 user 消息: {body}"
user=users[-1]
assert user.get("userName")=="alice", user
assert user.get("userId")=="user-123", user
print("\u2705 消息读取字段正确；userId 以请求头为准")
'
```

**期望**：消息中 `userName=alice`、`userId=user-123`；数据可从 PG 持久化消息记录读取。`userId` 不应是 body 中伪造的 `spoofed-id`。

## T25.3 不传用户字段时向后兼容

新建 session 后发送：

```bash
curl -sS -X POST "$BASE/api/session/$SID/prompt" \
  -H 'Content-Type: application/json' \
  -d '{"text":"hello without identity","resume":false}'
```

**期望**：请求正常接受；读取到的 user 消息没有 `userName`、`userId` 字段（或解码值为 `null`），既有不带标识的调用保持兼容。

## T25.4 请求头优先且忽略不可信 body userId

新建 session 后，不带 `x-user-id`，但 body 传入 `userId`：

```bash
curl -sS -X POST "$BASE/api/session/$SID/prompt" \
  -H 'Content-Type: application/json' \
  -d '{"text":"body identity is untrusted","userName":"bob","userId":"spoofed-id","resume":false}'
```

**期望**：消息保留 `userName=bob`，不包含 `userId`。对照 T25.1，有请求头时消息 `userId` 必须等于头值，即使 body 同时携带了不同值。

## T25.5 多轮交替用户，逐条消息独立记录标识

在同一 session 中顺序发送以下请求（每次请求后确认 prompt 已接受）：

```bash
# alice
curl -sS -X POST "$BASE/api/session/$SID/prompt" -H 'Content-Type: application/json' \
  -H 'x-user-id: pm-001' -d '{"text":"需求一","userName":"alice","resume":false}'
# bob
curl -sS -X POST "$BASE/api/session/$SID/prompt" -H 'Content-Type: application/json' \
  -H 'x-user-id: fe-002' -d '{"text":"补充前端要求","userName":"bob","resume":false}'
# alice 再发言
curl -sS -X POST "$BASE/api/session/$SID/prompt" -H 'Content-Type: application/json' \
  -H 'x-user-id: pm-001' -d '{"text":"继续补充","userName":"alice","resume":false}'
```

从 `GET /api/session/{sessionID}/message` 按 durable sequence 读取后检查 user 消息：

- 三条 user 消息依次为 `alice/pm-001`、`bob/fe-002`、`alice/pm-001`。
- 同一 session 中每条消息保留各自请求的用户标识，不以后续请求覆盖历史消息。
- 可在客户端筛选 `info.userId`（若 message API 返回包装对象，先取 `data` 数组）。当前用例不要求服务端提供按 `userId` 的查询过滤参数。

## PG 检查

```bash
PG_URL="${PG_URL:-postgresql://local@127.0.0.1:15432/opencode}"
psql "$PG_URL" -v sid="$SID" -c \
  "SELECT id, type, data::jsonb->>'userName' AS user_name, data::jsonb->>'userId' AS user_id \
   FROM session_message WHERE session_id = :'sid' AND type = 'user' ORDER BY seq"
```

**期望**：查询结果与消息列表断言一致。测试不得仅凭 prompt HTTP 成功就判定数据库断言通过。

## 自动化实测记录

2026-09-30 使用独立 Docker 容器 `opencode-user-fields-tmp`（14101）、隔离 PG 库 `opencode-v2-test`、真实 HTTP API 验证：

- T25.1/T25.2：请求头 `x-user-id` 覆盖伪造的 body `userId`，`userName` 与 `userId` 均出现在消息读取结果。
- T25.3：省略用户标识字段的请求兼容，消息没有 `userId`。
- T25.4：只有不可信 body `userId` 时不写入身份标识，`userName` 保留。
- T25.5：同一 session 的三轮交替用户标识逐条正确，历史消息没有被后续用户覆盖。
- PG：6 条 user 消息的 text、userName、userId 均与预期一致。

结果：全部通过。脚本 `docs/test-cases/scripts/session-user-fields-e2e.mjs` 已增加 `finally` 清理；测试 session 删除后，隔离库 session 行数恢复为运行前的 14 条。
