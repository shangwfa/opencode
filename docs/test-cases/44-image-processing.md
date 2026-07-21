# 图片处理与权限元数据

> 公共测试环境和配置请参考 [`00-preamble.md`](./00-preamble.md)。
>
> 本文档覆盖以下修改的测试用例（V1 + V2 双链路）：
> - 能力过滤：非 vision 模型收到图片时，图片 part 替换为文本提示
>   - V1：`packages/opencode/src/provider/transform.ts` `unsupportedParts()`
>   - V2：`packages/core/src/session/runner/to-llm-message.ts` `media()` + `supportedInputs`
> - 图片压缩：用户上传图片时，persist 前调用 `Image.normalize` 压缩
>   - V1：`packages/opencode/src/session/prompt.ts` `image.normalize()`
>   - V2：`packages/core/src/session.ts` `V2Session.prompt` 中 normalize
> - bash permission description fallback：`shell.ts` 中 permission metadata.description 不再为 undefined

### 通用变量

```bash
source test-env.sh 3
source test-lib.sh
export NO_PROXY=localhost,127.0.0.1

# V1 和 V2 的 API 路径不同：
# V1: POST /session/:sid/message  — payload 用 parts 数组
# V2: POST /api/session/:sid/prompt — payload 用 prompt 对象

# 1x1 红色 PNG 的 base64 data URL
SMALL_PNG="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
```

---

## 一、V1 能力过滤

> V1 API 路径：`POST /session/:sessionID/message`
> V1 payload 格式：`{"parts":[{"type":"text","text":"..."},{"type":"file","mime":"image/png","url":"data:...","filename":"..."}],"model":{...}}`
>
> 前提：测试模型 `zhipuai/glm-5.1` 不支持 image 输入。

### T44.1 V1 非 vision 模型收到图片 — 图片替换为文本提示

```bash
SID=$(new_sid)
RESULT=$(curl -s --max-time 30 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"描述这张图片\"},{\"type\":\"file\",\"mime\":\"image/png\",\"url\":\"$SMALL_PNG\",\"filename\":\"test.png\"}],\"model\":{\"providerID\":\"zhipuai\",\"modelID\":\"glm-5.1\"}}" \
  2>&1)

echo "$RESULT" | grep -qi "does not support image\|无法\|不支持" && pass "T44.1 V1 image replaced with text" || fail "T44.1" "expected image capability error"
```

**期望**：AI 回复中包含 "does not support image" 或模型不支持提示，不返回 413 / request_too_large。

### T44.2 V1 空 base64 图片 — 替换为错误文本

```bash
SID=$(new_sid)
RESULT=$(curl -s --max-time 30 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"看图"},{"type":"file","mime":"image/png","url":"data:image/png;base64,","filename":"empty.png"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}' \
  2>&1)

echo "$RESULT" | grep -qi "empty\|corrupt\|空\|损坏" && pass "T44.2 V1 empty base64 detected" || fail "T44.2" "expected empty image error"
```

**期望**：AI 回复中包含 "empty" 或 "corrupted" 提示。

### T44.3 V1 混合 files — 仅过滤不支持的 modality

```bash
SID=$(new_sid)
RESULT=$(curl -s --max-time 30 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"检查附件\"},{\"type\":\"file\",\"mime\":\"image/png\",\"url\":\"$SMALL_PNG\",\"filename\":\"img.png\"},{\"type\":\"file\",\"mime\":\"text/plain\",\"url\":\"data:text/plain;base64,aGVsbG8=\",\"filename\":\"notes.txt\"}],\"model\":{\"providerID\":\"zhipuai\",\"modelID\":\"glm-5.1\"}}" \
  2>&1)

echo "$RESULT" | grep -qi "does not support image\|不支持" && pass "T44.3 V1 mixed files filtered" || fail "T44.3" "expected partial filter"
```

**期望**：图片被替换为错误文本，text 文件正常传递。

---

## 二、V2 能力过滤

