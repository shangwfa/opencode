# V2 AI 对话与工具调用

> 本文按当前 V2 HTTP API 编写。接口地址以 `/api/...` 开头，会话工作目录使用 `/workspace`。
> V2 API 契约以 `packages/protocol/src/groups/session.ts`、`message.ts` 和运行中服务的 `/openapi.json` 为准。

## V1 到 V2 的接口变化

T4.1–T4.7 的功能在 V2 都有对应能力，但不能复用 V1 路径和响应结构：

| V1 调用 | V2 调用 | V2 语义 |
|---|---|---|
| `POST /session` | `POST /api/session` | 请求中传 `location.directory`；成功响应为 `{data: session}` |
| `POST /session/:id/message` | `POST /api/session/:id/prompt`，再 `POST /api/experimental/session/:id/wait` | prompt 接纳后立即返回，不同步返回 assistant 回复 |
| `POST /session/:id/prompt_async` | `POST /api/session/:id/prompt` | 返回 HTTP 200 和已接纳的 user message，不是 V1 的 204 |
| `POST /session/:id/abort` | `POST /api/session/:id/interrupt` | 返回 `{interrupted: boolean}`；执行状态用 `/api/session/active` 查询 |
| 消息 `parts[]` | `GET /api/session/:id/message` 的 `data[]` | assistant 内容在 `content[]`，工具调用是 `type: "tool"`，状态在 `state.status` |

**当前没有 V1 HTTP 路径/响应格式的兼容层。** 如果 SaaS 外部调用方必须保持 V1 wire contract，需要另行决定是否提供兼容路由；本文只测 V2。沙箱会话的 `shell` 工具目前不支持 `background: true`，本用例只验证前台命令。

## 前置条件与通用变量

- 服务已在 Docker 中启动，并连接要验证的 PG 和 sandbox；`BASE` 指向该服务的宿主机端口。
- 服务端配置的口令放在 `OPENCODE_PASSWORD`。若服务关闭 HTTP Basic Auth，将 `CURL_AUTH=()` 留空。
- `jq` 用于从 V2 JSON 响应中读取字段。

```bash
export BASE="${BASE:-http://localhost:14096}"
MODEL='{"id":"deepseek-v4-flash","providerID":"Yd-DeepSeek"}'
CURL_AUTH=()
if [[ -n "${OPENCODE_PASSWORD:-}" ]]; then
  CURL_AUTH=(-u "opencode:${OPENCODE_PASSWORD}")
fi

# 创建一个位于 /workspace 的 V2 会话，并固定模型。
SID=$(curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session" \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"T4 AI conversation\",\"location\":{\"directory\":\"/workspace\"},\"model\":$MODEL}" \
  | jq -r '.data.id')
echo "SID=$SID"

# 发起一个 prompt 后等待该会话空闲。prompt 本身是异步接纳接口。
send_prompt() {
  local text="$1"
  jq -n --arg text "$text" '{text:$text,metadata:{},delivery:"queue"}' \
    | curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$SID/prompt" \
        -H 'Content-Type: application/json' --data-binary @-
  curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST \
    "$BASE/api/experimental/session/$SID/wait" -H 'Content-Type: application/json' -d '{}'
}

# 查看 V2 消息及真实工具状态。
messages() {
  curl -fsS --noproxy '*' "${CURL_AUTH[@]}" \
    "$BASE/api/session/$SID/message?order=asc&limit=200"
}
messages | jq -r '.data[] | select(.type=="assistant") | .content[]? |
  select(.type=="tool") | "\(.name)(\(.state.status))"'
```

## T4.1 简单文本对话

```bash
send_prompt '1+1等于几'
messages | jq -r '.data[] | select(.type=="assistant") | .content[]? |
  select(.type=="text") | .text'
```

**期望**：assistant 文本包含 `2`，assistant 消息的 `finish` 为正常结束状态。

## T4.2 多轮上下文记忆

```bash
send_prompt '记住我叫张三'
send_prompt '我叫什么？'
messages | jq -r '.data[] | select(.type=="assistant") | .content[]? |
  select(.type=="text") | .text' | tail -5
```

**期望**：第二轮回复包含「张三」。两轮必须使用同一个 `SID`。

## T4.3 写文件工具

```bash
send_prompt '在 /workspace 创建 t4-3.txt 内容是 hello'
messages | jq -r '.data[] | select(.type=="assistant") | .content[]? |
  select(.type=="tool") | "\(.name)(\(.state.status))"'

# 使用 session-scoped 沙箱文件接口核验实际文件，不以 assistant 自述作为写入证据。
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" \
  "$BASE/api/session/$SID/fs/read/t4-3.txt"
```

**期望**：工具列表包含 `write(completed)`；文件接口返回内容 `hello`。

## T4.4 读文件工具

```bash
send_prompt '读 /workspace/t4-3.txt'
messages | jq -r '.data[] | select(.type=="assistant") | .content[]? |
  select(.type=="tool") | "\(.name)(\(.state.status))"'
messages | jq -r '.data[] | select(.type=="assistant") | .content[]? |
  select(.type=="tool" and .name=="read") | .state.content[]?.text'
```

