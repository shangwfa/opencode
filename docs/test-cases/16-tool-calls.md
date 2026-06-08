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

### T18.1 基础工具调用 smoke test

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
**期望**：全部显示 `✅`，每个场景都有对应的工具调用（bash/write/read/edit 或 apply_patch）

### T18.2 搜索工具和 sandbox 文件系统一致性

> 该组用例专门覆盖 `grep` / `glob`，并与 `read` / `bash rg` 对比，用于发现 sandbox 镜像缺少 `rg`、路径映射错误、read 与 grep/glob 不一致等问题。

```bash
send_and_verify "$SID" "用 bash 创建 /workspace/tool-regression/src/search-target.ts，内容包含 export const profileCardToken = 'PROFILE_CARD_SENTINEL'; 再创建 /workspace/tool-regression/src/empty.ts" "T18.2a: 准备搜索夹具"
send_and_verify "$SID" "只用 grep 工具在 /workspace/tool-regression 搜索 PROFILE_CARD_SENTINEL" "T18.2b: grep 精确搜索"
send_and_verify "$SID" "只用 grep 工具在 /workspace/tool-regression 搜索 profileCardToken，并 include 限制为 *.ts" "T18.2c: grep include 过滤"
send_and_verify "$SID" "只用 glob 工具列出 /workspace/tool-regression 下的 **/*.ts 文件" "T18.2d: glob ts 文件"
send_and_verify "$SID" "读取 /workspace/tool-regression/src/search-target.ts，确认内容包含 PROFILE_CARD_SENTINEL" "T18.2e: read 与 grep 一致性"
send_and_verify "$SID" "用 bash 执行: cd /workspace/tool-regression && rg --version && rg PROFILE_CARD_SENTINEL src" "T18.2f: bash rg 直接验证"
```

**期望**：
- `grep` 不能返回 `No files found`。
- `glob` 至少返回 `search-target.ts` 和 `empty.ts`。
- `read`、内置 `grep`、内置 `glob`、`bash rg` 看到的是同一批文件。
- 如果 `read` 成功但 `grep/glob` 全部空结果，优先判定为 sandbox 镜像缺少 `rg` 或 `rg` 命令不可用。

### T18.3 编辑工具分支验证

> opencode 会按模型过滤编辑工具：部分 GPT 模型启用 `apply_patch`，其他模型启用 `edit/write`。SaaS 当前常用 `glm-5.1`，默认应覆盖 `edit/write`；如果切换 GPT 模型，需要覆盖 `apply_patch`。

```bash
send_and_verify "$SID" "把 /workspace/tool-regression/src/search-target.ts 里的 PROFILE_CARD_SENTINEL 改成 PROFILE_CARD_PATCHED" "T18.3a: edit 或 apply_patch 修改"
send_and_verify "$SID" "读取 /workspace/tool-regression/src/search-target.ts，确认 PROFILE_CARD_PATCHED 存在且 PROFILE_CARD_SENTINEL 不存在" "T18.3b: 验证修改结果"
send_and_verify "$SID" "只用 grep 工具在 /workspace/tool-regression 搜索 PROFILE_CARD_PATCHED" "T18.3c: 修改后 grep 验证"
```

**期望**：
- 非 GPT 模型：PG 中能看到 `edit` 或 `write` completed。
- GPT 模型：PG 中能看到 `apply_patch` completed。
- 修改后 `read` 与 `grep` 结果一致。

### T18.4 subagent sandbox 复用验证

> 该组用例用于发现子会话创建独立 sandbox 导致 `/workspace` 为空的问题。子会话必须通过 root session 的 `sandboxSessionID` 复用父会话 sandbox。

```bash
send_and_verify "$SID" "启动一个 explore 子 agent，让它只使用 grep/glob/read 工具验证 /workspace/tool-regression/src/search-target.ts 存在，并返回文件路径和 PROFILE_CARD_PATCHED 这一行" "T18.4a: subagent 搜索父会话文件"
```

**期望**：
- 父会话和子会话不应各自创建独立 sandbox。
- 子会话的 `/workspace` 不能是空目录。
- 子会话必须能找到父会话创建的 `tool-regression/src/search-target.ts`。

### T18.5 后台 subagent（可选）

