# Session Compaction 历史文件引用（摘要可检索历史）

> 验证 V2 Session Runner 在 compaction（自动摘要）时，将被压缩的对话历史完整落盘，并让 Agent 在摘要后按需检索找回细节。

## 功能背景与效果

上下文窗口被填满时，SessionRunner 触发一次 compaction，用一个 LLM 摘要替换旧对话。摘要是有损压缩，Agent 可能丢失任务关键细节。

本功能参照 Cursor「将对话历史作为文件引用」方案，在 compaction 成功时把**被压缩部分的历史**（含完整、不截断的工具输出）落盘到 `tool-output/`，并将文件路径写入 `Compaction` 消息。后续 Agent 生成的 `<conversation-checkpoint>` 中附带检索提示，摘要缺细节时可用 Grep / Read(offset/limit) 回检索，无需整读。

| 能力 | 效果 |
|------|------|
| 历史完整落盘 | 被压缩消息序列化为 `## <id> \| <type> \| <ISO时间>` 分节的 Markdown，工具输出**不截断** |
| 路径持久化 | `Compaction.Ended` 事件 → `Compaction` 消息 `historyPath` 字段 → DB 落库 |
| 检索提示注入 | `<conversation-checkpoint>` 附带「完整记录在 <path>，可用 Grep/Read 检索，勿整读」 |
| 零额外 LLM 成本 | 落盘是纯文件 I/O，不增加 provider 调用 |
| 权限零配置 | 文件落 `tool-output/`，复用 `Truncate.GLOB` 默认 allow（`agent.ts`） |
| 自动清理 | 文件名带 `tool_` 前缀，沿用 `truncate.ts` 每小时、7 天保留的回收机制 |
| 优雅降级 | 落盘失败仅跳过 `historyPath`，不影响摘要与 compaction 流程 |

## 实现位置

| 模块 | 内容 |
|------|------|
| `packages/core/src/session/compaction.ts` | `select` 返回 `headEntries`；`serialize(message, full)` / `serializeHistory`；`writeHistory` 落盘 `tool_history_<messageID>.md`；`Compaction.Ended` 携带 `historyPath` |
| `packages/core/src/session/runner/llm.ts` | 注入 `FSUtil`，`historyDir = <Global.Path.data>/tool-output` |
| `packages/core/src/session/message-updater.ts` | `historyPath` 透传进 `SessionMessage.Compaction` |
| `packages/core/src/session/runner/to-llm-message.ts` | checkpoint 附检索提示（无 `historyPath` 时输出与旧版逐字节一致） |
| `packages/schema/src/session-event.ts` / `session-message.ts` | `historyPath: Schema.String.pipe(optional)` |

## 公共配置

> SaaS 环境数据库为 **PostgreSQL**（`sqliteTable` schema 经 `storage/db.pg.ts` 适配跑在 PG，表名/列名不变）。历史文件在文件系统，不存 DB。

```bash
# 运行前先加载 SaaS 测试环境（提供 $BASE/$PG_URL/$MODEL，见 docs/test-cases/test-env.sh）
source ../test-env.sh 3 && source ../test-lib.sh

# 历史文件所在目录（文件系统，与 DB 无关）
#   Linux:   ~/.local/share/opencode/tool-output
#   macOS:   ~/Library/Application Support/opencode/tool-output
export TOOL_OUTPUT="$HOME/.local/share/opencode/tool-output"
```

触发方式说明：historyPath 落盘仅在 **V2 SessionRunner** 路径生效（`packages/core/src/session/compaction.ts` 的 `compactAfterOverflow` → `writeHistory`）。当前仓库主链路走 **V1 SessionPrompt**（`packages/opencode/src/session/prompt.ts`），V1 的 overflow compaction 调用 `buildPrompt` from core 但**不含** historyPath 落盘逻辑。因此 T-CX.2~6 端到端用例在当前架构下无法触发，需等 V2 主链路上线。

## 验收层级

