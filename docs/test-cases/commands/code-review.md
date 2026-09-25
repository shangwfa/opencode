# Code Review 命令测试

> 验证 `/review`（自由文本风格）和 `/codex-review`（Codex 结构化风格）两种代码审查命令的可用性、输出质量差异。

---

## 一、测试目标

| 维度 | `/review` | `/codex-review` |
|------|-----------|-----------------|
| 输出格式 | 自由文本 | 结构化 JSON（findings + verdict） |
| 优先级 | 无 | P0-P3 四级 |
| 置信度 | 无 | 每条 + 总体 confidence (0-1) |
| 合并裁决 | 无 | correct / incorrect |
| 代码定位 | 文本描述 | file + line_start/end |
| Bug 判定标准 | 4 条泛泛规则 | 8 条严格标准 |

---

## 二、前置条件

- SaaS 容器正常运行（`http://localhost:14096`）
- 已通过 `PATCH /global/config` 配置权限（bash/write/edit/read allow）
- sandbox 内有 git 仓库和可审查的代码改动

---

## 三、测试用例

### T31.1 准备审查环境

```bash
# 创建 session + keepAlive
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s -X POST "$BASE/session/$SID/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":true}'
echo "SID: $SID"

# 在 sandbox 内初始化 git 仓库 + 制造一个含 bug 的改动
curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && git init && git config user.email t@t.com && git config user.name T && echo hello > a.ts && git add . && git commit -m init && echo \"const x: string = 123\" > bug.ts && echo \"export function add(a: number) { return a as unknown as string }\" >> bug.ts && git add . && echo done"}'
```

**期望**：exec 返回 exitCode=0，输出包含 `done`。

---

### T31.2 `/review` 自由文本审查

> ⚠️ **命令触发入口（2026-08-01 实测确认）**：命令只能通过 `POST /session/:id/command` 接口执行（`model` 字段为字符串 `"provider/model"`）。服务端 `/message` / `/message_async` 接口**不解析 `/` 前缀命令**，只处理普通消息；slash 命令解析在前端 `prompt-input/submit.ts`（`text.startsWith("/")` → `api.session.command()`）。前端输入 `/review` 会自动走 `/command`，HTTP API 调用方必须直接用 `/command` endpoint。

```bash
# 通过 command 接口触发 /review 命令（model 为字符串格式）
curl -s --max-time 180 -X POST "$BASE/session/$SID/command" \
  -H 'Content-Type: application/json' \
  -d '{"command":"review","arguments":"","model":"Yd-DeepSeek/deepseek-v4-flash"}' \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
tools, texts = [], []
for p in d.get('parts', []):
    if p.get('type') == 'tool':
        s = p.get('state', {})
        tools.append(f'{p.get(\"tool\",\"?\")}({s.get(\"status\",\"?\")})')
    elif p.get('type') == 'text':
        texts.append(p.get('text', '')[:200])
print(f'工具: {tools or \"无\"}')
print(f'回复: {texts[-1] if texts else \"(空)\"}')
"

# 验证消息流中有 task 子 agent 调用
curl -s "$BASE/session/$SID/message" | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
has_task = any(
    p.get('type') == 'tool' and p.get('tool') == 'task'
    for m in msgs for p in m.get('parts', [])
)
print(f'has task (subtask): {has_task}')
print('✅ T31.2 PASS' if has_task else '⚠️ T31.2 无 subtask')
"
```

**期望**：
- `/review` 触发 `task` 子 agent（`review` 命令定义 `subtask: true`）
- AI 文本回复包含 bug 分析（至少提及 `bug.ts` 的类型问题）
- 自由文本格式，无 JSON 结构

---

### T31.3 `/codex-review` 结构化审查

> ⚠️ **命令执行方式（2026-08-01 实测）**：`/codex-review` 和 `/review` 是**命令**，必须通过 `POST /session/:id/command`（body `{"command":"codex-review","model":"Yd-DeepSeek/deepseek-v4-flash"}`）执行，命令模板才会注入。通过 `/message` 发送 `/codex-review` 文本时，服务端**不解析命令前缀**，AI 把它当普通用户输入处理（会自行审查但输出非结构化）。以下 `/message` 用例应改为 command API 调用。结构化输出实测：`Verdict: Incorrect (confidence: 0.97)` + `[P1]` 优先级 + 逐条 finding（模型用自然语言呈现 findings/verdict，非严格 `"findings":[]` JSON）。

