# Session Compaction 历史文件引用（摘要可检索历史）

> 验证 V2 Session Runner 在 compaction（自动摘要）时，将被压缩的对话历史完整落盘，并让 Agent 在摘要后按需检索找回细节。

## 功能背景与效果

上下文窗口被填满时，SessionRunner 触发一次 compaction，用一个 LLM 摘要替换旧对话。摘要是有损压缩，Agent 可能丢失任务关键细节。

本功能参照 Cursor「将对话历史作为文件引用」方案，在 compaction 成功时把**被压缩部分的历史**（含完整、不截断的工具输出）落盘到 `tool-output/`，并将文件路径写入 `Compaction` 消息。后续 Agent 生成的 `<conversation-checkpoint>` 中附带检索提示，摘要缺细节时可用 Grep / Read(offset/limit) 回检索，无需整读。

| 能力            | 效果                                                                                    |
| --------------- | --------------------------------------------------------------------------------------- |
| 历史完整落盘    | 被压缩消息序列化为 `## <id> \| <type> \| <ISO时间>` 分节的 Markdown，工具输出**不截断** |
| 路径持久化      | `Compaction.Ended` 事件 → `Compaction` 消息 `historyPath` 字段 → DB 落库                |
| 检索提示注入    | `<conversation-checkpoint>` 附带「完整记录在 <path>，可用 Grep/Read 检索，勿整读」      |
| 零额外 LLM 成本 | 落盘是纯文件 I/O，不增加 provider 调用                                                  |
| 权限零配置      | 文件落 session 远程沙箱的 `/workspace/.opencode/tool-output/`，Read/Grep 可直接访问     |
| 自动清理        | 文件名带 `tool_` 前缀，沿用 `truncate.ts` 每小时、7 天保留的回收机制                    |
| 优雅降级        | 落盘失败仅跳过 `historyPath`，不影响摘要与 compaction 流程                              |

## 实现位置

> 本分支（`feat/opencode-saas-2.0`）为 **V2 SessionRunner** 实现；历史中 V1（`packages/opencode`）路径已随 v1-relocate 移除。

| 模块                                                                                     | 内容                                                                                                                                                       |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/session/compaction.ts`                                                | `serializeHistory(message)`：`## <id> \| <type> \| <ISO时间>` 分节、工具输出**不截断**（`serializeRecentMessage(_, full)`）；`writeHistory` 落盘 `tool_history_<messageID>.md`（链头引用 `previousHistoryPath`）；`execute` 开头固定 messageID；`Compaction.Ended` 携带 `historyPath`；落盘失败 `WARN failed to write compaction history` 降级 |
| `packages/core/src/session/message-updater.ts`                                           | `historyPath` 透传进 `SessionMessage.Compaction`（update 与 append 两分支）                                                                                 |
| `packages/core/src/session/runner/to-llm-message.ts`                                     | checkpoint 附检索提示（无 `historyPath` 时输出与旧版逐字节一致）                                                                                            |
| `packages/schema/src/session-event.ts` / `session-message.ts`                            | `historyPath: SessionMessage.CompactionCompleted.fields.historyPath`（`Schema.String.pipe(optional)`）                                                      |
| `packages/core/src/tool-output.ts`                                                       | 清理正则 `/^tool_(?:[0-9a-f]{12}\|history_)/` 纳入历史文件，沿用 `RETENTION=7天`、每小时扫描                                                                |

### 落盘目录与可达性

- V2 写 **服务进程** `Global.data/tool-output/`（SaaS 容器内为 `/home/opencode/.local/share/opencode/tool-output/`），PG 只保存 `historyPath`。
- ⚠️ 与 V1 的差异：V1 写 session 远程沙箱 `/workspace/.opencode/tool-output/`（Agent 的 Grep/Read 零配置直达）。V2 路径下 Agent 的 **Read 类工具按服务端本地读取可达**，但沙箱内执行的 **bash/Grep 对该路径不可达**；检索提示同时给了 Read(offset/limit)，端到端见 T-CX.4 实测。

## 公共配置

> SaaS 环境只支持 **PostgreSQL**。`historyPath` 随 compaction part 存在 PG 的 `part.data` JSONB 中；完整历史正文写入沙箱/容器文件系统，数据库只保存可检索路径。

