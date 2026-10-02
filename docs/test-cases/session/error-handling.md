# 错误处理

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-preamble.md`](./00-preamble.md)。

## ⚠️ V1 路径已失效（2026-09-29）

原文档使用 V1 路径（`/session/:id/message`）。**V2 无兼容层**，且 V1 请求会命中 **SPA fallback 返回 HTML 200** —— 判定端点存在必须看 `content-type`，只看状态码会被骗过。

V1 → V2 映射：

| V1 | V2 |
|---|---|
| `POST /session` | `POST /api/session`（全部字段可选） |
| `POST /session/:id/message`（同步返回 AI 回复） | `POST /api/session/:id/prompt`（**仅异步接纳**），结果从 `GET /api/session/:id/message` 读 |

## 公共环境

```bash
export BASE="${BASE:-http://localhost:14096}"
export PG_URL="${PG_URL:-postgresql://local@127.0.0.1:5432/opencode-v2-up}"
export MODEL='{"id":"deepseek-v4-flash","providerID":"Yd-DeepSeek"}'
CURL_AUTH=(-u "opencode:${OPENCODE_PASSWORD}")
api(){ curl -sS --noproxy '*' "${CURL_AUTH[@]}" "$@"; }
pgval(){ psql "$PG_URL" -t -A -c "$1"; }
```

---

## 七、错误处理

### T7.1 未配置的 provider

⚠️ **V2 行为与 V1 根本不同**：`POST /api/session` **不校验 model**。带一个不存在的 provider 建会话会正常返回 **HTTP 200**，错误要到发 prompt 时才暴露。

```bash
SID=$(api -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
  -d '{"title":"T7.1","location":{"directory":"/workspace"},"model":{"id":"fake","providerID":"not-exist"}}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])")
echo "建会话: $SID  (V2 期望 200，不是 500)"

# 错误在 prompt 阶段暴露，且**不阻塞 HTTP 响应** —— prompt 依然返回 200 并被接纳
api -X POST "$BASE/api/session/$SID/prompt" -H 'Content-Type: application/json' \
  -d '{"text":"hi","metadata":{},"delivery":"queue"}'

# 关键：会话必须收敛，不能卡死
curl -s --noproxy '*' "${CURL_AUTH[@]}" -o /dev/null -w 'wait HTTP %{http_code}\n' \
  -X POST "$BASE/api/experimental/session/$SID/wait" -H 'Content-Type: application/json' -d '{}'

pgval "SELECT type||'='||count(*) FROM session_message WHERE session_id='$SID' GROUP BY type"
```

**期望**：建会话 **HTTP 200**；prompt 被接纳后 wait 返回 **204**（会话收敛，未卡死）；PG 中只有 `user` 和 `idle` 消息，**没有 assistant 消息** —— 说明模型调用失败且没有产生任何输出。

> **与 V1 的关键差异**：V1 在 `/message` 上直接返回 500 `UnknownError`；V2 的 prompt 是异步接纳接口，HTTP 层看不到错误，错误只体现在「没有 assistant 消息」上。
>
> **V1 文档提到的缺陷仍然存在**：错误详情（`ProviderModelNotFoundError` 的 suggestions 等）未保留到任何可观测位置。V2 虽不再返回 500，但**错误原因同样丢失**，前端仍无法做「Model not found: x/y, did you mean…」提示。

### T7.2 不存在的 session 发消息

```bash
api -o /tmp/o -w 'HTTP %{http_code}\n' -X POST "$BASE/api/session/ses_NOTEXIST/prompt" \
  -H 'Content-Type: application/json' -d '{"text":"hi","metadata":{},"delivery":"queue"}'
cat /tmp/o
```

**期望**：**404**，响应体为结构化错误：

```json
{"_tag":"SessionNotFoundError","sessionID":"ses_NOTEXIST","message":"Session not found: ses_NOTEXIST"}
```

> V2 明显优于 V1：返回**带 `_tag` 的结构化错误体**，不再是无法解析的 `UnknownError`。

### T7.3 无效 JSON 请求体

```bash
api -o /tmp/o -w 'HTTP %{http_code}\n' -X POST "$BASE/api/session" \
  -H 'Content-Type: application/json' -d 'not-json'
cat /tmp/o
```

**期望**：**400**

```json
{"_tag":"InvalidRequestError","message":"Expected a valid JSON body","kind":"Payload"}
```

### T7.4 缺失必填字段

⚠️ `POST /api/session` **没有必填字段**，空 body `{}` 返回 200（这是预期，不是缺陷）。真正缺必填字段的场景在 prompt 上：

```bash
api -o /tmp/o -w 'HTTP %{http_code}\n' -X POST "$BASE/api/session/$SID/prompt" \
  -H 'Content-Type: application/json' -d '{"metadata":{},"delivery":"queue"}'
cat /tmp/o
```

**期望**：**400**（缺 `text`）。

> V1 期望 500 `UnknownError`，V2 修正为 400 —— 客户端错误用 4xx 才是正确语义。

### T7.5 超长消息

```bash
SID=$(api -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
  -d "{\"title\":\"T7.5\",\"location\":{\"directory\":\"/workspace\"},\"model\":$MODEL}" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])")

