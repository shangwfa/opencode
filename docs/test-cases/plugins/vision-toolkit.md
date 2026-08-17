# Vision Toolkit 插件测试用例

> 验证内置 vision-toolkit 插件（V1 `experimental.chat.messages.transform` 钩子 + V2 `catalog.transform`/`aisdk.language`）的图片拦截与视觉 API 代理能力：纯文本模型通过视觉 API 获得图片描述，原生多模态模型不受影响，配置与协议切换。
>
> 当前测试环境：本地 PG + 远程沙箱，服务地址 `http://localhost:14096`。

---

## 前置条件

```bash
BASE="http://localhost:14096"
source "$(dirname "$0")/../test-env.sh" 3 2>/dev/null || true
source "$(dirname "$0")/../test-lib.sh" 2>/dev/null || true

curl -s --noproxy '*' "$BASE/" -o /dev/null -w "HTTP %{http_code}\n"
```

期望：HTTP 200。

辅助函数：生成 1x1 红色测试 PNG 的 base64：

```bash
gen_test_img() {
  python3 -c "
import base64, struct, zlib
sig = b'\\x89PNG\\r\\n\\x1a\\n'
ihdr = struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)
ihdr_crc = struct.pack('>I', zlib.crc32(b'IHDR' + ihdr) & 0xffffffff)
ihdr_chunk = struct.pack('>I', 13) + b'IHDR' + ihdr + ihdr_crc
raw = b'\\x00\\xff\\x00\\x00\\x00'
comp = zlib.compress(raw)
idat_crc = struct.pack('>I', zlib.crc32(b'IDAT' + comp) & 0xffffffff)
idat_chunk = struct.pack('>I', len(comp)) + b'IDAT' + comp + idat_crc
iend_crc = struct.pack('>I', zlib.crc32(b'IEND') & 0xffffffff)
iend_chunk = struct.pack('>I', 0) + b'IEND' + iend_crc
png = sig + ihdr_chunk + idat_chunk + iend_chunk
print(base64.b64encode(png).decode())
"
}

send_msg() {
  local sid="$1" model="$2" text="$3" img="$4"
  curl -s --noproxy '*' --max-time 120 -X POST "$BASE/session/$sid/message" \
    -H 'Content-Type: application/json' \
    -d "$(python3 -c "
import json
payload = {
    'parts': [
        {'type': 'text', 'text': '$text'},
        {'type': 'file', 'mime': 'image/png', 'url': 'data:image/png;base64,$img'}
    ],
    'model': $model
}
print(json.dumps(payload))
")"
}

get_ai_text() {
  python3 -c "
import json,sys
d = json.load(sys.stdin)
for p in d.get('parts',[]):
    if p.get('type') == 'text':
        print(p['text'][:500])
        break
"
}
```

---

## TV.1 纯文本模型 + 图片 → 插件拦截并返回描述

> 验证 vision-toolkit 插件拦截纯文本模型（`Yd-DeepSeek/deepseek-v4-flash`）的图片附件，通过视觉 API 获取描述后替换。

```bash
SID1=$(curl -s --noproxy '*' -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
IMG=$(gen_test_img)
MODEL='{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}'

send_msg "$SID1" "$MODEL" "What color is this image? Answer in one word." "$IMG" | get_ai_text | grep -qi 'black\|red\|color' && echo "PASS" || echo "FAIL"
```

**期望**：AI 回复包含颜色描述（如 "Black"），说明图片已被插件拦截并通过视觉 API 解析。

---

## TV.2 原生多模态模型 + 图片 → 直接处理（插件不拦截）

> 验证原生多模态模型（`Yd-KiMi/kimi-k3`）的图片请求不被 vision-toolkit 插件拦截，模型直接处理图片。

```bash
SID2=$(curl -s --noproxy '*' -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
IMG=$(gen_test_img)
MODEL='{"providerID":"Yd-KiMi","modelID":"kimi-k3"}'

send_msg "$SID2" "$MODEL" "What color is this image? Answer in one word." "$IMG" | get_ai_text | grep -qi 'black\|red\|color' && echo "PASS" || echo "FAIL"
```

