# Session 操作审计日志（V2 `log` 表）

> V2 会话级变更操作的写审计，覆盖 Session **全生命周期**的所有变更类接口。V1 的 `exec_log` 表与 `logAction` 机制已随 V1 路由移除；本文件按当前 V2 契约定义用例，V1 记录保留在文末仅作历史证据。
>
> **V2 双载体分工**：
>
> | 载体 | 内容 | 读取方式 |
> |---|---|---|
> | `log` 表 | HTTP 控制面**变更操作**审计（本文件） | `GET /api/session/:id/logs`（升序，`limit`/`after` 游标翻页；无 `limit` 返回全量） |
> | `event` 表 | durable 运行时事件（执行/工具/推理流），`OPENCODE_EVENTS_PERSIST=1` 开启 | `GET /api/experimental/session/:id/log`（`after`/`follow` 回放，先发 `log.synced` 水位） |
>
> 注意：V2 没有 `logs` 复数表；`/api/experimental/session/:id/log`（单数）是 **event 表**的回放流，不是本文件的 `log` 审计表。

## 一、当前 V2 契约

- 表：`log`（`id` log_ 前缀、`session_id` FK `session_v2` `ON DELETE CASCADE`、`source`、`detail` JSON、`time_created`）。
- 契约：`packages/schema/src/log.ts`（`Log.Info`、闭合 `Log.Source` 集合 47 类、`MaxDetailBytes=8192`）。
- 服务：`packages/core/src/log.ts`（`Log.Service.record/list`，同步落库，失败即 defect——部分变更不得静默成功）。
- API：`GET /api/session/:sessionID/logs`——按 sessionID 查询**所有**审计日志：升序；`limit` 分页；`after`（上一页最后一条 ID）游标翻页可取尽全部；缺失 session 404。
- `detail` 超过 8KB 降级为 `{ truncated: true, bytes }`。
- 审计在操作**成功后**记录；失败操作不产生审计行。

### 审计点矩阵（47 类 source）

| 分组 | source（触发接口） |
|---|---|
| 生命周期 | `session.create`(POST /session) · `session.update`(PATCH) · `session.move` · `session.fork`(记在 fork 新 session，detail `{from}`) · `session.import`(记在导入新 session) · `session.interrupt` · `session.background` · `session.killSandbox` `{destroyed}` · `session.keepAlive` `{enabled}` · `session.snapshot.create` `{snapshotID}` · `session.view` · `session.environment` `{variables:[键]}` · `session.permissions` `{preset}` · `session.terminal.create` `{command,title?}` |
| 回合入口 | `session.prompt`(POST /prompt 与 /prompt_stream，`{stream,delivery,agents?,model?,preset?}`，不记 prompt 全文) · `session.synthetic` · `session.command` `{name}` · `session.skill` `{skill}` · `session.shell` `{command}` · `session.compact` |
| revert | `session.revert.stage` `{messageID?}` · `session.revert.commit` · `session.revert.clear` |
| 定义 CRUD | agent：`create {id}` / `delete {agentID}` / `clear` / `permissionPreset {agentID,preset}`；command：`create {name}` / `delete {name}` / `clear`；tool：同 command；skill：`create {skill}` / `delete {skillID}` / `clear`；mcp：`create {name}` / `delete {name}` / `clear` |
| 指令文档 | `session.agentsMd.update` `{bytes}` · `session.agentsMd.remove` |
| 交互应答 | `permission.respond` `{requestID,decision,message?}` · `session.form.reply` `{formID,keys}` · `session.form.cancel` `{formID}` · `session.inbox.update` `{inboxID,delivery}` · `session.inbox.cancel` `{inboxID}` |
| 选择 | `session.agent.select` `{agent}` · `session.model.select` `{model}` |

**能力边界（如实记录，不以 V1 行为推断）**：
- `DELETE /api/session` **不记录**审计（行随 Session 级联清理，与 V1 相同），删除本身只能通过 PG 行为间接审计。
- prompt 全文不进日志（隐私/体积），记 delivery/agents/model/preset 等元信息；config 全文不进日志（状态表 `session_agents` 等可查）。
- 读类接口（get/list/message/event/logs/export/diff/wait/generate/terminal 读、definitions 的 list/refresh）不审计——与 V1 惯例一致。
- `persistent-pty` 组其余写端点（shutdown/handoff/update/remove/connectToken）不带 `sessionID`，属 session 级审计范围外；`session.terminal.create` 已审计（实现经 typecheck/单测回归保障，运行时行为验证依赖 PTY 二进制可用环境，本机测试环境 skip，待 PTY 环境顺带覆盖）。
- 复用说明：agent/command/tool/skill/mcp/agentsMd 六类资源定义共用**同一** `Log.Service` + handler 级 `audit()` helper + 一张 `log` 表，新增资源类型只需扩展 `Log.Source` 并在 handler 成功路径加一行，无需新建表/服务。

**测试中发现的产品问题（独立于本功能，待修复）**：
1. `POST /api/experimental/session/import` 覆盖 `info.id` 导入 → **500 空响应体**（原样导出→删除→导入同 ID 正常；探针已最小复现）。
2. 沙箱模式下 `POST /move` 到沙箱内目录 → **400 "Directory does not exist"**（mkdir 已在沙箱成功、shell 消息 exited 0 后仍复现；疑似 move 校验未走沙箱 fs 或跨沙箱状态丢失）。

