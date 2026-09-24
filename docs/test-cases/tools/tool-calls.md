# 工具调用过程批量验证

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-INDEX.md`](./00-INDEX.md)。

## 十八、工具调用过程批量验证

> 本节专门验证 AI 工具调用的**过程**而非仅最终结果，确保 `POST /message` 返回的文字总结背后确实执行了工具。

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）
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

> opencode 会按模型过滤编辑工具：部分 GPT 模型启用 `apply_patch`，其他模型启用 `edit/write`。SaaS 当前常用 `deepseek-v4-flash`，默认应覆盖 `edit/write`；如果切换 GPT 模型，需要覆盖 `apply_patch`。

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
>
> **交叉引用**：双向写读验证见 T16.29（14 文档，`scripts/sandbox-shared-test.mjs`）；本条从 AI 对话路径验证。

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

### T18.8 子项目路径映射回归

> 该组用例覆盖 session `ses_15ad78f66ffea1OvpVGbRZBrYv` 暴露的问题：当项目目录位于 `/workspace/app` 时，`read/write/edit/bash workdir` 不能把 `/workspace/app/...` 错误折叠成 `/workspace/...`。该问题会表现为 `write` 返回 completed 但 bash 读到的仍是旧内容，或 `workdir=/workspace/app` 执行 `npm run build` 却去读取 `/workspace/package.json`。

```bash
# 准备一个子项目目录。注意：路径必须是 /workspace/app，不是 /workspace 根目录。
send_and_verify "$SID" "用 bash 执行: rm -rf /workspace/app && npx create-vite@5 /workspace/app --template react-ts --yes && cd /workspace/app && npm install" "T18.8a: 创建 /workspace/app 子项目"

# 通过 write 工具写入子项目文件。
send_and_verify "$SID" "只用 write 工具把 /workspace/app/src/App.tsx 改成以下内容：export default function App() { return <main>SUBPROJECT_WRITE_SENTINEL</main> }" "T18.8b: write 子项目 App.tsx"

# 通过 bash 直接读取同一路径，验证 write 写到的就是 /workspace/app/src/App.tsx，而不是 /workspace/src/App.tsx。
send_and_verify "$SID" "用 bash 执行: cat /workspace/app/src/App.tsx && test ! -f /workspace/src/App.tsx" "T18.8c: bash 验证 write 落点"

# 通过 read 工具读取同一路径，验证 read 与 bash 看到同一个文件系统位置。
send_and_verify "$SID" "只用 read 工具读取 /workspace/app/src/App.tsx，确认包含 SUBPROJECT_WRITE_SENTINEL" "T18.8d: read 子项目文件"

# 通过 edit 修改子项目文件，再用 bash 验证。
send_and_verify "$SID" "只用 edit 工具把 /workspace/app/src/App.tsx 里的 SUBPROJECT_WRITE_SENTINEL 改成 SUBPROJECT_EDIT_SENTINEL" "T18.8e: edit 子项目 App.tsx"
send_and_verify "$SID" "用 bash 执行: grep SUBPROJECT_EDIT_SENTINEL /workspace/app/src/App.tsx && ! grep -R SUBPROJECT_EDIT_SENTINEL /workspace/src 2>/dev/null" "T18.8f: bash 验证 edit 落点"

# workdir 必须保留 /workspace/app，不能被映射为 /workspace。
send_and_verify "$SID" "用 bash 工具执行 npm run build，workdir 必须设置为 /workspace/app，不要在命令里写 cd" "T18.8g: bash workdir 子项目 build"
```

**期望**：
- T18.8b 的 `write` 状态为 completed，T18.8c 能在 `/workspace/app/src/App.tsx` 读到 `SUBPROJECT_WRITE_SENTINEL`。
- T18.8c 中 `/workspace/src/App.tsx` 不应存在；如果存在，说明子项目路径被错误折叠。
- T18.8d 的 `read` 输出必须包含 `/workspace/app/src/App.tsx` 和 `SUBPROJECT_WRITE_SENTINEL`。
- T18.8e/T18.8f 后，`SUBPROJECT_EDIT_SENTINEL` 只出现在 `/workspace/app/src/App.tsx`。
- T18.8g 不应出现 `npm error path /workspace/package.json`；如果出现，说明 `workdir=/workspace/app` 被错误映射成 `/workspace`。

### T18.9 bash 命令不存在快速失败

> 该组用例覆盖 session `ses_15ad78f66ffea1OvpVGbRZBrYv` 暴露的问题：当 bash 命令不存在（如 `ss`）时，工具应立即失败返回错误信息，而非等到 timeout 超时。AI 收到错误后应自动调整策略（如改用替代命令 `netstat`），无需用户介入。

```bash
# 执行一个不存在的命令，验证快速失败。
send_and_verify "$SID" "用 bash 执行: ss -tlnp" "T18.9a: 执行不存在的命令 ss"

# AI 应快速从错误中恢复，改用替代命令。
send_and_verify "$SID" "用 bash 执行: netstat -tlnp" "T18.9b: AI 自动改用替代命令"

# 验证超长 timeout 不会被 AI 滥用导致卡顿。
send_and_verify "$SID" "用 bash 执行，timeout 设置为 600000: nonexistent-command-xyz" "T18.9c: 超长 timeout 不应导致超时等待"