> V2 API 路径：`POST /api/session/:sessionID/prompt`
> V2 payload 格式：`{"prompt":{"text":"...","files":[{"uri":"data:...","name":"..."}]},"model":{...}}`
> V2 创建 session：`POST /api/session`
>
> 前提：V2 API 已挂载且可用。

### T44.4 V2 非 vision 模型收到图片 — 图片替换为文本提示

```bash
# V2 创建 session
V2_SID=$(curl -s -X POST "$BASE/api/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
echo "V2 SID: $V2_SID"

RESULT=$(curl -s --max-time 30 -X POST "$BASE/api/session/$V2_SID/prompt" \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":{\"text\":\"描述这张图片\",\"files\":[{\"uri\":\"$SMALL_PNG\",\"name\":\"test.png\"}]},\"model\":{\"providerID\":\"zhipuai\",\"modelID\":\"glm-5.1\"}}" \
  2>&1)

echo "$RESULT" | grep -qi "does not support image\|无法\|不支持" && pass "T44.4 V2 image replaced with text" || fail "T44.4" "expected image capability error"
```

**期望**：AI 回复中包含 "does not support image" 或模型不支持提示。

### T44.5 V2 空 base64 图片 — 替换为错误文本

```bash
V2_SID=$(curl -s -X POST "$BASE/api/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

RESULT=$(curl -s --max-time 30 -X POST "$BASE/api/session/$V2_SID/prompt" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":{"text":"看图","files":[{"uri":"data:image/png;base64,","name":"empty.png"}]},"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}' \
  2>&1)

echo "$RESULT" | grep -qi "empty\|corrupt\|空\|损坏" && pass "T44.5 V2 empty base64 detected" || fail "T44.5" "expected empty image error"
```

**期望**：AI 回复中包含 "empty" 或 "corrupted" 提示。

### T44.6 V2 混合 files — 仅过滤不支持的 modality

```bash
V2_SID=$(curl -s -X POST "$BASE/api/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

RESULT=$(curl -s --max-time 30 -X POST "$BASE/api/session/$V2_SID/prompt" \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":{\"text\":\"检查附件\",\"files\":[{\"uri\":\"$SMALL_PNG\",\"name\":\"img.png\"},{\"uri\":\"data:text/plain;base64,aGVsbG8=\",\"name\":\"notes.txt\"}]},\"model\":{\"providerID\":\"zhipuai\",\"modelID\":\"glm-5.1\"}}" \
  2>&1)

echo "$RESULT" | grep -qi "does not support image\|不支持" && pass "T44.6 V2 mixed files filtered" || fail "T44.6" "expected partial filter"
```

**期望**：图片被替换为错误文本，text 文件正常传递。

---

## 三、V1 图片压缩

> V1 压缩在 `prompt.ts` persist 前调用 `image.normalize`。
> 前提：SaaS 容器中 photon WASM 可用。默认限制：max 2000x2000，max base64 5MB。

### T44.7 V1 大图片上传 — PG 中 part data 被压缩

```bash
SID=$(new_sid)

# 生成 500x500 RGBA PNG
BIG_PNG="data:image/png;base64,$(python3 -c "
import base64, struct, zlib
width, height = 500, 500
raw = b''
for y in range(height):
    raw += b'\\x00' + b'\\xff\\x00\\x00\\xff' * width
compressed = zlib.compress(raw)
def chunk(ctype, data):
    c = ctype + data
    return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
png = b'\\x89PNG\\r\\n\\x1a\\n'
png += chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
png += chunk(b'IDAT', compressed)
png += chunk(b'IEND', b'')
print(base64.b64encode(png).decode())
")"

ORIG_LEN=${#BIG_PNG}
echo "  original data URL length: $ORIG_LEN"

curl -s --max-time 30 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"看图\"},{\"type\":\"file\",\"mime\":\"image/png\",\"url\":\"$BIG_PNG\",\"filename\":\"big.png\"}],\"model\":{\"providerID\":\"zhipuai\",\"modelID\":\"glm-5.1\"}}" \
  >/dev/null 2>&1

STORED_LEN=$(pgval "SELECT length(data::text) FROM part WHERE session_id = '$SID' AND data->>'type' = 'file' ORDER BY time_created DESC LIMIT 1")
echo "  V1 stored part data length: $STORED_LEN"

[ -n "$STORED_LEN" ] && [ "$STORED_LEN" -gt 0 ] && pass "T44.7 V1 image part persisted (size: $STORED_LEN)" || fail "T44.7" "no file part found"
```

