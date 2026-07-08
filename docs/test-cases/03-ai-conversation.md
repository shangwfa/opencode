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

> ⚠️ **前提**：SaaS 容器必须设置 `ZHIPU_API_KEY` 环境变量（或通过 `PUT /auth/zhipuai` 配置 credential）。否则所有 AI 调用返回 `UnknownError`。详见 [`local-test-env.md`](../local-test-env.md) §7.4。

## 四、AI 对话与工具调用

### T4.1 简单文本对话
```bash
curl -s --max-time 30 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"1+1等于几"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}'
```
**期望**：AI 返回包含 `2` 的文本

### T4.2 多轮上下文记忆
```bash
# 第一轮
curl -s --max-time 30 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"记住我叫张三"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}'

# 第二轮
curl -s --max-time 30 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"我叫什么？"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}'
```
**期望**：第二轮回复中含「张三」

### T4.3 写文件工具
```bash
# 发送消息
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"在 /workspace 创建 t4-3.txt 内容是 hello"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}'

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
  -d '{"parts":[{"type":"text","text":"读 /workspace/t4-3.txt"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}'
```
**期望**：`tools` 包含 `read(completed)`；回复中含 `hello`

### T4.5 bash 命令执行
```bash
curl -s --max-time 30 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"执行 ls /workspace 命令"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}'
```
**期望**：`tools` 包含 `bash(completed)` 或 `read(completed)`；回复中含文件列表或 `t4-3.txt`

### T4.6 异步消息（不等结果）
```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"写一首五言绝句"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}'
```
**期望**：`status: 204`

### T4.7 中断会话
```bash
# 先异步发送一个长任务
curl -s -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"写一篇1万字的文章"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}'

# 立即中断
sleep 1 && curl -s -X POST "$BASE/session/$SID/abort"
```
**期望**：abort 返回 `true`，最后一条消息 `finish=abort` 或类似

---