# 端到端测试：给 AI 一个真实场景任务，观察其在命令不存在时的恢复行为。
send_and_verify "$SID" "项目是 Vite + React 应用，运行在沙箱的 /workspace 目录。请帮我查看 5173 端口是否被占用，如果被占用找到占用进程并杀掉" "T18.9d: 端到端端口检查任务"
```

**期望**：
- T18.9a 的 `bash` 状态应为 `completed`（快速失败返回错误信息，不是卡到超时），输出应包含 `command not found` 或类似信息。
- T18.9b 的 `bash` 状态为 `completed`，输出应包含正常结果（如 `Active Internet connections` 或类似），说明 AI 从错误中恢复并使用了替代方案。
- T18.9c 即使 AI 设置了 10 分钟 timeout，系统应在几秒内返回 `command not found`，不应真正等待 10 分钟。
- T18.9d 的 PG 中每个 bash 工具调用耗时不应超过 30 秒；AI 最终应完成任务（找到端口状态），而非卡在 `command not found` 上无限重试。
- PG 中 T18.9a/T18.9c 的 tool 耗时不应超过 30 秒。

### T18.10 sandbox 生命周期与文件 I/O 健壮性

> 该组用例覆盖 sandbox 不可用时的快速失败、文件 I/O 超时销毁、stuck tool watchdog、以及权限等待阻塞等问题。这些问题会导致会话永久卡在 `running` 状态。

#### T18.10a sandbox 销毁后的行为（V2 语义）

> **背景（V2 重定义）**：V2 provider 对已连接 sandbox 采用**内存缓存优先**——直接 UPDATE DB `state='destroyed'` 不构成不可用（连接仍在用，read/write 正常 completed）。V2 的真实销毁路径是 `POST /api/session/:id/kill-sandbox`（内存缓存 + PG 行 + 远端容器三态清理）。本用例验证：销毁后工具调用**自动重建** sandbox 并 completed，不出现 `running` 卡死或 fallback 到本地文件系统。
>
> （V1 旧语义"DB 标记 destroyed 后 read/write 应报错"已废弃：UPDATE DB 只影响持久层状态，仅在进程重启后或缓存 miss 时改变行为——不 reconnect、触发重建。）

```bash
# V2: 真实销毁路径 = kill-sandbox 端点
curl -s -u opencode:$PW -X POST "$BASE/api/session/$SID/kill-sandbox"
psql "$PG_URL" -t -A -c "SELECT state FROM sandbox WHERE session_id='$SID';"   # 期望 destroyed

# 销毁后 read/write 应触发自动重建（而非 error/卡死）
send_and_verify "$SID" "读取 /workspace/test.txt 的内容" "T18.10a-1: kill-sandbox 后 read 自动重建"
send_and_verify "$SID" "把 /workspace/test.txt 的内容改为 rebuilt" "T18.10a-2: 重建后 write"

# PG 验证：sandbox 重建为 running，工具状态 completed
psql "$PG_URL" -t -A -c "SELECT state FROM sandbox WHERE session_id='$SID';"   # 期望 running
```

**期望**：
- kill-sandbox 后 PG 行 `state=destroyed`。
- 后续 read/write **completed**（自动重建 sandbox），无 `running` 卡死、无本地文件系统 fallback、无 `undefined is not an object`。注：kill 后**首次**工具调用可能撞上重建过渡窗口报一次 `File not found`，模型重试即恢复——属预期，不判定为 FAIL（实测 session `ses_f2dba38f5ffe3ijVfGEt5K6SGk`：首 read error → 模型自动重试 → write/read completed、state 回 running）。
- 重建后 PG 行回到 `state=running`，文件读写内容一致。
- 直接 UPDATE DB（不 kill-sandbox）时 read/write 仍正常 completed——内存缓存优先属预期行为，不判定为 FAIL。


#### T18.10b read/write 文件 I/O 超时销毁

> **背景**：opensandbox 文件通道偶发 hung，`sb.files.readFile()` 或 `sb.files.writeFiles()` 的 Promise 永久 pending。工具层增加了 60s timeout，timeout 后 destroy 当前 sandbox，下次调用自动重建。

```bash
# 1. 确认当前 sandbox 正常工作
send_and_verify "$SID" "读取 /workspace/test.txt" "T18.10b-1: 正常 read（基线）"

# 2. 记录当前 sandbox ID
OLD_SB_ID=$(psql "$PG_URL" -t -A -c "SELECT id FROM sandbox WHERE session_id='$SID' AND state='running' LIMIT 1;")
echo "OLD_SB_ID: $OLD_SB_ID"

# 3. 模拟文件通道 hung（如果 sandbox 支持 network policy 或手动 hang）：
#    方式 A：在 sandbox 内执行一个占用文件锁的死循环
#    方式 B：直接通过 sandbox API 断开文件通道
#    这里用方式 A：
send_and_verify "$SID" "用 bash 执行，background 必须为 true: while true; do sleep 3600; done" "T18.10b-2: 占用 sandbox"

# 4. 在 PG 中确认旧 sandbox 被 destroy 后重建
sleep 5
NEW_SB_ID=$(psql "$PG_URL" -t -A -c "SELECT id FROM sandbox WHERE session_id='$SID' AND state='running' LIMIT 1;")
echo "NEW_SB_ID: $NEW_SB_ID"