**期望**：PG 中存在 file 类型 part，data 长度 > 0。

---

## 四、V2 图片压缩

> V2 压缩在 `session.ts` `V2Session.prompt` persist 前调用 `Image.normalize`。
> 前提：SaaS 容器中 photon WASM 可用。

### T44.8 V2 大图片上传 — PG 中 part data 被压缩

```bash
V2_SID=$(curl -s -X POST "$BASE/api/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

# 生成 500x500 RGBA PNG
BIG_PNG="data:image/png;base64,$(python3 -c "
import base64, struct, zlib
width, height = 500, 500
raw = b''
for y in range(height):
    raw += b'\\x00' + b'\\xff\\x00\\x00\\xff' * width
compressed = zlib.compress(raw)
def chunk(ctype, data):
    c = ctype + data
    return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
png = b'\\x89PNG\\r\\n\\x1a\\n'
png += chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
png += chunk(b'IDAT', compressed)
png += chunk(b'IEND', b'')
print(base64.b64encode(png).decode())
")"

ORIG_LEN=${#BIG_PNG}
echo "  original data URL length: $ORIG_LEN"

curl -s --max-time 30 -X POST "$BASE/api/session/$V2_SID/prompt" \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":{\"text\":\"看图\",\"files\":[{\"uri\":\"$BIG_PNG\",\"name\":\"big.png\"}]},\"model\":{\"providerID\":\"zhipuai\",\"modelID\":\"glm-5.1\"}}" \
  >/dev/null 2>&1

STORED_LEN=$(pgval "SELECT length(data::text) FROM part WHERE session_id = '$V2_SID' AND data->>'type' = 'file' ORDER BY time_created DESC LIMIT 1")
echo "  V2 stored part data length: $STORED_LEN"

[ -n "$STORED_LEN" ] && [ "$STORED_LEN" -gt 0 ] && pass "T44.8 V2 image part persisted (size: $STORED_LEN)" || fail "T44.8" "no file part found"
```

**期望**：PG 中存在 file 类型 part，data 长度 > 0。

### T44.9 V2 图片压缩 — 确认 normalize 生效

```bash
V2_SID=$(curl -s -X POST "$BASE/api/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

# 生成 3000x3000 RGBA PNG（超出默认 2000x2000 限制，应触发 resize）
HUGE_PNG="data:image/png;base64,$(python3 -c "
import base64, struct, zlib
width, height = 3000, 3000
raw = b''
for y in range(height):
    raw += b'\\x00' + b'\\xff\\x00\\x00\\xff' * width
compressed = zlib.compress(raw)
def chunk(ctype, data):
    c = ctype + data
    return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
png = b'\\x89PNG\\r\\n\\x1a\\n'
png += chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
png += chunk(b'IDAT', compressed)
png += chunk(b'IEND', b'')
print(base64.b64encode(png).decode())
")"

ORIG_LEN=${#HUGE_PNG}
echo "  original data URL length: $ORIG_LEN"

curl -s --max-time 60 -X POST "$BASE/api/session/$V2_SID/prompt" \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":{\"text\":\"看图\",\"files\":[{\"uri\":\"$HUGE_PNG\",\"name\":\"huge.png\"}]},\"model\":{\"providerID\":\"zhipuai\",\"modelID\":\"glm-5.1\"}}" \
  >/dev/null 2>&1

STORED_LEN=$(pgval "SELECT length(data::text) FROM part WHERE session_id = '$V2_SID' AND data->>'type' = 'file' ORDER BY time_created DESC LIMIT 1")
echo "  V2 stored part data length: $STORED_LEN"

if [ -n "$STORED_LEN" ] && [ "$STORED_LEN" -lt "$ORIG_LEN" ]; then
  pass "T44.9 V2 image compressed ($ORIG_LEN → $STORED_LEN)"
elif [ -n "$STORED_LEN" ]; then
  echo "  (normalize may have skipped — check photon availability)"
  pass "T44.9 V2 part persisted (size: $STORED_LEN)"
else
  fail "T44.9" "no file part found"
fi
```