| 层级 | 用例 | 验证目标 | 状态 |
|------|------|----------|------|
| L0 单元 | T-CX.1 | 纯函数与落盘/透传/提示注入的单元测试 | ✅ 可执行（25 pass） |
| L1 落盘 | T-CX.2 | 触发 compaction 后历史文件生成、命名、内容完整 | ⏸️ blocked by V2 |
| L2 持久化 | T-CX.3 | `Compaction` 消息带 `historyPath` 且落库 | ⏸️ blocked by V2 |
| L3 效果 | T-CX.4 | 模型能通过历史文件检索回摘要丢失的细节 | ⏸️ blocked by V2 |
| L4 可靠性 | T-CX.5 | 落盘失败优雅降级；head 为空不产生文件 | ⏸️ blocked by V2（降级路径已由 T-CX.1 单测覆盖） |
| L5 清理 | T-CX.6 | `tool_*` 文件进入 7 天清理 | ⏸️ blocked by V2（清理实现待补直接回归测试） |
| L3 实战 | T-CX.7 | 二次 compaction 后仍可沿历史文件链找回第一次压缩的细节 | ✅ 单测覆盖；端到端 blocked by V2 |

> **T-CX.2~6 当前无法端到端执行**：historyPath 落盘仅在 V2 SessionRunner 路径生效（`packages/core/src/session/compaction.ts`），而当前仓库主链路走 V1 SessionPrompt（`packages/opencode/src/session/prompt.ts`），V1 的 overflow compaction 不含 historyPath 逻辑。V2 SessionRunner / SessionExecution 在当前仓库生产代码中未被引用。需等 V2 主链路上线后才能跑这些用例。

## 测试用例

### T-CX.1 单元测试（L0）

> 测试必须从包目录运行，不能从仓库根运行。

```bash
cd packages/core
bun test test/session-compaction.test.ts test/session-runner-message.test.ts
```

**期望**：24 pass / 0 fail。覆盖点：
- `serializeHistory`：工具输出 5000 字符完整保留、无 `[truncated]`；shell 完整输出；头部 `## msg_.. | shell | ISO 时间`
- `serialize`：`full=true` 完整 vs 默认截断 + `[truncated]` 标记
- `compactAfterOverflow` 集成：文件落盘、事件 `historyPath`、head 在文件、recent 保留在上下文
- 落盘失败降级：`historyPath` 为 `undefined`，compaction 仍发布摘要
- `message-updater`：`historyPath` 透传 / 无字段时省略
- `to-llm-message`：checkpoint 附检索提示
- 连续 compaction：新历史文件包含前一历史文件路径，Agent 可沿链检索更早的完整记录

### T-CX.2 触发 compaction 并验证历史文件落盘（L1）

```bash
# 1) 在 SaaS 环境（$BASE）中创建 session 并持续 prompt，累积长对话：
#    多轮大段文本或大文件读取，使 provider 上下文超限 → V2 SessionRunner 自动触发
#    auto/overflow compaction（可用低 context 模型，如 context=4k，加速触发）。
#    本地调试可起带 PG 模式的服务：cd packages/opencode && bun dev（或容器内 opencode）

# 2) compaction 完成后检查历史文件
ls -la "$TOOL_OUTPUT" | grep tool_history_
```

**期望**：
- 生成文件 `$TOOL_OUTPUT/tool_history_<messageID>.md`，`<messageID>` 为 `msg_` 开头的 compaction 消息 ID
- 文件内容为分节 Markdown：

```markdown
## msg_ffcf... | user | 2026-08-14T10:00:00.000Z
[User]: 文本

## msg_... | assistant | ...
[Assistant tool call]: read("src/foo.ts", 1, 200)
[Tool result]:
<完整工具输出，不截断>
```

### T-CX.3 验证 Compaction 消息持久化 historyPath（L2）

```bash
psql "$PG_URL" -c \
  "SELECT id, data->>'historyPath' AS history_path \
     FROM session_message WHERE type='compaction' ORDER BY seq DESC LIMIT 5;"
```

**期望**：最近一条 compaction 行的 `history_path` 为 `$TOOL_OUTPUT/tool_history_<同一 messageID>.md`，与 T-CX.2 文件一一对应。