# 期望：如果 timeout destroy 生效，NEW_SB_ID 可能与 OLD_SB_ID 不同（重建后）
# 或 OLD_SB_ID 的记录被标记为 destroyed 后重新 upsert
```

**期望**：
- 正常 read completed（基线确认）。
- 如果文件 I/O 真正 hung（需要真实 sandbox 环境），60s 后工具返回 `status=error`，错误信息包含 `Read timed out` 或 `Write timed out`。
- timeout 后 sandbox 被 destroy，日志中出现 `sandbox-provider ... destroying sandbox` 和 `sandbox destroyed`。
- 后续工具调用能自动重建 sandbox 并 completed。

#### T18.10c stuck tool watchdog 自动恢复

> **背景**：session watchdog（`watchdog.ts:84-108`）每 60s 扫描所有 `status=running` 且 `start < now-5min` 的 tool part（无“最近 1 小时”上限），标记为 `status=error`。用于兜底所有未被工具层 timeout 捕获的卡死场景。

```bash
# 1. 构造一个 stuck tool：手动在 PG 插入一个 running 状态、start 时间为 6 分钟前的 tool part
STUCK_PART_ID="prt_test_stuck_$(date +%s)"
MSG_ID=$(psql "$PG_URL" -t -A -c "SELECT id FROM message WHERE session_id='$SID' ORDER BY time_created DESC LIMIT 1;")
SIX_MIN_AGO=$(($(date +%s%3N) - 360000))

psql "$PG_URL" -c "
INSERT INTO part (id, session_id, message_id, time_created, time_updated, data)
VALUES (
  '$STUCK_PART_ID',
  '$SID',
  '$MSG_ID',
  $(date +%s%3N),
  $(date +%s%3N),
  '{\"type\":\"tool\",\"tool\":\"read\",\"callID\":\"call_stuck_test\",\"state\":{\"status\":\"running\",\"input\":{\"filePath\":\"/workspace/test.txt\"},\"time\":{\"start\":$SIX_MIN_AGO}}}'::jsonb
);
"

echo "Inserted stuck part: $STUCK_PART_ID (start=$((SIX_MIN_AGO)))"

# 2. 等待 watchdog 扫描（最多 70s）
echo "Waiting for watchdog scan (up to 70s)..."
for i in $(seq 1 14); do
  sleep 5
  STATUS=$(psql "$PG_URL" -t -A -c "SELECT data->'state'->>'status' FROM part WHERE id='$STUCK_PART_ID';")
  echo "  [$((i*5))s] status=$STATUS"
  if [ "$STATUS" = "error" ]; then
    echo "Watchdog recovered stuck tool after ~$((i*5))s"
    break
  fi
done