```bash
# 运行前先加载 SaaS 测试环境（提供 $BASE/$PG_URL/$MODEL，见 docs/test-cases/test-env.sh）
source ../test-env.sh 3 && source ../test-lib.sh

# SaaS 远程沙箱中的历史文件目录（PG 仅保存 historyPath）
export TOOL_OUTPUT="/workspace/.opencode/tool-output"
```

## 触发方式

本分支（V2）三条 compaction 路径都会落历史文件（本地执行路径）：

- **手动**：`POST /api/session/:id/compact`（inbox steer，`Session.compact` → `compactManual` → `execute`）
- **自动**：`SessionCompaction.required` 达阈值触发（`runner/llm.ts` auto 分支）
- **溢出恢复**：已知 context overflow → `recoverLocally` → `execute`

provider 原生 compaction（`executeProvider`）与 hooks 直接供给摘要的路径**不写**历史文件（无本地 head 语义，`historyPath` 为 `undefined`）。

## 验收层级

| 层级      | 用例   | 验证目标                                               | 状态                                        |
| --------- | ------ | ------------------------------------------------------ | ------------------------------------------- |
| L0 单元   | T-CX.1 | 纯函数与落盘/透传/提示注入的单元测试                   | ✅ 54 pass / 0 fail（2026-09-24）           |
| L1 落盘   | T-CX.2 | 触发 compaction 后历史文件生成、命名、内容完整         | ✅ 沙箱内实测（2026-09-24）                 |
| L2 持久化 | T-CX.3 | `Compaction` 消息带 `historyPath` 且落库               | ✅ 沙箱路径实测（2026-09-24）               |
| L3 效果   | T-CX.4 | 模型能通过历史文件检索回摘要丢失的细节                 | ✅ 严格版实测：AI 沿链检索并答对（2026-09-24） |
| L4 可靠性 | T-CX.5 | 落盘失败优雅降级；head 为空不产生文件                  | ✅ 本地/沙箱双降级 + 空 head 单测覆盖        |
| L5 清理   | T-CX.6 | `tool_*` 文件进入 7 天清理                             | ✅ 过期删除单测覆盖（2026-09-24 补齐）      |
| L3 实战   | T-CX.7 | 二次 compaction 后仍可沿历史文件链找回第一次压缩的细节 | ✅ 链式引用实测（2026-09-24）               |

> T-CX.1~T-CX.7 已在 **V2 SessionRunner**（本分支唯一实现）上闭环：单测覆盖 L0/L4/L5，端到端覆盖 L1/L2/L3。

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
curl -s "$BASE/session/$SID/shell" -H 'Content-Type: application/json' \
  -d "{\"command\":\"ls -la $TOOL_OUTPUT | grep tool_history_\"}"
```

**期望**：

- 远程沙箱生成文件 `$TOOL_OUTPUT/tool_history_<messageID>.md`，`<messageID>` 为 `msg_` 开头的 compaction 消息 ID
- 文件内容为分节 Markdown：

```markdown
## msg_ffcf... | user | 2026-08-14T10:00:00.000Z

[User]: 文本

## msg\_... | assistant | ...

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

> V1 主链路已接入 historyPath；端到端测试需要准备可触发 compaction 的低上下文模型或测试配置。

1. 在第一次 compaction 前读取或生成唯一细节，例如 `FIRST_COMPACTION_SECRET=violet-owl-42`。
2. 触发第一次 compaction，记录其历史文件 `tool_history_<first>.md`。
3. 再累积足够长的会话并触发第二次 compaction，记录 `tool_history_<second>.md`。
4. 在第二个文件中执行 `grep -n "Earlier compacted history\|tool_history_<first>" "$TOOL_OUTPUT/tool_history_<second>.md"`。
5. 让 Agent 回答第一次压缩前的唯一细节。

**期望**：第二个历史文件声明并引用第一个文件路径；Agent 从最新 checkpoint 的 historyPath 开始，可沿引用检索到 `violet-owl-42` 并正确回答。不会因只保留最新 compaction 消息而丢失早期完整历史的可达性。

## 已知限制