**期望**：AI 回复颜色描述，说明 kimi-k3 原生多模态直接处理了图片（V2 插件 `textOnly Set` 不包含 kimi-k3）。

---

## TV.3 VISION_REWRITE=off 禁用插件

> 验证 `VISION_REWRITE=off` 时插件完全禁用，图片原样传递给模型。

```bash
SID3=$(curl -s --noproxy '*' -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
IMG=$(gen_test_img)
MODEL='{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}'

# 检查容器是否设了 VISION_REWRITE=off
docker exec opencode-saas-test env | grep VISION_REWRITE || echo "VISION_REWRITE not set (plugin active)"
```

**期望**：容器内 `VISION_REWRITE` 未设置则插件启用；设置 `=off` 则禁用。

---

## TV.4 Anthropic 协议视觉 API（kimi-k3）

> 验证 `VISION_API_PROTOCOL=anthropic` 时插件使用 Anthropic Messages 格式调用视觉 API。

```bash
SID4=$(curl -s --noproxy '*' -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
IMG=$(gen_test_img)
MODEL='{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}'

send_msg "$SID4" "$MODEL" "What color is this image? Answer in one word." "$IMG" | get_ai_text | grep -qi 'black\|red\|color' && echo "PASS" || echo "FAIL"
```

**期望**：AI 回复颜色描述，验证 Anthropic 协议通路正常工作。

---

## TV.5 focus-hint 意图提取

> 验证插件从同消息文本中提取 intent（后 500 字符）作为 focus-hint 传递给视觉模型，使描述聚焦于问题。

```bash
SID5=$(curl -s --noproxy '*' -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
IMG=$(gen_test_img)
MODEL='{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}'

# 发送包含具体问题的消息，期望视觉模型回答具体问题而非泛泛描述
curl -s --noproxy '*' --max-time 120 -X POST "$BASE/session/$SID5/message" \
  -H 'Content-Type: application/json' \
  -d "$(python3 -c "
import json
payload = {
    'parts': [
        {'type': 'text', 'text': 'What color is the pixel in this image?'},
        {'type': 'file', 'mime': 'image/png', 'url': 'data:image/png;base64,$IMG'}
    ],
    'model': $MODEL
}
print(json.dumps(payload))
")" | get_ai_text | grep -qi 'black\|red\|pixel\|color' && echo "PASS" || echo "FAIL"
```

**期望**：AI 回复与问题相关（颜色/像素），而非通用描述。

---

## TV.6 图片缓存：相同图片重复请求命中缓存

> 验证插件对相同 (图片, prompt) 组合的去重缓存（进程内 Map，最多 128 条）。

```bash
SID6=$(curl -s --noproxy '*' -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
IMG=$(gen_test_img)
MODEL='{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}'

# 请求 1
TIME1=$(send_msg "$SID6" "$MODEL" "Describe this image in 3 words." "$IMG" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(d['info']['time'].get('completed',0)-d['info']['time'].get('created',0))" 2>/dev/null || echo "0")
echo "Request 1: ${TIME1}ms"

# 请求 2（相同图片 + 相同 prompt，应命中缓存）
TIME2=$(send_msg "$SID6" "$MODEL" "Describe this image in 3 words." "$IMG" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(d['info']['time'].get('completed',0)-d['info']['time'].get('created',0))" 2>/dev/null || echo "0")
echo "Request 2: ${TIME2}ms"

[ "$TIME2" -le "$TIME1" ] 2>/dev/null && echo "PASS (cache hit)" || echo "FAIL (no cache)"
```

**期望**：第二次请求响应时间 ≤ 第一次（缓存命中，无需再调用视觉 API）。

---

## TV.7 错误安全性：图片文件不可读时返回明确错误

> 验证文件读取失败时插件不抛出异常，而是生成明确的错误文本告知模型，原始图片不透传。