python3 -c "import json;print(json.dumps({'text':'x'*100000,'metadata':{},'delivery':'queue'}))" > /tmp/big.json
api --max-time 60 -o /tmp/o -w 'HTTP %{http_code} 耗时 %{time_total}s\n' \
  -X POST "$BASE/api/session/$SID/prompt" -H 'Content-Type: application/json' --data-binary @/tmp/big.json
```

**期望**：返回明确状态码（实测 **200**，被正常接纳），**不 hang**。100 KB payload 耗时 < 1s。

### T7.6 assistant finish 正常结束

```bash
SID=$(api -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
  -d "{\"title\":\"T7.6\",\"location\":{\"directory\":\"/workspace\"},\"model\":$MODEL}" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])")
api -X POST "$BASE/api/session/$SID/prompt" -H 'Content-Type: application/json' \
  -d '{"text":"回复OK即可","metadata":{},"delivery":"queue"}' >/dev/null
curl -s --noproxy '*' "${CURL_AUTH[@]}" -o /dev/null -X POST \
  "$BASE/api/experimental/session/$SID/wait" -H 'Content-Type: application/json' -d '{}'

pgval "SELECT data::jsonb->>'finish' FROM session_message WHERE session_id='$SID' AND type='assistant' ORDER BY seq DESC LIMIT 1"
```

**期望**：finish 为 `stop` / `tool-calls` / `length` 之一，**不应为 `unknown`**（`unknown` 意味着被截断）。

> 注意 V2 的 PG 表是 `session_message`，角色判断用 `type` 列而非 V1 的 `data->>'role'`。

### T7.7 / T7.8 retry 链路

> ⚠️ **原文档引用的单测路径在 V2 中不存在**。文档写的是 `packages/opencode/test/session/retry.test.ts`，该文件已不存在。
>
> V2 的 retry 实现在 `packages/util/src/retry.ts`，单测在 `packages/util/src/retry.test.ts`（5 个用例），**不覆盖 `network_error` finish reason**（那是模型侧 `finish_reason`，与 HTTP 传输层的 retry 不是同一层）。

```bash
cd packages/util && bun test src/retry.test.ts
```

**当前状态：5 pass / 0 fail**（2026-09-29 已修复，见下方实测记录）。

---

## 2026-09-29 V2 实测记录

环境：SaaS `opencode-saas-sandbox-test:9d86bde786-t4`、沙箱 `opencode-opensandbox:local`（`7057c941ec64`）、本地 PG + 本地 OpenSandbox、Bun 1.3.14。**8 条断言 PASS，0 FAIL。**

| 用例 | 结果 | 实际观察 |
|---|---|---|
| T7.1 | ✅ | 带非法 provider 建会话 **HTTP 200**（V2 不校验）；prompt 被接纳后 **wait 204** 收敛；PG 只有 `user`+`idle`，**无 assistant** |
| T7.2 | ✅ | **404** + 结构化 `{"_tag":"SessionNotFoundError",...}` |
| T7.3 | ✅ | **400** + `{"_tag":"InvalidRequestError","message":"Expected a valid JSON body"}` |
| T7.4 | ✅ | prompt 缺 `text` → **400**（`{}` 建会话 200 属预期） |
| T7.5 | ✅ | 100 KB payload → **HTTP 200，耗时 0s**，未 hang |
| T7.6 | ✅ | assistant `finish=stop` |
| T7.7/T7.8 | ✅ | `packages/util/src/retry.test.ts` **5 pass / 0 fail**（本轮修复后）；全量 util 测试 49 pass / 0 fail |

### V2 相比 V1 的四处语义修正

| 用例 | V1 行为 | V2 实测 |
|---|---|---|
| T7.1 | `/message` 返回 **500 UnknownError** | 建会话 **200**，错误在 prompt 后体现为「无 assistant 消息」；会话正常收敛不卡死 |
| T7.2 | 404（错误体不可解析） | 404 + **结构化 `_tag` 错误体** |
| T7.4 | **500 UnknownError** | **400 InvalidRequestError** —— 客户端错误用 4xx 才是正确语义 |
| T7.7/8 | 引用 `packages/opencode/test/session/retry.test.ts` | 该文件已不存在；V2 改在 `packages/util/src/retry.test.ts` |

### ⚠️ 发现并修复：retry 单测断言绑死了运行时错误类

**发现时的状态**：

```
cd packages/util && bun test src/retry.test.ts
→ 4 pass / 1 fail
(fail) client retry > retries a real network failure wrapped as the cause of a transport error
     at retry.test.ts:47  expect(failures.every(c => c instanceof TypeError)).toBe(true)