**期望**：真实调用 `read(completed)`，工具结果或 assistant 回复包含 `hello`。

## T4.5 Shell 命令执行

```bash
send_prompt '执行 ls /workspace 命令'
messages | jq -r '.data[] | select(.type=="assistant") | .content[]? |
  select(.type=="tool") | "\(.name)(\(.state.status))"'
```

**期望**：调用 `shell(completed)`，shell 输出或回复中包含 `t4-3.txt`。V2 工具名是 `shell`，不再断言 V1 的 `bash` 名称。

## T4.6 异步消息接纳

```bash
curl -sS --noproxy '*' "${CURL_AUTH[@]}" -o /tmp/t4-6-response.json \
  -w 'HTTP %{http_code}\n' -X POST "$BASE/api/session/$SID/prompt" \
  -H 'Content-Type: application/json' \
  -d '{"text":"写一首五言绝句","metadata":{},"delivery":"queue"}'
cat /tmp/t4-6-response.json | jq
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST \
  "$BASE/api/experimental/session/$SID/wait" -H 'Content-Type: application/json' -d '{}'
messages | jq -r '.data[] | select(.type=="assistant") | .content[]? |
  select(.type=="text") | .text' | tail -5
```

**期望**：prompt 接纳请求快速返回 HTTP 200，响应含 `.data.id`；wait 返回 HTTP 204，完成后消息列表中有 assistant 内容。

## T4.7 中断会话

使用独立会话以避免中断前面用例。中断前先确认 session 出现在 `/api/session/active`，不要依赖旧版 `is_busy` 查询参数。

```bash
SID_ABORT=$(curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session" \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"T4 interrupt\",\"location\":{\"directory\":\"/workspace\"},\"model\":$MODEL}" \
  | jq -r '.data.id')

curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$SID_ABORT/prompt" \
  -H 'Content-Type: application/json' \
  -d '{"text":"请开始写一篇一万字的中文文章，不要先给提纲，持续写正文。","metadata":{},"delivery":"queue"}'

# 等待 active map 出现 SID_ABORT 后立即中断。
ACTIVE_SEEN=false
for _ in $(seq 1 100); do
  if curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/active" \
    | jq -e --arg sid "$SID_ABORT" '.data[$sid].type == "running"' >/dev/null; then
    ACTIVE_SEEN=true
    break
  fi
  sleep 0.2
done
[[ "$ACTIVE_SEEN" == true ]] || { echo "session never became active: $SID_ABORT" >&2; exit 1; }
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$SID_ABORT/interrupt" \
  -H 'Content-Type: application/json' -d '{}'
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST \
  "$BASE/api/experimental/session/$SID_ABORT/wait" -H 'Content-Type: application/json' -d '{}'
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/active" | jq --arg sid "$SID_ABORT" '.data[$sid] // null'
```

**期望**：active map 曾包含该会话；interrupt 返回 HTTP 200 且 `interrupted: true`；wait 后该会话不再出现在 active map。中断时如果 assistant 消息尚未落库，历史中没有 assistant 消息也属有效结果。

## 2026-09-23 V2 实测记录

环境：Docker 镜像 `opencode-saas-e2e:session-fs-fix3`（复用已有镜像，未重建）、本地 PG `opencode-v2-up`、远端 OpenSandbox、`Yd-DeepSeek/deepseek-v4-flash`。新建会话目录 `/workspace`。

| 用例 | 结果 | 实际观察 |
|---|---|---|
| T4.1 | ✅ | assistant 回复 `2` |
| T4.2 | ✅ | 第二轮回复包含「张三」 |
| T4.3 | ✅ | `write(completed)`；session fs read 实际读回 `hello` |
| T4.4 | ✅ | `read(completed)`；回复包含 `hello` |
| T4.5 | ✅ | `shell(completed)`；输出列出 `t4-3.txt` |
| T4.6 | ✅ | prompt HTTP 200 且含 message ID；wait HTTP 204；assistant 消息已落库 |
| T4.7 | ✅ | active map 确认运行中；interrupt HTTP 200、`interrupted=true`；wait 后不再 active |

PG 核验：T4.1–T4.6 session 行存在且 `directory=/workspace`；assistant 10 条、user 7 条、idle 7 条；数据库中的真实工具调用为 shell 1、write 1、read 1，状态全部 `completed`；T4.7 中断 session 也存在，两个 session 的 pending 数均为 0。测试 session 与对应 sandbox 已在核验后清理。

## 需要讨论的兼容范围

本轮 T4 功能均由 V2 原生 API 支持，没有功能性阻塞。未提供的是旧版 HTTP endpoint 和 response shape 兼容：若有既有 SaaS 客户端仍依赖 `/session/:id/message`、`prompt_async`、`abort` 或 `parts[]`，需要另行讨论是否加兼容适配层；否则调用方应迁移到本文列出的 V2 路径。
