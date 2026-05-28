# 工具调用过程批量验证

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-INDEX.md`](./00-INDEX.md)。

## 十八、工具调用过程批量验证

> 本节专门验证 AI 工具调用的**过程**而非仅最终结果，确保 `POST /message` 返回的文字总结背后确实执行了工具。

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"
```

### T18.1 批量验证 7 种工具调用场景

```bash
# 通用发送+验证函数
send_and_verify() {
  local sid=$1 prompt=$2 label=$3
  echo ""
  echo "=== $label ==="
  curl -s --max-time 120 -X POST "$BASE/session/$sid/message" \
    -H 'Content-Type: application/json' \
    -d "{\"parts\":[{\"type\":\"text\",\"text\":\"$prompt\"}],\"model\":$MODEL}" > /dev/null 2>&1

  curl -s "$BASE/session/$sid/message" | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
recent = msgs[-3:] if len(msgs) >= 3 else msgs
tools, texts = [], []
for m in recent:
    for p in m.get('parts', []):
        if p.get('type') == 'tool':
            t = p.get('tool', '?')
            s = p.get('state', {})
            status = s.get('status', '?')
            tools.append(f'{t}({status})')
        elif p.get('type') == 'text':
            texts.append(p.get('text', '')[:80])
print(f'  工具: {\"✅ \" + str(tools) if tools else \"❌ 无工具调用\"}')
print(f'  回复: {texts[-1] if texts else \"(空)\"}')
"
}

send_and_verify "$SID" "用 bash 执行: echo hello"                   "T18.1a: bash 命令"
send_and_verify "$SID" "在 /workspace 创建 test.txt 内容是 hello"     "T18.1b: write 写文件"
send_and_verify "$SID" "读取 /workspace/test.txt 的内容"              "T18.1c: read 读文件"
send_and_verify "$SID" "列出 /workspace 下所有文件"                   "T18.1d: 模糊指令"
send_and_verify "$SID" "在 /workspace 下创建三个文件：a.txt 内容 AAA，b.txt 内容 BBB，c.txt 内容 CCC" "T18.1e: 批量写"
send_and_verify "$SID" "把 /workspace/test.txt 的内容改为 modified"   "T18.1f: 修改文件"
send_and_verify "$SID" "用 bash 工具执行，background 必须设为 true: sleep 1 && echo bg-done" "T18.1g: background bash"
```
**期望**：全部显示 `✅`，每个场景都有对应的工具调用（bash/write/read/edit）

### T18.2 验证完整消息流结构

```bash
echo "=== 完整消息列表 ==="
curl -s "$BASE/session/$SID/message" | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
for i, m in enumerate(msgs):
    parts = m.get('parts', [])
    types = [p.get('type', '?') for p in parts]
    tools = [p.get('tool', '') for p in parts if p.get('type') == 'tool']
    text = [p.get('text', '')[:50] for p in parts if p.get('type') == 'text']
    marker = '🔧' if tools else '💬'
    print(f'  {marker} [{i:2d}] tools={tools or \"-\"} text={text[:1] or \"-\"}')
"
```
**期望**：消息交替出现 `💬`（用户 prompt / AI 文字总结）和 `🔧`（工具调用），结构为：`💬 prompt → 🔧 tool call → 💬 summary`

---