> 仅在 `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` 时执行。

```bash
send_and_verify "$SID" "后台启动一个 explore 子 agent，验证 /workspace/tool-regression 下有 ts 文件；background 必须为 true" "T18.5a: background task"
send_and_verify "$SID" "查询刚才后台子 agent 的任务状态" "T18.5b: task_status"
```

**期望**：PG 中出现 `task` completed；开启后台能力时出现 `task_status` completed。

### T18.6 网络和 skill 工具（可选）

> 网络工具依赖运行环境网络和 provider 配置，不作为必过项；用于验证工具注册和 provider 透传。

```bash
send_and_verify "$SID" "使用 webfetch 抓取 https://example.com 并总结标题" "T18.6a: webfetch"
send_and_verify "$SID" "如果有可用 skill，加载一个与代码搜索或前端开发相关的 skill；如果没有，说明没有可用 skill" "T18.6b: skill"
```

**期望**：
- `webfetch` 在有网络时 completed；无网络时允许记录为环境限制。
- `skill` 能返回 skill 内容或明确说明没有可用 skill。

### T18.7 验证完整消息流结构

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

### PG 验证（推荐）

> 解析 `POST /message` 响应只能看到 user message。验证 assistant 的 tool 调用应直接查 PG `part` 表：

```bash
# 验证各工具调用次数和状态（按实际 OPENCODE_DATABASE_URL 调整连接方式）
PGPASSWORD='<password>' psql "host=127.0.0.1 port=15432 dbname=opencode user=app password=<password> sslmode=disable" -c "
SELECT p.data->>'tool' as tool, p.data->'state'->>'status' as status, COUNT(*)
FROM message m JOIN part p ON p.message_id = m.id
WHERE m.session_id='\$SID' AND p.data->>'type'='tool'
GROUP BY p.data->>'tool', p.data->'state'->>'status'
ORDER BY tool;
"

# 验证消息角色分布
PGPASSWORD='<password>' psql "host=127.0.0.1 port=15432 dbname=opencode user=app password=<password> sslmode=disable" -c "
SELECT m.data->>'role' as role, COUNT(DISTINCT m.id) FROM message m
WHERE m.session_id='\$SID' GROUP BY m.data->>'role';
"

# 验证 grep/glob 不能全为空结果
PGPASSWORD='<password>' psql "host=127.0.0.1 port=15432 dbname=opencode user=app password=<password> sslmode=disable" -c "
SELECT p.data->>'tool' as tool,
  count(*) as total,
  count(*) FILTER (WHERE p.data->'state'->>'output' LIKE '%No files found%') as empty_results
FROM part p
WHERE p.session_id='\$SID'
  AND p.data->>'tool' IN ('grep', 'glob')
GROUP BY p.data->>'tool';
"

# 验证 sandbox 复用：父会话及其直接子会话不应各自创建独立 sandbox
PGPASSWORD='<password>' psql "host=127.0.0.1 port=15432 dbname=opencode user=app password=<password> sslmode=disable" -c "
WITH tree AS (
  SELECT id FROM session WHERE id='\$SID' OR parent_id='\$SID'
)
SELECT id, session_id, host, state, time_created, time_updated
FROM sandbox
WHERE session_id IN (SELECT id FROM tree)
ORDER BY time_created;
"
```
**期望**：
- `bash/read/grep/glob/task` 至少出现一次且 status=completed。
- 非 GPT 模型应出现 `write/edit`；GPT 模型应出现 `apply_patch`。
- `grep/glob` 不能全部为 `No files found`。
- 子会话不应因为独立 sandbox 导致 `/workspace` 为空。

### 问题判定标准

| 现象 | 判定 | 常见根因 |
|------|------|----------|
| `read /workspace` 有文件，但 `grep/glob` 全部 `No files found` | FAIL | sandbox 镜像缺少 `rg` 或 `rg` 不可执行 |
| 子会话 `read /workspace` 为 `(0 entries)` | FAIL | subagent 未复用 root sandbox |
| `task` completed 但子会话找不到父会话创建文件 | FAIL | `sandboxSessionID` 未正确传入工具上下文 |
| `bash rg --version` 失败 | FAIL | 默认 sandbox image 不含 ripgrep |
| 只有最终 assistant 文本，没有 tool part | FAIL | 模型未调用工具或工具注册失败 |
| PG 中 tool status=error | FAIL | 需要查看 `state.output` 和 sandbox/server 日志 |