```

**根因**：断言写死了 `instanceof TypeError`，但 Bun 1.3.14 对连接重置抛的是：

```
Error: The socket connection was closed unexpectedly.  code: ECONNRESET
instanceof TypeError: false
```

**产品代码本身是对的** —— `retry.ts` 的 `isTransientError` 会沿 `cause` 链读取 `code` 字段，`transientMessages` 里就有 `econnreset`，所以重试 3 次成功（`toHaveLength(3)` 断言通过，失败发生在下一行的类型断言）。

源码注释也明确写了这个设计意图：

> Generated clients wrap fetch failures as ClientError("Transport", { cause }) and Bun/Node put the network detail in `code`, so the transient signal may sit anywhere along the cause chain.

**修复（只改测试，不动产品）**：把断言从「必须是某个错误类」改成「必须携带可识别的瞬态信号」，与 `isTransientError` 实际匹配的依据对齐：

```ts
// 修复前
expect(failures.every((cause) => cause instanceof TypeError)).toBe(true)

// 修复后
for (const cause of failures) expect(carriesTransientSignal(cause)).toBe(true)
```

`carriesTransientSignal` 同时接受 `TypeError` 与 `code`/消息中的网络标识，跨运行时成立。

**验证修复有效 —— 变异测试**（光变绿不算数，必须证明新断言还能抓问题）：

| 变异体 | 结果 |
|---|---|
| 从 `transientMessages` 删除 `econnreset`/`etimedout` | ✅ 该用例 FAIL |
| `isTransientError` 不再递归 `cause` 链 | ✅ 该用例 FAIL |
| `attempts` 默认改为 1（不重试） | ✅ 2 个用例 FAIL |

三个变异体全部被捕获，`retry.ts` 已还原（`git diff` 为空）。

**修复后结果**：

```
bun test src/retry.test.ts   → 5 pass / 0 fail（连跑 3 次稳定）
bun test（util 全量）         → 49 pass / 0 fail
bunx tsc --noEmit            → 通过
```

改动仅限 `packages/util/src/retry.test.ts` 一个文件。

### 遗留缺陷（V1 时期记录，V2 仍存在）

T7.1 提到的「原始 error 未保留」问题在 V2 依然存在：模型解析失败时，`ProviderModelNotFoundError` 的 suggestions 等详情**没有任何可观测出口**。V2 虽然不再返回误导性的 500，但错误原因同样丢失，前端无法做友好提示。影响面比 V1 更大 —— V1 至少能从 500 响应知道「出错了」，V2 只能通过「没有 assistant 消息」间接推断。

**清理**：本轮 10 个会话已删除，逐个确认 HTTP 204，直接 `count` 复查为 0。

### 写测试脚本时反复踩的两个坑

1. **bash 里 `$VAR` 紧跟全角标点会被当成变量名的一部分**

   ```bash
   echo "状态码 $C（未 hang）"     # ❌ unbound variable
   echo "状态码 ${C}（未 hang）"   # ✅
   ```

   bash 的变量名可含多字节字符，`（`（U+FF08）被算进名字里。本轮和 T4 那轮各踩一次 —— 中文文案里**一律写 `${VAR}`**。

2. **zsh 下 `for s in $SIDS` 只迭代一次**（清理会话时必踩）

   详见 [e2e.md 的「清理陷阱」](./e2e.md#️-清理陷阱zsh-下-for-s-in-sids-只迭代一次)。核心：清理用 `while IFS= read -r`，验证用直接 `count`，绝不拼 `IN` 列表。

---

## 历史记录（V1 时期，保留备查）

> 复测记录（2026-09-06，merge upstream/dev v1.18.29 后，镜像 `t0906-merged-1.18.29`）：T7.1（500 UnknownError）/T7.2（404）/T7.3（400）/T7.4（500）/T7.5（超长 200 截断）全部符合期望 ✅。T7.6-T7.8（finish/retry 变体）由单测 `test/session/retry.test.ts`（60 用例 0 fail）覆盖。