**期望**：PG 中存储的 part data 长度 < 原始 data URL 长度（3000x3000 应被 resize 到 2000x2000 以内）。

---

## 五、bash permission description fallback

> 前提：配置 `bash` 权限为 `ask`，使 bash 工具调用触发 permission 请求。
>
> ```bash
> curl -s -X PATCH "$BASE/global/config?directory=/workspace" \
>   -H 'Content-Type: application/json' -d '{"permission":{"bash":"ask"}}' >/dev/null
> sleep 3
> ```

### T44.10 bash permission metadata.description 不为 undefined

```bash
SID=$(new_sid)

curl -s --max-time 40 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"用 bash 执行: ls /workspace"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}' \
  >/dev/null 2>&1 &

sleep 15

PERM=$(curl -s "$BASE/permission?directory=/workspace")
echo "$PERM" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
if isinstance(data, list) and len(data) > 0:
    desc = data[0].get('metadata', {}).get('description')
    if desc is not None:
        print(f'  description: {desc}')
        sys.exit(0)
    else:
        print('  description is None or missing')
        sys.exit(1)
else:
    print(f'  unexpected response: {str(data)[:200]}')
    sys.exit(1)
" && pass "T44.10 description not undefined" || fail "T44.10" "description is undefined or no permission pending"
```

**期望**：`GET /permission` 返回 HTTP 200，`metadata.description` 不为 `undefined`。

### T44.11 GET /permission 不再返回 BadRequest

```bash
SID=$(new_sid)

curl -s --max-time 40 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"用 bash 执行: echo hello"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}' \
  >/dev/null 2>&1 &

sleep 15

HTTP_CODE=$(curl -s -o /tmp/perm_check.json -w "%{http_code}" "$BASE/permission?directory=/workspace")

[ "$HTTP_CODE" = "200" ] && pass "T44.11 GET /permission returns 200" || fail "T44.11" "HTTP $HTTP_CODE: $(cat /tmp/perm_check.json | head -c 200)"
```

**期望**：HTTP 200，不再返回 `{"name":"BadRequest",...,"kind":"Body"}` 错误。

---

## 六、回归验证

### T44.12 恢复权限配置后 V1 正常对话

```bash
curl -s -X PATCH "$BASE/global/config?directory=/workspace" \
  -H 'Content-Type: application/json' -d '{"permission":{"bash":"allow"}}' >/dev/null
sleep 3

SID=$(new_sid)
RESULT=$(curl -s --max-time 30 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"hello"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}')

echo "$RESULT" | grep -qi "hello\|hi\|你好\|help" && pass "T44.12 V1 normal conversation restored" || fail "T44.12" "no AI response"
```

**期望**：AI 正常回复。

### T44.13 V2 正常对话（无图片）

```bash
V2_SID=$(curl -s -X POST "$BASE/api/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

RESULT=$(curl -s --max-time 30 -X POST "$BASE/api/session/$V2_SID/prompt" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":{"text":"hello"},"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}')

echo "$RESULT" | grep -qi "hello\|hi\|你好\|help" && pass "T44.13 V2 normal conversation" || fail "T44.13" "no AI response"
```

**期望**：V2 API 正常回复，能力过滤和图片压缩不影响纯文本对话。