---

## 结果汇总

| 用例 | 状态 | 说明 |
|------|------|------|
| T18.1a | ✅ | bash echo hello，PG tool=bash completed |
| T18.1b | ✅ | write `/workspace/test.txt` 内容为 hello，PG tool=write completed |
| T18.1c | ✅ | read `/workspace/test.txt`，PG tool=read completed，返回 hello |
| T18.1d | ✅ | read 目录 `/workspace`，PG tool=read completed，看到 `test.txt` |
| T18.1e | ✅ | 批量写 `a.txt`/`b.txt`/`c.txt`，同一消息含 `write×3 completed` |
| T18.1f | ✅ | `edit` 修改 `test.txt` 为 modified，PG tool=edit completed |
| T18.1g | ✅ | background bash `sleep 1 && echo bg-done`，PG tool=bash completed |
| T18.2 | ✅ | session `ses_15d763272ffeVyMjgYRDGWX3bu`；`grep×2`、`glob×1`、`read×1`、`bash rg×1` 均 completed，看到同一 `/workspace/tool-regression/src/search-target.ts`；`rg --version` 返回 ripgrep 14.1.0 |
| T18.3 | ✅ | `edit` completed，将 `PROFILE_CARD_SENTINEL` 改为 `PROFILE_CARD_PATCHED`；随后 `read` 与 `grep` 均确认 patched 内容 |
| T18.4 | ✅ | 父 `task` completed，子 session `ses_15d722806ffe9b6xIzjwr0s4Eu` 的 `glob/read/grep` completed；sandbox 表仅父 session 一条记录，子 agent 复用父 sandbox |
| T18.5 | ✅ | 开启 `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` 后，background `task` completed，`task_status×2 completed`，后台子 session `ses_15d71a3b3ffe8CYluGMfkKbuZt` 找到 2 个 ts 文件 |
| T18.6 | ✅ | `webfetch` completed，抓取 `https://example.com` 标题为 Example Domain；`skill` completed，加载 `frontend-design` skill |
| T18.7 | ✅ | 完整消息流验证通过：父 session 共 66 条消息，结构按 `user text → tool → assistant text` 交替出现，所有 tool part 状态为 completed |

**本轮全量回归环境**：宿主机 opencode server `127.0.0.1:14097`，PG auth，OpenSandbox Docker runtime `127.0.0.1:8080`，sandbox image `opencode-opensandbox:local`，`OPENCODE_SANDBOX_USE_SERVER_PROXY=false`，`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`，session `ses_15d763272ffeVyMjgYRDGWX3bu`。

**PG 工具调用统计**（父 session `ses_15d763272ffeVyMjgYRDGWX3bu`）：`bash×4`、`write×6`、`read×4`、`edit×2`、`grep×3`、`glob×1`、`task×2`、`task_status×2`、`webfetch×1`、`skill×1`，全部 `completed`。

**PG 子会话统计**：子 session `ses_15d722806ffe9b6xIzjwr0s4Eu` 执行 `glob×1/read×1/grep×1`，全部 `completed`；后台子 session `ses_15d71a3b3ffe8CYluGMfkKbuZt` 执行 `glob×1`，`completed`。

**PG 结构验证**：父 session message role 分布为 `assistant=44`、`user=22`；`grep/glob` 空结果统计为 `glob total=1 empty_results=0`、`grep total=3 empty_results=0`；父 session 及其直接子会话在 `sandbox` 表中仅有 1 条记录，`session_id=ses_15d763272ffeVyMjgYRDGWX3bu`，测试后清理为 state=`destroyed`，确认子 agent 没有创建独立 sandbox。

**实测注意**：本地 OpenSandbox Docker runtime 验证时，建议先启用 `keep-alive`，并通过配置放行 `external_directory`，否则跨 prompt 的 `/workspace` 文件可能因 idle destroy 或 permission ask 导致测试阻塞。此次回归还修复了 `grep` 对 OpenSandbox stdout chunks 使用 `join("")` 拼接导致 JSON 行粘连、误报 `No files found` 的问题。
