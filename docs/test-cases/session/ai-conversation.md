# AI 对话与工具调用

> 公共测试环境和配置请参考 [`00-preamble.md`](./00-preamble.md)。
>
> **注意**：文档中的 `bun -e "fetch('http://127.0.0.1:4096/...')"` 原使用容器内部端口。本地测试时改用 `http://localhost:14096`（宿主机映射端口）。下方用例已统一为 `$BASE` 变量。

### 通用变量

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"
```

## 四、AI 对话与工具调用

### T4.1 简单文本对话
```bash
curl -s --max-time 30 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"1+1等于几"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}'
```
**期望**：AI 返回包含 `2` 的文本

### T4.2 多轮上下文记忆
```bash
# 第一轮
curl -s --max-time 30 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"记住我叫张三"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}'

# 第二轮
curl -s --max-time 30 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"我叫什么？"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}'
```
**期望**：第二轮回复中含「张三」

### T4.3 写文件工具
```bash
# 发送消息
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"在 /workspace 创建 t4-3.txt 内容是 hello"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}'

# 验证工具调用（POST /message 返回的是文字总结，工具调用在前一条消息中）
curl -s "$BASE/session/$SID/message" | python3 -c "
import json, sys
msgs = json.load(sys.stdin, strict=False)
tools = []
for m in msgs[-3:]:
    for p in m.get('parts', []):
        if p.get('type') == 'tool':
            tools.append(p['tool'] + '(' + p.get('state', {}).get('status', '?') + ')')
print('tools:', tools if tools else '❌ NO TOOLS')
"
```
**期望**：`tools` 包含 `write(completed)` 或 `bash(completed)`；文字总结确认文件已创建

### T4.4 读文件工具
```bash
curl -s --max-time 30 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"读 /workspace/t4-3.txt"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}'
```
**期望**：`tools` 包含 `read(completed)`；回复中含 `hello`

### T4.5 bash 命令执行
```bash
curl -s --max-time 30 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"执行 ls /workspace 命令"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}'
```
**期望**：`tools` 包含 `bash(completed)` 或 `read(completed)`；回复中含文件列表或 `t4-3.txt`

### T4.6 异步消息（不等结果）
```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"写一首五言绝句"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}'
```
**期望**：`status: 204`

### T4.7 中断会话
```bash
# 先异步发送一个长任务
curl -s -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"写一篇1万字的文章"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}'

# 立即中断
sleep 1 && curl -s -X POST "$BASE/session/$SID/abort"
```
**期望**：abort 返回 `true`，session 不再是 `busy`。如果中断前 assistant message 已落库，最后一条消息应为 `finish=abort`、`finish=error` 或类似终止状态；如果在首个 assistant message 落库前中断，历史中可以没有 assistant message。

**2026-07-22 实测**：等待 session 进入 `busy` 后调用 abort，返回 `true`，随后 session 从 busy status 列表移除；本次中断发生在首个 assistant message 落库前，因此没有 `finish` 字段，符合上述早期中断语义。

---