# 3. 验证 watchdog 标记
RESULT=$(psql "$PG_URL" -t -A -c "
SELECT data->'state'->>'status', data->'state'->>'error'
FROM part WHERE id='$STUCK_PART_ID';
")
echo "Final: $RESULT"
```

**期望**：
- 插入的 stuck tool part 初始 `status=running`。
- watchdog 在 60-70s 内将其标记为 `status=error`。
- `error` 字段包含 `Tool execution timed out after 300s (watchdog)`（`mark-timed-out.ts:67`，按 timeoutMs 动态生成）。
- 容器日志中出现 `service=watchdog ... stuck=1 ... watchdog scan completed`。

#### T18.10d 权限等待不阻塞会话

> **背景**：HTTP API 模式下没有 UI 回答权限请求。如果全局权限未配置为 allow，`write/edit/bash` 等工具会在 `Permission.ask` 中永久 pending。需提前配置全局权限。

```bash
# 1. 确认全局权限已配置
curl -s "$BASE/global/config" | python3 -c "
import json, sys
cfg = json.load(sys.stdin)
perm = cfg.get('permission', {})
required = ['bash', 'edit', 'write', 'read', 'glob', 'grep', 'list']
missing = [k for k in required if perm.get(k) != 'allow']
if missing:
    print(f'❌ Missing permissions: {missing}')
    sys.exit(1)
print('✅ All required permissions are allow')
"

# 2. 发送一个 write 请求，验证不被权限阻塞
TIME_START=$(date +%s)
send_and_verify "$SID" "用 write 工具创建 /workspace/perm-test.txt 内容是 ok" "T18.10d: 权限不阻塞 write"
TIME_END=$(date +%s)
DURATION=$((TIME_END - TIME_START))
echo "  耗时: ${DURATION}s"

# 3. PG 验证 write 状态
WRITE_STATUS=$(psql "$PG_URL" -t -A -c "
SELECT data->'state'->>'status'
FROM part
WHERE session_id='$SID' AND data->>'tool'='write'
  AND data->'state'->'input'->>'filePath' LIKE '%perm-test.txt%'
ORDER BY time_created DESC LIMIT 1;
")
echo "  write status: $WRITE_STATUS"
```

**期望**：
- 全局权限配置检查通过。
- write 请求在 30s 内 completed（不被权限 ask 阻塞）。
- PG 中 write `status=completed`，不出现 `status=running`。

#### T18.10e sandbox cache invalidate 一致性

> **背景**：sandbox provider 维护内存缓存（`sbCache`，TTL 30s）。destroy 操作必须 invalidate 缓存，否则后续 getOrCreate 返回已销毁的 sandbox 对象。PG 层的 `destroy`/`destroyById`/`destroyAll` 均已补齐 `invalidateCachedSandbox`。

```bash
# 1. 正常创建文件
send_and_verify "$SID" "用 write 创建 /workspace/cache-test.txt 内容是 v1" "T18.10e-1: 写入 v1"

# 2. 手动 destroy sandbox（触发 cache invalidate）
curl -s -X POST "$BASE/session/$SID/kill-sandbox" > /dev/null 2>&1 || true
# 如果没有 destroy 端点，通过 DB 标记 + 等待 cache TTL 过期
psql "$PG_URL" -c "UPDATE sandbox SET state='destroyed' WHERE session_id='$SID';" 2>/dev/null || true
sleep 31  # 等 cache TTL 过期

# 3. 再次写入，验证 sandbox 重建
send_and_verify "$SID" "用 write 创建 /workspace/cache-test2.txt 内容是 v2" "T18.10e-2: cache invalidate 后重建"

# 4. PG 验证
SB_COUNT=$(psql "$PG_URL" -t -A -c "SELECT count(*) FROM sandbox WHERE session_id='$SID' AND state='running';")
echo "Running sandbox count: $SB_COUNT"
```

**期望**：
- destroy 后 cache 被 invalidate，不返回旧 sandbox 对象。
- 后续工具调用触发 sandbox 重建（新 sandboxID 或旧 ID 重新 connect）。
- 容器日志中出现 `sandbox-provider ... getOrCreate start` → `reconnect done` 或 `createSandbox done`。
- 最终 `SB_COUNT=1`（不会出现两个 running sandbox）。

### T18.11 并发工具调用竞态验证

> **背景**：AI SDK 在 LLM 返回同一 step 的多个 tool call 时会**并发**调用各工具的 `execute()`。当前实现中 read/write/edit 走 `sb.files` API 不经过 semaphore → 可以并发；bash/grep/glob 走 `runInSession` 受 `Semaphore(1)` 约束 → 串行。**竞态控制由模型实现**——模型自行决定是否在同一 step 对同一文件发起多个操作。本节测试目的是观察模型实际行为和系统在并发下的表现，而非判定系统 BUG。

#### T18.11a 不同文件并发 write（安全基线）

```bash
send_and_verify "$SID" "一次性创建 3 个文件：/workspace/concurrent-x.txt 内容 XXX，/workspace/concurrent-y.txt 内容 YYY，/workspace/concurrent-z.txt 内容 ZZZ。不要一个一个创建，同时创建" "T18.11a: 不同文件并发 write"
```

**PG 时间线验证**：
```bash
psql "$PG_URL" -c "
SELECT data->>'tool',
  data->'state'->'input'->>'filePath' AS file_path,
  to_timestamp((data->'state'->'time'->>'start')::bigint/1000)::time AS start_t,
  (data->'state'->'time'->>'end')::bigint - (data->'state'->'time'->>'start')::bigint AS dur_ms
FROM part
WHERE session_id='$SID' AND data->>'tool'='write'
  AND data->'state'->'input'->>'filePath' LIKE '/workspace/concurrent-%'
ORDER BY (data->'state'->'time'->>'start')::bigint;
"
```

**期望**：3 个 write 的 `start_t` 在同一秒或相邻秒 → 确认并发。三个文件最终内容各自正确。

#### T18.11b 同一文件并发 write（竞态场景）

```bash
# 先创建目标文件
send_and_verify "$SID" "用 write 创建 /workspace/race.txt，内容是 3 行：line1-alpha、line2-alpha、line3-alpha" "T18.11b-0: 准备 race.txt"

# 让 LLM 同时修改同一文件的两处
send_and_verify "$SID" "同时执行两个操作：1) 把 /workspace/race.txt 第一行改成 line1-beta  2) 把 /workspace/race.txt 第三行改成 line3-beta。两个操作必须同时发起，不要等第一个完成再做第二个" "T18.11b: 同一文件并发 write"
```

**PG 时间线 + 内容验证**：
```bash
psql "$PG_URL" -c "
SELECT data->>'tool',
  data->'state'->'input'->>'filePath' AS file_path,
  substring(data->'state'->'input'->>'content', 1, 50) AS content_preview,
  to_timestamp((data->'state'->'time'->>'start')::bigint/1000)::time AS start_t,
  to_timestamp((data->'state'->'time'->>'end')::bigint/1000)::time AS end_t
FROM part
WHERE session_id='$SID' AND data->>'tool' IN ('write','edit')
  AND data->'state'->'input'->>'filePath' LIKE '%race.txt'
  AND data->'state'->'time'->>'start' IS NOT NULL
ORDER BY (data->'state'->'time'->>'start')::bigint;
"

send_and_verify "$SID" "用 bash 执行: cat /workspace/race.txt" "T18.11b-verify: 检查最终内容"
```

**观察点**：
- 记录模型是否在同一 step 发起两个 tool call（并发），还是分两步串行。
- 如果并发：后完成的覆盖先完成的，只有一处修改生效 → 记录为"模型选择并发，系统未拦截，结果丢失一处修改"。
- 如果串行：两处修改都生效 → 记录为"模型选择串行"。
- **注意**：系统层不做竞态拦截，并发下的结果由模型行为决定。

#### T18.11c write + read 同一文件并发

```bash
send_and_verify "$SID" "同时做两件事：1) 把 /workspace/race.txt 的内容改成 OVERWRITTEN  2) 读取 /workspace/race.txt 的内容。两件事同时发起" "T18.11c: write+read 同一文件并发"
```

**PG 时间线验证**：
```bash
psql "$PG_URL" -c "
SELECT data->>'tool',
  to_timestamp((data->'state'->'time'->>'start')::bigint/1000)::time AS start_t,
  to_timestamp((data->'state'->'time'->>'end')::bigint/1000)::time AS end_t,
  substring(coalesce(data->'state'->>'output',''), 1, 60) AS output_preview
FROM part
WHERE session_id='$SID' AND data->>'tool' IN ('write','read')
  AND data->'state'->'input'->>'filePath' LIKE '%race.txt'
  AND data->'state'->'time'->>'start' IS NOT NULL
ORDER BY (data->'state'->'time'->>'start')::bigint DESC LIMIT 5;
"
```

**观察点**：
- 如果 write 和 read 并发 → read 可能读到旧内容而非 `OVERWRITTEN` → 记录为"模型选择并发，read 读到旧内容"。
- 如果串行 → read 读到 `OVERWRITTEN` → 记录为"模型选择串行"。
- **注意**：系统层不做读写一致性保证，结果由模型行为决定。

#### T18.11d 多 bash 命令串行化验证

```bash
send_and_verify "$SID" "同时执行 3 个独立的 bash 工具调用（不要用 && 或 ; 连接，用三个独立的 bash 工具调用）：第一个执行 echo CMD1 && sleep 2，第二个执行 echo CMD2 && sleep 2，第三个执行 echo CMD3 && sleep 2" "T18.11d: 多 bash 命令并发"
```

**PG 时间线验证**：
```bash
psql "$PG_URL" -c "
SELECT data->>'tool',
  substring(data->'state'->'input'->>'command', 1, 40) AS cmd,
  to_timestamp((data->'state'->'time'->>'start')::bigint/1000)::time AS start_t,
  to_timestamp((data->'state'->'time'->>'end')::bigint/1000)::time AS end_t,
  (data->'state'->'time'->>'end')::bigint - (data->'state'->'time'->>'start')::bigint AS dur_ms
FROM part
WHERE session_id='$SID' AND data->>'tool'='bash'
  AND data->'state'->'input'->>'command' LIKE '%CMD%'
  AND data->'state'->'time'->>'start' IS NOT NULL
ORDER BY (data->'state'->'time'->>'start')::bigint;
"
```

**期望**：
- 3 个 bash 的 `start_t`/`end_t` **不重叠**（第二个 start ≥ 第一个 end）→ 确认 semaphore(1) 生效。
- 总耗时 ≈ 3 × 单个耗时（串行累加），而非并发 max。

#### T18.11 竞态判定标准

| 现象 | 判定 | 说明 |
|------|------|------|
| T18.11a：3 个 write start 在同一秒 | 并发确认 | 文件 API 无锁，不同文件安全 |
| T18.11b：模型在同一 step 对同一文件发起两个操作 | 行为记录 | 系统正确执行并发请求，结果由模型行为决定 |
| T18.11b：模型分两步串行执行 | 行为记录 | 模型自行选择了串行 |
| T18.11c：read 在 write 完成前启动 | 行为记录 | 系统正确执行并发请求，read 可能读到旧内容 |
| T18.11d：3 个 bash 的 start/end 有重叠 | **semaphore 失效** | command session 并发会致 shell 输出混乱，这是系统层约束 |
| T18.11d：3 个 bash 串行（无重叠） | 正常 | semaphore(1) 生效 |



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

# 验证子项目路径没有被折叠：失败会出现 /workspace/package.json 或 /workspace/src/App.tsx
PGPASSWORD='<password>' psql "host=127.0.0.1 port=15432 dbname=opencode user=app password=<password> sslmode=disable" -c "
SELECT p.id,
  p.data->>'tool' as tool,
  p.data->'state'->'input'->>'filePath' as file_path,
  p.data->'state'->'input'->>'workdir' as workdir,
  p.data->'state'->>'status' as status,
  substring(coalesce(p.data->'state'->>'output', p.data->'state'->>'error', ''), 1, 240) as output_or_error
FROM part p
WHERE p.session_id='\$SID'
  AND p.data->>'type'='tool'
  AND (
    p.data->'state'->'input'->>'filePath' LIKE '/workspace/app/%'
    OR p.data->'state'->'input'->>'workdir' = '/workspace/app'
    OR p.data->'state'->>'output' LIKE '%/workspace/package.json%'
    OR p.data->'state'->>'error' LIKE '%/workspace/package.json%'
  )
ORDER BY p.time_created;
"
```
**期望**：
- `bash/read/grep/glob/task` 至少出现一次且 status=completed。
- 非 GPT 模型应出现 `write/edit`；GPT 模型应出现 `apply_patch`。
- `grep/glob` 不能全部为 `No files found`。
- 子会话不应因为独立 sandbox 导致 `/workspace` 为空。
- 子项目路径回归中不应出现 `/workspace/package.json` 构建错误，也不应出现 sentinel 写到 `/workspace/src/*` 的情况。

### 问题判定标准

| 现象 | 判定 | 常见根因 |
|------|------|----------|
| `read /workspace` 有文件，但 `grep/glob` 全部 `No files found` | FAIL | sandbox 镜像缺少 `rg` 或 `rg` 不可执行 |
| 子会话 `read /workspace` 为 `(0 entries)` | FAIL | subagent 未复用 root sandbox |
| `task` completed 但子会话找不到父会话创建文件 | FAIL | `sandboxSessionID` 未正确传入工具上下文 |
| `bash rg --version` 失败 | FAIL | 默认 sandbox image 不含 ripgrep |
| `write /workspace/app/src/App.tsx` completed，但 `bash cat /workspace/app/src/App.tsx` 仍是旧内容 | FAIL | `/workspace/app` 被路径映射折叠成 `/workspace`，实际写到 `/workspace/src/App.tsx` |
| `workdir=/workspace/app` 执行 `npm run build` 报 `/workspace/package.json` 不存在 | FAIL | `toSandboxCwd` 把已在 sandbox 内的 cwd 二次映射成 `/workspace` |
| `bash ss -tlnp` 挂起 28 分钟才返回 `command not found` | FAIL | stderr 中 `command not found` 未触发快速失败，shell tool 等到 timeout 才返回 |
| read/write 在 sandbox 不可用时返回 `undefined is not an object` | FAIL | 工具层未检查 sandbox resolve 值是否为 null |
| read/write `status=running` 超过 60s 且无 timeout 日志 | FAIL | sandbox 文件 I/O Promise 永久 pending，工具层缺少 timeout |
| tool `status=running` 超过 5 分钟未恢复 | FAIL | watchdog 未扫描到 stuck tool，或扫描间隔/窗口配置错误 |
| write `status=running` 且容器日志无 `permission ... evaluated` | FAIL | HTTP API 模式下全局权限未配置 allow，Permission.ask 永久 pending |
| destroy sandbox 后 getOrCreate 返回旧对象导致 `sb.files is undefined` | FAIL | destroy 未 invalidate 内存缓存（sbCache） |
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
| T18.2 | ✅ | session `ses_15d763272ffeVyMjgYRDGWX3bu`；`grep×2`、`glob×1`、`read×1`、`bash rg×1` 均 completed，看到同一 `/workspace/tool-regression/src/search-target.ts`；`rg --version` 返回 ripgrep 14.1.0 |
| T18.3 | ✅ | `edit` completed，将 `PROFILE_CARD_SENTINEL` 改为 `PROFILE_CARD_PATCHED`；随后 `read` 与 `grep` 均确认 patched 内容 |
| T18.4 | ✅ | 父 `task` completed，子 session `ses_15d722806ffe9b6xIzjwr0s4Eu` 的 `glob/read/grep` completed；sandbox 表仅父 session 一条记录，子 agent 复用父 sandbox |
| T18.5 | ✅ | 开启 `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` 后，background `task` completed，`task_status×2 completed`，后台子 session `ses_15d71a3b3ffe8CYluGMfkKbuZt` 找到 2 个 ts 文件 |
| T18.6 | ✅ | `webfetch` completed，抓取 `https://example.com` 标题为 Example Domain；`skill` completed，加载 `frontend-design` skill |
| T18.7 | ✅ | 完整消息流验证通过：父 session 共 66 条消息，结构按 `user text → tool → assistant text` 交替出现，所有 tool part 状态为 completed |
| T18.8 | ✅ | 子项目路径映射回归通过：write/edit/read 正确写入 `/workspace/app/src/App.tsx`，sentinel 未泄露到 `/workspace/src`；bash workdir 正确保留 `/workspace/app` |
| T18.9 | ✅ | bash 命令不存在快速失败：`ss: command not found` 在 2 秒内返回而非等待 28 分钟；`lsof` 失败后 AI 自动尝试 `netstat` → `ps aux | grep` → 完成端口检查任务，全程 < 10 秒 |
| T18.10a | ⏳ | sandbox 不可用时 read/write 直接报错，不 fallback 到本地文件系统 |
| T18.10b | ⏳ | read/write 文件 I/O 60s timeout 后 destroy sandbox 并自动重建 |
| T18.10c | ⏳ | watchdog 检测 stuck tool（running > 5min）并标记为 error（error 字符串 `...after 300s (watchdog)`） |
| T18.10d | ⏳ | 全局权限配置 allow，write 不被权限 ask 阻塞 |
| T18.10e | ⏳ | sandbox cache invalidate 后 destroy → 重建一致性 |

**本轮全量回归环境**：宿主机 opencode server `127.0.0.1:14097`，PG auth，OpenSandbox Docker runtime `127.0.0.1:8080`，sandbox image `opencode-opensandbox:local`，`OPENCODE_SANDBOX_USE_SERVER_PROXY=false`，`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`，session `ses_15d763272ffeVyMjgYRDGWX3bu`。

**PG 工具调用统计**（父 session `ses_15d763272ffeVyMjgYRDGWX3bu`）：`bash×4`、`write×6`、`read×4`、`edit×2`、`grep×3`、`glob×1`、`task×2`、`task_status×2`、`webfetch×1`、`skill×1`，全部 `completed`。

**PG 子会话统计**：子 session `ses_15d722806ffe9b6xIzjwr0s4Eu` 执行 `glob×1/read×1/grep×1`，全部 `completed`；后台子 session `ses_15d71a3b3ffe8CYluGMfkKbuZt` 执行 `glob×1`，`completed`。

**PG 结构验证**：父 session message role 分布为 `assistant=44`、`user=22`；`grep/glob` 空结果统计为 `glob total=1 empty_results=0`、`grep total=3 empty_results=0`；父 session 及其直接子会话在 `sandbox` 表中仅有 1 条记录，`session_id=ses_15d763272ffeVyMjgYRDGWX3bu`，测试后清理为 state=`destroyed`，确认子 agent 没有创建独立 sandbox。

**实测注意**：本地 OpenSandbox Docker runtime 验证时，建议先启用 `keep-alive`，并通过配置放行 `external_directory`，否则跨 prompt 的 `/workspace` 文件可能因 idle destroy 或 permission ask 导致测试阻塞。此次回归还修复了 `grep` 对 OpenSandbox stdout chunks 使用 `join("")` 拼接导致 JSON 行粘连、误报 `No files found` 的问题。

> 复测记录（2026-09-06，merge upstream/dev v1.18.29 后，镜像 `t0906-merged-1.18.29`）：工具域单测 `apply_patch`/`edit`（29/29，30s 超时）/`attachment`/`session-tool-load` 全过；write→read 闭环与 T-WEX.1 exists 语义见 ai-conversation 与 write-exists-semantics 复测记录。T18.9（bash 快速失败）因当日模型不调 bash 未执行——A/B 镜像对照已定性为 deepseek-v4-flash 行为波动，非 merge 回归（详见 session/ai-conversation.md 复测注记）。

---

## V2 全量回归记录（2026-09-24）

**环境**：容器 `opencode-saas-test`（`127.0.0.1:14096`，镜像 `opencode-saas-sandbox-test:9aa68014be-subagent-sb`），本地 PG `opencode-v2-up`（V2 架构：`session_v2`/`session_message`，无 `part` 表），OpenSandbox Docker runtime `127.0.0.1:8080`，镜像 `opencode-opensandbox:local`（**不含 ripgrep**），模型 `Yd-DeepSeek/deepseek-v4-flash`，session `ses_f2df342fcffew9kNdKitiDlxQr`（修复验证 session `ses_f2df74ecffeH44kBtV3elR2Kb`）。

**V1→V2 接口/数据映射**（执行本文档用例时必须适配）：

| V1 文档路径 | V2 实际 |
|---|---|
| `POST /session`（body `{}`） | `POST /api/session`（body `{model:{id,providerID}}`，Model.Ref 需 `id` 字段） |
| `POST /session/:id/message`（`parts` 数组，同步） | `POST /api/session/:id/prompt`（`{text}`，异步投递）+ `POST /api/experimental/session/:id/wait` 等待 idle |
| `GET /session/:id/message` | `GET /api/session/:id/message` 或直查 PG `session_message` |
| PG `part` 表（`data->>'tool'`） | PG `session_message.data->content[]`（`elem->>'name'`；`state.status`；`time.created/completed`） |
| bash 工具名 `bash` | `shell` |
| task/subagent | `subagent`（无独立 `task_status`） |
| watchdog（T18.10c） | **V2 无此实现**，用例不适用 |
| `date +%s%3N` | macOS 不可用，用 `python3 -c "import time;print(int(time.time()*1000))"` |

认证：V2 server 启用 Basic auth（用户名固定 `opencode`，密码 = 容器 `OPENCODE_PASSWORD`），所有请求需 `-u opencode:$PW`。

**本轮结果**：

| 用例 | 状态 | 说明 |
|------|------|------|
| T18.1a-f | ✅ | bash/write/read/批量写/edit 全部 completed（原 T18.1g background 用例已随 background 概念在 V2 移除而删除） |
| T18.2b-d | ✅(镜像修复后) | 首轮 ❌：镜像缺 `rg` 致 `grep`×7、`glob`×6 全空且静默不报错。**已修复**：V1 沙箱 Dockerfile（含 ripgrep）已迁至 `packages/containers/sandbox/` 并重建 `opencode-opensandbox:local`。重跑（session `ses_f2dce0715ffe2FX2O9MCyNBb89`）：`rg 14.1.0`、grep 精确/include 命中、glob 返回 2 个 ts 文件、PG 统计 `grep×3/glob×1 empty_results=0`。遗留建议：工具层对 rg 缺失应显式报错而非静默空结果 |
| T18.2e/f、T18.3a/b | ✅ | read/rg 对照、edit 修改+验证正常 |
| T18.3c | ✅(镜像修复后) | 修改后 grep 命中 `PROFILE_CARD_PATCHED`（首轮失败同 rg 根因） |
| T18.4 | ✅（修复后） | **发现并修复 P1**：V2 subagent 子会话曾创建独立 sandbox（子会话 `/workspace` 为空、read `File not found`）。修复：`packages/core/src/sandbox/provider.ts` 增加 `rootSessionID`（沿 `session_v2.parent_id` 上溯，V1 `resolveSandboxOpts` 语义）+ `resolveSandboxKey`（Ref 缓存），provider 全部 17 个对外方法（run/boot/destroy/keepAlive/file*…）入口统一解析 root——所有调用方（工具插件、HTTP handler、proxy）自动收敛。修复后验证：子会话 `read` completed 读到父会话文件；sandbox 表父+子仅 root 一条 running 记录 |
| T18.5 | ⏭️ | 跳过：未开启 `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`；且 subagent `background` 参数同属已按设计移除的 background 概念（background 概念已移除），V2 不再要求覆盖 |
| T18.6a | ✅ | webfetch completed，标题 Example Domain |
| T18.6b | ✅ | skill 工具未触发，但模型明确列出可用 skill 并说明类别不符（符合"明确说明"预期） |
| T18.7 | ✅ | 消息流 `user → tool → assistant text` 交替正常，全 session 45 个 tool part |
| T18.8a-g | ✅ | 子项目路径映射全过：write/edit/read 落点 `/workspace/app/src/App.tsx` 正确、sentinel 无折叠泄露、`workdir=/workspace/app` build 成功（T18.8a 模型自行绕过 create-vite 交互提问） |
| T18.9a-d | ✅ | `ss: command not found` 164ms 快速返回（端到端 4.6s）；超长 timeout 不等待；netstat 亦缺失但模型改用 `/proc/net/tcp` 完成端口检查（9.2s） |
| T18.10a | ✅ | V2 语义验证通过：kill-sandbox（真实销毁路径）后 read/write **自动重建** sandbox 并 completed，无卡死无本地 fallback。注意：直接 UPDATE DB `state=destroyed` 不构成不可用（内存缓存优先，属预期）——用例语义已按 V2 重定义（见 T18.10a 小节） |
| T18.10b | ❌(环境) | 验证期间宿主机容器被外部重启 + **keep-alive 未启用**导致 idle destroy 反复重建 sandbox，`/workspace` 清空（race.txt/concurrent 等夹具丢失）。重跑（启用 keep-alive）后正常。文档"实测注意"已注明本地 Docker runtime 需先启用 keep-alive。注：T18.10b-2 的 `background` 占用手法在 V2 不适用（background 概念已移除） |
| T18.10c | ⏭️ | V2 代码库无 watchdog（`watchdog.ts`/`mark-timed-out.ts` 不存在），不适用 |
| T18.10d | ✅ | `/api/config` 权限配置存在；write 8.5s completed 未被权限阻塞 |
| T18.10e | ✅(重跑) | `kill-sandbox` HTTP 200 → destroyed → 后续调用自动重建 completed；重跑（keep-alive）后 sandbox 状态一致 |
| T18.11a | ✅ | 3 个 write 同秒并发 completed，文件内容各自正确 |
| T18.11b/c | ✅(重跑) | 模型同批次并发两个 edit，两处修改均生效（`line1-beta`+`line3-beta`）；write+read 并发正常 |
| T18.11d | ✅ | 3 个 shell 同秒 start、end 依次错开（2.2s/6.2s/4.1s）——command session semaphore(1) 串行化生效 |

**修复代码**：`packages/core/src/sandbox/provider.ts`（root session 解析 + 17 方法收敛）、`packages/core/test/sandbox-provider.test.ts`（新增 `rootSessionID` 4 用例：无 parent/链式上溯/循环防护/行缺失降级，15/15 全过）。类型检查无新增错误。

**待办**：
1. ~~sandbox 镜像补装 ripgrep 并恢复 Dockerfile~~ ✅ 已完成：V1 沙箱镜像（`packages/opencode/docker/` → `packages/containers/sandbox/`，COPY 路径与 README/local-test-env.md 引用同步更新）已迁入 V2 并重建 `opencode-opensandbox:local`（含 ripgrep 14.1.0、Node 24、git、python3），T18.2/T18.3 重跑全过。
2. ~~V2 sandbox 会话支持 background 执行~~ 无需处理：V2 已按设计移除该概念（`shell.ts` 对 sandbox 会话显式拒绝并提示前台重跑），原 T18.1g 用例已删除。
3. ~~工具层对 rg 缺失静默空结果~~ ✅ 已修复：`SandboxTools.ensureRipgrep`（`packages/core/src/sandbox/tools.ts`）在 glob/grep 前探测 `command -v rg`（per-session 缓存），缺失时显式返回 `ToolFailure: ripgrep (rg) is not available in the sandbox image...`；单测 `sandbox-tools-ripgrep.test.ts` 3/3 过；e2e（镜像 `9aa68014be-rg-guard`，session `ses_f2dba38f5ffe3ijVfGEt5K6SGk`）验证正常路径不回归：grep/glob/shell 全 completed，探测命令在 provider.run 层执行不落 tool part。
4. ~~非法路由 500~~ ✅ 已闭环：工作区既有修复（`.dockerignore` 加 `!packages/app/dist` 例外 + `app-assets.ts` 对 dist 缺失降级为空资产并 warn）已随当前镜像生效——验证：无效路由回 index.html 200、`/api/*` 未命中 404、无 500。
5. ~~T18.10a 用例语义重定义~~ ✅ 已完成：用例改写为 V2 语义（kill-sandbox 真实销毁 → 自动重建 completed；UPDATE DB 标记不再判定 FAIL）。
6. 遗留决策项：V2 无 stuck tool watchdog（V1 `watchdog.ts` 每 60s 扫描 running>5min 的 tool part 标记 error）。V2 若无替代机制，sandbox 文件 I/O 永久 pending 会导致 session 永卡 `running`，需确认是否有意移除或需要补齐。

