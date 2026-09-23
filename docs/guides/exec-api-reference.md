# exec / keep-alive API 参考

> 本文档从 [`17-exec-api.md`](../17-exec-api.md) 迁出（2026-07-17 整理），为参考文档而非测试用例。用例见 17 文档。

## API 接口详情

#### `POST /session/:sessionID/exec`

在沙箱中执行命令。沙箱不存在时会按需自动创建；无需先通过 AI 消息创建 sandbox。同步 exec 会等待命令退出，长驻进程请使用 `/exec/async`，或在命令内部用 `nohup ... </dev/null > /tmp/app.log 2>&1 & echo $!` 显式后台化。

**请求体**：
```json
{
  "command": "echo hello",
  "workingDirectory": "/workspace",  // 可选，默认 /workspace
  "timeoutSeconds": 30               // 可选，默认不限
}
```

**响应**：
```json
{
  "id": "exec-xxx",
  "exitCode": 0,
  "stdout": "hello\n",
  "stderr": "",
  "error": null  // 或 {"name":"...","value":"...","traceback":[...]}
}
```

#### `POST /session/:sessionID/exec/async`

异步执行命令，适合长运行任务、watch 模式和 dev server。接口只负责启动命令并返回 `execId`；实时输出通过 `/stream` 消费，最终状态通过 `/exec/:execId` 查询。

**请求体**：同 `POST /exec`。

**响应**：
```json
{"execId":"exec-1-1234567890","status":"running","sessionID":"ses_xxx"}
```

#### `GET /session/:sessionID/exec/:execId/stream`

SSE 方式监听 async exec 的实时输出。

**事件**：
```text
event: stdout
data: {"text":"line\n"}

event: stderr
data: {"text":"error\n"}

event: ping
（data 为空字符串；SSE 编码后通常只有 `event:ping\n\n`）

event: done
data: {"execId":"exec-1-...","status":"completed","exitCode":0,"stdout":"...","stderr":""}
```

**注意**：当前 stream 直接消费内存 queue，不是可回放日志，也不是多消费者广播；客户端应在启动 async exec 后立即连接，且同一 `execId` 只保留一个 stream 消费者。

#### `GET /session/:sessionID/exec/:execId`

查询 async exec 当前或最终状态。该接口适合作为 SSE 断线后的兜底，不适合作为实时日志替代。

**响应**：
```json
{"execId":"exec-1-...","status":"completed","exitCode":0,"stdout":"...","stderr":"...","startedAt":123,"finishedAt":456}
```

#### `POST /session/:sessionID/exec/:execId/kill`

请求中断 async exec。当前 opencode 侧会将状态置为 `killed` 并结束 SSE stream；底层 detached command 是否立即中断取决于 sandbox execd 对 detached session interrupt 的支持，关键用例应同时验证进程是否退出或直接调用 `kill-sandbox` 清理。

#### `POST /session/:sessionID/keep-alive`

设置或释放 keepAlive。`keepAlive=true` 时 sandbox 在 session idle 后不会被自动销毁。`boot=true` 时额外立即创建沙箱。

**请求体**：
```json
{"enabled": true}                  // 设置 keepAlive（默认）
{"enabled": true, "boot": true}    // 设置 keepAlive + 立即启动沙箱
{"enabled": false}                 // 释放 keepAlive
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | `true` | keepAlive 开关。`true`=保活，`false`=释放 |
| `boot` | boolean | `false` | 是否立即启动沙箱。仅在 `enabled:true` 时生效 |

> `boot:true` 先设置 keepAlive（写入 DB），再调用 `getOrCreate` 创建沙箱，确保沙箱使用 10x TTL。boot 失败不影响 keepAlive 设置，返回 `sandboxId: null`。

**响应**：
```json
{"sessionID": "ses_xxx", "keepAlive": true, "sandboxId": null}
```

- `sandboxId`：`boot:true` 且沙箱创建成功时返回沙箱 ID；其余情况为 `null`

#### `GET /session/:sessionID/keep-alive`

查询 keepAlive 状态。

**响应**：
```json
{"sessionID": "ses_xxx", "keepAlive": true}
```


---

