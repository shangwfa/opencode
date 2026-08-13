# context-mode SaaS Session Plugin 集成测试

> 验证 [context-mode](https://github.com/mksglu/context-mode) 作为 SaaS Session Plugin 接入 OpenCode：沙箱预装、PG 持久化、11 个 `ctx_*` 工具、自动路由、上下文压缩、Session 连续性、故障恢复和隔离。
>
> 上游宣称的 96%～98% 是特定大输出 benchmark 的结果，不是每次调用的保证。本用例对固定的大文件场景设置量化阈值，并单独验证答案正确性。

## 接入语义

| 能力 | Session Plugin | Local MCP |
|------|----------------|-----------|
| `ctx_execute`、`ctx_search` 等工具 | 支持 | 支持 |
| OpenCode hooks | 支持 | 不支持 |
| 自动路由 | before hook 可提示、改写或阻断原工具调用 | 不支持 |
| Session 连续性 | compaction hook 记录并注入 resume snapshot | 不支持 |
| 系统提示注入 | `experimental.chat.system.transform` | 不支持 |
| 执行位置 | V1 Server 进程或 V2 Session 沙箱 | MCP 子进程 |

`tool.execute.after` 主要记录 continuity event，不应笼统描述为“自动把所有工具输出替换为摘要”。大输出压缩主要来自主动使用 `ctx_execute*`、`ctx_index`、`ctx_search` 和 `ctx_fetch_and_index`。

## 验收层级

| 层级 | 用例 | 验证目标 |
|------|------|----------|
| L0 安装 | T-CM.1～2 | Session、沙箱、CLI、FTS5 |
| L1 接入 | T-CM.3～4 | Plugin 注册、PG、hooks、11 个工具 |
| L2 功能 | T-CM.5～7 | execute、文件分析、批处理、索引、搜索、网页抓取 |
| L3 效果 | T-CM.8 | 正确性与压缩率 |
| L4 路由 | T-CM.9 | Bash、Read、WebFetch before hook |
| L5 连续性 | T-CM.10 | compaction、重启、resume snapshot |
| L6 可靠性 | T-CM.11～13 | Agent 恢复、Session 隔离、诊断与安全 |

## 公共配置

```bash
export BASE="http://localhost:14096"
export PG_URL="postgresql://local@127.0.0.1:15432/opencode"
export PROVIDER_ID="Yd-DeepSeek"
export MODEL_ID="deepseek-v4-flash"
```

以下辅助程序使用同步 `POST /session/:id/message`。响应体只包含最终 assistant message，工具调用位于同一轮的中间 message，因此程序按 message ID 差集收集完整证据并保存到 `/tmp/cm-last.json`。不能只按消息数量切片，否则异步落盘会造成跨轮竞态。

```bash
cat >/tmp/cm-prompt.py <<'PY'
import json, os, sys, urllib.request

base = os.environ["BASE"]
sid = os.environ["SID"]
expected = sys.argv[1]
prompt = sys.argv[2]

def get_messages():
    with urllib.request.urlopen(f"{base}/session/{sid}/message") as response:
        return json.load(response)

before = {item["info"]["id"] for item in get_messages()}
body = json.dumps({
    "parts": [{"type": "text", "text": prompt}],
    "model": {
        "providerID": os.environ["PROVIDER_ID"],
        "modelID": os.environ["MODEL_ID"],
    },
}).encode()
request = urllib.request.Request(
    f"{base}/session/{sid}/message",
    data=body,
    headers={"Content-Type": "application/json"},
)
final = json.load(urllib.request.urlopen(request))
current = [item for item in get_messages() if item["info"]["id"] not in before]

with open(os.environ.get("CM_OUTPUT", "/tmp/cm-last.json"), "w") as output:
    json.dump(current, output, ensure_ascii=False, indent=2)

tools = [
    (part.get("tool", ""), part.get("state", {}).get("status", ""))
    for item in current
    for part in item.get("parts", [])
    if part.get("type") == "tool"
]
texts = [
    part.get("text", "")
    for item in current
    for part in item.get("parts", [])
    if part.get("type") == "text" and part.get("text", "").strip()
]
print("tools:", tools)
print("answer:", "\n".join(texts)[-2000:])
if expected != "-" and not any(expected in tool for tool, _ in tools):
    raise SystemExit(f"expected tool {expected!r}, got {tools!r}")
PY
```

## L0 安装

### T-CM.1 创建 Session 并启动沙箱

```bash
export SID=$(python3 - <<'PY'
import json, os, urllib.request
request = urllib.request.Request(
    os.environ["BASE"] + "/session",
    data=b'{"title":"context-mode-e2e"}',
    headers={"Content-Type": "application/json"},
)
print(json.load(urllib.request.urlopen(request))["id"])
PY
)

python3 - <<'PY'
import json, os, urllib.request
request = urllib.request.Request(
    f'{os.environ["BASE"]}/session/{os.environ["SID"]}/keep-alive',
    data=b'{"enabled":true,"boot":true}',
    headers={"Content-Type": "application/json"},
)
result = json.load(urllib.request.urlopen(request))
assert result["keepAlive"] is True
assert result["sandboxId"]
print(result)
PY
```

通过标准：返回非空 `sandboxId`，沙箱进入 running 状态。

### T-CM.2 验证 CLI、版本和 FTS5

沙箱镜像在 `packages/opencode/docker/Dockerfile` 中全局安装 `context-mode` 和 `zod`。记录版本，避免仅验证二进制存在。

```bash
python3 - <<'PY'
import json, os, urllib.request
command = r'''set -e
command -v context-mode
npm list -g context-mode --depth=0
cd "$(npm root -g)/context-mode"
node -e 'const Database=require("better-sqlite3");const db=new Database(":memory:");db.exec("CREATE VIRTUAL TABLE search USING fts5(content)");console.log("FTS5 OK")'
'''
request = urllib.request.Request(
    f'{os.environ["BASE"]}/session/{os.environ["SID"]}/exec',
    data=json.dumps({"command": command}).encode(),
    headers={"Content-Type": "application/json"},
)
print(urllib.request.urlopen(request).read().decode())
PY
```

通过标准：

- 路径为 `/root/.local/share/mise/shims/context-mode`。
- 输出明确版本号，将该版本记录到测试报告。
- 输出 `FTS5 OK`。

## L1 接入

### T-CM.3 注册 Session Plugin

使用 `source: "code"` wrapper，处理 SaaS V2 所需的四个兼容点：

- 强制 `CONTEXT_MODE_PLATFORM=opencode`。
- 使用 `CONTEXT_MODE_DIR` 将 SessionDB 和 ContentStore 同时放入 Session PVC；只设置 `CONTEXT_MODE_DATA_DIR` 不会迁移 ContentStore。
- 为 native tools 创建 readiness sentinel，否则上游路由会认为 MCP 不可用并 fail-open。
- 兼容当前 OpenCode 的 `webfetch`、`read.filePath`，并将大文件 Read guidance 转成模型可见的阻断。

```bash
python3 - <<'PY'
import json, os, urllib.request
code = '''process.env.CONTEXT_MODE_PLATFORM = "opencode"
process.env.CONTEXT_MODE_DATA_DIR = "/workspace/.context-mode-data"
process.env.CONTEXT_MODE_DIR = "/workspace/.context-mode-data/context-mode"
process.env.CONTEXT_MODE_PROJECT_DIR = "/workspace"
const { writeFileSync, unlinkSync } = await import("node:fs")
const { default: plugin } = await import("context-mode")
export default async (input) => {
  const hooks = await plugin.server(input)
  const sentinel = `/tmp/context-mode-mcp-ready-${process.pid}`
  writeFileSync(sentinel, String(process.pid))
  const dispose = hooks.dispose
  hooks.dispose = async () => {
    await dispose?.()
    try { unlinkSync(sentinel) } catch {}
  }
  const before = hooks["tool.execute.before"]
  if (before) hooks["tool.execute.before"] = async (hookInput, output) => {
    const tool = hookInput.tool === "webfetch" ? "fetch" : hookInput.tool
    if (tool === "read" && output.args.filePath) output.args.file_path = output.args.filePath
    const result = await before({ ...hookInput, tool }, output)
    delete output.args.file_path
    if (tool === "read" && output.args.additionalContext) {
      const guidance = output.args.additionalContext
      delete output.args.additionalContext
      throw new Error(guidance)
    }
    return result
  }
  return hooks
}'''
open("/tmp/cm-wrapper.ts", "w").write(code)
body = json.dumps({
    "name": "context-mode",
    "source": "code",
    "code": code,
    "enabled": True,
}).encode()
request = urllib.request.Request(
    f'{os.environ["BASE"]}/session/{os.environ["SID"]}/plugins/create',
    data=body,
    headers={"Content-Type": "application/json"},
)
result = json.load(urllib.request.urlopen(request))
assert result["name"] == "context-mode"
assert result["source"] == "code"
assert result["enabled"] is True
print(result)
PY
```

### T-CM.4 验证 API、PG、Agent 和工具集合

先发送一次最小 prompt，使 V2 Runtime 启动沙箱 Plugin Agent。

```bash
python3 /tmp/cm-prompt.py ctx_stats \
  "必须调用一次 ctx_stats 工具，然后只回复工具是否成功。"
```

验证 API 和 PG：

```bash
python3 - <<'PY'
import json, os, urllib.request
with urllib.request.urlopen(f'{os.environ["BASE"]}/session/{os.environ["SID"]}/plugins') as response:
    rows = json.load(response)
row = next(item for item in rows if item["name"] == "context-mode")
assert row["source"] == "code"
assert row["enabled"] is True
print(row)
PY

psql "$PG_URL" -Atc \
  "SELECT name, source, enabled FROM session_plugins WHERE session_id='$SID'"
# 期望：context-mode|code|t
```

从沙箱内直接检查 Agent 协议，确定性验证 hooks 和完整工具集合：

```bash
python3 - <<'PY'
import json, os, urllib.request
command = r'''python3 - <<'INNER'
import json, urllib.request
health = json.load(urllib.request.urlopen("http://127.0.0.1:9200/health"))
tools = json.load(urllib.request.urlopen("http://127.0.0.1:9200/tools"))
required = {
  "ctx_execute", "ctx_execute_file", "ctx_batch_execute", "ctx_index",
  "ctx_search", "ctx_fetch_and_index", "ctx_stats", "ctx_doctor",
  "ctx_upgrade", "ctx_purge", "ctx_insight",
}
assert set(tools) == required, (set(tools), required)
assert "tool.execute.before" in health["hooks"]
assert "tool.execute.after" in health["hooks"]
assert "experimental.session.compacting" in health["hooks"]
assert "experimental.chat.system.transform" in health["hooks"]
print(json.dumps(health, indent=2))
print("11 tools OK")
INNER'''
request = urllib.request.Request(
    f'{os.environ["BASE"]}/session/{os.environ["SID"]}/exec',
    data=json.dumps({"command": command}).encode(),
    headers={"Content-Type": "application/json"},
)
print(urllib.request.urlopen(request).read().decode())
PY
```

## L2 核心功能

### T-CM.5 execute、execute_file 和 batch_execute

准备固定输入：

```bash
python3 - <<'PY'
import json, os, urllib.request
command = r'''mkdir -p /workspace/cm-fixtures
printf '%s\n' '{"orders":[{"amount":12},{"amount":30},{"amount":7}]}' > /workspace/cm-fixtures/orders.json
'''
request = urllib.request.Request(
    f'{os.environ["BASE"]}/session/{os.environ["SID"]}/exec',
    data=json.dumps({"command": command}).encode(),
    headers={"Content-Type": "application/json"},
)
urllib.request.urlopen(request).read()
PY
```

```bash
python3 /tmp/cm-prompt.py ctx_execute \
  "必须用 ctx_execute 执行 JavaScript console.log(6 * 7)，最终答案必须是 42。"

python3 /tmp/cm-prompt.py ctx_execute_file \
  "必须用 ctx_execute_file 分析 /workspace/cm-fixtures/orders.json，计算 orders 的 amount 总和，最终答案必须是 49。"

python3 /tmp/cm-prompt.py ctx_batch_execute \
  "必须用 ctx_batch_execute 一次执行 pwd、printf alpha、printf beta 三个命令，并概括三个结果。"
```

通过标准：三个指定工具均出现 `completed` tool part，结果分别为 `42`、`49` 和三项命令输出。只出现正确文本但未调用指定工具不算通过。

### T-CM.6 index 和 search

```bash
python3 /tmp/cm-prompt.py ctx_index \
  "必须调用 ctx_index，把文本 'ORCHID-CM-7429 belongs to project helios' 写入 source cm-e2e-sentinel。"

python3 /tmp/cm-prompt.py ctx_search \
  "必须调用 ctx_search，只在 source cm-e2e-sentinel 中搜索 ORCHID-CM-7429，并回复它属于哪个 project。"
```

通过标准：

- 搜索结果包含 `ORCHID-CM-7429` 和 `helios`。
- 使用不存在的 source 搜索时不得返回该 sentinel。
- 连续两次搜索结果语义一致，不依赖模型历史复述。

```bash
python3 /tmp/cm-prompt.py ctx_search \
  "必须调用 ctx_search，只在 source cm-e2e-missing 中搜索 ORCHID-CM-7429；如无结果明确回复 NOT_FOUND。"
```

### T-CM.7 fetch_and_index 与缓存

使用沙箱内本地 HTTP 服务，避免公网波动。context-mode 默认允许 localhost；若设置了 `CTX_FETCH_STRICT=1`，应改用允许的测试域名。

```bash
python3 - <<'PY'
import json, os, urllib.request
command = r'''mkdir -p /tmp/cm-web
printf '<html><body><h1>CM-FETCH-3817</h1><p>owner: atlas</p></body></html>' >/tmp/cm-web/index.html
pkill -f 'http.server 18081' 2>/dev/null || true
nohup python3 -m http.server 18081 --directory /tmp/cm-web >/tmp/cm-http.log 2>&1 &
'''
request = urllib.request.Request(
    f'{os.environ["BASE"]}/session/{os.environ["SID"]}/exec',
    data=json.dumps({"command": command}).encode(),
    headers={"Content-Type": "application/json"},
)
urllib.request.urlopen(request).read()
PY

python3 /tmp/cm-prompt.py ctx_fetch_and_index \
  "必须用 ctx_fetch_and_index 抓取 http://127.0.0.1:18081/index.html，source 使用 cm-e2e-fetch，然后告诉我 owner。"

python3 /tmp/cm-prompt.py ctx_search \
  "必须用 ctx_search 在 source cm-e2e-fetch 搜索 CM-FETCH-3817，并回复 owner。"
```

再次抓取相同 URL，检查缓存，并验证无效 URL 的错误：

```bash
python3 /tmp/cm-prompt.py ctx_fetch_and_index \
  "再次用 ctx_fetch_and_index 抓取 http://127.0.0.1:18081/index.html，source 仍使用 cm-e2e-fetch。"

python3 /tmp/cm-prompt.py ctx_stats \
  "必须调用 ctx_stats，报告 fetch cache hit、miss 和 avoided bytes。"

python3 /tmp/cm-prompt.py ctx_fetch_and_index \
  "必须用 ctx_fetch_and_index 抓取 http://127.0.0.1:18081/missing.html，原样报告工具错误。"
```

通过标准：答案为 `atlas`，第二次抓取显示 cache hit 或统计中的 cache hit 增加；无效 URL 的 tool part 明确失败且不会污染已有 source。

## L3 效果量化

### T-CM.8 固定大输出压缩率

生成约 2 MB JSON，sentinel 只出现一次：

```bash
python3 - <<'PY'
import json, os, urllib.request
command = r'''python3 - <<'INNER'
import json
rows = [{"id": i, "payload": "x" * 180, "marker": "CM-LARGE-9913" if i == 7311 else ""} for i in range(10000)]
with open("/workspace/cm-fixtures/large.json", "w") as output:
    json.dump(rows, output)
INNER'''
request = urllib.request.Request(
    f'{os.environ["BASE"]}/session/{os.environ["SID"]}/exec',
    data=json.dumps({"command": command}).encode(),
    headers={"Content-Type": "application/json"},
)
urllib.request.urlopen(request).read()
PY

python3 /tmp/cm-prompt.py ctx_execute_file \
  "必须用 ctx_execute_file 分析 /workspace/cm-fixtures/large.json，只返回 marker CM-LARGE-9913 对应的 id。"

# ctx_execute_file 不把 FILE_CONTENT 字节计入 ctx_stats，外部计算其实际压缩效果。
python3 - <<'PY'
import json, os, urllib.request
with open("/tmp/cm-last.json") as source:
    messages = json.load(source)
call = next(
    part for item in reversed(messages) for part in reversed(item.get("parts", []))
    if part.get("tool") == "ctx_execute_file" and part.get("state", {}).get("status") == "completed"
)
request = urllib.request.Request(
    f'{os.environ["BASE"]}/session/{os.environ["SID"]}/exec',
    data=json.dumps({"command": "wc -c < /workspace/cm-fixtures/large.json"}).encode(),
    headers={"Content-Type": "application/json"},
)
fixture = int(json.load(urllib.request.urlopen(request))["stdout"].strip())
returned = len(call["state"]["output"].encode())
reduction = 1 - returned / fixture
print({"fixtureBytes": fixture, "responseBytes": returned, "reduction": reduction})
assert reduction >= 0.9
PY

# 使用 FS instrumentation 场景验证 ctx_stats 的统计口径。
python3 /tmp/cm-prompt.py ctx_execute \
  "必须用 ctx_execute；JavaScript 代码用 fs.readFileSync('/workspace/cm-fixtures/large.json','utf8') 读取并 JSON.parse，只打印 CM-LARGE-9913 对应的 id。"

python3 /tmp/cm-prompt.py ctx_stats \
  "必须调用 ctx_stats，原样报告 reduction 和 Without/With context-mode 字节数。"
```

通过标准：

- 答案正确：`id=7311`。
- 大文件分析工具返回内容不包含完整原始 JSON。
- `ctx_execute_file` 外部比率 `1 - responseBytes / fixtureBytes >= 90%`。v1.0.169 实测为 `2,228,903 B -> 775 B`，减少 `99.97%`。
- `ctx_execute` 的 FS instrumentation 被 stats 计入 sandboxed bytes，固定场景 reduction `>= 90%`。v1.0.169 实测为 `2.1 MB -> 16.5 KB`，减少 `99.3%`。
- `ctx_stats` 的工具调用计数与本用例实际调用方向一致。

注意：v1.0.169 的 `ctx_execute_file` 不把 `FILE_CONTENT` 大小计入 `ctx_stats.processed`，因此不能直接用该工具后的 stats 断言 fixture 大小。这是统计口径，不代表文件内容进入了模型上下文。

## L4 自动路由

### T-CM.9 Bash、Read、WebFetch compatibility

这组测试验证 before hook，不以最终答案正确作为唯一标准。必须检查 `/tmp/cm-last.json` 中原工具参数、状态、错误和后续是否切换到 `ctx_*`。

```bash
python3 /tmp/cm-prompt.py - \
  "先直接调用 bash，command 必须包含 curl http://127.0.0.1:18081/index.html；如果被 hook 重定向，再按提示完成任务。"

python3 /tmp/cm-prompt.py - \
  "先直接调用 read 读取完整的 /workspace/cm-fixtures/large.json；如果 hook 建议使用 context-mode，再改用建议工具查找 CM-LARGE-9913。"

python3 /tmp/cm-prompt.py - \
  "先直接调用 webfetch 访问 http://127.0.0.1:18081/index.html；如果被阻断，再改用 ctx_fetch_and_index。"
```

通过标准：

- Bash 中的 `curl` 不直接产生完整网页输出，而是被拒绝、改写或明确引导到 `ctx_fetch_and_index`。
- Read 不把 2 MB JSON 注入模型上下文，应明确引导到 `ctx_execute_file`。
- WebFetch 被阻断并引导到 `ctx_fetch_and_index`，不能静默 fail-open。
- 三种原生工具名必须按 OpenCode 实际 ID `bash`、`read`、`webfetch` 验证。任何 alias 不匹配都应记为兼容性缺陷。

Session Plugin Agent 必须传播 hook 异常，wrapper 必须提供 readiness sentinel 和当前 OpenCode 参数兼容。缺少任一项都会使 Bash/WebFetch fail-open，或使 Read guidance 对模型不可见。

## L5 Session 连续性

### T-CM.10 compaction 和 Session 恢复

先确保 sentinel 已进入 continuity event，再触发显式 compaction：

```bash
python3 /tmp/cm-prompt.py ctx_search \
  "用 ctx_search 查找 ORCHID-CM-7429，然后记住结果，稍后压缩后还要恢复。"

python3 - <<'PY'
import json, os, urllib.request
body = json.dumps({
    "providerID": os.environ["PROVIDER_ID"],
    "modelID": os.environ["MODEL_ID"],
    "auto": False,
}).encode()
request = urllib.request.Request(
    f'{os.environ["BASE"]}/session/{os.environ["SID"]}/summarize',
    data=body,
    headers={"Content-Type": "application/json"},
)
assert json.load(urllib.request.urlopen(request)) is True
PY

# ctx_stats v1.0.169 不展示 compact_count/consumed，直接查询 PVC SessionDB。
python3 - <<'PY'
import json, os, urllib.request
command = r'''python3 - <<'INNER'
import glob, json, sqlite3
path = glob.glob('/workspace/.context-mode-data/context-mode/sessions/*.db')[0]
db = sqlite3.connect(path)
print(json.dumps({
  "meta": db.execute("select session_id, compact_count from session_meta").fetchall(),
  "resume": db.execute("select session_id, event_count, consumed from session_resume").fetchall(),
}))
INNER'''
request = urllib.request.Request(
    f'{os.environ["BASE"]}/session/{os.environ["SID"]}/exec',
    data=json.dumps({"command": command}).encode(),
    headers={"Content-Type": "application/json"},
)
print(json.load(urllib.request.urlopen(request))["stdout"])
PY
```

在同一沙箱内继续搜索 sentinel，然后真正销毁并重建沙箱：

```bash
python3 /tmp/cm-prompt.py ctx_search \
  "上下文已压缩。必须用 ctx_search 恢复 ORCHID-CM-7429，并回复它所属的 project。"

export OLD_SANDBOX=$(python3 - <<'PY'
import json, os, urllib.request
print(json.load(urllib.request.urlopen(f'{os.environ["BASE"]}/session/{os.environ["SID"]}/sandbox'))["sandboxId"])
PY
)
python3 - <<'PY'
import json, os, urllib.request
for path, body in [
    ("kill-sandbox", {}),
    ("keep-alive", {"enabled": True, "boot": True}),
]:
    request = urllib.request.Request(
        f'{os.environ["BASE"]}/session/{os.environ["SID"]}/{path}',
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    result = json.load(urllib.request.urlopen(request))
    print(result)
    if path == "keep-alive":
        assert result["sandboxId"] and result["sandboxId"] != os.environ["OLD_SANDBOX"]
PY

python3 /tmp/cm-prompt.py ctx_search \
  "沙箱已经销毁重建。必须用 ctx_search 在 source cm-e2e-sentinel 搜索 ORCHID-CM-7429，并回复 project。"
```

通过标准：

- compaction hook 不报类型错误，summary 成功。
- SessionDB 中 `compact_count` 增加且生成一条 `session_resume`。
- 压缩后仍能恢复 `ORCHID-CM-7429 -> helios`。
- 沙箱 ID 变化后仍能恢复 sentinel，证明 sessions/content 均位于 Session PVC。
- 系统提示注入不改变 `system[0]`，以保留 provider prompt cache。

上游不会让当前 Session claim 自己产生的 snapshot，因此当前行的 `consumed=0` 是预期语义；同 Session compaction 由 OpenCode summary 继续，context-mode snapshot 面向同项目的后续 Session。

`keep-alive: false` 只取消保活，不能模拟重建；必须使用 `POST /session/:id/kill-sandbox`。当前 PVC 按 SessionID 使用独立 subPath，所以不同 Session 不共享 context-mode SQLite；上游跨 Session snapshot claim 在 V2 隔离模式下不可用，详见“已知边界”。

## L6 可靠性与安全

### T-CM.11 Agent 崩溃恢复和错误传播

```bash
python3 - <<'PY'
import json, os, urllib.request
request = urllib.request.Request(
    f'{os.environ["BASE"]}/session/{os.environ["SID"]}/exec',
    data=json.dumps({"command": "pkill -f 'bun.*sandbox-plugin-agent' || true"}).encode(),
    headers={"Content-Type": "application/json"},
)
urllib.request.urlopen(request).read()
PY

python3 /tmp/cm-prompt.py - \
  "Plugin Agent 刚被终止。如果 ctx_execute 暂时不可用，只回复 RETRY，不要使用其他工具。"

python3 /tmp/cm-prompt.py ctx_execute \
  "必须调用 ctx_execute 计算 20+22，验证 Agent 恢复后的工具代理。"

python3 /tmp/cm-prompt.py ctx_execute_file \
  "必须调用 ctx_execute_file 读取 /workspace/cm-fixtures/does-not-exist.json，并原样报告工具错误。"
```

通过标准：Runtime 自动识别失效 endpoint、重启 Agent，下一次 `ctx_execute` 无需重新注册 Plugin 即可返回 `42`。不存在文件的 tool part 必须明确失败，错误不能伪装成成功文本。代理层 502/无 JSON 响应属于可重试传输错误；Agent 返回的 `{ error }` 属于 Plugin 拒绝，必须传播而不能重试为 fail-open。

### T-CM.12 多 Session 隔离

创建第二个 Session、启动沙箱并注册相同 Plugin。不要在 SID2 写入 sentinel。

```bash
export SID2=$(python3 - <<'PY'
import json, os, urllib.request
request = urllib.request.Request(
    os.environ["BASE"] + "/session",
    data=b'{"title":"context-mode-isolation"}',
    headers={"Content-Type": "application/json"},
)
print(json.load(urllib.request.urlopen(request))["id"])
PY
)

python3 - <<'PY'
import json, os, urllib.request
sid = os.environ["SID2"]
keep_alive = urllib.request.Request(
    f'{os.environ["BASE"]}/session/{sid}/keep-alive',
    data=b'{"enabled":true,"boot":true}',
    headers={"Content-Type": "application/json"},
)
urllib.request.urlopen(keep_alive).read()
code = open("/tmp/cm-wrapper.ts").read()
create = urllib.request.Request(
    f'{os.environ["BASE"]}/session/{sid}/plugins/create',
    data=json.dumps({"name":"context-mode","source":"code","code":code,"enabled":True}).encode(),
    headers={"Content-Type": "application/json"},
)
urllib.request.urlopen(create).read()
PY

export SID_ORIGINAL="$SID"
export SID="$SID2"
python3 /tmp/cm-prompt.py ctx_search \
  "必须用 ctx_search 搜索 source cm-e2e-sentinel 中的 ORCHID-CM-7429；如无结果回复 NOT_FOUND。"
export SID="$SID_ORIGINAL"

# 并发执行时为辅助程序指定不同输出文件，避免测试证据互相覆盖。
CM_OUTPUT=/tmp/cm-sid1.json SID="$SID_ORIGINAL" \
  python3 /tmp/cm-prompt.py ctx_execute \
  "必须用 ctx_execute 计算 40+2，只回复结果。" >/tmp/cm-sid1.log 2>&1 &
PID1=$!
CM_OUTPUT=/tmp/cm-sid2.json SID="$SID2" \
  python3 /tmp/cm-prompt.py ctx_execute \
  "必须用 ctx_execute 计算 20+22，只回复结果。" >/tmp/cm-sid2.log 2>&1 &
PID2=$!
wait "$PID1"
wait "$PID2"
cat /tmp/cm-sid1.log /tmp/cm-sid2.log

CM_OUTPUT=/tmp/cm-sid1-stats.json SID="$SID_ORIGINAL" \
  python3 /tmp/cm-prompt.py ctx_stats \
  "必须调用 ctx_stats，报告当前 session ID、工具调用计数和 continuity 状态。"
CM_OUTPUT=/tmp/cm-sid2-stats.json SID="$SID2" \
  python3 /tmp/cm-prompt.py ctx_stats \
  "必须调用 ctx_stats，报告当前 session ID、工具调用计数和 continuity 状态。"
```

通过标准：

- SID2 返回 `NOT_FOUND`。
- SID1 仍能搜索到 sentinel。
- 两个 Session 并发调用 `ctx_execute` 都返回 `42`；各自 stats 调用计数独立，SID2 不得看到 SID1 的 source 或 snapshot。

### T-CM.13 doctor、purge 和安全边界

```bash
python3 /tmp/cm-prompt.py ctx_doctor \
  "必须调用 ctx_doctor，报告 runtime、storage、FTS5、hooks 和版本检查结果。"

python3 /tmp/cm-prompt.py ctx_execute_file \
  "必须用 ctx_execute_file 尝试读取项目外的 /etc/passwd，并原样报告工具是否拒绝。"

python3 /tmp/cm-prompt.py ctx_purge \
  "调用 ctx_purge 但不要传 confirm，验证它拒绝执行；不要清除数据。"
```

通过标准：

- doctor 的 runtime、storage、FTS5 和版本检查通过。它对全局 `opencode.json(c)` Plugin 配置的检查不适用于 Session Plugin API 接入，应单独记录而非判失败。
- `/etc/passwd` 被项目根边界拒绝，错误明确指出 `/workspace` 外路径不可读。
- `ctx_purge` 缺少 `confirm:true` 时拒绝执行，sentinel 仍可搜索。
- `ctx_upgrade` 和 `ctx_insight` 只验证已注册及参数 schema；CI 不执行升级，也不要求打开托管网页。

最后在测试 Session 中验证 project/session scope 后执行 purge，并确认 source 已清空：

```bash
python3 /tmp/cm-prompt.py ctx_purge \
  "这是测试 Session。必须调用 ctx_purge，scope 使用 session，sessionId 使用 $SID，并传 confirm=true。"

python3 /tmp/cm-prompt.py ctx_search \
  "必须用 ctx_search 在 source cm-e2e-sentinel 搜索 ORCHID-CM-7429；如无结果回复 NOT_FOUND。"
```

## 验收记录

> **2026-08-02 容器重建后重跑**（T-CM.1-7 核心链路）：session/沙箱、context-mode 预装 + FTS5、plugin 注册（`context-mode|code|t`）、11 工具精确匹配 + 6 hooks、execute（42）/execute_file（49）/batch_execute、index/search（helios / NOT_FOUND 隔离）、fetch_and_index（atlas / 缓存命中 / 404 报错）全部通过。L3-L6 历史结论不变。

| 验证项 | 结果 | 证据 |
|--------|------|------|
| Session 与沙箱启动 | 通过 | SID `ses_077a3afbfffejdCimEHum6C4IH`，sandbox `3c226...` |
| context-mode 版本与 FTS5 | 通过 | v1.0.169，`FTS5 OK` |
| Plugin API 与 PG 持久化 | 通过 | `context-mode|code|t` |
| 4 个关键 hooks | 通过 | Agent 实际加载 6 类 hooks |
| 11 个工具完整注册 | 通过 | `/tools` 精确集合 |
| execute/file/batch 正确性 | 通过 | `42`、`49`、三项 batch |
| index/search/source 隔离 | 通过 | `ORCHID-CM-7429 -> helios` |
| fetch/cache | 通过 | 4 hits、2 misses；404 为 error part |
| 大文件压缩率 >= 90% | 通过 | file 99.97%；stats 99.3% |
| Bash/Read/WebFetch 路由 | 通过 | 改写、阻断、切换 ctx 工具 |
| compaction 与重建恢复 | 通过 | `compact_count=1`；新 sandbox 仍可搜索 PVC sentinel |
| Agent 崩溃恢复 | 通过 | kill 后下一次 `ctx_execute` 返回 42 |
| 多 Session 隔离 | 通过 | SID2 `NOT_FOUND`；并发均返回 42 |
| doctor、安全、purge | 通过 | storage/FTS5 OK；越界拒绝；purge 后空库 |

## 已知边界

- context-mode 的 sandbox 是子进程执行边界，不是完整 OS 安全沙箱；在本接入中，外层 OpenSandbox 才提供容器隔离。
- `ctx_fetch_and_index` 不执行浏览器 JavaScript。动态网页应使用浏览器工具，而不是把抓取失败误判为 Plugin 故障。
- localhost 和私网 URL 默认可访问；`CTX_FETCH_STRICT=1` 会改变该行为。
- 小输出不保证高压缩率。量化阈值只适用于 T-CM.8 固定 fixture。
- 自动路由依赖上游对 OpenCode 原生工具 ID 的兼容。T-CM.9 是必要的回归测试，不能由“ctx 工具可调用”替代。
- OpenSandbox PVC 使用 `sessions/<sessionID>` subPath。`CONTEXT_MODE_DIR` 可保证同一 Session 沙箱重建后恢复索引，但不同 Session 不共享 SQLite，因此上游“新 Session claim 旧 Session snapshot”在 V2 隔离模式下不可用。若产品要求跨 Session continuity，需要单独设计 app/project 级持久化与并发 SQLite 所有权，不能通过放宽 Session 隔离临时解决。
- `ctx_stats` v1.0.169 不展示 `compact_count` 或 `session_resume.consumed`，这些指标需直接查询 SessionDB。
- `ctx_doctor` 的全局 `opencode.json(c)` Plugin configuration 检查不适用于 Session Plugin API，实测该项为 FAIL，但 runtime、PVC storage、FTS5、hooks 和版本均正常。
- `ctx_upgrade` 会改变运行环境，`ctx_insight` 会访问托管服务，因此不属于 CI 的破坏性自动验收。

## 清理

```bash
rm -f /tmp/cm-prompt.py /tmp/cm-wrapper.ts /tmp/cm-last.json /tmp/cm-sid{1,2}{,-stats}.{json,log}
```