- 历史文件有 7 天保留期；服务端目录由 `tool-output` 清理循环管理，**沙箱内文件由沙箱生命周期兜底**（沙箱回收即删除）。过期后文件被清理，但被压缩历史的原始数据仍在 PG 的 `session_message` 表。
- 历史文件含明文对话，可能很大；Agent 被提示用 Grep/Read 而非整读。
- **provider 原生 compaction / hooks 供给摘要的路径不写历史文件**（无本地 head；`historyPath=undefined`）。
- **弱模型不一定主动检索**：checkpoint 提示给出路径与 Grep/Read 方法，但小模型可能直接答摘要内容；显著标记（如"暗号"）会被摘要模板保留，评测细节应选中性内容（见 T-CX.4 严格版做法）。
- 本地模式（sandbox disabled）落盘 `Global.data/tool-output`；沙箱部署必须落 `/workspace/.opencode/tool-output`，否则 Agent 不可达（2026-09-24 实测教训）。

## 复测记录

### 2026-09-24 全量复测（本分支实现 V2 compaction history，本地 PG + 本地 OpenSandbox）

> 背景：本分支（`feat/opencode-saas-2.0`）此前**没有** historyPath 功能（实现位于 `feat/opencode-2.0` 分支），本次参考 V1 语义在 V2 SessionRunner 落地并全量跑通。
> 环境：worktree（HEAD `514d9311f9` + 本次改动）本地进程 `:14998`，PG `opencode-v2-up`，OpenSandbox `localhost:8080`，模型 `opencode/space-bunny-free`。

| 用例                  | 结果            | 实测                                                                                                                                                              |
| --------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-CX.1 单元（L0）     | ✅ **54/0**     | `session-compaction`(含沙箱写入/沙箱降级/空 head/链式) + `session-runner-message`(checkpoint 提示) + `tool-output`(过期清理)；影响面另跑 220 pass                     |
| T-CX.2 落盘（L1）     | ✅              | 沙箱内 `/workspace/.opencode/tool-output/tool_history_<msgID>.md` 生成，`ls`+`head` 可见分节头 `## msg_… \| user \| 2026-…Z`，100 行工具输出完整落盘（无截断标记） |
| T-CX.3 持久化（L2）   | ✅              | `session_message` 中 `type=compaction` 行 `data->>'historyPath'` = `/workspace/.opencode/tool-output/tool_history_<同一 msgID>.md`，与文件一一对应                  |
| T-CX.4 检索（L3）     | ✅ **严格版**   | 摘要与 recent 均**不含** `cfg.line.57`（f），历史文件**含**（t）→ AI 用 `read`+`grep` 读两个历史文件（工具调用铁证）→ 答对 `cfg.line.57 = val-57`（源文件已轮转） |
| T-CX.5 降级（L4）     | ✅ 单测覆盖     | 本地写失败、沙箱 `fileWrite` 失败均降级 `historyPath=undefined` 且摘要照发；空 head 不产生文件                                                                      |
| T-CX.6 清理（L5）     | ✅ 单测覆盖     | `sweeps expired compaction history files`：8 天前 `tool_history_*` 删除、7 天内保留（清理循环每小时，e2e 以单测代替）                                             |
| T-CX.7 链式（L3 实战） | ✅              | 第二文件头部 `1:## Earlier compacted history` + 引用第一文件路径 6 处；AI 沿链读两个文件                                                                          |

**过程发现与修复**：

1. 初版落盘 `Global.data/tool-output`（服务容器）→ 沙箱内 Agent 不可达，弱模型为读该路径乱调 `session_move`/webfetch 导致会话跑偏 → **改为 `SandboxProvider.fileWrite` 写沙箱 `/workspace/.opencode/tool-output`**（V1 语义），本地模式仍写 `Global.data`。
2. `POST /api/session/:id/compact`（V2 手动 compact）实测可用 —— 文档原「已知限制」过时已改。
3. 评测设计备注：显著标记（"暗号"类）会被摘要模板 `Important Context` 保留，无法证明检索通路；须用**中性行内容**（如第 57 行配置）+ 事后轮转源文件，才能使答案唯一来源于历史文件。

### 2026-08-23 重跑（merge upstream v1.18.21 后，hy3-free LLM）

