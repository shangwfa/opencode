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

## T4.8 Code Mode 触发

T4.1–T4.7 **验证不了** code mode：`write`/`read`/`shell` 都是 `codemode: false` 的例外，走 provider 原生工具列表，与 code mode 入口无关。即使 code mode 完全不可用，前面 7 条用例依然全绿。验证必须调用 catalog 内的工具。

内置 `codemode: true` 的工具只有三个：`opencode_models`、`opencode_session_rename`、`opencode_session_move`（见 `packages/core/src/tool/plugin/opencode.ts`）。本用例用只读的 `opencode_models`，不产生副作用。

前置条件：**sandbox 镜像必须含 code mode runner**，否则全部失败：

```bash
# 必须能列出该文件，否则 execute 必然报 "connection closed"
docker run --rm --entrypoint /bin/bash "$OPENCODE_SANDBOX_IMAGE" \
  -lc 'ls -la /opt/opencode-codemode-runner.mjs'
```

```bash
SID_CM=$(curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session" \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"T4 code mode\",\"location\":{\"directory\":\"/workspace\"},\"model\":$MODEL}" \
  | jq -r '.data.id')

curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$SID_CM/prompt" \
  -H 'Content-Type: application/json' \
  -d '{"text":"请使用 code mode 的 execute 工具调用 opencode_models 查询可用模型","metadata":{},"delivery":"queue"}' >/dev/null
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST \
  "$BASE/api/experimental/session/$SID_CM/wait" -H 'Content-Type: application/json' -d '{}'

# 断言 1：出现名为 execute 的工具调用，且状态为 completed
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$SID_CM/message?order=asc&limit=200" \
  | jq -r '.data[] | select(.type=="assistant") | .content[]? |
    select(.type=="tool") | "\(.name)(\(.state.status))"'

# 断言 2：execute 的入参是 JS 代码，且返回真实模型数据（非报错信息）
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$SID_CM/message?order=asc&limit=200" \
  | jq -r '.data[] | select(.type=="assistant") | .content[]? |
    select(.type=="tool" and .name=="execute") |
    "IN: \(.state.input.code)\nOUT: \((.state.content[]?.text) // .state.error.message)"'
```

**期望**：工具列表出现 `execute(completed)`；`IN` 是调用 `tools.opencode.models(...)` 的 JS 代码；`OUT` 是真实 provider/模型结构。

**失败判读**：`execute(error)` 且 `message` 为 `Code Mode Runner connection closed before completion` —— 该报错**指向的不是网络或协议问题**，而是 sandbox 镜像里缺 `/opt/opencode-codemode-runner.mjs`，runner 根本没起来。连 `return 1 + 1` 都失败即可确认这一点（与模型和业务代码无关）。此时按上面第一条命令核对镜像。

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

## 2026-10-25 阿里云后端实测记录

环境：镜像 `opencode-saas:aliyun-proxy-fixed-20261025`（当前工作区构建，含本次 proxy 修复）、独立 PG `opencode-v2-ai-conv-test`、阿里云杭州 + 二代模板 `base-5wa5`、`deepseek/deepseek-flash`，`OPENCODE_CODEMODE_EXECUTOR=sandbox`，HTTP Basic Auth 开启。会话目录 `/workspace`。执行器 `docs/test-cases/scripts/ai-conversation-v2.mjs`：全程订阅公共 SSE、表单自动代答、PG 后检、结束清理并做云端只读核验。**PASS=8 FAIL=0**（T4.1–T4.8）：

| 用例 | 结果 | 实际观察 |
|---|---|---|
| T4.1 | ✅ | 回复 `2`，`finish=stop` |
| T4.2 | ✅ | 第二轮回复「你叫张三。」（同一 SID） |
| T4.3 | ✅ | `write(completed)`；`GET /api/session/:id/fs/read/t4-3.txt` 返回 `hello` |
| T4.4 | ✅ | `read(completed)` |
| T4.5 | ✅ | `shell(completed)`，入参 `{"command":"ls /workspace"}`，输出含 `t4-3.txt` |
| T4.6 | ✅ | prompt HTTP 200 且 **57ms** 返回（含 `msg_*` ID，不等模型）；wait 204；assistant 五言绝句已落库 |
| T4.7 | ✅ | active map `type=running`；interrupt 200 `{"interrupted":true}`；wait 后 active 为 null；assistant 消息 0 条（文档允许） |
| T4.8 | ✅ | `execute(completed)`；入参 `await tools.opencode.models({limit:100})`；返回 14 个 provider 的真实模型数据 |