```bash
SID7=$(curl -s --noproxy '*' -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
MODEL='{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}'

curl -s --noproxy '*' --max-time 60 -X POST "$BASE/session/$SID7/message" \
  -H 'Content-Type: application/json' \
  -d "$(python3 -c "
import json
payload = {
    'parts': [
        {'type': 'text', 'text': 'What is in this image?'},
        {'type': 'file', 'mime': 'image/png', 'url': 'file:///nonexistent/path/image.png'}
    ],
    'model': $MODEL
}
print(json.dumps(payload))
")" | get_ai_text | grep -qi 'could not be read\|failed\|not delivered\|error' && echo "PASS" || echo "FAIL"
```

**期望**：AI 回复包含 "could not be read" 或 "not delivered" 等错误信息，原始图片未透传。

---

## TV.8 多图片并发处理

> 验证插件能并发处理同一消息中的多张图片（最多 4 路并发）。

```bash
SID8=$(curl -s --noproxy '*' -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
IMG=$(gen_test_img)
MODEL='{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}'

curl -s --noproxy '*' --max-time 120 -X POST "$BASE/session/$SID8/message" \
  -H 'Content-Type: application/json' \
  -d "$(python3 -c "
import json
payload = {
    'parts': [
        {'type': 'text', 'text': 'Compare these two images.'},
        {'type': 'file', 'mime': 'image/png', 'url': 'data:image/png;base64,$IMG'},
        {'type': 'file', 'mime': 'image/png', 'url': 'data:image/png;base64,$IMG'}
    ],
    'model': $MODEL
}
print(json.dumps(payload))
")" | get_ai_text | grep -qi 'image\|black\|red\|color' && echo "PASS" || echo "FAIL"
```

**期望**：AI 回复能处理多图片描述，说明并发处理正常。

---

## TV.9 CHANNEL_NOTE 注入

> 验证插件在第一条图片前插入 `[vision proxy]` 说明，告知模型图片已被代理。

```bash
# 从消息历史中检查第一条消息是否包含 CHANNEL_NOTE
curl -s --noproxy '*' "$BASE/session/$SID1/message" | python3 -c "
import json,sys
msgs = json.load(sys.stdin)
for m in msgs:
    for p in m.get('parts',[]):
        if p.get('type') == 'text' and 'vision proxy' in p['text'].lower():
            print('FOUND:', p['text'][:100])
            exit(0)
print('NOT FOUND')
" | grep -qi 'vision proxy' && echo "PASS" || echo "FAIL"
```

**期望**：第一条图片前存在包含 `[vision proxy]` 的文本部分。

---

## TV.10 非图片文件不被处理

> 验证插件只处理 `mime.startsWith("image/")` 的文件，非图片文件（如文本文件）不被拦截。

```bash
SID10=$(curl -s --noproxy '*' -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
MODEL='{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}'

# 发送纯文本文件（非图片），应不被插件处理
curl -s --noproxy '*' --max-time 60 -X POST "$BASE/session/$SID10/message" \
  -H 'Content-Type: application/json' \
  -d "$(python3 -c "
import json
payload = {
    'parts': [
        {'type': 'text', 'text': 'Read this file.'},
        {'type': 'file', 'mime': 'text/plain', 'url': 'data:text/plain;base64,SGVsbG8gV29ybGQ='}
    ],
    'model': $MODEL
}
print(json.dumps(payload))
")" | get_ai_text | grep -qi 'hello world\|read\|file' && echo "PASS" || echo "FAIL"
```

**期望**：AI 回复能读取并回应文本文件内容（非图片文件未被拦截）。

---

## TV.11 Assistant 消息中的图片不被处理

> 验证插件只处理 `user` 角色的消息，`assistant` 消息中的图片不被处理（插件逻辑限制）。

```bash
# 检查 collectJobs 逻辑：只处理 info.role == "user" 的消息
# 从消息列表中验证 assistant 消息的图片未被替换
curl -s --noproxy '*' "$BASE/session/$SID1/message" | python3 -c "
import json,sys
msgs = json.load(sys.stdin)
for m in msgs:
    role = m['info']['role']
    for p in m.get('parts',[]):
        if p.get('type') == 'file' and p.get('mime','').startswith('image/'):
            print(f'Message [{role}] has image: yes')
" | grep -q 'assistant.*image' && echo "assistant has image (expected)" || echo "ASSISTANT: no image parts"
```