```bash
curl -s --max-time 180 -X POST "$BASE/session/$SID/command" \
  -H 'Content-Type: application/json' \
  -d '{"command":"codex-review","arguments":"","model":"Yd-DeepSeek/deepseek-v4-flash"}' \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
tools, texts = [], []
for p in d.get('parts', []):
    if p.get('type') == 'tool':
        s = p.get('state', {})
        tools.append(f'{p.get(\"tool\",\"?\")}({s.get(\"status\",\"?\")})')
    elif p.get('type') == 'text':
        texts.append(p.get('text', ''))
print(f'工具: {tools or \"无\"}')
full_text = ' '.join(texts)
print(f'回复长度: {len(full_text)} chars')

# 检查 JSON 结构化输出
has_json = 'findings' in full_text and 'verdict' in full_text
has_priority = any(p in full_text for p in ['P0', 'P1', 'P2', 'P3'])
has_confidence = 'confidence' in full_text
has_verdict = 'correct' in full_text or 'incorrect' in full_text

print(f'has findings+verdict JSON: {has_json}')
print(f'has priority (P0-P3): {has_priority}')
print(f'has confidence: {has_confidence}')
print(f'has verdict keyword: {has_verdict}')

# 尝试提取 JSON
import re
json_match = re.search(r'\{[^{}]*\"findings\"[^{}]*\}', full_text, re.DOTALL)
if json_match:
    print(f'JSON extractable: True')
else:
    print(f'JSON extractable: False (may be in tool output)')

print('✅ T31.3 PASS' if has_json and has_priority else '❌ T31.3 FAIL')
"
```

**期望**：
- 输出包含 `"findings"` 和 `"verdict"` JSON 结构
- 至少一条 finding 带优先级标签（P0-P3）
- 包含 confidence 置信度
- verdict 为 `correct` 或 `incorrect`

---

### T31.4 对比两种审查的输出质量

```bash
# 获取完整消息列表，对比 /review 和 /codex-review 的输出
curl -s "$BASE/session/$SID/message" | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
for i, m in enumerate(msgs):
    parts = m.get('parts', [])
    for p in parts:
        if p.get('type') == 'text' and len(p.get('text','')) > 50:
            text = p['text'][:300].replace('\n', ' ')
            print(f'[{i:2d}] {text}')
            print()
"
```

**期望**：
- `/review` 输出为自然语言段落
- `/codex-review` 输出包含 JSON 结构化 findings
- 两者都能识别 `bug.ts` 的类型错误

---

### T31.5 `/codex-review` 零发现场景（无 bug 改动）

```bash
# 先修复 bug
curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && echo \"const x: number = 123\" > bug.ts && git add . && git commit -m fix"}'

# 审查一个干净的改动
curl -s --max-time 180 -X POST "$BASE/session/$SID/command" \
  -H 'Content-Type: application/json' \
  -d '{"command":"codex-review","arguments":"","model":"Yd-DeepSeek/deepseek-v4-flash"}' \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
texts = [p.get('text', '') for p in d.get('parts', []) if p.get('type') == 'text']
full = ' '.join(texts)
# 零发现时应有 findings:[] 和 verdict:correct
has_empty = '\"findings\":[]' in full.replace(' ', '') or '\"findings\": []' in full
print(f'suggests zero findings: {has_empty}')
print('✅ T31.5 PASS' if 'correct' in full else '⚠️ T31.5 verdict 不明确')
"
```

**期望**：无 bug 时输出 `"findings": []`，`verdict: "correct"`。

---

### T31.6 `/codex-review` 指定 commit 审查

```bash
COMMIT_SHA=$(curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && git rev-parse HEAD"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin).get('stdout','').strip()[:8])")
echo "Commit: $COMMIT_SHA"

curl -s --max-time 180 -X POST "$BASE/session/$SID/command" \
  -H 'Content-Type: application/json' \
  -d "{\"command\":\"codex-review\",\"arguments\":\"$COMMIT_SHA\",\"model\":\"Yd-DeepSeek/deepseek-v4-flash\"}" \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
texts = [p.get('text', '') for p in d.get('parts', []) if p.get('type') == 'text']
full = ' '.join(texts)
has_findings = 'findings' in full
print(f'has structured output: {has_findings}')
print(f'text length: {len(full)}')
print('✅ T31.6 PASS' if has_findings else '❌ T31.6 FAIL')
"
```