PG 核验（本轮实测）：3 个会话 `directory=/workspace`、`model={"id":"deepseek-flash","providerID":"deepseek"}`；`session_message` 展开工具调用 `write/read/shell/execute` 各 1 条且全部 `completed`；`session_pending=0`；清理后 `session_v2` 0 行、9 个 sandbox 行全部 `destroyed` 且无云实例残留（按 metadata 只读核验 0 个）。

过程说明（不影响结论）：新专用库默认无 provider 认证，需从已有库导入 `credential` 表后模型路由才可用；消息列表接口 `limit` 契约上限为 200（执行器曾用 400 被契约层拒绝，属脚本问题）。



## 2026-09-29 V2 实测记录

环境：按当前工作区重新构建两个镜像 —— SaaS 服务 `opencode-saas-sandbox-test:9d86bde786-t4`（HEAD `9d86bde786`）、沙箱 `opencode-opensandbox:local`（`7057c941ec64`，含 code mode runner）；本地 PG `opencode-v2-up`（组合 3）、本地 OpenSandbox（Docker runtime）、`Yd-DeepSeek/deepseek-v4-flash`。会话目录 `/workspace`，HTTP Basic Auth 开启。共 21 条断言（含 T4.8），**PASS=21 FAIL=0**。

| 用例 | 结果 | 实际观察 |
|---|---|---|
| T4.1 | ✅ | assistant 回复 `1+1 = 2`；最后一条 assistant `finish=stop` |
| T4.2 | ✅ | 第一轮「记住我叫张三」后，第二轮回复 `你叫张三。`（同一 SID） |
| T4.3 | ✅ | `write(completed)`；`GET /api/session/:id/fs/read/t4-3.txt` 返回 `hello` |
| T4.4 | ✅ | `read(completed)`；工具结果 `Read file /workspace/t4-3.txt, lines 1-1 1: hello` |
| T4.5 | ✅ | `shell(completed)`；shell 输出 `t4-3.txt` + `Command exited with code 0` |
| T4.6 | ✅ | prompt **HTTP 200 且 0.48s 返回**（含 `msg_*` ID，不等模型）；wait HTTP 204；assistant 五言绝句已落库 |
| T4.7 | ✅ | active map 出现 `type=running`；interrupt HTTP 200 `{"interrupted":true}`；wait 后 active 为 `null`；中断会话 assistant 消息 0 条（文档允许） |
| T4.8 | ✅ | `execute(completed)`；入参 `await tools.opencode.models({query:"",limit:100})`；返回真实 provider/模型结构 |

PG 核验（本轮实测，非文档转述）：

- `session_v2` 两行 `directory=/workspace`，`model={"id":"deepseek-v4-flash","providerID":"Yd-DeepSeek"}`。
- T4.1–T4.6 消息分布：assistant=10、user=7、idle=7；T4.7 中断会话 idle=1。
- 工具调用按 assistant 消息 `data.content[]` 展开统计：`read(completed)=1`、`shell(completed)=1`、`write(completed)=1`。
- **工具入参逐条核对**（不采信 assistant 自述）：

  | 工具 | PG 中的 `state.input` |
  |---|---|
  | `write` | `{"path":"/workspace/t4-3.txt","content":"hello"}` |
  | `read` | `{"path":"/workspace/t4-3.txt"}` |
  | `shell` | `{"command":"ls /workspace"}` |

  三条入参与 T4.3/T4.4/T4.5 的意图完全一致，且与 HTTP 层 fs read 返回的 `hello` 互为独立证据。
- `session_pending` 计数为 0；两个会话各绑定 1 个 sandbox（`state=running`），清理后 `session_v2` / `session_message` 中本轮记录归零、sandbox 均 `state=destroyed`。

补充观察（工具与 code mode 的关系）：**Code Mode 默认开启**。`upstream/v2:packages/core/src/tool/AGENTS.md` 的 Registration 章节写明「`codemode` defaults true; `codemode: false` keeps the tool on the provider's native tool list」，`upstream/v2:packages/core/src/tool.ts:232-236` 的实现一致（`codemode !== false` 进 code mode，`=== false` 进 `direct` 原生列表）。