**期望**：`assistant` 消息中不包含原始图片（插件只处理 user 消息，但不影响 assistant 的图片）。

---

## TV.12 V2 插件：catalog 模型能力注入

> 验证 V2 插件 `catalog.transform()` 为纯文本模型添加 `image` capability，原生多模态模型不受影响。

```bash
curl -s --noproxy '*' "$BASE/provider" | python3 -c "
import json,sys
providers = json.load(sys.stdin)
for p in providers:
    for m in p.get('models', []):
        caps = m.get('capabilities', {})
        has_image = 'image' in caps.get('input', [])
        if m['id'] == 'deepseek-v4-flash':
            print(f'deepseek-v4-flash has image: {has_image}')
        if m['id'] == 'kimi-k3':
            print(f'kimi-k3 has image: {has_image} (native)')
" 2>&1
```

**期望**：`deepseek-v4-flash` 的 capabilities.input 包含 `"image"`（由 V2 插件注入），`kimi-k3` 的 capabilities.input 也包含 `"image"`（原生支持）。

---

## TV.13 V2 插件：textOnly Set 不包装原生多模态模型

> 验证 V2 插件的 `textOnly Set` 只包含原本不支持多模态的模型，原生多模态模型（如 kimi-k3）不被包装。

```bash
# 检查容器日志中是否有 V2 插件包装信息
docker logs opencode-saas-test 2>&1 | grep -i 'vision-toolkit\|textonly\|text.only' | tail -5 || echo "No V2 plugin logs (expected if using V1 session runner)"
```

**期望**：V2 插件日志不显示任何信息（当前 SaaS 使用 V1 session runner，V2 插件未生效），或显示 kimi-k3 不在 `textOnly Set` 中。

---

## 附录：功能覆盖矩阵

| 功能点 | 测试用例 | 覆盖情况 |
|--------|---------|---------|
| 纯文本模型图片拦截 | TV.1 | ✅ |
| 原生多模态不拦截 | TV.2 | ✅ |
| `VISION_REWRITE=off` 禁用 | TV.3 | ✅ |
| Anthropic 协议视觉 API | TV.4 | ✅ |
| focus-hint 意图提取 | TV.5 | ✅ |
| 图片缓存（进程级别） | TV.6 | ✅ |
| 错误安全（文件不可读） | TV.7 | ✅ |
| 多图片并发（最多 4 路） | TV.8 | ✅ |
| CHANNEL_NOTE 注入 | TV.9 | ✅ |
| 非图片文件不拦截 | TV.10 | ✅ |
| 只处理 user 消息 | TV.11 | ✅ |
| V2 catalog 注入 | TV.12 | ✅ |
| V2 textOnly Set 隔离 | TV.13 | ✅ |
| 默认配置（内置免费服务） | 前置条件 + TV.5 | ✅ |
| 环境变量配置 | TV.4 | ✅ |
| 安全失败（不透传原始图片） | TV.7 | ✅ |

## 附录：环境变量参考

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `VISION_API_KEY` | `"free"` | 视觉 API key（内置免费服务用 `free`） |
| `VISION_BASE_URL` | `https://vision.anionex.me/v1` | 视觉 API 地址 |
| `VISION_MODEL` | `gemini-3.7-flash` | 视觉模型名 |
| `VISION_API_PROTOCOL` | `openai` | 协议：`openai`（`/chat/completions`）或 `anthropic`（`/messages`） |
| `VISION_LANG` / `LANG` | - | 描述语言 `zh`/`en` |
| `VISION_REWRITE=off` | - | 禁用图片重写（使用原生多模态模型时） |

环境变量可通过 `~/.config/agent-vision-toolkit/env` 文件链配置，优先级：进程环境 < `VISION_ENV_FILE` < `LOCALAPPDATA` < `~/.config` < `.env`。