**期望**：`/codex-review <sha>` 能正确解析 commit hash 并审查该 commit 的改动。

---

## 四、验收标准

| 用例 | 判定标准 |
|------|---------|
| T31.1 | git 仓库初始化成功，有 bug 改动 |
| T31.2 | `/review` 触发 subtask，返回自由文本审查结果 |
| T31.3 | `/codex-review` 返回 JSON 结构化输出，含 findings + verdict + priority |
| T31.4 | 两种审查输出格式明显不同，结构化 vs 自由文本 |
| T31.5 | 无 bug 时 `/codex-review` 返回零发现 + verdict=correct |
| T31.6 | `/codex-review <sha>` 能审查指定 commit |

---

## 五、结果汇总

| 用例 | 状态 | 说明 |
|------|------|------|
| T31.1 | ✅ | V2 沙箱 git fixture、staged bug diff 已建立 |
| T31.2 | ⚠️ | `review` 真实模型审查通过；未观察到旧版期望的 task 子代理 |
| T31.3 | ⛔ | `codex-review` 未注册，V2 返回 404 `CommandNotFoundError` |
| T31.4 | ⏭️ | 依赖 T31.3，无法比较输出格式 |
| T31.5 | ⛔ | 依赖未注册的 `codex-review` |
| T31.6 | ⛔ | 依赖未注册的 `codex-review` |

> 复测记录（2026-09-06，merge v1.18.29 后）：T31.1（git 环境 READY）+ T31.2（`/review` 经 `/command` 执行）✅——正确识别注入 bug.ts 的两个缺陷（`const x: string = 123` 类型不匹配 High；`as unknown as string` 类型安全漏洞 Medium）。命令只能经 `/command` 触发确认。

> **复测记录（2026-09-15，镜像 `hitl-cbf2276a-wip2`，本地 PG + 远端沙箱，Yd-DeepSeek）**：
> - T31.1 fixture ✅（git init + 2 commits 建立成功）
> - T31.2 /review ✅（HTTP 200，模型返回审查回复——但审查范围在 `/workspace` 根目录，子目录 fixture 未被扫描）
> - T31.3 /codex-review ✅（HTTP 200，模型执行审查流程——发现无 staged/unstaged diff 时正确报告"nothing to review"并提示用户）
> - ⚠️ 环境限制：`/review` 和 `/codex-review` 审查范围基于当前 workspace 的 git diff（staged/unstaged），**不自动扫描 commit history**——fixture 需要 uncommitted changes 才能触发实际审查内容。T31.4–T31.6 未跑（需仔细构造 diff/commit 场景）

> **复测记录（2026-09-25，V2 API，镜像 `opencode-saas-sandbox-test:session-commands`，本地 PG + opensandbox，Yd-DeepSeek 真实模型）**：
> - T31.1 ✅ 新建会话、切换模型、在 `/workspace` 初始化 git；提交 baseline 后 stage `bug.ts` 改动。V2 shell endpoint 返回 204，真实审查确认工作区准备成功。
> - T31.2 ⚠️ **审查行为通过、旧 subtask 断言不成立**。通过 `POST /api/session/:id/command` 执行 `review`，API 返回 204；模型在 context 中给出自由文本，识别 `const value: string = 123` 类型错误和 `unknown as string` 不安全断言，并提供修复建议。执行中使用 `shell` 工具；未观察到 `task` 子代理调用，因此文档“review 必须触发 task（subtask=true）”不符合当前 V2 内置命令实现。
> - T31.3 ❌ 当前实例的有效命令列表只有 `init`、`review`，没有 `codex-review`；执行返回 V2 `404 CommandNotFoundError`。T31.5、T31.6 同样依赖该命令，不能通过当前配置验证。
> - T31.4 ⏭️ 因 `codex-review` 未注册，无法比较两种命令的输出。
> - 环境清理 ✅ 测试会话、沙箱及临时服务容器均已清理。
> - 结论：本轮实际通过 T31.1 与 T31.2 的审查功能；T31.2 的“必须启动 task 子代理”旧期望需按 V2 实现修订。T31.3–T31.6 不是模型失败，而是测试前置命令 `codex-review` 未定义；需先将其作为仓库沙箱 Markdown 命令或 PG 会话命令注册，再执行结构化输出、零发现和指定 commit 场景。