因此 `write`/`read`/`shell`（以及 `edit`/`patch`/`glob`/`grep`/`skill`/`subagent`/`question`/`webfetch`/`websearch`）是**显式声明 `codemode: false` 的例外**，它们留在原生工具列表上；本组用例观察到模型直接发起 `write/read/shell` 调用即属预期，不表示 code mode 被关闭。

全局开关同样是默认开启：`codeModeEnabled = !whollyDisabled("execute", rules)`，而 `whollyDisabled` 仅在命中 `resource="*"` 且 `effect="deny"` 的规则时才为真，默认无此类 deny 规则时 `execute` 工具照常注册。

> 注意区分两个概念：`codemode` 字段决定**单个工具**折叠进 Code Mode 还是留在原生列表（默认 true = 折叠）；`whollyDisabled("execute", ...)` 决定**全局**是否注册 code mode 入口（默认开启）。二者独立。

### Code Mode 触发实测（T4.8）

新旧沙箱镜像的对比结论（**这条差异是 T4.8 存在的原因**）：

| 沙箱镜像 | T4.8 `execute` 结果 | 说明 |
|---|---|---|
| 旧的 `opencode-opensandbox:local`（构建于 runner 改动之前） | ❌ `execute(error)` × 6，全部 `Code Mode Runner connection closed before completion` | 镜像缺 `/opt/opencode-codemode-runner.mjs`，runner 起不来；连 `return 1 + 1` 都失败，证明与模型/业务代码无关 |
| 重建后的 `opencode-opensandbox:local`（`7057c941ec64`） | ✅ `execute(completed)` | 返回真实 provider/模型列表 |

关键点：**旧镜像下 T4.1–T4.7 依然 18/18 全绿** —— code mode 整体失效，这 7 条用例却毫无察觉。这正是补 T4.8 的理由。

模型实际写出的代码形态（两次运行分别产出 `limit: 20` 和 `limit: 100`）：

```js
const result = await tools.opencode.models({ query: "", limit: 100 });
return result;
```

### 踩坑记录

- **sandbox 镜像必须带 `--build-context repo=<repo 根目录>`**。`packages/containers/sandbox/Dockerfile` 的 `codemode-runner` 阶段用 `COPY --from=repo`，但该阶段并不在 Dockerfile 内定义，而是靠 buildx 的命名构建上下文注入。漏掉这个参数时构建会失败或产出缺 runner 的镜像：

  ```bash
  cd packages/containers/sandbox
  docker buildx build --platform linux/arm64 \
    --build-context repo=/Users/ruomu/code/opencode \
    -t opencode-opensandbox:local -f Dockerfile --load .
  ```

  该参数已写在 `packages/containers/sandbox/README.md` 的构建命令里。
- **按内容 hash / commit 命名沙箱镜像，不要复用固定 tag**。本轮 `opencode-opensandbox:local` 固定 tag 复用了 5 天前的旧镜像（缺 runner），导致 code mode 全部失败，而服务本身无任何异常日志。

- `psql` 统计工具调用时若写 `GROUP BY 1`，而 SELECT 表达式里含 `count(*)`，会报 `aggregate functions are not allowed in GROUP BY`；把表达式放进子查询再对子查询列分组才正确。
- bash 中 `"$VAR（中文全角括号…"` 会被当作变量名的一部分而报 `unbound variable`；中文标点前必须写 `${VAR}`。
- **`pgval` 里的 `2>/dev/null` 会把 SQL 错误静默成空输出**，上轮因此把「查询失败」误读成「数据不存在」，白跑一轮 PG 核验。已改为把 stderr 加 `[PG-ERR]` 前缀透出。
- `sandbox` 表的列名是 `id` / `state` / `session_id`，**没有 `sandbox_id` 列**；写错会直接报错而不是返回空。

## 需要讨论的兼容范围

本轮 T4 功能均由 V2 原生 API 支持，没有功能性阻塞。未提供的是旧版 HTTP endpoint 和 response shape 兼容：若有既有 SaaS 客户端仍依赖 `/session/:id/message`、`prompt_async`、`abort` 或 `parts[]`，需要另行讨论是否加兼容适配层；否则调用方应迁移到本文列出的 V2 路径。