| 用例                  | 结果                             | 备注                                                                                                                                                                                                                  |
| --------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-CX.1 单元测试（L0） | ✅ **26 pass / 0 fail**          | merge 后 `buildPrompt` 对齐 upstream 结构（`<conversation>` 标签包装 + 新指令 + `<prior-summary>` 分支），修复了 2 个 merge 组合回归（原 24 pass 2 fail → 26 pass）；保留我方 `select()` headEntries/splitPrefix 超集 |
| T-CX.2-6 端到端       | ✅ V1 已接入，待 SaaS 低阈值复测 | V1 `processCompaction` 已写入 `tool_history_<messageID>.md`、透传 `historyPath` 并在模型消息中注入检索提示                                                                                                            |
| 手动 summarize 触发   | ✅                               | `POST /session/:id/summarize`（opencode/hy3-free）→ compaction 消息正常生成（summary=true, mode=compaction, input 19.5K tokens），compaction 链路可用                                                                 |
| LLM 通路              | ⚠️                               | Yd 网关（claude.shadow-rpa.net）不可达 + opencode-go workspace 额度用尽 → 用例改用 **opencode/hy3-free**（zen v1 免费模型，验证可用）                                                                                 |

**结论**：L0 单测全通过（含 merge 回归修复），端到端用例维持 V2 未上线状态；LLM 测试通路已切换至 hy3-free。

### 2026-09-03 影响面回归（本地 PG + 远程沙箱）

| 用例                  | 结果 | 证据                                                                                  |
| --------------------- | ---- | ------------------------------------------------------------------------------------- |
| T-CX.1 V1 history 单测 | ✅   | `test/session/compaction-history.test.ts`：1 pass / 0 fail                             |
| T-CX.1 core compaction | ✅   | `test/session-compaction.test.ts` + `test/session-runner-message.test.ts`：26 pass / 0 fail |
| T-CX.2/T-CX.3         | ✅   | 低阈值 SaaS compaction 生成远程沙箱 history 文件，PG 持久化 `historyPath`              |
| T-CX.5                 | ✅   | core 落盘失败用例实际输出 `failed to write compaction history`，摘要流程继续             |
| Session 生命周期       | ✅   | 创建/查询/PATCH/DELETE：`200`，删除后 GET：`404`，PG 无残留                             |
| Sandbox 生命周期       | ✅   | boot/kill/recreate：均 `200`，kill 返回 `destroyed=true`                               |
| 基础兼容接口           | ✅   | `/session/status`、`/agent`、`/skill`、`/command` 均返回 `200`                          |

本次运行保持 SaaS 约束：只使用 PostgreSQL，历史正文只写远程沙箱，不再写本地文件回退。

> **复测记录（2026-09-15，镜像 `hitl-cbf2276a-wip2`（含 pgJsonb/LEASE_TOOLS/偏离修复），本地 PG + 远端沙箱，Yd-DeepSeek）**：
> | 用例 | 结果 | 实测 |
> |---|---|---|
> | T-CX.1 core 单测 | ✅ **27/27** | `session-compaction.test.ts`(26) + `session-runner-message.test.ts` 全过 + `compaction-history.test.ts`(1) |
> | T-CX.2 历史文件落盘 | ✅ | 沙箱 `/workspace/.opencode/tool-output/tool_history_msg_0a2cd939...md` 生成，内容含完整对话（violet-owl-42 细节可见） |
> | T-CX.3 historyPath 持久化 | ✅ | **`historyPath` 在 `type=compaction` 的 part data 中**（非 message data）：`{"auto":false,"type":"compaction","historyPath":"/workspace/.opencode/tool-output/tool_history_msg_...md"}` |
> | T-CX.4 检索效果 | ✅ | summarize 后问「秘密代码是什么」→ AI 回答 `violet-owl-42` 正确 |
> | T-CX.5 优雅降级 | ✅（单测覆盖） | compaction.test.ts 含落盘失败降级用例 |
> | T-CX.6 清理 | ✅（代码确认） | `compaction.ts` 落盘时附带 `find ... -mtime +7 -delete`；直接单测仍待补 |
> | T-CX.7 两次 compaction 链式检索 | ⏭️ 未跑 | 需要两次 overflow compaction（长流程） |
>
> ⚠️ 注意：**T-CX.3 的 `historyPath` 在 part data 而非 message data**——文档 SQL `SELECT data->>'historyPath' FROM session_message WHERE type='compaction'` 查不到（message 无 type 列，正确查法：`SELECT data->>'historyPath' FROM part WHERE data->>'type'='compaction'`）