## 二、环境与执行

```bash
# 需要包含 log 表功能的源码镜像（migration 自动建表）
source docs/test-cases/test-env.sh 3
export BASE=http://localhost:14106          # 隔离 SaaS 容器
export OPENCODE_PASSWORD=ab123456
export PG_URL='postgresql://local@127.0.0.1:5432/opencode-v2-up'
export MODEL='{"providerID":"Yd-DeepSeek","id":"deepseek-v4-flash"}'  # Phase B 需真实模型
node docs/test-cases/scripts/session-audit-log-v2.mjs
```

Phase A（确定性操作）无模型依赖；Phase B（prompt/permission/compact/command/skill/form/inbox/revert/snapshot）走真实模型回合。脚本自带 409 Sandbox 清理时序的删除轮询与零残留清理断言。

## 三、用例

| 用例 | 验证点 |
|---|---|
| T18.1 | `POST /api/session` 成功后 `log` 出现 `session.create` 一条 |
| T18.2 | 全部无模型审计点：生命周期 14 类 + 定义 CRUD 15 类 + agentsMd 2 类 + 选择 2 类，精确计数断言；detail 捕获（environment 变量名、permissionPreset preset、fork from）；`session.move` 沙箱 400 时**不产生**审计行（失败不记录的负向验证） |
| T18.2f | `session.fork` / `session.import` 分别记录在**产生的新 session** 上，fork detail `{from}` 指向源 |
| T18.3 | 模型回合审计：prompt_stream/prompt、permission.respond（含 requestID/decision）、compact、command、skill、form.reply/cancel（question 工具）、inbox.update/cancel（长回合中并发 steer）、revert stage/clear/commit；snapshot.create 按能力分支（成功记录/失败不记录） |
| T18.4 | API 通用属性：首条 create、`log_` 前缀、时间升序、`limit` 截断、**`after` 游标翻页取尽全部并与全量一致**、缺失 session 404 |
| T18.5 | 跨 session 隔离：B 的日志只含 B 的操作 |
| T18.6 | `DELETE /api/session` 后审计行级联清零、审计 API 404 |
| 单测 | `packages/core/test/log.test.ts`（顺序/截断/limit/**after 游标**/隔离/级联，SQLite+PG 双跑）、`packages/server/test/log.test.ts`（handler 全链路 + 生命周期/定义写入 + 游标翻页拼接全量） |

## 四、执行记录

**2026-10-09（全生命周期版）**：schema `Log.Source` 扩至 47 类；handler 埋点 47 处（`audit()` helper 统一）；`session.logs` API 支持 `after` 游标 + 无 limit 全量。core 单测 **6 pass / 0 fail**（SQLite 与 `opencode-v2-test` PG 各一遍，含游标分页/级联）；server 集成 **3 pass / 0 fail**（handler 全链路 + 生命周期/定义写入 + after 翻页拼接全量）；migration `--check` 通过。

E2E（隔离容器 + 本地 PG，模型 `Yd-DeepSeek/deepseek-v4-flash`）**分段全部通过**：Phase A（35 项：46 source 中全部无模型审计点精确计数 + detail 捕获 + move 失败不记录的负向验证 + fork/import 记录在新 session）连续多轮全绿；Phase B 模型段（prompt_stream/prompt、permission.respond 含 requestID+decision、snapshot 失败分支、compact、command、skill、form.reply/cancel、inbox.update/cancel）在稳定时段完整通过；revert 四步（stage×2/clear/commit，409 busy 重试）+ after 游标翻页 + 级联 404 以无模型探针（控制面 shell 消息）复验通过；清理零残留断言随各轮通过。**说明**：共享模型代理存在并行占用，完整脚本单次连续全绿未达成（多轮在模型回合超时中断，中断轮的残留均已清理），各段证据以上述输出为准；脚本已内置 409 删除/revert 重试与 90s wait 容错。

**2026-10-09（首版 16 source）**：镜像 `opencode-saas-audit-log:local` + 隔离容器 + 本地 PG，E2E `session-audit-log-v2.mjs` 18 项断言全部通过（含级联清理、隔离、detail 捕获、limit/404），PG 零残留。

> **删除时序**（与 compose-agent 记录一致）：agentsMd 写入会创建 Sandbox，`DELETE /api/session` 可能被 `SandboxRetainedError`（409）暂时拒绝，脚本对删除做 PG 轮询直至级联生效。

## 五、历史记录（V1，非当前契约证据）

以下记录基于 V1 `exec_log` 表与旧路由（`/session/:id/agents/create`、`/message`、`/abort`、`share` 等），仅说明当时行为，不能证明当前 V2：

- 2026-09-06（merge upstream/dev v1.18.29）：exec_log 审计全链路 15 类 source 通过。
- 2026-09-12（feat/opencode-1.18.30）：T17.28–30 工具全链路/收敛/abort 兜底通过。
- 2026-09-14（hitl-cbf2276a-wip2）：T17.1–T17.30 全 30 例 PASS（含 sandbox-create 耗时、permission-deny、share/unshare）。