### T-CX.4 检索效果验证（L3）

1. 在 compaction 前，让 Agent 用工具产生一段**不会被摘要记住**的细节（如长文件中的一段内容，并追问具体行）。
2. 触发 compaction（T-CX.2）。
3. 摘要后，让 Agent 回答该细节问题，并主动引用历史文件：
   > 刚才你读到 `src/foo.ts` 第 42 行的具体内容是什么？

**期望**：Agent 的下一轮消息中，checkpoint 旁出现检索提示「The full record of the compacted conversation is available at <path>… search that file with Grep or Read (offset/limit)」。Agent 能通过 Grep/Read 历史文件找回该细节，回答正确，而非答「我不记得」或依赖摘要。

### T-CX.5 优雅降级与空 head（L4）

- **落盘失败**：将 `$TOOL_OUTPUT` 改为只读（`chmod 500`）后触发 compaction。
  **期望**：日志出现 `WARN failed to write compaction history`，compaction 摘要正常发布，`historyPath` 为 `undefined`，`Compaction` 消息无该字段。
- **无可压缩内容**：仅 1-2 条小消息触发 compaction 时，`head` 为空，**不产生** `tool_history_` 文件（`compactAfterOverflow` 提前返回 false）。

### T-CX.6 清理验证（L5）

```bash
# 手工模拟过期文件（8 天前；Linux 用 date -d '8 days ago'）
touch -t "$(date -v-8d +%Y%m%d%H%M)" "$TOOL_OUTPUT/tool_history_stale.md"
# 等待清理循环（首次运行后延迟 1 分钟，随后每小时一次）
```

**期望**：8 天前的 `tool_history_stale.md` 在下一轮清理中被删除；7 天内的文件保留；清理不影响数据库中的 compaction 摘要与 `historyPath`（文件删除后 Agent 仅失去检索能力，会话数据不丢）。

### T-CX.7 实战：两次 compaction 后检索第一次细节（L3）

> 当前 V2 主链路未上线，此用例暂不能端到端运行；`session-compaction.test.ts` 已覆盖相同场景。

1. 在第一次 compaction 前读取或生成唯一细节，例如 `FIRST_COMPACTION_SECRET=violet-owl-42`。
2. 触发第一次 compaction，记录其历史文件 `tool_history_<first>.md`。
3. 再累积足够长的会话并触发第二次 compaction，记录 `tool_history_<second>.md`。
4. 在第二个文件中执行 `grep -n "Earlier compacted history\|tool_history_<first>" "$TOOL_OUTPUT/tool_history_<second>.md"`。
5. 让 Agent 回答第一次压缩前的唯一细节。

**期望**：第二个历史文件声明并引用第一个文件路径；Agent 从最新 checkpoint 的 historyPath 开始，可沿引用检索到 `violet-owl-42` 并正确回答。不会因只保留最新 compaction 消息而丢失早期完整历史的可达性。

## 已知限制

- **V2 主链路未上线**：historyPath 功能仅存在于 V2 SessionRunner 路径（core 包），当前仓库主链路走 V1 SessionPrompt，V1 compaction 不含此功能。V2 手动 `/compact` 也未实现（`OperationUnavailableError`）。T-CX.2~6 需等 V2 上线后才能端到端验证。
- 历史文件有 7 天保留期；过期后文件被清理，但被压缩历史的原始数据仍在 PG 的 `session_message` 表。
- 历史文件含明文对话，可能很大；Agent 被提示用 Grep/Read 而非整读。
- **TOOL_OUTPUT 路径因平台/运行方式而异**：文档示例写 `$HOME/.local/share/opencode/tool-output`（Linux/SaaS 容器），macOS 宿主机直跑时为 `~/Library/Application Support/opencode/tool-output`。端到端用例应从 `Global.Path.data` 动态获取，而非硬编码。
- **清理回归测试待补**：`truncate.ts` 实现以 `tool_` 前缀和 7 天 RETENTION 清理文件；目前尚无直接单测覆盖 T-CX.6 的过期文件删除行为。
